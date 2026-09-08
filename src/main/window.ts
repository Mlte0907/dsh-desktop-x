import { BrowserWindow, app, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as C from './config'
import type { BackendStatus } from './backend'

export type WindowAction = 'minimize' | 'maximize' | 'close'

const BOUNDS_FILE = 'window-bounds.json'

/**
 * Set while a real quit is in flight. Chromium delivers SIGTERM as an app-quit
 * whose first step is closing the window; without this flag that close is
 * indistinguishable from a user clicking ×, gets hidden to the tray, and the
 * quit — and the signal — die right there.
 */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

interface Bounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_BOUNDS: Bounds = { width: 1280, height: 860, maximized: false }

async function loadBounds(): Promise<Bounds> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(app.getPath('userData'), BOUNDS_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_BOUNDS
    const { x, y, width, height, maximized } = parsed as Record<string, unknown>
    return {
      x: typeof x === 'number' ? x : undefined,
      y: typeof y === 'number' ? y : undefined,
      width: typeof width === 'number' ? width : DEFAULT_BOUNDS.width,
      height: typeof height === 'number' ? height : DEFAULT_BOUNDS.height,
      maximized: maximized === true,
    }
  } catch {
    return DEFAULT_BOUNDS
  }
}

async function saveBounds(bounds: Bounds): Promise<void> {
  try {
    await writeFile(join(app.getPath('userData'), BOUNDS_FILE), JSON.stringify(bounds), 'utf8')
  } catch {
    /* geometry is a convenience; losing it is not an error */
  }
}

/**
 * The application window: a frameless Codex-style chrome wrapping one
 * `<webview>` that hosts `dsh web`.
 *
 * The chrome is local HTML rather than injected into the remote page, so it
 * paints before the backend exists. That is what keeps a cold start — where the
 * backend alone takes ~5s — from looking like a hung application.
 */
export class ShellWindow {
  readonly win: BrowserWindow
  private forceClose = false
  private saveTimer: NodeJS.Timeout | undefined

  private constructor(bounds: Bounds) {
    this.win = new BrowserWindow({
      ...(bounds.x === undefined || bounds.y === undefined ? {} : { x: bounds.x, y: bounds.y }),
      width: bounds.width,
      height: bounds.height,
      minWidth: 720,
      minHeight: 520,
      show: false,
      frame: false,
      // xfwm4 adds its own drop shadow around frameless windows; combined with
      // its 1px theme border it reads as a grey outline the chrome never drew.
      hasShadow: false,
      // Painting the shell's own dark background before first paint removes
      // the white flash that would otherwise precede the webview.
      backgroundColor: '#0b0d12',
      title: 'DeepSeek Harness',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // The backend <iframe> inherits the window's session. Without this it
        // lands on the default session: cookies land where the auth-wall
        // watcher is not listening, and nothing ever authenticates.
        partition: C.SESSION_PARTITION,
      },
    })

    if (bounds.maximized) this.win.maximize()

    this.registerLifecycle()

    void this.win.loadFile(join(__dirname, '..', 'renderer', 'shell.html')).catch((error: unknown) => {
      console.error('dsh-desktop: failed to load shell', error)
    })

