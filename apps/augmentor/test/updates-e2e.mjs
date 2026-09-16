// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// 0.1.30 (Phase 1) — in-place update path, pipe side, end to end.
//
// A. LIVE pipe (the real repo, the real DSH app):
//    - updates/check: live values from npm + GitHub releases + the plugin
//      handshake; shape + cross-field consistency (the asset URL must be the
//      canonical one for the reported latest version).
//    - updates/download allowlist: a non-canonical URL, a malformed version,
//      and a cross-version URL are all refused BEFORE any fetch (the URL
//      policy is pipe-side, because the panel renders hostile content).
// B. SCRATCH copy (mechanism proof, hermetic):
//    - a fake OLD state (manifest pinned to 0.0.1)
//    - a real updates/download of the latest GitHub release asset
//    - every zip entry verified byte-identical on disk afterwards
//    - a SECOND pipe spawn from the scratch reports the NEW version —
//      the proof that the next spawn runs the new pipe code (which is how an
//      in-place update activates: the extension reload spawns a fresh host).
//
// The plugin-side legs (update-status / update-plugin version refusal) live
// in plugin/tests/boot/run.sh (leg 7) — they need a token-gated WS and the
// boot test already owns that composition.
//
// Repo home: augmentor/test/updates-e2e.mjs.
// Env: DSH_BASE (default http://127.0.0.1:3080), UPDATES_E2E_VERSION
//      (pin the download version; default = the latest release's).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { encode, decode } from '../wire.mjs'

