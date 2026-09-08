import { Menu, Tray, app, nativeImage } from 'electron'
import { join } from 'node:path'
import type { BackendStatus } from './backend'

export interface TrayHandlers {
  onOpen(): void
  onOpenLog(): void
  onRestartBackend(): void
  onStopBackend(): void
  onQuit(): void
}

const ICONS = {
  online: 'tray-online.png',
  starting: 'tray-starting.png',
  error: 'tray-error.png',
  offline: 'tray-offline.png',
} as const

const LABELS: Record<BackendStatus['phase'], string> = {
  idle: '未连接',
  probing: '检测中',
  starting: '启动中',
  online: '在线',
  offline: '离线',
  error: '异常',
}

const OWNERSHIP_LABELS: Record<BackendStatus['ownership'], string> = {
  none: '',
  desktop: '桌面托管',
  systemd: 'systemd',
  external: '外部进程',
}

function iconFor(phase: BackendStatus['phase']): string {
  if (phase === 'online') return ICONS.online
  if (phase === 'starting' || phase === 'probing') return ICONS.starting
  if (phase === 'error') return ICONS.error
  return ICONS.offline
}

/**
 * Tray presence. This is the app's answer to "close the window": the window
 * hides, this stays, and it reports backend health so the state of a process
 * the user cannot see is never a guess.
 */
export class ShellTray {
  private readonly tray: Tray
  private status: BackendStatus = { phase: 'idle', ownership: 'none', detail: '未连接' }

  constructor(private readonly handlers: TrayHandlers) {
    this.tray = new Tray(nativeImage.createFromPath(join(__dirname, '..', 'assets', iconFor('offline'))))
    this.tray.setToolTip('DeepSeek Harness')
    // On XFCE a plain click reports to the shell; the context menu remains the
    // primary surface, so both are wired up.
    this.tray.on('click', () => this.handlers.onOpen())
    this.render()
  }

  update(status: BackendStatus): void {
    this.status = status
    this.render()
  }

  private render(): void {
    const { phase, ownership, detail } = this.status
    this.tray.setImage(nativeImage.createFromPath(join(__dirname, '..', 'assets', iconFor(phase))))

    const ownershipLabel = OWNERSHIP_LABELS[ownership]
    const summary = ownershipLabel === '' ? LABELS[phase] : `${LABELS[phase]} · ${ownershipLabel}`
    this.tray.setToolTip(`DeepSeek Harness · 后端${summary}`)

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开 DeepSeek Harness', click: () => this.handlers.onOpen() },
        { type: 'separator' },
        { label: `后端：${summary}`, enabled: false },
        { label: detail === '' ? '—' : detail, enabled: false },
        { type: 'separator' },
        { label: '重新连接', click: () => this.handlers.onOpen() },
        { label: '打开后端日志', click: () => this.handlers.onOpenLog() },
        { label: '重启后端', click: () => this.handlers.onRestartBackend() },
        { label: '停止后端', click: () => this.handlers.onStopBackend() },
        { type: 'separator' },
        {
          // The escape hatch for tight memory: the whole Electron tree (~395MB
          // PSS here) goes away, and the systemd backend keeps serving. Next
          // launch reuses it — sub-second, no token exchange.
          label: '退出前端并释放内存（后端继续运行）',
          click: () => this.handlers.onQuit(),
        },
      ]),
    )
  }

  destroy(): void {
    this.tray.destroy()
  }
}

/** Guard for environments without a systray: the window still works without it. */
export function traySupported(): boolean {
  return process.platform !== 'darwin' || app.isReady()
}
