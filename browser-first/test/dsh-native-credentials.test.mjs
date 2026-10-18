import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createHarnessCredentials } from '../host/harness-credentials.mjs';

const runtime = { credentialBinding: 'dsh.native', adapterId: 'dsh-typert-v1', authScheme: 'dsh-native-cookie', endpoint: 'http://127.0.0.1:3081' };
const binding = { name: 'dsh.native', addonId: 'addon.native', adapterId: runtime.adapterId, authScheme: runtime.authScheme, endpoint: runtime.endpoint, source: { managedDsh: true } };

function fixture(refresh = true, version = '0.2.0-rc.2', injectPolicy = true) {
  const controller = new AbortController();
  const token = randomBytes(24).toString('base64url');
  const providerKey = randomBytes(24).toString('base64url');
  let released = 0, failed = 0, acquired = 0;
  const nativeRuntime = { async acquire() {
    acquired++;
    return { isChildAlive: () => true, epoch: 'epoch-1', signal: controller.signal, deadline: Date.now() + 30000, version,
      use: callback => callback({ endpoint: runtime.endpoint, loginToken: token, providerKey }),
      ready() {}, fail() { failed++; controller.abort(); }, release() { released++; } };
  } };
  const options = { bindings: [binding], nativeRuntime };
  if (injectPolicy) options.refreshPolicy = () => refresh;
  const credentials = createHarnessCredentials(options);
  return { credentials, token, providerKey, released: () => released, failed: () => failed, acquired: () => acquired, controller };
}

test('exact public binding fields gate native acquisition before runtime use', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  for (const proposal of [
    { addonId: 'addon.other', runtime },
    { addonId: binding.addonId, runtime: { ...runtime, credentialBinding: 'other' } },
    { addonId: binding.addonId, runtime: { ...runtime, adapterId: 'other' } },
    { addonId: binding.addonId, runtime: { ...runtime, authScheme: 'other' } },
    { addonId: binding.addonId, runtime: { ...runtime, endpoint: 'http://127.0.0.1:3082' } },
  ]) await assert.rejects(f.credentials.acquire({ ...proposal, signal }), { code: 'permission-denied' });
  assert.equal(f.acquired(), 0);
});

test('one exchange and atomic generation across two leases', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  const b = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  let calls = 0;
  const exchange = async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return `dsh-auth-test=${randomBytes(24).toString('base64url')}`; };
  await Promise.all([a.authenticate(exchange, { signal }), b.authenticate(exchange, { signal })]);
  assert.equal(calls, 1);
  const old = await a.use(value => value.cookie);
  await Promise.all([a.authenticate(exchange, { signal, generation: 1, refresh: true }), b.authenticate(exchange, { signal, generation: 1, refresh: true })]);
  assert.equal(calls, 2);
  await b.authenticate(exchange, { signal, generation: 1, refresh: true });
  assert.equal(calls, 2);
  const current = await b.use(value => value.cookie);
  assert.notEqual(current, old);
  await a.dispose();
  await assert.rejects(a.use(() => true), { code: 'runtime-unavailable' });
  assert.equal(await b.use(value => value.generation), 2);
  for (const secret of [old, old.slice(old.indexOf('=') + 1), current, current.slice(current.indexOf('=') + 1), f.token, f.providerKey, `${runtime.endpoint}/?token=${f.token}`]) {
    for (const text of [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]) {
      assert.equal(a.sanitize({ text }).text, '[redacted]', 'each complete registered secret is redacted after disposal');
    }
  }
  await b.dispose();
  assert.equal(f.released(), 2);
});

test('disposed native lease cannot mark ready or fail a runtime held by another lease', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  const b = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  await a.dispose();
  assert.throws(() => a.ready(), { code: 'runtime-unavailable' });
  assert.throws(() => a.fail('runtime-unavailable'), { code: 'runtime-unavailable' });
  assert.equal(f.failed(), 0);
  assert.equal(await b.use(value => value.loginToken), f.token);
  b.ready();
  await b.dispose();
  assert.equal(f.released(), 2);
});

test('disabled refresh fences instead of replaying', async () => {
  const f = fixture(false), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  let exchanges = 0;
  const exchange = async () => { exchanges++; return 'dsh-auth-test=synthetic'; };
  await a.authenticate(exchange, { signal });
  await assert.rejects(a.authenticate(exchange, { signal, generation: 1, refresh: true }), { code: 'runtime-unavailable' });
  assert.equal(exchanges, 1);
  assert.equal(f.failed(), 1);
  await a.dispose();
});

