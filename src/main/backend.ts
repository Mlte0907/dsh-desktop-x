import { EventEmitter } from 'node:events'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, readlink, stat, truncate, writeFile } from 'node:fs/promises'
import * as C from './config'
import { entryUrlOpens, probeBackend } from './net'

export type BackendPhase = 'idle' | 'probing' | 'starting' | 'online' | 'offline' | 'error'

/** Who owns the running backend — decides how it may be stopped or restarted. */
export type Ownership = 'none' | 'desktop' | 'systemd' | 'external'

export interface BackendStatus {
  phase: BackendPhase
  ownership: Ownership
  detail: string
  pid?: number
  /** Epoch ms the current backend process was observed started. */
  since?: number
}

export interface ConnectOutcome {
  /** URL to load in the shell's webview. */
  url: string
  /** True when a backend was already listening and was reused as-is. */
  reused: boolean
  ownership: Ownership
  /** False when the request hit the auth wall and still needs a token. */
  authorized: boolean
}

/** Emitted: `status` — status changed; `log` — a line of backend output. */
export declare interface BackendManager {
  on(event: 'status', listener: (status: BackendStatus) => void): this
  on(event: 'log', listener: (line: string) => void): this
  emit(event: 'status', status: BackendStatus): boolean
  emit(event: 'log', line: string): boolean
}

function systemctl(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile('systemctl', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : 1, output: `${stdout ?? ''}${stderr ?? ''}`.trim() })
    })
  })
}

async function systemdUnitEnabled(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  try {
    const { code } = await systemctl(['--user', 'is-enabled', C.SYSTEMD_UNIT])
    return code === 0
  } catch {
    return false
  }
}

async function systemdUnitActive(): Promise<boolean> {
  try {
    const { code } = await systemctl(['--user', 'is-active', C.SYSTEMD_UNIT])
    return code === 0
  } catch {
    return false
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Whether `pid` still belongs to a `dsh web` backend.
 *
 * The state file persists a bare pid across app restarts, and pids get reused;
 * without this check a stop could SIGTERM an unrelated process that happened
 * to inherit the number. On non-Linux (no /proc) the check degrades to
 * pidAlive() alone.
 */
function isDshBackendPid(pid: number): boolean {
  if (process.platform !== 'linux') return true
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmdline.includes('bin.js') && cmdline.includes('web')
  } catch {
    return false
  }
}

async function tailText(file: string, bytes: number): Promise<string> {
  const { size } = await stat(file)
  const start = Math.max(0, size - bytes)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    createReadStream(file, { start, end: size - 1 })
      .on('data', (chunk: string | Buffer) =>
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
      )
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject)
  })
}

/**
 * Log files a running `dsh web` process is writing its stdout to, discovered
 * through /proc.
 *
 * A backend started by hand (`nohup dsh web > somewhere.log &`) prints its
 * token URL once and never repeats it. Without this scan, the only way to
 * authorise against such a backend would be to restart it — which would
 * interrupt whatever it is doing. Reading where its stdout already goes gets
 * the token without touching the process.
 */
async function backendProcessLogFiles(): Promise<string[]> {
  if (process.platform !== 'linux') return []
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const files = new Set<string>()
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8')
      if (!cmdline.includes('bin.js') || !cmdline.includes('web')) continue
      const target = await readlink(`/proc/${entry}/fd/1`)
      if (!target.startsWith('/') || target.startsWith('/dev/') || target.startsWith('/proc/')) continue
      files.add(target)
    } catch {
      /* process exited, or a pid we may not inspect */
    }
  }
  return [...files]
}

/** Most recent `dsh web: <url>` line in one log file. */
async function lastUrlIn(file: string): Promise<string | undefined> {
  let text: string
  try {
    text = await tailText(file, C.LOG_TAIL_BYTES)
  } catch {
    return undefined
  }
  const matches = text.match(/^dsh web: (\S+)/gm)
  const last = matches?.at(-1)
  return last?.slice('dsh web: '.length).trim()
}

/**
 * Candidate token URLs, best first: the shell's own log (written by both the
 * shell and the systemd unit), then whatever files running backends are
 * currently streaming to.
 *
 * Tokens are per-process, so every candidate is re-validated against the live
 * server by the caller before use.
 */
async function recoverEntryUrls(): Promise<string[]> {
  const files = [C.BACKEND_LOG, ...(await backendProcessLogFiles())]
  const urls: string[] = []
  for (const file of files) {
    const url = await lastUrlIn(file)
    if (url !== undefined && !urls.includes(url)) urls.push(url)
  }
  return urls
}

async function readState(): Promise<{ pid: number; url: string; startedAt: number } | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(C.BACKEND_STATE, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { pid, url, startedAt } = parsed as Record<string, unknown>
    if (typeof pid !== 'number' || typeof url !== 'string') return undefined
    return { pid, url, startedAt: typeof startedAt === 'number' ? startedAt : Date.now() }
  } catch {
    return undefined
  }
}

