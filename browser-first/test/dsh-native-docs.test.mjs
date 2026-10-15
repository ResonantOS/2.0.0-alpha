import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('native operator documentation preserves isolation, consent and coexistence', async () => {
  const doc = await readFile(new URL('../../docs/addons/harness-adapter-demo.md', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../host/README.md', import.meta.url), 'utf8');
  for (const text of ['## Native DSH authentication', 'RESONANTOS_DSH_PACKAGE_ROOT', 'RESONANTOS_DSH_HOME',
    'managedDsh', 'DSH_TELEMETRY_MODE=DISABLED', '50000', 'depth 64', '30 seconds', '3 seconds',
    'dsh-native-cookie', 'dsh-action-token', 'shell', 'filesystem', 'No automatic migration', 'No automatic restart',
    'DEEPSEEK_API_KEY', 'No provider key is required for protocol readiness', 'unconfirmed exit', 'local sink',
    '0.2.0-rc.2', '0.1.5-rc.1', '0.1.7-rc.2', 'anchor-missing', 'Runtime unavailable.']) assert.ok(doc.includes(text), text);
  assert.ok(readme.includes('../../docs/addons/harness-adapter-demo.md#native-dsh-authentication'));
});
