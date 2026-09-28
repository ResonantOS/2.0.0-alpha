// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

// Offline bridge-release rehearsal. Run with node --test; requires the pipe's
// normal ws/fflate dependencies and the existing pack script's zip/unzip tools.
// Only the scratch client's repository constant and installed versions are
// rewound. Production handlers and the strict URL policy run unmodified.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { encode, decode } from '../wire.mjs'

const AUG = fileURLToPath(new URL('../', import.meta.url))
const OLD_REPO = 'ManoloRemiddi/augmentor-dsh-extension-plugin'
const NEW_REPO = 'ResonantOS/2.0.0-alpha'
const VERSION = '0.1.33'
const assetUrl = repo => `https://github.com/${repo}/releases/download/v${VERSION}/augmentor-${VERSION}-dist.zip`
const apiUrl = repo => `https://api.github.com/repos/${repo}/releases/latest`
const require = createRequire(import.meta.url)

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`)
  return result.stdout
}

class PipeClient {
  constructor(dir, preload, origin, home) {
    this.stderr = ''
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.sequence = 0
    this.child = spawn(process.execPath, ['--import', preload, path.join(dir, 'pipe.mjs')], {
      cwd: dir,
      env: {
        ...process.env, NODE_OPTIONS: '', DSH_HOME: home,
        DSH_AUGMENTOR_URL: origin, DSH_AUGMENTOR_WS_TOKEN: 'offline-rehearsal-only',
        AUGMENTOR_PIPE_IDLE_MS: '60000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.closed = new Promise(resolve => this.child.once('close', resolve))
    const rejectAll = error => {
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
    }
    this.child.on('error', rejectAll)
    this.child.on('exit', code => rejectAll(new Error(`pipe exited ${code}: ${this.stderr}`)))
    this.child.stdin.on('error', rejectAll)
    this.child.stderr.on('data', data => { this.stderr += data })
    this.child.stdout.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data])
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0)
        if (this.buffer.length < length + 4) break
        const frame = decode(this.buffer.subarray(4, length + 4).toString('utf8'))
        this.buffer = this.buffer.subarray(length + 4)
        const waiter = this.pending.get(frame?.id)
        if (waiter && frame.method === undefined) {
          this.pending.delete(frame.id)
          waiter.resolve(frame)
        }
      }
    })
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = `bridge-${++this.sequence}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out: ${this.stderr}`))
      }, 10000)
      this.pending.set(id, {
        resolve: frame => { clearTimeout(timer); resolve(frame) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      const body = Buffer.from(encode({ id, method, params }))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32LE(body.length)
      this.child.stdin.write(Buffer.concat([prefix, body]))
    })
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
    await this.closed
  }
}

test('0.1.32 installs the bridge through its old authority, then 0.1.33 uses ResonantOS', { timeout: 60000 }, async t => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'augmentor-bridge-'))
  const clients = []
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/github-api/')) {
      const repo = req.url.slice('/github-api/'.length)
      if (![OLD_REPO, NEW_REPO].includes(repo)) { res.writeHead(404).end(); return }
      res.end(JSON.stringify({ tag_name: `v${VERSION}`, assets: [
        { name: `augmentor-${VERSION}-dist.zip`, browser_download_url: assetUrl(repo) },
      ] }))
    } else if (req.url.startsWith('/asset/')) {
      res.setHeader('content-type', 'application/zip')
      res.end(readFileSync(path.join(scratch, `augmentor-${VERSION}-dist.zip`)))
    } else if (req.url === '/npm') {
      res.end(JSON.stringify({ version: VERSION }))
    } else if (req.url === '/api/augmentor') {
      res.end(JSON.stringify({ version: '0.1.32' }))
    } else {
      // Keep unrelated boot/WS traffic disabled; update handlers still run.
      res.writeHead(503).end('{}')
    }
  })
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()))
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve))
      server.closeAllConnections()
      await closed
    }
    rmSync(scratch, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening') // EPERM is a failure, never silently skipped.
  const origin = `http://127.0.0.1:${server.address().port}`

  const release = path.join(scratch, 'release')
  mkdirSync(release)
  for (const entry of ['extension', 'shared', 'pipe.mjs', 'wire.mjs', 'install-native-host.sh',
    'presets', 'package.json', 'pnpm-lock.yaml', 'plugin', 'README.md', 'LICENSE', 'CHANGELOG.md', '.env.example']) {
    cpSync(path.join(AUG, entry), path.join(release, entry), {
      recursive: true, filter: source => path.basename(source) !== 'node_modules',
    })
  }
  const archive = path.join(scratch, `augmentor-${VERSION}-dist.zip`)
  run('sh', [path.join(AUG, 'scripts/pack-release.sh'), VERSION, archive, release])
  const bytes = readFileSync(archive)
  assert.ok(bytes.length > 0 && bytes.length <= 15 * 1024 * 1024)
  const entries = run('unzip', ['-Z1', archive]).trim().split('\n')
  const prefix = `augmentor-${VERSION}/`
  assert.ok(entries.every(entry => entry.startsWith(prefix)), 'exactly one release directory')
  for (const entry of ['extension/manifest.json', 'pipe.mjs', 'shared/dsh-auth.mjs',
    'plugin/package.json', 'plugin/dist/index.js', 'presets/augmentor/', 'install-native-host.sh']) {
    assert.ok(entries.includes(prefix + entry), `packaged ${entry}`)
  }
  assert.ok(!entries.some(entry => /(^|\/)(node_modules|\.env)(\/|$)/.test(entry)))

  const clientDir = path.join(scratch, 'installed')
  cpSync(release, clientDir, { recursive: true })
  const pipePath = path.join(clientDir, 'pipe.mjs')
  const newPipe = readFileSync(pipePath, 'utf8')
  assert.ok(newPipe.includes(`const RELEASE_REPO = '${NEW_REPO}'`))
  writeFileSync(pipePath, newPipe.replace(`const RELEASE_REPO = '${NEW_REPO}'`, `const RELEASE_REPO = '${OLD_REPO}'`))
  for (const relative of ['extension/manifest.json', 'plugin/package.json']) {
    const filename = path.join(clientDir, relative)
    const value = JSON.parse(readFileSync(filename, 'utf8'))
    assert.equal(value.version, VERSION)
    value.version = '0.1.32'
    writeFileSync(filename, JSON.stringify(value))
  }
  // Use the real declared runtime dependencies, with no replacement modules.
  for (const name of ['ws', 'fflate']) {
    let directory = path.dirname(require.resolve(name))
    while (!existsSync(path.join(directory, 'package.json')) ||
      JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')).name !== name) {
      assert.notEqual(directory, path.dirname(directory), `package root for ${name}`)
      directory = path.dirname(directory)
    }
    cpSync(directory, path.join(clientDir, 'node_modules', name), { recursive: true })
  }

  // Test-only fetch transport: URLs reach the real policy unchanged; only
  // after acceptance are exact known destinations routed onto loopback.
  // Unknown requests fail closed, and redirects cannot escape the stub.
  const routes = {
    [apiUrl(OLD_REPO)]: `/github-api/${OLD_REPO}`,
    [apiUrl(NEW_REPO)]: `/github-api/${NEW_REPO}`,
    [assetUrl(OLD_REPO)]: `/asset/${OLD_REPO}`,
    [assetUrl(NEW_REPO)]: `/asset/${NEW_REPO}`,
    'https://registry.npmjs.org/dsh-augmentor/latest': '/npm',
  }
  const preload = path.join(scratch, 'loopback-only.mjs')
  writeFileSync(preload, `
const originalFetch = globalThis.fetch;
const origin = ${JSON.stringify(origin)};
const routes = ${JSON.stringify(routes)};
globalThis.fetch = (input, options = {}) => {
  const url = String(input);
  if (Object.hasOwn(routes, url)) return originalFetch(origin + routes[url], { ...options, redirect: 'error' });
  if (new URL(url).origin === origin) return originalFetch(url, { ...options, redirect: 'error' });
  throw new Error('offline rehearsal refused network request: ' + url);
};
`)
  const start = () => {
    const client = new PipeClient(clientDir, preload, origin, path.join(scratch, 'home'))
    clients.push(client)
    return client
  }
  const old = start()
  const check = await old.request('updates/check', { extension: '0.1.32' })
  assert.equal(check.error, undefined)
  assert.deepEqual(check.result.installed, { plugin: '0.1.32', pipe: '0.1.32', pipeDisk: '0.1.32', extension: '0.1.32' })
  assert.equal(check.result.latest.extension, VERSION)
  assert.equal(check.result.latest.extAssetUrl, assetUrl(OLD_REPO))
  assert.deepEqual(check.result.errors, { npm: null, releases: null, plugin: null })
  assert.ok(requests.includes(`/github-api/${OLD_REPO}`))

  async function refusals(client, canonicalRepo, otherRepo) {
    const downloads = requests.filter(url => url.startsWith('/asset/')).length
    for (const url of [assetUrl(otherRepo), assetUrl(canonicalRepo) + '?extra=1',
      assetUrl(canonicalRepo).replace('https:', 'http:'),
      assetUrl(canonicalRepo).replace('/v0.1.33/', '/v0.1.32/'), `${origin}/asset/untrusted`]) {
      const response = await client.request('updates/download', { version: VERSION, url })
      assert.match(response.error?.message ?? '', /not the canonical release asset/)
    }
    for (const version of ['0.1', 'v0.1.33', '0.1.33-beta.1', '../0.1.33', '', 33]) {
      const response = await client.request('updates/download', { version, url: assetUrl(canonicalRepo) })
      assert.match(response.error?.message ?? '', /invalid version/)
    }
    assert.equal(requests.filter(url => url.startsWith('/asset/')).length, downloads, 'refusals never fetch an asset')
  }
  await refusals(old, OLD_REPO, NEW_REPO)
  const download = await old.request('updates/download', { version: VERSION, url: check.result.latest.extAssetUrl })
  assert.equal(download.error, undefined)
  assert.equal(download.result.ok, true)
  assert.deepEqual(download.result.failures, [])
  assert.deepEqual(download.result.warnings, [])
  const zipped = require('fflate').unzipSync(new Uint8Array(bytes))
  const files = entries.filter(entry => !entry.endsWith('/'))
  assert.equal(download.result.files, files.length)
  for (const entry of files) {
    const relative = entry.slice(prefix.length)
    assert.deepEqual(readFileSync(path.join(clientDir, relative)), Buffer.from(zipped[entry]), relative)
  }
  assert.equal(readFileSync(pipePath, 'utf8'), newPipe)
  const running = await old.request('updates/check', { extension: '0.1.32' })
  assert.equal(running.result.installed.pipe, '0.1.32')
  assert.equal(running.result.installed.pipeDisk, VERSION)
  await old.close()

  const fresh = start()
  const next = await fresh.request('updates/check', { extension: VERSION })
  assert.equal(next.result.installed.pipe, VERSION)
  assert.equal(next.result.installed.extension, VERSION)
  assert.equal(next.result.latest.extAssetUrl, assetUrl(NEW_REPO))
  assert.ok(requests.includes(`/github-api/${NEW_REPO}`))
  await refusals(fresh, NEW_REPO, OLD_REPO)
  const canonical = await fresh.request('updates/download', { version: VERSION, url: assetUrl(NEW_REPO) })
  assert.equal(canonical.result?.ok, true)
  assert.equal(requests.filter(url => url.startsWith('/asset/')).length, 2)
  t.diagnostic(`Bridge archive: ${bytes.length} bytes; ${files.length} files byte-identical after extraction; both authorities enforced.`)
})