    // Show only once the local chrome has painted. Waiting for the remote page
    // would couple first paint to the backend's 5s boot.
    this.win.once('ready-to-show', () => {
      if (!this.win.isDestroyed()) this.win.show()
    })
  }

  static async create(): Promise<ShellWindow> {
    return new ShellWindow(await loadBounds())
  }

  private registerLifecycle(): void {
    this.win.on('close', (event) => {
      // Closing collapses to the tray by design: the backend is a separate
      // process and must survive the window. A quit in flight (tray item,
      // SIGTERM) bypasses the hide.
      if (this.forceClose || quitting) {
        void this.persistBounds()
        return
      }
      event.preventDefault()
      this.win.hide()
    })

    const queueBoundsSave = (): void => {
      if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => void this.persistBounds(), 400)
    }
    this.win.on('resize', queueBoundsSave)
    this.win.on('move', queueBoundsSave)

    // Keep navigation inside: the harness UI never needs to leave the window,
    // and dropping a session into the system browser would lose the auth cookie.
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  private async persistBounds(): Promise<void> {
    if (this.win.isDestroyed()) return
    const bounds = this.win.getBounds()
    await saveBounds({ ...bounds, maximized: this.win.isMaximized() })
  }

  /**
   * Watch the embedded backend frame for the auth wall, and keep it fed with
   * its cookie.
   *
   * Two cross-origin consequences need handling here, in the one place that
   * can see the session's traffic:
   *
   * 1. The chrome is a file:// page, so the backend frame is a cross-site
   *    context and Chromium suppresses the backend's SameSite=Strict cookie on
   *    every request. The session does store the cookie after the token
   *    exchange — it just never sends it. Attach it explicitly; this touches
   *    nothing in the harness.
   * 2. The frame's DOM is invisible from the renderer, so a 401 is caught on
   *    this stream instead. The shell's own probes use node:http and never
   *    pass through this session.
   */
  watchWebview(onAuthWall: () => void): void {
    const base = C.BACKEND_BASE_URL
    // The backend's RPC stream rides a WebSocket upgrade; that request is
    // `ws://…`, which a `http://…` filter does NOT match — so without the
    // second entry the auth cookie is never injected onto the handshake and the
    // whole RPC stream dies (presets, model list, …).
    const filter = { urls: [`${base}/*`, `${base.replace(/^http/, 'ws')}/*`] }
    const sess = session.fromPartition(C.SESSION_PARTITION)

    // Synchronous snapshot of the session cookie. The injection below must
    // call back synchronously: awaiting inside onBeforeSendHeaders stalls
    // WebSocket upgrades — the request hangs forever with no handshake
    // response, which is what silently killed the RPC stream (presets, model
    // list) while plain HTTP requests still worked.
    let cookieHeader = ''
    const refreshCookieHeader = (): void => {
      sess.cookies
        .get({ url: C.BACKEND_BASE_URL })
        .then((cookies) => {
          cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        })
        .catch(() => undefined)
    }
    refreshCookieHeader()

    sess.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (cookieHeader !== '') details.requestHeaders['Cookie'] = cookieHeader
      callback({ requestHeaders: details.requestHeaders })
    })

    sess.webRequest.onCompleted(filter, (details) => {
      refreshCookieHeader()
      if (details.statusCode === 401) onAuthWall()
      // Failed backend calls would otherwise vanish inside a cross-origin
      // frame the shell cannot inspect.
      if (details.statusCode >= 400) {
        console.log(`dsh-desktop: ${details.method} ${details.url} → ${details.statusCode}`)
      }
    })
    sess.webRequest.onErrorOccurred(filter, (details) => {
      console.log(`dsh-desktop: ${details.method ?? 'GET'} ${details.url} → ERROR ${details.error}`)
    })
  }

  pushStatus(status: BackendStatus): void {
    this.send('backend:status', status)
  }

  pushLog(line: string): void {
    this.send('backend:log', line)
  }

  /** Point the webview at the backend. Called once per connect attempt. */
  loadBackend(url: string, reused: boolean): void {
    this.send('backend:load', { url, reused })
  }

  reportFailure(message: string): void {
    this.send('backend:failed', { message })
  }

  /** The backend answered 401 on the index route: it needs a token exchange. */
  notifyAuthWall(): void {
    this.send('backend:authwall', null)
  }

  private send(channel: string, payload: unknown): void {
    if (this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }

  show(): void {
    if (this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
    // After hide/show cycles on software rendering (llvmpipe), the compositor
    // can present a stale all-black frame for the webview while the chrome is
    // fine. Forcing a full repaint clears it.
    this.win.webContents.invalidate()
  }

  /** Close for real — used by the tray's quit item. */
  destroy(): void {
    if (this.win.isDestroyed()) return
    this.forceClose = true
    this.win.close()
  }
}

export interface IpcHandlers {
  getWindow: () => ShellWindow | undefined
  onConnect(): void
  onRestartBackend(): void
  onStopBackend(): void
  onQuit(): void
  snapshot(): unknown
}

/** Renderer → main actions raised by the self-drawn title bar and skeleton. */
export function registerWindowIpc(handlers: IpcHandlers): void {
  const { ipcMain } = require('electron') as typeof import('electron')

  ipcMain.handle('shell:snapshot', () => handlers.snapshot())
  ipcMain.handle('shell:connect', () => {
    handlers.onConnect()
  })
  ipcMain.handle('shell:restart-backend', () => {
    handlers.onRestartBackend()
  })
  ipcMain.handle('shell:stop-backend', () => {
    handlers.onStopBackend()
  })
  ipcMain.handle('shell:quit', () => {
    handlers.onQuit()
  })
  ipcMain.handle('shell:window', (_event: IpcMainInvokeEvent, action: WindowAction) => {
    const win = handlers.getWindow()?.win
    if (win === undefined || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize())
    else win.hide()
  })
}
