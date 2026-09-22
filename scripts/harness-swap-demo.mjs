#!/usr/bin/env node
// Intent: docs/addons/harness-adapter-demo.md. This is an operator demo, not a runtime authority.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DSH = 'addon.deepseek-harness', PROVIDER = 'addon.provider-chat-demo';
const now = () => new Date().toISOString();
const check = (condition, detail) => { if (!condition) throw new Error(`Invalid demo evidence: ${detail}`); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const identifier = value => typeof value === 'string' && value.trim().length > 0;

/** Validate observed receipts. This checks consistency, not a cryptographic attestation. */
export function verifyEvidence(bundle, { requireLive = true } = {}) {
  check(bundle?.version === 1 && ['live', 'fixture'].includes(bundle.mode), 'bundle version/mode');
  check(!requireLive || bundle.mode === 'live', 'fixture is not live proof');
  check(timestamp(bundle.startedAt) && timestamp(bundle.finishedAt) &&
    Date.parse(bundle.startedAt) <= Date.parse(bundle.finishedAt), 'bundle timestamps');
  const receipt = value => check(value && value.mode === bundle.mode && timestamp(value.at), 'receipt mode/timestamp');
  check(Array.isArray(bundle.turns) && bundle.turns.length === 3, 'three attributed turn receipts required');
  const ids = new Set();
  for (const [i, turn] of bundle.turns.entries()) {
    receipt(turn);
    check(turn.owner === [DSH, PROVIDER, DSH][i], 'owner order');
    check(turn.owner === turn.addonId, 'owner identity');
    check(Number.isSafeInteger(turn.generation) && turn.generation > 0 &&
      (!i || turn.generation > bundle.turns[i - 1].generation), 'owner generation');
    check(['bootEpoch', 'sessionId', 'turnId'].every(key => identifier(turn[key])), 'host provenance');
    check(!ids.has(turn.turnId), 'unique turn'); ids.add(turn.turnId);
    check(turn.dispatch?.accepted === true && timestamp(turn.dispatch.at) &&
      turn.dispatch.source === (turn.addonId === PROVIDER ? 'provider-fabric' : 'dsh-typert'), 'upstream dispatch receipt');
    check(turn.answer?.author === turn.addonId && turn.answer.visible === true &&
      typeof turn.answer.text === 'string' && turn.answer.text.trim() && timestamp(turn.answer.at), 'visible attributed answer');
    check(turn.final?.type === 'final' && turn.final.data?.text === turn.answer.text &&
      ['addonId', 'generation', 'bootEpoch', 'sessionId', 'turnId'].every(key => turn.final[key] === turn[key]), 'final host provenance');
  }
  check(bundle.turns[0].answer.text.trim() !== bundle.turns[1].answer.text.trim() &&
    bundle.turns[2].answer.text.trim() !== bundle.turns[1].answer.text.trim(), 'distinct second answer');
  const g = bundle.governance;
  for (const key of ['installation', 'denied', 'reload', 'revocation', 'removal']) receipt(g?.[key]);
  check(g.installation.addonId === DSH && Array.isArray(g.installation.grants) && !g.installation.grants.length, 'installation grants nothing');
  check(g.denied.code === 'permission-denied' && Number.isSafeInteger(g.denied.dispatchesBefore) &&
    g.denied.dispatchesBefore >= 0 && g.denied.dispatchesAfter === g.denied.dispatchesBefore, 'denial dispatched upstream');
  const { before, after } = g.reload;
  check(before?.addonId === DSH && after?.addonId === DSH && before.granted === true && after.granted === true &&
    before.generation === bundle.turns[2].generation && after.generation === before.generation &&
    identifier(before.bootEpoch) && identifier(after.bootEpoch) && before.bootEpoch !== after.bootEpoch, 'reload/restart persistence');
  const r = g.revocation;
  check(r.addonId === DSH && identifier(r.turnId) && r.dispatched === true && r.cancelled === true &&
    r.streamClosed === true && r.staleSessionCode === 'session-not-found' &&
    Number.isSafeInteger(r.generationBefore) && Number.isSafeInteger(r.generationAfter) && r.generationAfter > r.generationBefore &&
    Array.isArray(r.lateEvents) && r.lateEvents.length === 0, 'revocation fence');
  check(g.removal.addonId === DSH && g.removal.owner === DSH && g.removal.code === 'ownership-conflict' &&
    g.removal.installed === true, 'active owner removal refusal');
  return true;
}

// Resolve symlinks before creating anything; evidence, profiles and Vite cache never enter the repo.
export async function externalEvidenceDirectory(input) {
  if (!input || !path.isAbsolute(input)) throw new Error('Pass an absolute evidence directory outside the repository.');
  const target = path.resolve(input);
  let ancestor = target;
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
  }
  const repository = await realpath(ROOT);
  if (ancestor === repository || ancestor.startsWith(`${repository}${path.sep}`)) throw new Error('Evidence must be outside the repository.');
  await mkdir(target, { mode: 0o700 }); // Refuse reuse, including existing symlinks or prior evidence.
  return realpath(target);
}