test('epoch loss during exchange cannot publish credentials', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
  let finish;
  const pending = a.authenticate(() => new Promise(resolve => { finish = resolve; }), { signal });
  await new Promise(resolve => setImmediate(resolve));
  f.controller.abort();
  finish('dsh-auth-test=late');
  await assert.rejects(pending, { code: 'runtime-unavailable' });
  await assert.rejects(a.use(() => true), { code: 'runtime-unavailable' });
  await a.dispose();
});

test('simultaneous acquisitions share initialization; cancelled waiter cannot kill live refresh', async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController();
  const [a, b] = await Promise.all([
    f.credentials.acquire({ addonId: binding.addonId, runtime, signal: first.signal }),
    f.credentials.acquire({ addonId: binding.addonId, runtime, signal: second.signal }),
  ]);
  let complete, exchanges = 0;
  const exchange = () => { exchanges++; return new Promise(resolve => { complete = resolve; }); };
  const one = a.authenticate(exchange, { signal: first.signal });
  const rejected = assert.rejects(one, { code: 'runtime-unavailable' });
  const two = b.authenticate(exchange, { signal: second.signal });
  await new Promise(resolve => setImmediate(resolve));
  first.abort();
  complete('dsh-auth-test=surviving');
  await rejected;
  await two;
  assert.equal(exchanges, 1);
  assert.equal(f.failed(), 0);
  assert.equal(await b.use(value => value.cookie), 'dsh-auth-test=surviving');
  await assert.rejects(a.authenticate(exchange), { code: 'runtime-unavailable' });
  assert.throws(() => a.readinessLease(), { code: 'runtime-unavailable' });
  await b.dispose();
});

test('default exact-version refresh policy refuses unreviewed versions', async () => {
  for (const [version, refresh] of [['0.2.0-rc.2', true], ['0.1.5-rc.1', false], ['0.1.7-rc.2', false], ['0.2.0', false]]) {
    const f = fixture(true, version, false), signal = new AbortController().signal;
    const lease = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal });
    let calls = 0;
    const exchange = async () => { calls++; return `dsh-auth-test=${calls}`; };
    await lease.authenticate(exchange, { signal });
    if (refresh) {
      await lease.authenticate(exchange, { signal, generation: 1, refresh: true });
      assert.equal(calls, 2, version);
      assert.equal(f.failed(), 0, version);
    } else {
      await assert.rejects(lease.authenticate(exchange, { signal, generation: 1, refresh: true }), { code: 'runtime-unavailable' });
      assert.equal(calls, 1, version);
      assert.equal(f.failed(), 1, version);
    }
    await lease.dispose();
  }
});

test('disposed native cleanup access expires while shared epoch custody serves another lease', async () => {
  const f = fixture(), firstSignal = new AbortController().signal, secondSignal = new AbortController().signal;
  const a = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal: firstSignal });
  const b = await f.credentials.acquire({ addonId: binding.addonId, runtime, signal: secondSignal });
  const cookie = `dsh-auth-test=${randomBytes(24).toString('base64url')}`;
  await a.authenticate(async () => cookie, { signal: firstSignal });
  await a.dispose();
  assert.equal(await a.cleanupUse(value => value), cookie, 'retired lease may read current shared cookie for cleanup only');
  await assert.rejects(a.use(value => value.cookie), { code: 'runtime-unavailable' });
  assert.equal(await b.use(value => value.cookie), cookie, 'other live lease keeps current cookie');
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.throws(() => a.cleanupUse(value => value), { code: 'runtime-unavailable' }, 'retired cleanup access expires after one second');
  assert.equal(await b.use(value => value.cookie), cookie, 'expiry affects only retired session');
  f.controller.abort();
  await assert.rejects(b.use(value => value.cookie), { code: 'runtime-unavailable' }, 'epoch loss fences normal access immediately');
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.throws(() => b.cleanupUse(value => value), { code: 'runtime-unavailable' }, 'shared cookie cleanup access expires after epoch stop');
  assert.equal(b.sanitize({ text: cookie }).text, '[redacted]', 'late redaction survives cleanup expiry');
  await b.dispose();
});
