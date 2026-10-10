import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedBarActions } from '../resonantos-side-panel-extension/src/lib/embed-bar-actions.js';

function fixture({ mode = 'ask-before-action', failPermissions = false,
  onlyExtension = false, failWrite = false } = {}) {
  const sent = [], assigned = [], writes = [];
  const extension = { id: 1, active: true, url: 'chrome-extension://abc/src/side-panel.html', title: 'Augmentor' };
  const page = { id: 2, active: false, url: 'http://127.0.0.1:18890/fixture?secret=1', title: 'Fixture title' };
  const tabs = onlyExtension ? [extension] : [extension, page];
  const chromeApi = {
    tabs: { query: async () => tabs, get: async id => tabs.find(tab => tab.id === id) },
    webNavigation: { getAllFrames: async () => [] },
    storage: { local: {
      get: async key => {
        if (key === 'augmentorSitePermissions') {
          if (failPermissions) throw Error('private storage error');
          return { augmentorSitePermissions: { '127.0.0.1': mode } };
        }
        return { augmentorBrowserJobs: [{ id: 'a', status: 'approval',
          pendingApproval: { reason: 'Review', step: { type: 'click' } } }] };
      },
      set: async value => { if (failWrite) throw Error('write failed'); writes.push(value); }
    } }
  };
  const actions = createEmbedBarActions({ chromeApi,
    locationRef: { href: 'https://test.invalid/p?agentView=embed', assign: url => assigned.push(url) },
    sendContext: message => { sent.push(message); return true; }
  });
  return { actions, sent, assigned, writes, chromeApi, page };
}

test('Page selects the fixture instead of an active extension tab and sends exactly once', async () => {
  const f = fixture();
  assert.equal(await f.actions.sharePage(), 'Page shared');
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0], { type: 'augmentor-context', context: {
    source: 'resonantos', page: { title: 'Fixture title', url: 'http://127.0.0.1:18890/fixture' }
  } });
  f.page.title = 'Updated title';
  assert.equal(await f.actions.sharePage(), 'Page shared');
  assert.equal(f.sent[1].context.page.title, 'Updated title');
});

test('site-permission guard sends nothing for blocked, unknown, or unreadable state', async () => {
  for (const options of [{ mode: 'blocked' }, { mode: 'unexpected' }, { failPermissions: true }]) {
    const f = fixture(options);
    assert.notEqual(await f.actions.sharePage(), 'Page shared');
    assert.deepEqual(f.sent, []);
  }
  const missing = fixture();
  delete missing.chromeApi.storage.local.get;
  assert.equal(await missing.actions.sharePage(), 'Site permissions unavailable');
  assert.deepEqual(missing.sent, []);
});

test('allowed read modes share; restricted tabs and failed sends do not report success', async () => {
  for (const mode of ['read-only', 'ask-before-action', 'trusted-for-safe-actions']) {
    assert.equal(await fixture({ mode }).actions.sharePage(), 'Page shared');
  }
  const restricted = fixture({ onlyExtension: true });
  assert.equal(await restricted.actions.sharePage(), 'No readable page');
  assert.deepEqual(restricted.sent, []);
  const f = fixture();
  const actions = createEmbedBarActions({ chromeApi: f.chromeApi,
    locationRef: {}, sendContext: () => false });
  assert.equal(await actions.sharePage(), 'Assistant offline');
});

test('preferences reload only after persistence and approvals use the existing read path', async () => {
  const f = fixture();
  assert.equal(await f.actions.readApprovals(), 1);
  await f.actions.selectAssistant('normal');
  assert.deepEqual(f.writes, [{ 'resonantos.agentView': 'normal' }]);
  assert.equal(new URL(f.assigned[0]).searchParams.get('agentView'), 'normal');
  const failed = fixture({ failWrite: true });
  await assert.rejects(failed.actions.selectAssistant('normal'));
  assert.deepEqual(failed.assigned, []);
  f.chromeApi.storage.local.get = async () => { throw Error('unreadable'); };
  assert.equal(await f.actions.readApprovals(), null);
});