async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Demo did not observe ${label}. Check real DSH/provider availability; no live proof was produced.`);
}

/** Runs the actual React shell against the real authenticated bridge and registry. */
export async function runDemo({ evidenceDir, fixture = false, headed = false } = {}) {
  const output = await externalEvidenceDirectory(evidenceDir);
  const mode = fixture ? 'fixture' : 'live';
  const evidence = { version: 1, mode, startedAt: now(), turns: [], governance: {} };
  const stamp = fields => ({ mode, at: now(), ...fields });
  let browser, vite, server, host;
  const observed = [], dispatches = [], cancellations = [];
  let activeTurn, holdTurn = false, revoking = false;
  const { createHarnessHostService } = await import('../browser-first/host/harness-host-service.mjs');
  const { createHarnessTransport } = await import('../browser-first/host/harness-transport.mjs');
  const { createProviderHostService } = await import('../browser-first/host/provider-host-service.mjs');
  const { startBridgeServer, createBridgeToken } = await import('../browser-first/host/bridge-server.mjs');
  const { devBridgeConfigPlugin, EXPECTED_DEV_SERVER_FS_DENY } = await import('./vite-dev-bridge-config.mjs');
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { chromium } = await import('playwright');
  const bridgeToken = createBridgeToken(), capabilityBootstrapToken = createBridgeToken();
  const bridgeCapabilityTokens = Object.fromEntries(['addon-runtime-read', 'addon-runtime-control',
    'provider-diagnostics-read', 'provider-model-invoke', 'provider-credential-write', 'provider-routing-write'].map(key => [key, createBridgeToken()]));
  const origin = 'http://127.0.0.1:1430';
  let bridgeConfig;
  const manifest = JSON.parse(await readFile(new URL('../browser-first/host/harness-examples/deepseek-harness.json', import.meta.url)));
  const bindings = fixture ? [{ name: 'dsh.main', addonId: DSH, adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', endpoint: manifest.agentRuntime.endpoint, source: { env: 'UNUSED_FIXTURE_TOKEN' } }]
    : JSON.parse(process.env.RESONANTOS_HARNESS_BINDINGS ?? '[]');
  const recordDispatch = (source, accepted = true) => {
    const receipt = { source, accepted, at: now() }; dispatches.push(receipt);
    if (activeTurn) activeTurn.dispatch = receipt;
  };
  // Fixture adapters are used only under the explicit flag. The shell, transport
  // authentication, persistent registry, boundary, event bus and UI remain real.
  const fixtureDsh = () => ({
    async createSession() { return {}; },
    async history() { return { messages: [] }; },
    async status() { return { status: 'idle' }; },
    async *invoke({ signal }) {
      recordDispatch('dsh-typert');
      if (holdTurn) {
        await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
        yield { type: 'final', data: { text: 'LATE FIXTURE OUTPUT MUST BE FENCED' } };
      } else {
        await new Promise(resolve => setTimeout(resolve, 150));
        yield { type: 'final', data: { text: `Fixture DSH reply ${dispatches.length}` } };
      }
    },
    async cancel() { cancellations.push(now()); },
    async dispose() { cancellations.push(now()); },
  });
  const provider = fixture ? {
    async executeProviderStatus() { return { providers: [{ configured: true, models: [{ allowed: true }] }] }; },
    async executeRawProviderChat() { await new Promise(resolve => setTimeout(resolve, 150)); return { reply: 'Fixture provider reply, independently routed.' }; },
    providerBridgeRoutes: [],
  } : createProviderHostService({ redactDiagnosticText: () => '[redacted]', extractJsonObject: JSON.parse });
  const rawChat = provider.executeRawProviderChat.bind(provider);
  provider.executeRawProviderChat = async (...args) => {
    const result = await rawChat(...args); recordDispatch('provider-fabric'); return result;
  };
  async function startHost() {
    host = await createHarnessHostService({ userRoot: path.join(output, 'user'), bindings, providerHost: provider,
      env: { ...process.env, RESONANTOS_HARNESS_DEMO: '1' },
      ...(fixture ? { transportFactory: async () => ({ dispose() {} }), dshAdapterFactory: fixtureDsh } : {
        transportFactory: async options => {
          const transport = await createHarnessTransport(options);
          return { ...transport, async request(route, options) {
            if (route === '/api/session/cancel') cancellations.push(now());
            const result = await transport.request(route, options);
            if (route === '/api/session/prompt') recordDispatch('dsh-typert', result.body?.result?.ok === true && result.body?.result?.value?.accepted === true);
            return result;
          } };
        },
      }),
    });
    host.registry.onFence(({ slot }) => {
      if (revoking && slot === 'primary-agent' && activeTurn) activeTurn.fenceIndex = activeTurn.events.length;
    });
    const routes = host.harnessRoutes.map(route => ({ ...route, async handler(payload, request) {
      let turn;
      if (route.path === '/agent/turn') {
        turn = stamp({ ...payload.session, owner: host.registry.snapshot().slots['primary-agent']?.addonId, events: [] });
        activeTurn = turn; observed.push(turn);
      }
      const result = await route.handler(payload, request);
      if (turn) turn.turnId = result.turnId;
      if (route.path === '/agent/events') {
        const query = new URL(request.url, origin).searchParams;
        const target = observed.findLast(item => item.sessionId === query.get('sessionId'));
        if (target) {
          const events = result.events;
          result.events = { async *[Symbol.asyncIterator]() {
            try { for await (const event of events) { target.events.push({ at: now(), event }); yield event; } }
            finally { target.closedAt = now(); }
          } };
        }
      }
      return result;
    } }));
    server = await startBridgeServer({ port: 0, host: '127.0.0.1', bridgeToken, capabilityBootstrapToken, bridgeCapabilityTokens,
      routes: [...routes, ...host.composeProviderRoutes(provider.providerBridgeRoutes)], allowedOrigins: [origin], openPathPrefixes: [] });
    bridgeConfig = { bridgeUrl: `http://127.0.0.1:${server.address().port}`, bridgeToken, capabilityBootstrapToken };
  }
  async function stopHost() {
    await host?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  async function operator(pathname, payload) {
    const response = await fetch(`${bridgeConfig.bridgeUrl}${pathname}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'X-ResonantOS-Bridge-Token': bridgeToken,
        'X-ResonantOS-Bridge-Capability-Token': bridgeCapabilityTokens['addon-runtime-control'] }, body: JSON.stringify(payload) });
    return { status: response.status, ...await response.json() };
  }
  try {
    if (!fixture) {
      assert(bindings.some(binding => binding.name === 'dsh.main' && binding.addonId === DSH), 'Approve dsh.main in RESONANTOS_HARNESS_BINDINGS on the host first.');
      const status = await provider.executeProviderStatus();
      assert(status.providers.some(p => p.configured && p.models?.some(m => m.allowed)), 'A real configured provider is required; fixture mode is explicit.');
    }
    await startHost();
    const pageKey = randomBytes(32).toString('base64url');
    vite = await createServer({ configFile: false, root: ROOT, mode: 'harness-demo', cacheDir: path.join(output, 'vite-cache'),
      plugins: [devBridgeConfigPlugin({ env: () => ({ RESONANTOS_DEV_BRIDGE_CONFIG: '1', RESONANTOS_DEV_BRIDGE_PAGE_KEY: pageKey }),
        readConfig: async () => bridgeConfig, expectedPort: 1430 }), react()],
      server: { host: '127.0.0.1', port: 1430, strictPort: true, allowedHosts: ['127.0.0.1'], cors: false,
        fs: { strict: true, deny: [...EXPECTED_DEV_SERVER_FS_DENY] },
        watch: { ignored: ['**/bridge-config.generated.js', '**/ResonantOS_User/**', '**/.rig-in/**'] } },
    });
    await vite.listen();
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({ httpCredentials: { username: 'dev', password: pageKey }, viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(origin);
    await page.getByRole('button', { name: 'Apply Selection', exact: true }).click();
    const addons = async () => {
      await page.getByRole('button', { name: /Add-ons/ }).first().click();
      await page.getByRole('button', { name: 'Refresh harnesses' }).waitFor();
    };
    await addons();
    const card = name => page.getByRole('region', { name, exact: true });
    async function clickResponse(locator, pathname) {
      const response = page.waitForResponse(r => new URL(r.url()).pathname === pathname && r.request().method() === 'POST');
      await locator.click();
      const result = await response;
      return { status: result.status(), ...await result.json() };
    }
    async function grant(name) {
      await card(name).getByRole('button', { name: 'Grant', exact: true }).first().waitFor();
      while (await card(name).getByRole('button', { name: 'Grant', exact: true }).count()) {
        const count = await card(name).getByRole('button', { name: 'Grant', exact: true }).count();
        const result = await clickResponse(card(name).getByRole('button', { name: 'Grant', exact: true }).first(), '/addons/grants');
        assert.equal(result.status, 200);
        await until(async () => await card(name).getByRole('button', { name: 'Grant', exact: true }).count() < count, 'acknowledged grant');
      }
    }
    async function select(name) {
      const result = await clickResponse(card(name).getByRole('button', { name: /^(Make primary|Replace)$/ }), '/addons/slots/assign');
      assert.equal(result.status, 200);
      await page.getByText(`Current owner: ${name} · Available`, { exact: true }).waitFor();
    }
    await clickResponse(card('DeepSeek Harness').getByRole('button', { name: 'Install', exact: true }), '/addons/install');
    let projection = host.registry.snapshot();
    evidence.governance.installation = stamp({ addonId: DSH, grants: projection.installations[DSH].grantedCapabilities.filter(g => g.granted).map(g => g.capability) });
    const beforeDenied = dispatches.length;
    const denied = await clickResponse(card('DeepSeek Harness').getByRole('button', { name: 'Make primary' }), '/addons/slots/assign');
    evidence.governance.denied = stamp({ code: denied.code, dispatchesBefore: beforeDenied, dispatchesAfter: dispatches.length });
    await grant('DeepSeek Harness'); await select('DeepSeek Harness');
    async function send(prompt, complete = true) {
      // The normal chat rail is retained across workspace navigation.
      const composer = page.locator('textarea[placeholder^="Message "]');
      if (!(await composer.isVisible())) await page.getByRole('button', { name: 'Chat', exact: true }).click();
      const count = observed.length;
      await composer.fill(prompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const turn = await until(() => observed[count]?.turnId && observed[count], 'host turn registration');
      await until(() => turn.dispatch?.accepted, 'upstream accepted dispatch', 150000);
      if (complete) {
        const final = await until(() => turn.events.find(item => item.event.type === 'final')?.event, 'host final reply', 150000);
        // The DOM must show the host-attributed message, not a model's self-identification.
        const message = page.locator('article.message-bubble.assistant').filter({ hasText: final.data.text }).last();
        await message.waitFor();
        assert((await message.innerText()).includes(turn.addonId), 'UI answer must name the host owner');
        const { events, closedAt, ...receipt } = turn;
        evidence.turns.push({ ...receipt, final, answer: { author: turn.addonId, text: final.data.text, visible: true, at: now() } });
      }
      return turn;
    }
    await send('Reply with one short plain-text sentence about the number seven.');
    await clickResponse(card('Provider Chat Demo').getByRole('button', { name: 'Install', exact: true }), '/addons/install');
    await grant('Provider Chat Demo'); await select('Provider Chat Demo');
    await send('Reply with one short plain-text sentence about an ocean.');
    await select('DeepSeek Harness');
    await send('Reply with one short plain-text sentence about a mountain.');
    const persisted = () => {
      const s = host.registry.snapshot(), owner = s.slots['primary-agent'];
      return { addonId: owner.addonId, generation: owner.generation, bootEpoch: s.bootEpoch,
        granted: s.installations[DSH].grantedCapabilities.every(g => g.granted) };
    };
    const before = persisted();
    await stopHost(); await startHost(); await page.reload(); await addons();
    await page.getByText('Current owner: DeepSeek Harness · Available', { exact: true }).waitFor();
    evidence.governance.reload = stamp({ before, after: persisted() });
    holdTurn = true;
    const revoked = await send('Write a detailed 2000-word explanation of prime numbers. Continue until the full explanation is complete.', false);
    assert(!revoked.events.some(item => item.event.type === 'final'), 'Turn finished before revocation; rerun to obtain mid-response evidence.');
    projection = host.registry.snapshot();
    const generationBefore = projection.slots['primary-agent'].generation, cancelsBefore = cancellations.length;
    // There is no revoke button in 1G. The operator uses the real authenticated
    // host transaction, then refreshes the UI projection; no browser state edits.
    revoking = true;
    const result = await operator('/addons/grants', { addonId: DSH, consent: true, expectedRevision: projection.revision,
      grants: projection.installations[DSH].grantedCapabilities.map(g => ({ ...g, granted: false })) });
    assert.equal(result.status, 200);
    assert(Number.isSafeInteger(revoked.fenceIndex), 'Host must observe the ownership fence.');
    await page.getByRole('button', { name: 'Refresh harnesses' }).click();
    await until(() => revoked.closedAt, 'revoked stream closure');
    await until(() => cancellations.length > cancelsBefore, 'upstream cancellation attempt');
    const stale = await operator('/agent/turn', { session: Object.fromEntries(['addonId', 'sessionId', 'generation', 'bootEpoch'].map(key => [key, revoked[key]])),
      input: { messages: [{ role: 'user', content: 'This stale turn must never execute.' }] } });
    evidence.governance.revocation = stamp({ addonId: DSH, turnId: revoked.turnId, generationBefore,
      generationAfter: host.registry.snapshot().slots['primary-agent'].generation, dispatched: revoked.dispatch.accepted,
      cancelled: cancellations.length > cancelsBefore, streamClosed: Boolean(revoked.closedAt), staleSessionCode: stale.code,
      lateEvents: revoked.events.slice(revoked.fenceIndex).filter(item => ['delta', 'final'].includes(item.event.type)) });
    const removal = await clickResponse(card('DeepSeek Harness').getByRole('button', { name: 'Remove', exact: true }), '/addons/remove');
    evidence.governance.removal = stamp({ addonId: DSH, owner: host.registry.snapshot().slots['primary-agent'].addonId,
      code: removal.code, installed: host.registry.snapshot().installations[DSH].installed });
    evidence.finishedAt = now();
    verifyEvidence(evidence, { requireLive: !fixture });
    await page.screenshot({ path: path.join(output, 'governance.png'), fullPage: true });
    await writeFile(path.join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return evidence;
  } finally {
    await browser?.close(); await vite?.close(); await stopHost();
    await rm(path.join(output, 'vite-cache'), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--verify') {
      assert(args.length === 2 || (args.length === 3 && args[2] === '--fixture'), 'Usage: --verify evidence.json [--fixture]');
      verifyEvidence(JSON.parse(await readFile(args[1], 'utf8')), { requireLive: !args.includes('--fixture') });
      console.log(args.includes('--fixture') ? 'Fixture evidence verified; not live proof.' : 'Evidence is internally consistent; liveness is attested by the operator who ran the demo and by its witnesses, not proven by this verifier');
    } else {
      const positional = args.filter(arg => !arg.startsWith('--'));
      assert(positional.length === 1 && args.every(arg => !arg.startsWith('--') || ['--fixture', '--headed'].includes(arg)),
        'Usage: node scripts/harness-swap-demo.mjs /absolute/external/evidence-directory [--fixture] [--headed]');
      const result = await runDemo({ evidenceDir: positional[0], fixture: args.includes('--fixture'), headed: args.includes('--headed') });
      console.log(`${result.mode} evidence written outside the repository.`);
    }
  } catch (error) {
    // Do not print transport errors, bindings, upstream bodies, or credentials.
    console.error(`Harness demo failed (${error?.code ?? error?.name ?? 'Error'}). No live certification. Check prerequisites and receipt assertions.`);
    if (error?.name === 'AssertionError' || /^Invalid demo evidence:|^Pass an absolute|^Evidence must|^Usage:|^Demo did not observe/.test(error?.message)) console.error(error.message);
    process.exitCode = 1;
  }
}