const AUG = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BASE = (process.env.DSH_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const REPO = 'ManoloRemiddi/augmentor-dsh-extension-plugin'
const SEMVER = /^\d+\.\d+\.\d+$/
const CANONICAL = (ver) =>
  `https://github.com/${REPO}/releases/download/v${ver}/augmentor-${ver}-dist.zip`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const ok = (name) => {
  passed++
  console.log(`PASS: ${name}`)
}
const fail = (name, extra) => {
  console.log(`FAIL: ${name}${extra ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)
  process.exit(1)
}

/** Drive a pipe.mjs the way the extension's native port does (frames over stdio). */
class PipeClient {
  constructor(dir, env = {}) {
    this.child = spawn(process.execPath, [path.join(dir, 'pipe.mjs')], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    this.buf = Buffer.alloc(0)
    this.err = ''
    this.seq = 0
    this.waiters = new Map()
    this.child.stdout.on('data', (d) => this._onData(d))
    this.child.stderr.on('data', (d) => {
      this.err += d.toString('utf8')
    })
    this.child.on('exit', (code) => {
      for (const w of this.waiters.values()) w.reject(new Error(`pipe exited (code ${code})`))
      this.waiters.clear()
    })
  }
  stderrText() {
    return this.err
  }
  _onData(d) {
    this.buf = Buffer.concat([this.buf, d])
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0)
      if (this.buf.length < 4 + len) break
      const frame = decode(this.buf.subarray(4, 4 + len).toString('utf8'))
      this.buf = this.buf.subarray(4 + len)
      if (frame && frame.id !== undefined && frame.method === undefined) {
        const w = this.waiters.get(frame.id)
        if (w) {
          this.waiters.delete(frame.id)
          w.resolve(frame)
        }
      }
    }
  }
  request(method, params, timeoutMs = 60000) {
    const id = `ue-${++this.seq}`
    return new Promise((resolve, reject) => {
      const to = setTimeout(
        () => {
          this.waiters.delete(id)
          reject(new Error(`${method} timed out after ${timeoutMs}ms`))
        },
        timeoutMs,
      )
      this.waiters.set(id, {
        resolve: (f) => {
          clearTimeout(to)
          resolve(f)
        },
        reject: (e) => {
          clearTimeout(to)
          reject(e)
        },
      })
      // NMH framing: 4-byte little-endian length prefix + JSON payload.
      // (Chrome's port.postMessage does this for the extension; a raw
      // stdio driver must do it itself — the pipe decodes the prefix.)
      const json = encode({ id, method, params })
      const buf = Buffer.alloc(4 + Buffer.byteLength(json, 'utf8'))
      buf.writeUInt32LE(Buffer.byteLength(json, 'utf8'), 0)
      buf.write(json, 4, 'utf8')
      this.child.stdin.write(buf)
    })
  }
  close() {
    try {
      this.child.stdin.end()
    } catch {
      /* already closed */
    }
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already dead */
    }
  }
}

// ---------------------------------------------------- A. live pipe (real repo)
const live = new PipeClient(AUG, { DSH_AUGMENTOR_URL: BASE })
try {
  // A1: updates/check — live values, each source degrading independently.
  const r = await live.request('updates/check', { extension: '0.1.29' })
  const v = r.result
  if (!v) fail('updates/check', r.error?.message ?? r)
  if (!SEMVER.test(v.installed?.pipe ?? '')) fail('check.installed.pipe', v.installed)
  if (v.installed?.extension !== '0.1.29') fail('check.installed.extension echo', v.installed)
  for (const [name, val] of [
    ['latest.plugin', v.latest?.plugin],
    ['latest.extension', v.latest?.extension],
    ['installed.plugin', v.installed?.plugin],
    ['installed.pipeDisk', v.installed?.pipeDisk],
  ]) {
    if (val != null && !SEMVER.test(val)) fail(`check.${name} is semver`, val)
  }
  if (v.latest?.extension && v.latest?.extAssetUrl) {
    if (v.latest.extAssetUrl !== CANONICAL(v.latest.extension)) fail('check.extAssetUrl is canonical', v.latest.extAssetUrl)
  }
  console.log(
    `INFO: check → plugin ${v.installed.plugin ?? '?'} → ${v.latest.plugin ?? '?'} (npm: ${v.errors.npm ?? 'ok'}); ` +
      `ext ${v.installed.extension} → ${v.latest.extension ?? '?'} (releases: ${v.errors.releases ?? 'ok'}); ` +
      `handshake: ${v.errors.plugin ?? 'ok'}`,
  )
  ok('updates/check (live values + shape + canonical asset)')

  // A2: the allowlist refuses before any fetch.
  const bad1 = await live.request('updates/download', { version: '0.1.29', url: 'http://127.0.0.1:1/evil.zip' })
  if (bad1.error?.message?.includes('canonical release asset') !== true) fail('download refuses non-canonical url', bad1)
  const bad2 = await live.request('updates/download', { version: '1.2', url: 'https://github.com/x' })
  if (bad2.error?.message?.includes('invalid version') !== true) fail('download refuses malformed version', bad2)
  const bad3 = await live.request('updates/download', {
    version: '0.1.29',
    url: CANONICAL('0.1.28'), // right shape, wrong version for the requested one
  })
  if (bad3.error?.message?.includes('canonical release asset') !== true) fail('download refuses cross-version url', bad3)
  ok('updates/download allowlist (url + version, no fetch on refusal)')
} finally {
  live.close()
}

// --------------------------- B. scratch copy: a REAL in-place download
const gh = await (
  await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/json' } })
).json()
const LATEST = (process.env.UPDATES_E2E_VERSION ?? gh.tag_name).replace(/^v/, '')
const ASSET = (gh.assets ?? []).find((a) => a.name === `augmentor-${LATEST}-dist.zip`)
if (!ASSET) fail('no release asset for ' + LATEST, gh.assets ?? gh.message)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'augmentor-updates-e2e-'))
try {
  // Copy the repo (without .git/trace) with a real node_modules copy (the
  // pipe's ws + fflate deps). Then fake an OLD state so the "next spawn runs
  // the new code" proof is observable.
  fs.cpSync(AUG, scratch, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      return base !== '.git' && base !== 'trace' && base !== 'dist'
    },
  })
  const manifestPath = path.join(scratch, 'extension', 'manifest.json')
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  m.version = '0.0.1'
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n')

  // B1: the scratch pipe boots and reports the old version.
  const p1 = new PipeClient(scratch, { DSH_AUGMENTOR_URL: 'http://127.0.0.1:1' })
  const c1 = await p1.request('updates/check', { extension: '0.0.1' }, 30000)
  if (c1.result?.installed?.pipe !== '0.0.1') fail('scratch pipe reports the old version', c1.result?.installed)
  ok('scratch pipe boots on the old (0.0.1) state')

  // B2: real download from the GitHub release, extracted in place.
  const d = await p1.request('updates/download', { version: LATEST, url: ASSET.browser_download_url }, 120000)
  if (d.error) fail('scratch updates/download', d.error.message)
  const dv = d.result
  if (!dv?.ok || !(dv.files > 40)) fail('download result', dv)
  ok(`in-place download of v${LATEST} (${dv.files} files written)`)

  // B3: every zip entry is byte-identical on disk; the manifest moved.
  const zip = unzipSync(new Uint8Array(await (await fetch(ASSET.browser_download_url)).arrayBuffer()))
  const prefix = `augmentor-${LATEST}/`
  let checked = 0
  for (const k of Object.keys(zip)) {
    if (!k.startsWith(prefix) || k.endsWith('/')) continue
    const rel = k.slice(prefix.length)
    if (rel.startsWith('node_modules/') || rel.startsWith('plugin/node_modules/')) continue
    const onDisk = fs.readFileSync(path.join(scratch, rel))
    if (!onDisk.equals(Buffer.from(zip[k]))) fail(`byte mismatch: ${rel}`)
    checked++
  }
  if (checked < 40) fail('integrity check coverage', checked)
  const newManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (newManifest.version !== LATEST) fail('manifest not updated', newManifest.version)
  ok(`integrity: ${checked} files byte-identical to the release artifact; manifest → v${LATEST}`)
  p1.close()

  // B4: the NEXT pipe spawn runs the new code. The downloaded published pipe
  // predates updates/check (the method that just ran), so the version proof
  // must be cross-vintage: every pipe logs "pipe <ver> starting" at boot,
  // where <ver> is read from the manifest the download just updated.
  const p2 = new PipeClient(scratch, { DSH_AUGMENTOR_URL: 'http://127.0.0.1:1' })
  const wantBoot = `pipe ${LATEST} starting`
  let booted = false
  for (let i = 0; i < 100 && !booted; i++) {
    await sleep(100)
    booted = p2.stderrText().includes(wantBoot)
  }
  if (!booted) fail('next spawn loads the new pipe', p2.stderrText().slice(0, 400))
  ok('next pipe spawn runs the new version (in-place update activated)')
  p2.close()
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

console.log(
  `\nUPDATES-E2E: OK — ${passed} assertions (live updates/check + allowlist on the real tree; real in-place download + integrity + next-spawn proof in a scratch copy)`,
)
