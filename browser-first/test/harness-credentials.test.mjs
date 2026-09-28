import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const module = await import('../host/harness-credentials.mjs').catch(() => ({}));
const secret = () => randomBytes(32).toString('base64url');
const runtime = { adapterId: 'dsh-typert-v1', authScheme: 'dsh-action-token', credentialBinding: 'dsh.main', endpoint: 'http://127.0.0.1:3080' };
const binding = { name: 'dsh.main', addonId: 'addon.dsh', adapterId: runtime.adapterId, authScheme: runtime.authScheme, endpoint: runtime.endpoint, source: { env: 'DSH_AUGMENTOR_WS_TOKEN' } };
function create(options = {}) {
  assert.equal(typeof module.createHarnessCredentials, 'function', 'host-only named credential custody must exist');
  return module.createHarnessCredentials({ bindings: [binding], env: { DSH_AUGMENTOR_WS_TOKEN: secret() }, ...options });
}

test('binding names do not confer secret access', async () => {
  const canary = secret(), custody = create({ env: { DSH_AUGMENTOR_WS_TOKEN: canary } });
  const lease = await custody.acquire({ addonId: 'addon.dsh', runtime });
  assert.equal(await lease.use(({ actionToken }) => actionToken), canary);
  for (const proposal of [
    { addonId: 'addon.other', runtime },
    { addonId: 'addon.dsh', runtime: { ...runtime, adapterId: 'other' } },
    { addonId: 'addon.dsh', runtime: { ...runtime, authScheme: 'none' } },
    { addonId: 'addon.dsh', runtime: { ...runtime, endpoint: 'http://127.0.0.1:3081' } },
    { addonId: 'addon.dsh', runtime: { ...runtime, credentialBinding: 'missing' } },
  ]) await assert.rejects(custody.acquire(proposal), { code: 'permission-denied' });
  const launch = secret(), cookie = `dsh-auth-local=${secret()}`;
  lease.remember(launch); lease.remember(cookie);
  const variants = [canary, launch, cookie].flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]);
  for (const sink of ['projection', 'log', 'event', 'persistence']) {
    const safe = JSON.stringify(lease.sanitize({ [sink]: variants.join(' '), authorization: canary, cookie, source: '/private/token' }));
    for (const variant of variants) assert.ok(!safe.includes(variant), `${sink} must redact credential variants`);
    assert.ok(!safe.includes('/private/token'));
  }
  assert.equal(JSON.stringify(custody), '{}');
  assert.ok(!JSON.stringify(lease).includes(canary));
  lease.dispose();
  await assert.rejects(lease.use(() => 'unexpected'), { code: 'runtime-unavailable' });
  // Retired output must still be redacted.
  assert.equal(lease.sanitize(canary), '[redacted]');
});

test('host bindings are snapshotted and secrets are bounded and validated', async () => {
  const config = structuredClone(binding), env = { DSH_AUGMENTOR_WS_TOKEN: secret() };
  const custody = create({ bindings: [config], env });
  config.addonId = 'addon.other'; config.endpoint = 'http://127.0.0.1:9999';
  await custody.acquire({ addonId: 'addon.dsh', runtime });
  for (const value of ['', 'x'.repeat(8193), 'token\r\ninjected: yes']) {
    env.DSH_AUGMENTOR_WS_TOKEN = value;
    await assert.rejects(custody.acquire({ addonId: 'addon.dsh', runtime }), { code: 'runtime-unavailable' });
  }
});

test('operator token files require private regular files and bounded reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'token'), canary = secret();
  await writeFile(file, `${canary}\n`, { mode: 0o600 });
  const from = path => create({ bindings: [{ ...binding, source: { file: path } }] });
  const lease = await from(file).acquire({ addonId: 'addon.dsh', runtime });
  assert.equal(await lease.use(({ actionToken }) => actionToken), canary);
  await chmod(file, 0o644);
  await assert.rejects(from(file).acquire({ addonId: 'addon.dsh', runtime }), { code: 'runtime-unavailable' });
  await chmod(file, 0o600);
  await writeFile(file, 'x'.repeat(8193));
  await assert.rejects(from(file).acquire({ addonId: 'addon.dsh', runtime }), { code: 'runtime-unavailable' });
  await symlink(file, join(root, 'link'));
  await assert.rejects(from(join(root, 'link')).acquire({ addonId: 'addon.dsh', runtime }), { code: 'runtime-unavailable' });
  await assert.rejects(from(root).acquire({ addonId: 'addon.dsh', runtime }), { code: 'runtime-unavailable' });
});