export class BackendManager extends EventEmitter {
  private status: BackendStatus = { phase: 'idle', ownership: 'none', detail: '未连接' }
  private boot: Promise<ConnectOutcome> | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private logChain: Promise<void> = Promise.resolve()
  private lastLogLine = ''

  getStatus(): BackendStatus {
    return this.status
  }

  private setStatus(patch: Partial<BackendStatus>): void {
    const next: BackendStatus = { ...this.status, ...patch }
    const changed =
      next.phase !== this.status.phase ||
      next.ownership !== this.status.ownership ||
      next.detail !== this.status.detail ||
      next.pid !== this.status.pid
    this.status = next
    if (changed) this.emit('status', next)
  }

  private queueLog(text: string): void {
    this.logChain = this.logChain
      .then(async () => {
        await mkdir(C.STATE_DIR, { recursive: true })
        await appendFile(C.BACKEND_LOG, text, 'utf8')
      })
      .catch(() => undefined)
  }

  /** Surface one meaningful backend line (the URL line) to the UI as it appears. */
  private relayLog(text: string): void {
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim()
      if (line === '' || line === this.lastLogLine) continue
      this.lastLogLine = line
      this.emit('log', line)
    }
  }

  private async pruneLog(): Promise<void> {
    try {
      const { size } = await stat(C.BACKEND_LOG)
      if (size <= C.LOG_MAX_BYTES) return
      const keep = await tailText(C.BACKEND_LOG, Math.floor(C.LOG_MAX_BYTES / 2))
      await writeFile(C.BACKEND_LOG, keep, 'utf8')
    } catch {
      /* no log yet — nothing to prune */
    }
  }

  /**
   * Ensure a backend is reachable and return the URL to load.
   *
   * Order matters: an already-running backend is reused untouched (no restart,
   * no token exchange), and only a silent port triggers a launch. Concurrent
   * callers share one launch.
   */
  connect(): Promise<ConnectOutcome> {
    this.boot ??= this.doConnect().finally(() => {
      this.boot = undefined
    })
    return this.boot
  }

  private async doConnect(): Promise<ConnectOutcome> {
    await this.pruneLog()

    this.setStatus({ phase: 'probing', ownership: 'none', detail: '正在检测后端…' })
    const probe = await probeBackend(C.BACKEND_BASE_URL, C.PROBE_TIMEOUT_MS)

    if (probe.kind === 'online') {
      const ownership = await this.detectOwnership()
      const url = await this.bestEntryUrl()
      this.setStatus({
        phase: 'online',
        ownership,
        detail: ownership === 'external' ? '已连接（外部后端）' : '已连接',
        since: Date.now(),
      })
      this.startPolling()
      return { url, reused: true, ownership, authorized: probe.authorized }
    }

    this.setStatus({ phase: 'starting', ownership: 'none', detail: '正在启动后端…' })
    const useSystemd = await systemdUnitEnabled()

    if (useSystemd) {
      const { code, output } = await systemctl(['--user', 'start', C.SYSTEMD_UNIT])
      if (code !== 0) {
        this.setStatus({ phase: 'error', detail: `systemd 启动失败：${output}` })
        throw new Error(`dsh-desktop: systemctl start failed: ${output}`)
      }
      await this.waitForOnline(C.BACKEND_BOOT_TIMEOUT_MS)
    } else {
      await this.spawnBackend()
    }

    const url = await this.bestEntryUrl()
    const probeAfter = await probeBackend(C.BACKEND_BASE_URL, C.PROBE_TIMEOUT_MS)
    this.setStatus({
      phase: 'online',
      ownership: useSystemd ? 'systemd' : 'desktop',
      detail: '后端已就绪',
      since: Date.now(),
    })
    this.startPolling()
    return {
      url,
      reused: false,
      ownership: useSystemd ? 'systemd' : 'desktop',
      authorized: probeAfter.kind === 'online' && probeAfter.authorized,
    }
  }

  private async detectOwnership(): Promise<Ownership> {
    const state = await readState()
    if (state !== undefined && pidAlive(state.pid)) return 'desktop'
    if (await systemdUnitActive()) return 'systemd'
    return 'external'
  }

  /**
   * Prefer a validated token URL (it mints a fresh cookie); fall back to the
   * bare origin, which works on its own once a cookie already exists.
   */
  private async bestEntryUrl(): Promise<string> {
    for (const candidate of await recoverEntryUrls()) {
      if (await entryUrlOpens(candidate, C.ENTRY_URL_CHECK_TIMEOUT_MS)) return candidate
    }
    return C.BACKEND_BASE_URL
  }

  private async spawnBackend(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const child = spawn(C.NODE_BIN, [C.CLI_BIN, 'web', '--no-open'], {
        // Session history is grouped by this directory; the user's own
        // sessions live under their home, not the checkout.
        cwd: C.BACKEND_CWD,
        env: { ...process.env, DSH_HOME: C.DSH_HOME },
        // Detached puts the backend in its own process group; unref() drops it
        // from this event loop. Together they are what let the backend outlive
        // the window and the app itself.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`dsh-desktop: backend did not become ready within ${C.BACKEND_BOOT_TIMEOUT_MS}ms`)))
      }, C.BACKEND_BOOT_TIMEOUT_MS)

      let buffered = ''
      const consume = (chunk: string): void => {
        this.queueLog(chunk)
        this.relayLog(chunk)
        buffered += chunk
        // The URL line arrives after the whole plugin tree settles; the
        // harness prints a lot before it, so keep only a rolling window.
        if (buffered.length > 65536) buffered = buffered.slice(-8192)
        const match = /^dsh web: (\S+)/m.exec(buffered)
        if (match?.[1] !== undefined) finish(() => resolve(match[1]))
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', consume)
      let stderrTail = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.queueLog(chunk)
        this.relayLog(chunk)
        stderrTail = (stderrTail + chunk).slice(-2000)
      })

      child.on('error', (error: Error) => {
        finish(() => {
          this.setStatus({ phase: 'error', detail: `无法启动后端：${error.message}` })
          reject(error)
        })
      })
      child.on('exit', (code: number | null) => {
        finish(() => {
          const reason = stderrTail.trim() === '' ? `退出码 ${String(code)}` : stderrTail.trim().split(/\r?\n/u).at(-1)
          this.setStatus({ phase: 'error', detail: `后端启动失败：${reason ?? '未知原因'}` })
          reject(new Error(`dsh-desktop: backend exited during startup (${reason ?? 'unknown'})`))
        })
      })

      child.unref()
      // Ownership is recorded as a pid, not a handle: after an app restart the
      // handle is gone but the backend is (deliberately) still running.
      void this.persistState(child.pid)
    })
  }

  private async persistState(pid: number | undefined): Promise<void> {
    if (pid === undefined) return
    try {
      await mkdir(C.STATE_DIR, { recursive: true })
      await writeFile(
        C.BACKEND_STATE,
        `${JSON.stringify({ pid, url: C.BACKEND_BASE_URL, startedAt: Date.now() }, null, 2)}\n`,
        'utf8',
      )
      this.setStatus({ pid })
    } catch {
      /* state is an optimisation; a missing file only costs pid-scoped stop */
    }
  }

  private async waitForOnline(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const probe = await probeBackend(C.BACKEND_BASE_URL, C.PROBE_TIMEOUT_MS)
      if (probe.kind === 'online') return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    this.setStatus({ phase: 'error', detail: '等待后端就绪超时' })
    throw new Error('dsh-desktop: timed out waiting for the backend to accept connections')
  }

  /** Background liveness check so the tray reflects reality, not optimism. */
  private startPolling(): void {
    if (this.pollTimer !== undefined) return
    this.pollTimer = setInterval(() => {
      void this.refresh().catch(() => undefined)
    }, C.HEALTH_POLL_INTERVAL_MS)
  }

  async refresh(): Promise<BackendStatus> {
    const probe = await probeBackend(C.BACKEND_BASE_URL, C.PROBE_TIMEOUT_MS)
    if (probe.kind === 'online') {
      const ownership = await this.detectOwnership()
      const wasDown = this.status.phase !== 'online'
      this.setStatus({
        phase: 'online',
        ownership,
        detail: '后端在线',
        since: wasDown ? Date.now() : this.status.since,
      })
    } else {
      this.setStatus({
        phase: 'offline',
        ownership: 'none',
        detail: probe.kind === 'offline' ? '后端未运行' : (probe.message ?? '后端不可达'),
        pid: undefined,
      })
      // Keep polling through the outage: an external restart (plugin market
      // update, `systemctl --user restart`, another agent) is the common way
      // this backend comes back, and clearing the timer here used to strand
      // the shell on the manual-launch page until the user clicked through.
    }
    return this.status
  }

  /** Stop a backend this shell can account for. Never kills an unrelated process on the port. */
  async stop(): Promise<void> {
    this.stopPolling()
    const state = await readState()
    if (state !== undefined && pidAlive(state.pid) && isDshBackendPid(state.pid)) {
      try {
        // Signal the backend process alone. A process-group kill (-pid) would
        // also take out every child the agent spawned mid-task — shells,
        // builds, whatever is running — which is exactly how the previous
        // shell once took a whole desktop session down with it. `dsh web`
        // handles SIGTERM itself with a 5s dispose window.
        process.kill(state.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    if (await systemdUnitActive()) await systemctl(['--user', 'stop', C.SYSTEMD_UNIT])
    await this.pruneLog()
    this.setStatus({ phase: 'offline', ownership: 'none', detail: '后端已停止', pid: undefined })
  }

  async restart(): Promise<ConnectOutcome> {
    await this.stop()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await this.clearOwnedState()
    return this.connect()
  }

  /** Forget any backend record so a reconnect path re-owns it. */
  private async clearOwnedState(): Promise<void> {
    try {
      await truncate(C.BACKEND_STATE)
    } catch {
      /* nothing recorded */
    }
  }

  stopPolling(): void {
    if (this.pollTimer === undefined) return
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }
}
