import { app, globalShortcut, session, shell as electronShell } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BackendManager } from './backend'
import type { BackendStatus, ConnectOutcome } from './backend'
import { ShellWindow, registerWindowIpc, markQuitting } from './window'
import { ShellTray } from './tray'
import * as C from './config'

// Electron modules are only available at runtime, not at build time.
// The `require('electron')` call in Node.js returns the path to the
// Electron executable, not the Electron modules. We need to use the
// `electron` module only at runtime.
const _electron = require('electron')

const backend = new BackendManager()

/**
 * Crash output lands in a file, not just the launching terminal: the usual
 * failure mode here is a double-clicked `.desktop` entry whose stdout goes to
 * nowhere, and a vanished process with no stack is undiagnosable.
 */
function logCrash(kind: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`
  try {
    mkdirSync(C.STATE_DIR, { recursive: true })
    appendFileSync(join(C.STATE_DIR, 'shell.log'), line, 'utf8')
  } catch {
    /* nowhere left to write; stderr is all that remains */
  }
  console.error(line)
}

process.on('uncaughtException', (error) => logCrash('uncaughtException', error))
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))

let shell: ShellWindow | undefined
let tray: ShellTray | undefined

let lastError: string | null = null

/**
 * Load events are pushed only after the renderer is listening. The backend
 * probe starts before the window exists, so an early result is held here and
 * released on the renderer's first snapshot request — otherwise the first
 * connect would either be dropped or applied twice.
 */
let rendererReady = false
let pendingDelivery: ConnectOutcome | null = null
let notifiedUrl: string | null = null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pushStatus(status: BackendStatus): void {
  shell?.pushStatus(status)
  tray?.update(status)
}

function deliver(outcome: ConnectOutcome): void {
  if (!rendererReady) {
    pendingDelivery = outcome
    return
  }
  if (notifiedUrl === outcome.url) return
  notifiedUrl = outcome.url
  shell?.loadBackend(outcome.url, outcome.reused)
}

/**
 * Begin a connect.
 *
 * `notify` distinguishes the two callers: the startup probe (silent — the
 * renderer picks the result up via its snapshot) from an explicit user retry
 * (which must always reach the UI, even if nothing changed).
 */
async function ensureConnected(notify: boolean): Promise<void> {
  lastError = null
  try {
    const outcome = await backend.connect()
    // A user retry must reach the UI even if the URL is unchanged, so its
    // dedupe key is cleared first.
    if (notify) notifiedUrl = null
    deliver(outcome)
  } catch (error) {
    lastError = errorMessage(error)
    if (notify) shell?.reportFailure(lastError)
  }
}

async function restartBackend(): Promise<void> {
  lastError = null
  notifiedUrl = null
  try {
    deliver(await backend.restart())
  } catch (error) {
    lastError = errorMessage(error)
    shell?.reportFailure(lastError)
  }
}

async function stopBackend(): Promise<void> {
  await backend.stop()
  notifiedUrl = null
}

function markRendererReady(): void {
  if (rendererReady) return
  rendererReady = true
  const pending = pendingDelivery
  pendingDelivery = null
  if (pending !== null) deliver(pending)
}

/**
 * Toggle the window.
 *
 * A hidden window with no tray (XFCE ships only the XEmbed systray item by
 * default, which cannot render Electron's StatusNotifierItem) would otherwise
 * be unreachable — no taskbar entry, no tray icon. The shortcut is the
 * backstop that makes hide-to-tray safe on such a setup.
 */
function toggleWindow(): void {
  if (shell === undefined || shell.win.isDestroyed()) return
  if (shell.win.isVisible()) {
    if (shell.win.isFocused()) {
      console.log('dsh-desktop: toggle → hide (was visible+focused)')
      shell.win.hide()
    } else {
      console.log('dsh-desktop: toggle → focus (visible, not focused)')
      shell.show()
    }
    return
  }
  console.log('dsh-desktop: toggle → show (was hidden)')
  shell.show()
}

function registerShortcut(): void {
  // Not Ctrl+Alt+D: XFCE binds that to show-desktop.
  const accelerator = process.env.DSH_TOGGLE_ACCEL ?? 'Super+Shift+D'
  if (globalShortcut.register(accelerator, toggleWindow)) {
    console.log(`dsh-desktop: toggle shortcut ${accelerator}`)
    return
  }
  console.warn(`dsh-desktop: could not register ${accelerator}; set DSH_TOGGLE_ACCEL to another binding`)
}

function quit(): void {
  // The backend is detached on purpose and is never terminated here: closing
  // the frontend must not interrupt running work.
  backend.stopPolling()
  tray?.destroy()
  shell?.destroy()
  // exit(), not quit(): the quit() cascade re-enters the window's close path —
  // the very path that hides to tray — and on this X11 setup it stalls with the
  // whole process tree left behind. exit() terminates now and reaps children.
  app.exit(0)
}

async function boot(): Promise<void> {
  // Hardware acceleration is OFF by default. This host (and any other without
  // a real GPU) falls back to llvmpipe, and the llvmpipe compositor black-screens
  // the <webview> after a restart while the local chrome keeps painting — the
  // remote page never comes back. Pure software rendering is stable here and
  // also drops the ~98MB GPU process. Set DSH_ENABLE_GPU=1 on a machine with a
  // working GPU to turn acceleration back on.
  if (process.env.DSH_ENABLE_GPU !== '1') app.disableHardwareAcceleration()

  await app.whenReady()

  // A `persist:` partition is what keeps the 30-day `/api` cookie on disk, so a
  // later launch reconnects with one request instead of a token exchange.
  session.fromPartition(C.SESSION_PARTITION)

  registerWindowIpc({
    getWindow: () => shell,
    onConnect: () => void ensureConnected(true),
    onRestartBackend: () => void restartBackend(),
    onStopBackend: () => void stopBackend(),
    onQuit: quit,
    snapshot: () => {
      markRendererReady()
      return { status: backend.getStatus(), error: lastError }
    },
  })

  backend.on('status', pushStatus)
  backend.on('log', (line) => shell?.pushLog(line))

  // Start the backend probe first and let it run while the window is built:
  // a cold boot costs ~5s, and this is the only way that time is not also
  // added to time-to-first-paint.
  const connecting = ensureConnected(false)

  // Background mode: skip window and tray creation, just run backend
  if (process.env.DSH_BACKGROUND_MODE === '1') {
    console.log('dsh-desktop: background mode enabled, skipping UI')
    // Register shortcut even in background mode (optional, for wake-up)
    if (process.env.DSH_ENABLE_SHORTCUT !== '0') {
      registerShortcut()
    }
    await connecting
    return
  }

  shell = await ShellWindow.create()
  shell.watchWebview(() => {
    console.log('dsh-desktop: backend answered 401 — a token exchange is required')
    shell?.notifyAuthWall()
  })

  registerShortcut()

  try {
    tray = new ShellTray({
      onOpen: () => shell?.show(),
      onOpenLog: () => void electronShell.openPath(C.BACKEND_LOG),
      onRestartBackend: () => void restartBackend(),
      onStopBackend: () => void stopBackend(),
      onQuit: quit,
    })
    tray.update(backend.getStatus())
  } catch (error) {
    // No systray (some X11 sessions): the window alone is still fully usable.
    console.warn('dsh-desktop: tray unavailable:', errorMessage(error))
  }

  await connecting
}

const acquiredLock = _electron.app.requestSingleInstanceLock()

if (!acquiredLock) {
  // A second launch is a request to show the existing window, not a new app.
  // The first instance receives `second-instance` with this instance's argv
  // (Electron dispatches it when the lock fails), so it handles `--quit` itself
  // and all this instance has to do is get out of the way.
  //
  // exit(0), not quit(): this branch runs synchronously at module top level,
  // before app.whenReady() — and quit() before ready is a no-op on this
  // platform. That left the caller alive (11 lingering processes) and, worse,
  // promoted it into the live frontend. exit() terminates immediately.
  // No teardown needed: boot() only runs in the locked branch, so this
  // instance has created no window, tray, or backend poller yet.
  _electron.app.exit(0)
} else {
  _electron.app.on('second-instance', (_event: unknown, argv: string[]) => {
    // `electron . --quit` from another shell is the one reliable way to end
    // the app from outside the GUI: SIGTERM is swallowed by Chromium's own
    // handler on this platform, which merely hides the window and stalls.
    if (argv.some((arg: string) => arg === '--quit')) {
      quit()
      return
    }
    shell?.show()
  })

  // Hiding the window is the normal close path; only the tray's quit ends the
  // process, and the backend outlives both. Merely subscribing here suppresses
  // Electron's default quit-on-last-window-close.
  _electron.app.on('window-all-closed', () => {})

  _electron.app.on('before-quit', () => {
    // Chromium's SIGTERM handling enters here before closing windows; flag it
    // so the window's close handler lets the process actually die.
    markQuitting()
    backend.stopPolling()
    globalShortcut.unregisterAll()
  })

  // Without this, SIGTERM (systemd stop, kill, logout) closes the window, the
  // close handler hides it instead, and the app silently survives — an
  // unkillable 400MB ghost. The tray's quit item routes through the same
  // quit(), so behaviour stays identical.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => quit())
  }

  _electron.app.on('activate', () => {
    shell?.show()
  })


  void boot().catch((error: unknown) => {
    console.error('dsh-desktop: fatal', errorMessage(error))
    _electron.app.quit()
  })
}
