import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'

export interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

export interface RequestOptions {
  method?: 'GET' | 'HEAD'
  timeoutMs?: number
}

/** True for errors that mean "nothing is listening here", as opposed to a fault. */
export function isUnreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND'
}

/**
 * One HTTP request with no redirect following. Redirects are the signal here:
 * `303` means the backend minted an auth cookie, `200` means a cached cookie
 * was accepted, and `401` means neither.
 */
export function request(target: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const { method = 'GET', timeoutMs = 2000 } = options
  return new Promise((resolve, reject) => {
    let url: URL
    try {
      url = new URL(target)
    } catch {
      reject(new Error(`dsh-desktop-x: not a URL: ${target}`))
      return
    }
    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { accept: 'text/html,*/*', 'user-agent': 'dsh-desktop-x/0.1' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error(`dsh-desktop-x: request to ${target} timed out`)))
    req.on('error', reject)
    req.end()
  })
}

/**
 * Outcome of a backend liveness check against `/`.
 *
 * The index route answers `401` to an unauthenticated caller *after* the
 * server is fully up, so `401` is a positive "alive" signal, not a failure —
 * this is what lets the shell tell "backend running, needs a token" apart from
 * "backend not running" without any dedicated health endpoint.
 */
export type ProbeResult =
  | { kind: 'online'; authorized: boolean; status: number }
  | { kind: 'offline' }
  | { kind: 'unreachable'; message: string }

export async function probeBackend(baseUrl: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const res = await request(baseUrl, { method: 'GET', timeoutMs })
    if (res.status === 200) return { kind: 'online', authorized: true, status: res.status }
    if (res.status === 401) return { kind: 'online', authorized: false, status: res.status }
    return { kind: 'online', authorized: false, status: res.status }
  } catch (error) {
    if (isUnreachable(error)) return { kind: 'offline' }
    return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether `url` would be served the app rather than bounced at the auth wall.
 * `303` (token accepted, cookie minted) and `200` (cookie accepted) both pass.
 */
export async function entryUrlOpens(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await request(url, { method: 'GET', timeoutMs })
    return res.status === 200 || res.status === 303
  } catch {
    return false
  }
}
