#!/usr/bin/env node
/**
 * Copies non-TS assets into dist/ so the built app resolves them relative to
 * its own output tree:
 *
 *   build/tray-*.png   → dist/assets/   (systray icons)
 *   src/renderer/*     → dist/renderer/ (shell chrome, loaded via loadFile)
 */
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST = join(ROOT, 'dist')

await mkdir(join(DIST, 'assets'), { recursive: true })
// No filter: `cp`'s filter applies to directories too, and excluding the root
// would silently skip the entire tree.
await cp(join(ROOT, 'build'), join(DIST, 'assets'), { recursive: true })
await cp(join(ROOT, 'src', 'renderer'), join(DIST, 'renderer'), { recursive: true })

console.log('copy-assets: dist/assets + dist/renderer ready')
