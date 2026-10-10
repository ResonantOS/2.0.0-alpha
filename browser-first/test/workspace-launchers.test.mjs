
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installWorkspaceLaunchers } from '../resonantos-side-panel-extension/src/lib/workspace-launchers.js';

function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), fire: (...args) =>
    Promise.all(listeners.map(fn => fn(...args))) };
}

test('command and toolbar item open/focus; unrelated events do nothing', async () => {
  const calls = [], menus = [], removed = [];
  const chromeApi = {
    runtime: { onInstalled: event(), onStartup: event(), lastError: undefined },
    commands: { onCommand: event() },
    contextMenus: { onClicked: event(),
      remove: async id => removed.push(id),
      create: (item, done) => { menus.push(item); done(); }
    }
  };
  installWorkspaceLaunchers({ chromeApi, openWorkspace: async options => calls.push(options) });
  await chromeApi.runtime.onInstalled.fire();
  await chromeApi.runtime.onStartup.fire();
  assert.deepEqual(removed, ['open-resonantos-workspace', 'open-resonantos-workspace']);
  assert.deepEqual(menus, Array.from({ length: 2 }, () => ({
    id: 'open-resonantos-workspace', title: 'Open ResonantOS workspace', contexts: ['action']
  })));
  await chromeApi.commands.onCommand.fire('open-resonantos-workspace', { windowId: 4 });
  await chromeApi.contextMenus.onClicked.fire({ menuItemId: 'open-resonantos-workspace' }, { windowId: 7 });
  await chromeApi.commands.onCommand.fire('open-augmentor-side-panel');
  await chromeApi.contextMenus.onClicked.fire({ menuItemId: 'unrelated' }, {});
  assert.deepEqual(calls, [{ windowId: 4 }, { windowId: 7 }]);
  const source = await readFile(new URL('../resonantos-side-panel-extension/src/background.js', import.meta.url), 'utf8');
  assert.match(source, /installWorkspaceLaunchers\(\{/);
  assert.match(source, /openWorkspace:\s*workspaceLauncher\.open/);
});
