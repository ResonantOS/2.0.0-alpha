// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('native host stays alive for heartbeats, then exits even if stdin remains open', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'augmentor-heartbeat-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../pipe.mjs', import.meta.url))], {
    env: { ...process.env, DSH_HOME: home, DSH_AUGMENTOR_URL: 'http://127.0.0.1:9', AUGMENTOR_PIPE_IDLE_MS: '200' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.resume(); child.stderr.resume()
  child.stdin.on('error', () => {})
  const body = Buffer.from(JSON.stringify({ method: 'augmentor/heartbeat' }))
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length)
  const timer = setInterval(() => child.stdin.write(Buffer.concat([prefix, body])), 50)
  t.after(() => { clearInterval(timer); child.kill(); rmSync(home, { recursive: true, force: true }) })
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  await new Promise(resolve => setTimeout(resolve, 700))
  assert.equal(child.exitCode, null, 'heartbeats must keep a live extension connected')
  clearInterval(timer)
  const timeout = setTimeout(() => child.kill(), 3000)
  try { assert.equal(await exited, 0) } finally { clearTimeout(timeout) }
})
