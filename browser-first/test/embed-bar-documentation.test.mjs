import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('bar permissions and ownership have explicit documentation', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const ownership = await readFile(new URL('../../docs/architecture/MODULE-OWNERSHIP.md', import.meta.url), 'utf8');
  for (const text of ['contextMenus', 'Alt+Shift+W', 'Open ResonantOS workspace', 'resonantos.agentView']) {
    assert.ok(readme.includes(text), text);
  }
  for (const text of ['embed-bar.js', 'embed-bar-model.js', 'embed-bar-actions.js', 'workspace-launchers.js', 'GET /embed/status']) {
    assert.ok(ownership.includes(text), text);
  }
  assert.match(ownership, /GET \/embed\/status[^\n]*addon-runtime-control/);
});
