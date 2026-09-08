import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Every location the shell depends on is absolute. A process launched from an
 * XFCE `.desktop` entry inherits almost no PATH, so nothing here may rely on
 * `node` or `dsh` being resolvable by name.
 */

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** Checkout of deepseek-harness this shell wraps. */
export const HARNESS_ROOT = resolve(env('DSH_HARNESS_ROOT', '/home/xiaoxin/deepseek-harness'))

/** Built `dsh` entry point (`@deepseek-ai/dsh` → bin.dsh). */
export const CLI_BIN = join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js')

/** Node interpreter. Pinned: the harness needs the toolchain that built it. */
export const NODE_BIN = env('DSH_NODE_BIN', '/home/xiaoxin/.hermes/node/bin/node')

/**
 * Working directory for the spawned backend. Session history is grouped by
 * the directory the backend runs in (`~/.dsh/sessions/--home-xiaoxin--/...`),
 * so this must match where the user's own `dsh web` habit runs from — the
 * checkout would give the shell a brand-new, empty history.
 */
export const BACKEND_CWD = resolve(env('DSH_BACKEND_CWD', homedir()))

/**
 * Harness home. Must match the backend's: the `/api` browser cookie is signed
 * with a secret persisted in this directory's credential store, so a shell and
 * a backend using different homes can never authenticate each other.
 */
export const DSH_HOME = resolve(env('DSH_HOME', join(homedir(), '.dsh')))

/** Shell-owned state, deliberately kept out of the harness's own directories. */
export const STATE_DIR = join(DSH_HOME, 'desktop')

/**
 * Backend stdout, appended by whoever started it — the desktop shell appends
 * directly, and the systemd unit declares `StandardOutput=append:` onto this
 * same file. It is the one channel that survives every launch path, which is
 * what makes the `dsh web: <url>` token line recoverable for a backend this
 * process did not spawn.
 */
export const BACKEND_LOG = join(STATE_DIR, 'backend.log')

/** Last backend instance this shell spawned, for pid-scoped stop/restart. */
export const BACKEND_STATE = join(STATE_DIR, 'backend.json')

/** systemd user unit name (see scripts/install-system.sh). */
export const SYSTEMD_UNIT = 'dsh-desktop-x.service'

export const BACKEND_HOST = env('DSH_WEB_HOST', '127.0.0.1')

/**
 * Fixed port, on purpose. The browser cookie is authority-bound, so an
 * OS-assigned port would invalidate it on every restart and force a token
 * exchange each time — which is impossible for a backend we did not spawn.
 */
export const BACKEND_PORT = Number.parseInt(env('DSH_WEB_PORT', '3080'), 10)

export const BACKEND_BASE_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`

/**
 * Persistent session partition. Holds the 30-day `/api` cookie across app
 * restarts so a reconnect costs one request instead of a token exchange.
 */
export const SESSION_PARTITION = 'persist:dsh'

/** Unauthenticated text the backend returns on 401; used to detect an auth wall. */
export const AUTH_WALL_MARKER = 'authentication required'

export const PROBE_TIMEOUT_MS = 1500
export const ENTRY_URL_CHECK_TIMEOUT_MS = 2500
export const BACKEND_BOOT_TIMEOUT_MS = 180_000
export const HEALTH_POLL_INTERVAL_MS = 5000

/** Bytes of backend log re-read when hunting for the most recent token URL. */
export const LOG_TAIL_BYTES = 256 * 1024

/** Backend log is truncated to this size once it grows past the cap. */
export const LOG_MAX_BYTES = 4 * 1024 * 1024
