#!/usr/bin/env node
/* Conductor-only companion: never run by node:test. No live lane is run on import.
 * Required: DSH_LIVE_PREFIX, DSH_LIVE_PLUGIN_PREFIX, DSH_LIVE_PLUGIN_TARBALL,
 * DSH_LIVE_BROWSER_OUT (existing external directory), DSH_LIVE_FINAL_GATE (update mode),
 * DSH_LIVE_CHROME_EXECUTABLE (Chrome for Testing), DEEPSEEK_API_KEY.
 * DSH_LIVE_GATE_MODE: update (default pins only) or observe (never resolves the gate).
 * Overrides are all-or-none and require explicit observe:
 * DSH_LIVE_PLUGIN_DSH_VERSION, DSH_LIVE_PLUGIN_HOST_TOOLS_VERSION,
 * DSH_LIVE_PLUGIN_VERSION, DSH_LIVE_PLUGIN_TARBALL_SHA1.
 * Observe requires an empty output directory; both modes write five screenshots.
 * Passed lanes require all five regular, non-symlink files with matching SHA-256.
 * All paths absolute. Approved input installs/tarball may live in the main
 * checkout's .resonant-rig; output, scratch state and browser profile may not.
 * No prefix is modified. No live output, request body or error is logged.
 *
 * React harness-demo shell over the production bridge; not the Chrome extension.
 * Uses the swap demo's production host composition, explicit host consent and
 * signed receipts. No fixture transport and no credentials written by this driver.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID, randomBytes, createPublicKey, verify } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '../..');
export const SURFACE = 'react-harness-demo-shell';
export const SURFACE_DESCRIPTION = 'React harness-demo shell over the production bridge; not the Chrome extension';
const VERSION = '0.2.0-rc.2';
const PLUGIN_DSH = '0.1.5-rc.1';
// DSH 0.1.5-rc.1 resolves its own host dsh-tools at 0.1.5-rc.3 (its packages
// peer on ^0.1.5-rc.3; the prefix lockfile pins rc.3). The plugin links that host copy.
const PLUGIN_HOST_TOOLS = '0.1.5-rc.3';
export const TARBALL_SHA1 = '9a2096ee68652fd9fc171665b8462b71f83de4f1';
// Exact releases only: no ranges, tags, paths, whitespace or command fragments.
export function pluginConfig(env = process.env) {
  const names = ['DSH_LIVE_PLUGIN_DSH_VERSION', 'DSH_LIVE_PLUGIN_HOST_TOOLS_VERSION',
    'DSH_LIVE_PLUGIN_VERSION', 'DSH_LIVE_PLUGIN_TARBALL_SHA1'];
  const count = names.filter(name => env[name] !== undefined).length;
  assert(count === 0 || env.DSH_LIVE_GATE_MODE === 'observe', 'overrides-require-observe');
  assert(count === 0 || count === names.length, 'plugin-overrides-all-or-none');
  const [dshVersion, hostToolsVersion, pluginVersion, tarballSha1] = count
    ? names.map(name => env[name]) : [PLUGIN_DSH, PLUGIN_HOST_TOOLS, '0.2.11', TARBALL_SHA1];
  for (const value of [dshVersion, hostToolsVersion, pluginVersion]) {
    assert(typeof value === 'string' && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9][0-9]*))?$/.test(value)
      && !/\s/.test(value), 'invalid-plugin-version');
  }
  assert(typeof tarballSha1 === 'string' && /^[a-f0-9]{40}$/.test(tarballSha1) && tarballSha1.length === 40, 'invalid-plugin-tarball-sha1');
  const gateMode = env.DSH_LIVE_GATE_MODE ?? 'update';
  assert(['update', 'observe'].includes(gateMode), 'invalid-gate-mode');
  return Object.freeze({ dshVersion, hostToolsVersion, pluginVersion, tarballSha1, gateMode });
}
export const ATTESTATION = 'conductor-verified screenshots pending owner review';
const KEYS = ['browserVisible', 'pluginCoexistence'];
const REASONS = new Set(['passed', 'preflight-failed', 'observation-unproven', 'evidence-missing',
  'overrides-require-observe', 'observe-output-not-empty',
  'requires-human-action:install', 'requires-human-action:grant', 'requires-human-action:assign',
  'requires-human-action:chat', 'owned-process-cleanup-unproven', 'interrupted']);
const inside = (root, value) => { const rel = path.relative(root, value); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = child => child.pid && child.exitCode === null && child.signalCode === null;
const fail = code => { throw new Error(code); };
async function until(fn, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(50); }
  fail('observation-unproven');
}
async function repositoryRoots() {
  const roots = [await realpath(ROOT)];
  const git = await lstat(path.join(ROOT, '.git'));
  if (git.isFile()) {
    const pointer = /^gitdir: (.+)\s*$/.exec(await readFile(path.join(ROOT, '.git'), 'utf8'));
    assert(pointer);
    const gitdir = await realpath(path.resolve(ROOT, pointer[1]));
    const common = (await readFile(path.join(gitdir, 'commondir'), 'utf8')).trim();
    roots.push(path.dirname(await realpath(path.resolve(gitdir, common))));
  }
  return roots;
}
export async function externalPath(value, { file = false, basename } = {}) {
  assert(typeof value === 'string' && path.isAbsolute(value), 'absolute-path-required');
  if (basename) assert.equal(path.basename(value), basename);
  const resolved = file ? path.join(await realpath(path.dirname(value)), path.basename(value)) : await realpath(value);
  for (const root of await repositoryRoots()) assert(!inside(root, resolved), 'repository-path-refused');
  try { const stat = await lstat(resolved); assert(!stat.isSymbolicLink()); assert(file ? stat.isFile() : stat.isDirectory()); }
  catch (error) { if (!file || error.code !== 'ENOENT') throw error; }
  return resolved;
}
export function assertPort(port) {
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535 && ![19387, 47773, 47883].includes(port), 'port-refused');
  return port;
}
async function unusedPort(excluded) {
  for (;;) {
    const server = net.createServer();
    const listening = once(server, 'listening'); server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
    await listening; const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    try { assertPort(port); if (!excluded.includes(port)) return port; } catch { /* Retry only allocation. */ }
  }
}
export async function verifyTarball(file, expectedSha1 = TARBALL_SHA1) {
  assert(path.isAbsolute(file));
  const stat = await lstat(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size < 10 * 1024 * 1024);
  const bytes = await readFile(file);
  const digest = createHash('sha1').update(bytes).digest('hex');
  assert.equal(digest, expectedSha1, 'tarball-digest-mismatch');
  return bytes;
}
function lane(value) {
  assert(value && typeof value.passed === 'boolean' && REASONS.has(value.reason), 'unsafe-evidence');
  assert.equal(value.passed, value.reason === 'passed');
  return { passed: value.passed, reason: value.reason };
}
const SCREENSHOTS = ['browser-visible.png', 'plugin-swap-1.png', 'plugin-swap-2.png', 'plugin-swap-3.png', 'plugin-swap-4.png'];
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64;
export async function verifyEvidence(out, results, digests) {
  try {
    for (const name of SCREENSHOTS) {
      assert(validDigest(digests[name]));
      const file = path.join(out, name), stat = await lstat(file);
      assert(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), digests[name]);
    }
  } catch {
    for (const key of KEYS) results[key] = { passed: false, reason: 'evidence-missing' };
  }
}
export async function assertPluginTools(prefix, tools) {
  assert(inside(await realpath(prefix), await realpath(tools)), 'plugin-tools-outside-prefix');
}
export async function assertLaneIsolation(homes, ports) {
  const resolved = await Promise.all(homes.map(home => realpath(home)));
  assert.equal(new Set(resolved).size, homes.length, 'lane-isolation');
  assert.equal(new Set(ports).size, ports.length, 'lane-isolation');
}
export async function assertOutputDirectory(out, mode) {
  if (mode === 'observe') assert((await readdir(out)).length === 0, 'observe-output-not-empty');
}
export function summary(results, cleanup, digests = {}, config = pluginConfig({})) {
  assert.equal(typeof cleanup, 'boolean');
  const evidence = {};
  for (const name of SCREENSHOTS) {
    if (digests[name] !== undefined) {
      assert(validDigest(digests[name])); evidence[name] = digests[name];
    }
  }
  if (KEYS.some(key => results[key]?.passed)) assert(SCREENSHOTS.every(name => validDigest(digests[name])), 'evidence-missing');
  return { surface: SURFACE, surfaceDescription: SURFACE_DESCRIPTION, screenshotSha256: evidence, browserVisible: lane(results.browserVisible), pluginCoexistence: lane(results.pluginCoexistence),
    cleanup, nativeVersion: VERSION, pluginDshVersion: config.dshVersion, pluginHostToolsVersion: config.hostToolsVersion, pluginVersion: config.pluginVersion,
    expectedTarballSha1: config.tarballSha1, gateMode: config.gateMode };
}
export function patchGate(gate, results) {
  assert.deepEqual(Object.keys(results).sort(), [...KEYS].sort(), 'gate-key-restriction');
  assert(gate && Array.isArray(gate.liveVersions));
  const next = structuredClone(gate), rows = next.liveVersions.filter(row => row.version === VERSION);
  assert.equal(rows.length, 1, 'ambiguous-gate');
  const row = rows[0];
  assert(row.reasons && typeof row.reasons === 'object' && !Array.isArray(row.reasons));
  for (const key of KEYS) {
    assert.equal(typeof row[key], 'boolean');
    assert.equal(typeof row.reasons[key], 'string');
    const result = lane(results[key]); row[key] = result.passed; row.reasons[key] = result.reason;
  }
  assert(row.attestation === undefined || row.attestation === ATTESTATION, 'conflicting-attestation');
  row.attestation = ATTESTATION;
  row.surface = SURFACE;
  // Only default pins can reach update mode; identity additions are fixed here.
  Object.assign(row, { pluginVersion: '0.2.11', pluginDshVersion: PLUGIN_DSH,
    pluginHostToolsVersion: PLUGIN_HOST_TOOLS, pluginTarballSha1: TARBALL_SHA1 });
  // status, deterministic, blockedReasons, other observations and metadata are
  // deliberately NOT recalculated: only the conductor owns final certification.
  return next;
}
// A displayed answer must be the same turn, owner, session and generation as
// the production host's signed dispatch/final, under its boot public key.
export async function matchSignedReply({ receipts, signer, addonId, text, author }) {
  const { canonicalReceipt, receiptFingerprint } = await import('../host/harness-host-service.mjs');
  const key = createPublicKey(signer.publicKey);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(receiptFingerprint(signer.publicKey), signer.fingerprint);
  for (const receipt of receipts) {
    const { signature, ...body } = receipt;
    assert.equal(receipt.mode, 'live');
    assert.equal(receipt.signer.keyId, signer.fingerprint);
    assert(verify(null, Buffer.from(canonicalReceipt(body)), key, Buffer.from(signature, 'base64')), 'invalid-host-signature');
  }
  const invocation = receipts.find(r => r.kind === 'route' && r.operation === '/agent/turn' && r.ok);
  assert(invocation, 'missing-signed-dispatch');
  const final = receipts.find(r => r.kind === 'event' && r.event.type === 'final' && r.event.turnId === invocation.result.turnId);
  assert(final, 'missing-signed-final');
  const session = invocation.request.session;
  assert.equal(session.addonId, addonId);
  assert.equal(final.bootEpoch, invocation.bootEpoch);
  for (const field of ['addonId', 'sessionId', 'bootEpoch', 'generation']) assert.equal(final.event[field], session[field]);
  assert.equal(text, final.event.data.text);
  assert.equal(text, 'synthetic');
  assert.equal(author.trim(), addonId, 'displayed-owner-mismatch');
}

