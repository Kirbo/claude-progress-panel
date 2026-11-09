import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// A file URL becomes a path only through `fileURLToPath`. Its `.pathname` is `/C:/…` on Windows,
// which `resolve()` turns into `C:\C:\…` — the Windows CI failure of 2026-11-09 — while it passes
// on Linux and macOS, so only a scan catches it everywhere.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCANNED = ['scripts', 'hooks']
const PATTERN = /import\.meta\.url\)?\s*\)?\s*\.pathname|new URL\([^)]*import\.meta\.url\)\.pathname/

function sources(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(m?js|tsx?)$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

test('no file URL is turned into a path by its .pathname', () => {
  const offenders = SCANNED.flatMap(sources)
    .filter(f => !f.endsWith('file-urls.test.mjs')) // its own examples below
    .filter(f => PATTERN.test(readFileSync(join(ROOT, f), 'utf8')))
  assert.deepEqual(offenders, [])
})

test('the scan sees the mistake it guards against', () => {
  assert.ok(PATTERN.test("loadConfig(new URL('..', import.meta.url).pathname)"))
  assert.ok(!PATTERN.test("loadConfig(fileURLToPath(new URL('..', import.meta.url)))"))
  // What .pathname gives on Windows, and what fileURLToPath gives instead.
  assert.equal(new URL('file:///C:/runner/repo/').pathname, '/C:/runner/repo/')
  assert.equal(fileURLToPath('file:///C:/runner/repo/', { windows: true }), 'C:\\runner\\repo\\')
})
