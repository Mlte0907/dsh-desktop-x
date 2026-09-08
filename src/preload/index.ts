import { contextBridge, ipcRenderer } from 'electron'
import type { BackendStatus } from '../main/backend'

/**
 * State pulled once at startup. The connect result is deliberately absent: the
 * main process pushes it as a `load` event once the renderer is listening, so
 * the URL is never loaded twice.
 */
export interface ShellSnapshot {
  status: BackendStatus
  error: string | null
}

export interface ShellApi {
  /**
   * Current state, pulled once at startup. The main process begins probing the
   * backend before the renderer exists, so push events fired in that gap would
   * be lost; the snapshot closes it.
   */
  snapshot(): Promise<ShellSnapshot>
  /** Ask the main process to connect (or reconnect) and load the backend. */
  connect(): Promise<void>
  restartBackend(): Promise<void>
  stopBackend(): Promise<void>
  quit(): Promise<void>
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  onStatus(listener: (status: BackendStatus) => void): () => void
  onLog(listener: (line: string) => void): () => void
  onLoad(listener: (payload: { url: string; reused: boolean }) => void): () => void
  onFailed(listener: (payload: { message: string }) => void): () => void
  onAuthWall(listener: () => void): () => void
}

const api: ShellApi = {
  snapshot: () => ipcRenderer.invoke('shell:snapshot') as Promise<ShellSnapshot>,
  connect: () => ipcRenderer.invoke('shell:connect').then(() => undefined),
  restartBackend: () => ipcRenderer.invoke('shell:restart-backend').then(() => undefined),
  stopBackend: () => ipcRenderer.invoke('shell:stop-backend').then(() => undefined),
  quit: () => ipcRenderer.invoke('shell:quit').then(() => undefined),
  windowAction: (action) => ipcRenderer.invoke('shell:window', action).then(() => undefined),
  onStatus: (listener) => {
    const handler = (_event: unknown, status: BackendStatus): void => listener(status)
    ipcRenderer.on('backend:status', handler)
    return () => ipcRenderer.removeListener('backend:status', handler)
  },
  onLog: (listener) => {
    const handler = (_event: unknown, line: string): void => listener(line)
    ipcRenderer.on('backend:log', handler)
    return () => ipcRenderer.removeListener('backend:log', handler)
  },
  onLoad: (listener) => {
    const handler = (_event: unknown, payload: { url: string; reused: boolean }): void => listener(payload)
    ipcRenderer.on('backend:load', handler)
    return () => ipcRenderer.removeListener('backend:load', handler)
  },
  onFailed: (listener) => {
    const handler = (_event: unknown, payload: { message: string }): void => listener(payload)
    ipcRenderer.on('backend:failed', handler)
    return () => ipcRenderer.removeListener('backend:failed', handler)
  },
  onAuthWall: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('backend:authwall', handler)
    return () => ipcRenderer.removeListener('backend:authwall', handler)
  },
}

contextBridge.exposeInMainWorld('dshShell', api)