async function atomicWrite(file, data, before) {
  const temporary = path.join(path.dirname(file), `.browser-lanes-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    if (before !== undefined) assert.equal(await readFile(file, 'utf8'), before, 'gate-changed-concurrently');
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
export async function updateGate(file, results, mode = 'update') {
  assert(['update', 'observe'].includes(mode), 'invalid-gate-mode');
  if (mode === 'observe') return;
  file = await externalPath(file, { file: true, basename: 'final-gate.json' });
  // Exclusive companion lock; core driver must not run concurrently. Compare
  // original bytes again before replacement so observed concurrent writes fail.
  const lock = await open(`${file}.browser-lanes.lock`, 'wx', 0o600);
  try {
    const raw = await readFile(file, 'utf8'), gate = JSON.parse(raw);
    // Core-driver canonical shape refuses duplicate keys and lossy numbers.
    assert.equal(raw, `${JSON.stringify(gate, null, 2)}\n`, 'noncanonical-gate');
    await atomicWrite(file, `${JSON.stringify(patchGate(gate, results), null, 2)}\n`, raw);
  } finally { await lock.close(); await rm(`${file}.browser-lanes.lock`); }
}
function safeEnv(home) {
  return { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'),
    TMPDIR: path.join(home, 'tmp'), LANG: 'en_US.UTF-8', DSH_TELEMETRY_MODE: 'DISABLED' };
}
async function stop(child) {
  if (!live(child)) return;
  child.kill('SIGTERM');
  try { await until(() => !live(child), 15000); }
  catch { child.kill('SIGKILL'); await until(() => !live(child), 5000); }
  assert(!live(child));
}

// Match the swap demo's capability bootstrap even though provider routes are
// not used by these harness turns. React requests this set in one transaction.
export function shellCapabilities({ read, control }) {
  return { ...Object.fromEntries(['provider-diagnostics-read', 'provider-model-invoke',
    'provider-credential-write', 'provider-routing-write'].map(name => [name, randomUUID()])),
    'addon-runtime-read': read, 'addon-runtime-control': control };
}

// Production bridge wrapper: observe only children this launcher actually
// spawns. No PID discovery, foreign process groups, protocol replacements or
// credentials over IPC. Forced cleanup targets only captured ChildProcesses.
async function bridgeChild() {
  assert(process.connected);
  const entry = await realpath(path.join(process.env.RESONANTOS_DSH_PACKAGE_ROOT, 'node_modules/@deepseek-ai/dsh/lib/bin.js'));
  const owned = new Set(), spawned = new Set(), spawn = childProcess.spawn;
  let foreignSignalAttempts = 0;
  const originalKill = childProcess.ChildProcess.prototype.kill;
  childProcess.ChildProcess.prototype.kill = function (signal) {
    if (!spawned.has(this)) { foreignSignalAttempts++; fail('foreign-process-signal-refused'); }
    return originalKill.call(this, signal);
  };
  childProcess.spawn = function (file, args, options) {
    const child = spawn(file, args, options);
    spawned.add(child);
    if (file === process.execPath && args?.[0] === entry) {
      owned.add(child); process.send?.({ kind: 'native-start' });
      child.once('exit', () => { owned.delete(child); process.send?.({ kind: 'native-exit' }); });
    }
    return child;
  };
  syncBuiltinESMExports();
  process.on('message', message => {
    if (message?.kind === 'audit-signals') process.send?.({ kind: 'signal-audit', safe: foreignSignalAttempts === 0 });
    if (message?.kind === 'stop-owned') for (const child of owned) if (live(child)) child.kill('SIGKILL');
  });
  const { createHarnessHostService } = await import('../host/harness-host-service.mjs');
  const { createHarnessRegistryStore } = await import('../host/harness-registry-store.mjs');
  const { startBridgeServer } = await import('../host/bridge-server.mjs');
  const userRoot = process.env.RESONANTOS_BROWSER_FIRST_USER_ROOT;
  const host = await createHarnessHostService({ userRoot,
    store: createHarnessRegistryStore({ userRoot, stateRoot: path.join(userRoot, 'state') }),
    bindings: JSON.parse(process.env.RESONANTOS_HARNESS_BINDINGS), env: process.env,
    onReceipt: receipt => process.send?.({ kind: 'receipt', receipt }) });
  let server, closing;
  const close = () => closing ??= (async () => {
    await host.close();
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    if (process.connected) process.disconnect();
  })();
  process.on('SIGTERM', () => { void close(); });
  process.on('SIGINT', () => { void close(); });
  process.on('disconnect', () => { void close(); });
  server = await startBridgeServer({ host: '127.0.0.1', port: assertPort(Number(process.env.RESONANTOS_BROWSER_FIRST_BRIDGE_PORT)),
    bridgeToken: process.env.RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN,
    capabilityBootstrapToken: process.env.DSH_BROWSER_BOOTSTRAP,
    bridgeCapabilityTokens: shellCapabilities({ read: process.env.RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN,
      control: process.env.RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN }),
    routes: host.harnessRoutes, allowedOrigins: [process.env.DSH_BROWSER_ORIGIN], openPathPrefixes: [] });
  process.send?.({ kind: 'ready', signer: host.signer,
    routes: host.harnessRoutes.map(({ path, method, requiredCapability }) => ({ path, method, requiredCapability })) });
}

export async function main() {
  process.umask(0o077);
  const results = Object.fromEntries(KEYS.map(key => [key, { passed: false, reason: 'preflight-failed' }]));
  const children = new Set(), secrets = new Set(), digests = {}; let browser, bridge, out, gate, scratch, dispatcher, vite, config;
  const receipts = []; let ready, signalAudit = false;
  let interrupted = false, cleanup = true, starts = 0, exits = 0;
  const interrupt = () => { interrupted = true; void browser?.close().catch(() => {}); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  function spawn(file, args, env, ipc = false) {
    assert(!interrupted);
    const child = childProcess.spawn(file, args, { cwd: scratch, env, shell: false, detached: ipc,
      stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    children.add(child); child.on('error', () => {}); child.stdout.resume(); child.stderr.resume();
    return child;
  }
  const check = () => { if (interrupted) fail('interrupted'); };
  const step = async (key, action) => {
    try { check(); await action(); results[key] = { passed: true, reason: 'passed' }; }
    catch (error) { results[key] = { passed: false, reason: REASONS.has(error.message) ? error.message : 'observation-unproven' }; }
  };
  try {
    config = pluginConfig();
    const output = await externalPath(process.env.DSH_LIVE_BROWSER_OUT);
    await assertOutputDirectory(output, config.gateMode);
    out = output;
    if (config.gateMode === 'update') {
      gate = await externalPath(process.env.DSH_LIVE_FINAL_GATE, { file: true, basename: 'final-gate.json' });
      // Validate gate shape before any network, process or profile work.
      const raw = await readFile(gate, 'utf8'); assert.equal(raw, `${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      patchGate(JSON.parse(raw), results);
    }
    for (const name of ['DSH_LIVE_PREFIX', 'DSH_LIVE_PLUGIN_PREFIX', 'DSH_LIVE_PLUGIN_TARBALL', 'DSH_LIVE_CHROME_EXECUTABLE']) assert(path.isAbsolute(process.env[name] ?? ''));
    const prefix = await realpath(process.env.DSH_LIVE_PREFIX);
    // A shared read-only install is allowed; homes and ports below remain distinct.
    const pluginPrefix = await realpath(process.env.DSH_LIVE_PLUGIN_PREFIX);
    const { validateDshPrefix } = await import('../host/dsh-runtime.mjs');
    assert.equal((await validateDshPrefix(prefix, { deadline: Date.now() + 30000 })).version, VERSION);
    const pluginPackage = path.join(pluginPrefix, 'node_modules/@deepseek-ai/dsh');
    assert.equal(JSON.parse(await readFile(path.join(pluginPackage, 'package.json'), 'utf8')).version, config.dshVersion);
    const tarball = await verifyTarball(process.env.DSH_LIVE_PLUGIN_TARBALL, config.tarballSha1);
    assert(process.env.DEEPSEEK_API_KEY?.trim()); secrets.add(process.env.DEEPSEEK_API_KEY);
    const chrome = await realpath(process.env.DSH_LIVE_CHROME_EXECUTABLE);
    assert.equal(path.basename(chrome), 'Google Chrome for Testing');
    // Prefix may be in the approved parent checkout. In that case the output
    // directory is the external scratch parent; otherwise use beside prefix.
    const parent = await externalPath(path.dirname(prefix)).catch(() => out);
    scratch = await mkdtemp(path.join(parent, 'dsh-native-browser-'));
    const home = path.join(scratch, 'home'), pluginHome = path.join(scratch, 'plugin-home');
    const dshHome = path.join(scratch, 'native-dsh'), pluginDshHome = path.join(scratch, 'plugin-dsh');
    for (const dir of [home, pluginHome, dshHome, path.join(home, 'tmp'), path.join(pluginHome, 'tmp'), pluginDshHome, path.join(scratch, 'user')]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const bridgePort = await unusedPort([]), nativePort = await unusedPort([bridgePort]), pluginPort = await unusedPort([bridgePort, nativePort]);
    const shellPort = await unusedPort([bridgePort, nativePort, pluginPort]);
    await assertLaneIsolation([home, pluginHome, dshHome, pluginDshHome], [bridgePort, nativePort, pluginPort, shellPort]);
    const origin = `http://127.0.0.1:${shellPort}`;
    const manifests = {};
    for (const mode of ['native', 'plugin']) {
      const name = mode === 'native' ? 'deepseek-harness-native.json' : 'deepseek-harness.json';
      manifests[mode] = JSON.parse(await readFile(path.join(ROOT, 'browser-first/host/harness-examples', name), 'utf8'));
      manifests[mode].agentRuntime.endpoint = `http://127.0.0.1:${mode === 'native' ? nativePort : pluginPort}`;
    }
    const tokenFile = path.join(pluginDshHome, 'augmentor-ws-token');
    const bindings = Object.entries(manifests).map(([mode, manifest]) => ({ name: manifest.agentRuntime.credentialBinding,
      addonId: manifest.id, adapterId: manifest.agentRuntime.adapterId, authScheme: manifest.agentRuntime.authScheme,
      endpoint: manifest.agentRuntime.endpoint, source: mode === 'native' ? { managedDsh: true } : { file: tokenFile } }));
    const auth = { bridge: randomUUID(), read: randomUUID(), control: randomUUID(), bootstrap: randomUUID() };
    for (const value of Object.values(auth)) secrets.add(value);
    bridge = spawn(process.execPath, [SELF, '--bridge-child'], { ...safeEnv(home),
      DSH_BROWSER_ORIGIN: origin, DSH_BROWSER_BOOTSTRAP: auth.bootstrap, RESONANTOS_HARNESS_DEMO: '1', RESONANTOS_BROWSER_FIRST_USER_ROOT: path.join(scratch, 'user'),
      RESONANTOS_BROWSER_FIRST_BRIDGE_PORT: String(bridgePort), RESONANTOS_BRIDGE_HOST: '127.0.0.1',
      RESONANTOS_BROWSER_FIRST_BRIDGE_TOKEN: auth.bridge,
      RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_READ_TOKEN: auth.read,
      RESONANTOS_BROWSER_FIRST_ADDON_RUNTIME_CONTROL_TOKEN: auth.control,
      RESONANTOS_HARNESS_BINDINGS: JSON.stringify(bindings), RESONANTOS_DSH_PACKAGE_ROOT: prefix,
      RESONANTOS_DSH_HOME: dshHome, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY }, true);
    bridge.on('message', message => {
      if (message.kind === 'native-start') starts++;
      if (message.kind === 'native-exit') exits++;
      if (message.kind === 'receipt') receipts.push(message.receipt);
      if (message.kind === 'ready') ready = message;
      if (message.kind === 'signal-audit') signalAudit = message.safe === true;
    });
    await until(() => { check(); assert(live(bridge)); return ready; });
    const { Agent, fetch: directFetch } = await import('undici'); dispatcher = new Agent();
    const { createBridgeClient } = await import('../../scripts/harness-swap-demo.mjs');
    const bridgeConfig = { bridgeUrl: `http://127.0.0.1:${bridgePort}`, bridgeToken: auth.bridge, capabilityBootstrapToken: auth.bootstrap };
    const client = createBridgeClient({ ...bridgeConfig, routes: ready.routes,
      headers: capability => ({ 'content-type': 'application/json', 'x-resonantos-bridge-token': auth.bridge,
        'x-resonantos-bridge-capability-token': capability === 'addon-runtime-control' ? auth.control : auth.read }),
      fetchImpl: (url, options) => directFetch(url, { ...options, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(40000) }) });
    const request = async (route, body) => {
      check(); assert(live(bridge)); const result = await client.request(route, body);
      assert(!result.code); return result;
    };
    assert.equal(starts, 0);
    const { devBridgeConfigPlugin, EXPECTED_DEV_SERVER_FS_DENY } = await import('../../scripts/vite-dev-bridge-config.mjs');
    const { createServer } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    const pageKey = randomBytes(32).toString('base64url'); secrets.add(pageKey);
    vite = await createServer({ configFile: false, root: ROOT, mode: 'harness-demo', cacheDir: path.join(scratch, 'vite-cache'),
      plugins: [devBridgeConfigPlugin({ env: () => ({ RESONANTOS_DEV_BRIDGE_CONFIG: '1', RESONANTOS_DEV_BRIDGE_PAGE_KEY: pageKey }),
        readConfig: async () => bridgeConfig, expectedPort: shellPort }), react()],
      server: { host: '127.0.0.1', port: shellPort, strictPort: true, allowedHosts: ['127.0.0.1'], cors: false,
        fs: { strict: true, deny: [...EXPECTED_DEV_SERVER_FS_DENY] },
        watch: { ignored: ['**/bridge-config.generated.js', '**/ResonantOS_User/**', '**/.rig-in/**'] } } });
    await vite.listen();
    const { chromium } = await import('playwright');
    browser = await chromium.launchPersistentContext(path.join(scratch, 'chrome-profile'), { executablePath: chrome,
      headless: false, env: safeEnv(home), viewport: { width: 1600, height: 1000 },
      httpCredentials: { username: 'dev', password: pageKey } });
    const page = await browser.newPage(); page.setDefaultTimeout(30000);
    await page.goto(origin);
    await page.getByRole('button', { name: 'Choose Add-ons Manually', exact: true }).click();
    const install = async mode => {
      const manifest = manifests[mode];
      let projection = await request('/addons/registry');
      await request('/addons/install', { manifest, enabled: true, expectedRevision: projection.revision });
      projection = await request('/addons/registry');
      await request('/addons/grants', { addonId: manifest.id, consent: true, expectedRevision: projection.revision,
        grants: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })) });
    };
    const assign = async mode => {
      for (const slot of ['primary-agent', 'chat-interface']) {
        const projection = await request('/addons/registry');
        await request('/addons/slots/assign', { slot, addonId: manifests[mode].id,
          expectedGeneration: projection.slots[slot]?.generation ?? 0, replace: Boolean(projection.slots[slot]?.addonId) });
        const next = await request('/addons/registry'); assert.equal(next.slots[slot].addonId, manifests[mode].id);
      }
    };
    const reply = async mode => {
      const manifest = manifests[mode];
      await page.getByRole('button', { name: /Add-ons/ }).first().click();
      await page.getByRole('button', { name: 'Refresh harnesses' }).click();
      const projection = await request('/addons/registry');
      const ownerName = projection.candidates.find(candidate => candidate.id === manifest.id)?.name ?? manifest.id;
      await page.getByText(`Current owner: ${ownerName} · Available`, { exact: true }).waitFor();
      const composer = page.locator('textarea[placeholder^="Message "]');
      if (!await composer.isVisible()) await page.getByRole('button', { name: 'Chat', exact: true }).click();
      const messages = page.locator('article.message-bubble.assistant'), before = await messages.count(), prior = receipts.length;
      await composer.fill('Reply with the word synthetic.');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await until(async () => {
        check();
        const recent = receipts.slice(prior);
        if (!recent.some(r => r.kind === 'event' && r.event.type === 'final') || await messages.count() !== before + 1) return false;
        const last = messages.last();
        const text = (await last.locator('.message-renderer').innerText()).trim();
        if (text !== 'synthetic') return false;
        await matchSignedReply({ receipts: recent, signer: ready.signer, addonId: manifest.id,
          text, author: await last.locator('.message-meta strong').innerText() });
        await last.scrollIntoViewIfNeeded(); assert(await last.isVisible()); return true;
      }, 150000);
    };
    const screenshot = async name => {
      // Only the synthetic conversation is in this fresh profile. Refuse a
      // screenshot containing anything beyond the fixed prompt/reply in chat,
      // except the shell's static seed copy: an exact string literal in
      // src/core/defaults.ts (e.g. the built-in Augmentor greeting).
      const seedSource = await readFile(path.join(ROOT, 'src/core/defaults.ts'), 'utf8');
      for (const text of await page.locator('article.message-bubble .message-renderer').allTextContents()) {
        const value = text.trim();
        assert(['synthetic', 'Reply with the word synthetic.'].includes(value) || (value.length > 0 && seedSource.includes(JSON.stringify(value))));
      }
      const text = await page.locator('body').innerText();
      assert(![...secrets].some(value => value && text.includes(value)));
      const png = await page.screenshot();
      // Evidence is written in both modes; observe mode only leaves the gate untouched.
      await writeFile(path.join(out, name), png, { flag: 'wx', mode: 0o600 });
      digests[name] = createHash('sha256').update(png).digest('hex');
    };
    await step('browserVisible', async () => {
      await install('native');
      await assign('native');
      await reply('native');
      assert.equal(starts - exits, 1); await screenshot('browser-visible.png');
    });
    await step('pluginCoexistence', async () => {
      const localTarball = path.join(scratch, `dsh-augmentor-${config.pluginVersion}.tgz`);
      await writeFile(localTarball, tarball, { mode: 0o600 }); await verifyTarball(localTarball, config.tarballSha1);
      const pluginEnv = { ...safeEnv(pluginHome), DSH_HOME: pluginDshHome };
      const entry = path.join(pluginPackage, 'lib/bin.js');
      const installer = spawn(process.execPath, [entry, 'plugin', '--profile', 'web', 'add', localTarball,
        '--ignore-scripts', '--config.auto-install-peers=false', '--registry=https://registry.npmjs.org'], pluginEnv);
      await until(() => !live(installer), 120000);
      const profile = path.join(pluginDshHome, 'profiles/web');
      if (installer.exitCode === 127) {
        // Both CLI versions accept tarballs and return 127 for absent pnpm
        // (0.2: dsh/lib/plugin-BGnVfe_D.js and plugin-manager operations). Its own command
        // already initialized this scratch web profile. Avoid peer downloads:
        // DSH's pinned host packages are linked read-only from the exact prefix.
        const npm = spawn('npm', ['install', '--prefix', profile, '--ignore-scripts', '--no-audit', '--no-fund',
          '--legacy-peer-deps', '--registry=https://registry.npmjs.org', localTarball], pluginEnv);
        await until(() => !live(npm), 120000); assert.equal(npm.exitCode, 0);
        const file = path.join(profile, 'package.json'), pkg = JSON.parse(await readFile(file, 'utf8'));
        assert(Array.isArray(pkg.dsh?.profile?.bundles));
        if (!pkg.dsh.profile.bundles.includes('dsh-augmentor')) pkg.dsh.profile.bundles.push('dsh-augmentor');
        await writeFile(file, JSON.stringify(pkg, null, 2));
      } else assert.equal(installer.exitCode, 0);
      const { createRequire } = await import('node:module');
      const hostRequire = createRequire(path.join(pluginPackage, 'package.json'));
      const toolsEntry = await realpath(hostRequire.resolve('@deepseek-ai/dsh-tools'));
      const tools = path.dirname(path.dirname(toolsEntry));
      await assertPluginTools(pluginPrefix, tools);
      assert.equal(JSON.parse(await readFile(path.join(tools, 'package.json'), 'utf8')).version, config.hostToolsVersion);
      await mkdir(path.join(profile, 'node_modules/@deepseek-ai'), { recursive: true, mode: 0o700 });
      const toolsLink = path.join(profile, 'node_modules/@deepseek-ai/dsh-tools');
      try { await symlink(tools, toolsLink); } catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await realpath(toolsLink), tools); }
      const installed = JSON.parse(await readFile(path.join(profile, 'node_modules/dsh-augmentor/package.json'), 'utf8'));
      assert.equal(installed.version, config.pluginVersion);
      const pluginRequire = createRequire(await realpath(path.join(profile, 'node_modules/dsh-augmentor/package.json')));
      for (const [name, version] of [['ws', '8.21.3'], ['@deepseek-ai/schemastery', '3.18.2']]) {
        assert.equal(installed.dependencies[name], version);
        const entry = await realpath(pluginRequire.resolve(name));
        let dir = path.dirname(entry), found = false;
        for (let depth = 0; depth < 5; depth++, dir = path.dirname(dir)) {
          try { const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.name === name) { assert.equal(pkg.version, version); found = true; break; }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        assert(found);
      }
      const plugin = spawn(process.execPath, [entry, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(pluginPort)],
        { ...pluginEnv, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY });
      let pending = '', bytes = 0, bootToken;
      plugin.stdout.on('data', chunk => {
        bytes += chunk.length; if (bytes > 1048576) return;
        pending += chunk.toString();
        while (pending.includes('\n')) {
          const index = pending.indexOf('\n'), line = pending.slice(0, index).trimEnd(); pending = pending.slice(index + 1);
          if (!line.startsWith('dsh web: ')) continue;
          try { const url = new URL(line.slice(9)); if (url.origin === manifests.plugin.agentRuntime.endpoint) bootToken = url.searchParams.get('token'); } catch { /* Private stdout stays in memory. */ }
        }
      });
      await until(() => { check(); assert(live(plugin)); return bootToken; }); secrets.add(bootToken);
      const stat = await lstat(tokenFile); assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077));
      const actionToken = (await readFile(tokenFile, 'utf8')).trim(); assert(actionToken); secrets.add(actionToken);
      const response = await directFetch(`${manifests.plugin.agentRuntime.endpoint}/api/augmentor/auth`, {
        dispatcher, method: 'POST', redirect: 'manual', headers: { 'x-augmentor-token': actionToken }, signal: AbortSignal.timeout(10000) });
      // dsh-augmentor@0.2.11 returns the DSH login token as JSON {token}
      // (dist/index.js:463-465); it sets no cookie.
      assert.equal(response.status, 200);
      const { token: loginToken } = await response.json();
      assert(typeof loginToken === 'string' && loginToken.length > 0); secrets.add(loginToken);
      const healthy = async () => {
        assert(live(plugin)); process.kill(plugin.pid, 0); // Observation of our spawned PID only.
        const response = await directFetch(`${manifests.plugin.agentRuntime.endpoint}/api/augmentor`, {
          dispatcher, redirect: 'manual', signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200); const value = await response.json();
        assert.equal(value.name, 'dsh-augmentor'); assert.equal(value.version, config.pluginVersion);
      };
      await install('plugin'); await healthy();
      for (const [index, mode] of ['plugin', 'native', 'plugin', 'native'].entries()) {
        await assign(mode); await healthy(); await reply(mode); await healthy();
        await until(() => starts - exits === (mode === 'native' ? 1 : 0), 5000);
        signalAudit = false; bridge.send({ kind: 'audit-signals' });
        await until(() => { check(); assert(live(bridge)); return signalAudit; });
        assert([...children].includes(plugin)); // Every parent signal also targets a captured child handle.
        await screenshot(`plugin-swap-${index + 1}.png`);
      }
    });
  } catch (error) {
    const reason = REASONS.has(error.message) ? error.message : 'preflight-failed';
    for (const key of KEYS) if (!results[key].passed) results[key] = { passed: false, reason };
  } finally {
    try { await browser?.close(); } catch { cleanup = false; }
    try { await vite?.close(); } catch { cleanup = false; }
    // Keep bridge wrapper alive until it has confirmed all native child exits.
    if (bridge && live(bridge)) {
      bridge.kill('SIGTERM');
      try { await until(() => starts === exits && !live(bridge), 15000); }
      catch {
        cleanup = false;
        if (bridge.connected) bridge.send({ kind: 'stop-owned' });
        try { await until(() => starts === exits, 5000); } catch {
          // No foreign PID or process-group escalation; leave cleanup unproven.
        }
      }
    }
    for (const child of [...children].reverse()) { try { await stop(child); } catch { cleanup = false; } }
    cleanup &&= starts === exits && [...children].every(child => !live(child));
    await dispatcher?.destroy().catch(() => { cleanup = false; });
    if (!cleanup || interrupted) for (const key of KEYS) results[key] = { passed: false, reason: interrupted ? 'interrupted' : 'owned-process-cleanup-unproven' };
    let written = false;
    try {
      if (out && config && (gate || config.gateMode === 'observe')) {
        await verifyEvidence(out, results, digests);
        await atomicWrite(path.join(out, 'browser-lanes-summary.json'), `${JSON.stringify(summary(results, cleanup, digests, config), null, 2)}\n`);
        await updateGate(gate, results, config.gateMode); written = true;
      }
    } catch { /* No exception, path, credential or remote body is serialized. */ }
    for (const key of KEYS) console.log(`${results[key].passed ? 'PASS' : 'FAIL'} ${key} ${results[key].reason}`);
    if (!written) console.log('FAIL evidence-write');
    process.exitCode = written && cleanup && KEYS.every(key => results[key].passed) ? 0 : 1;
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === '--bridge-child') {
    try { await bridgeChild(); } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
  } else await main();
}
