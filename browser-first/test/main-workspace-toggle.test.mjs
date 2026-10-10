import assert from "node:assert/strict";
import test from "node:test";

import {
  MAIN_WORKSPACE_PATH,
  createMainWorkspaceToggle,
  isMainWorkspaceUrl,
  mainWorkspaceVisible,
  resolveMainWorkspaceToggle
} from "../resonantos-side-panel-extension/src/lib/main-workspace-toggle.js";

const workspaceUrl = `chrome-extension://abcdef${MAIN_WORKSPACE_PATH}`;
const pageUrl = "https://example.com/";

test("isMainWorkspaceUrl matches only the workspace page", () => {
  assert.equal(isMainWorkspaceUrl(workspaceUrl), true);
  assert.equal(isMainWorkspaceUrl(pageUrl), false);
  assert.equal(isMainWorkspaceUrl(""), false);
  assert.equal(isMainWorkspaceUrl("not a url"), false);
});

test("resolveMainWorkspaceToggle opens when no workspace tab exists", () => {
  const tabs = [{ id: 1, url: pageUrl, active: true }];
  assert.deepEqual(resolveMainWorkspaceToggle(tabs), { action: "open", visible: true });
});

test("resolveMainWorkspaceToggle focuses a backgrounded workspace tab", () => {
  const tabs = [
    { id: 1, url: pageUrl, active: true },
    { id: 2, url: workspaceUrl, active: false, windowId: 9 }
  ];
  assert.deepEqual(resolveMainWorkspaceToggle(tabs), { action: "focus", tabId: 2, windowId: 9, visible: true });
});

test("resolveMainWorkspaceToggle closes the workspace when it is being viewed", () => {
  const tabs = [
    { id: 1, url: pageUrl, active: false },
    { id: 2, url: workspaceUrl, active: true, windowId: 9 }
  ];
  assert.deepEqual(resolveMainWorkspaceToggle(tabs), { action: "close", tabId: 2, visible: false });
});

test("mainWorkspaceVisible reflects the active tab only", () => {
  assert.equal(mainWorkspaceVisible([{ id: 2, url: workspaceUrl, active: true }]), true);
  assert.equal(mainWorkspaceVisible([{ id: 2, url: workspaceUrl, active: false }]), false);
  assert.equal(mainWorkspaceVisible([{ id: 1, url: pageUrl, active: true }]), false);
});

function createTabsApi(tabs) {
  const calls = [];
  return {
    calls,
    api: {
      query: async () => tabs,
      create: async (opts) => { calls.push(["create", opts]); return { id: 99 }; },
      update: async (id, opts) => { calls.push(["update", id, opts]); },
      remove: async (id) => { calls.push(["remove", id]); }
    }
  };
}

test("toggle opens the workspace when none is open", async () => {
  const { api, calls } = createTabsApi([{ id: 1, url: pageUrl, active: true }]);
  const toggle = createMainWorkspaceToggle({ tabsApi: api, getWorkspaceUrl: () => workspaceUrl });

  const visible = await toggle.toggle();

  assert.equal(visible, true);
  assert.deepEqual(calls, [["create", { url: workspaceUrl, active: true }]]);
});

test("toggle focuses a backgrounded workspace tab and its window", async () => {
  const { api, calls } = createTabsApi([
    { id: 1, url: pageUrl, active: true },
    { id: 2, url: workspaceUrl, active: false, windowId: 9 }
  ]);
  const windowCalls = [];
  const windowsApi = { update: async (id, opts) => { windowCalls.push([id, opts]); } };
  const toggle = createMainWorkspaceToggle({ tabsApi: api, windowsApi, getWorkspaceUrl: () => workspaceUrl });

  const visible = await toggle.toggle();

  assert.equal(visible, true);
  assert.deepEqual(calls, [["update", 2, { active: true }]]);
  assert.deepEqual(windowCalls, [[9, { focused: true }]]);
});

test("toggle closes the workspace when it is the viewed tab", async () => {
  const { api, calls } = createTabsApi([
    { id: 1, url: pageUrl, active: false },
    { id: 2, url: workspaceUrl, active: true, windowId: 9 }
  ]);
  const toggle = createMainWorkspaceToggle({ tabsApi: api, getWorkspaceUrl: () => workspaceUrl });

  const visible = await toggle.toggle();

  assert.equal(visible, false);
  assert.deepEqual(calls, [["remove", 2]]);
});

test("toggle keeps the window alive by opening a default tab before closing the last one", async () => {
  const { api, calls } = createTabsApi([
    { id: 2, url: workspaceUrl, active: true, windowId: 9 }
  ]);
  const toggle = createMainWorkspaceToggle({ tabsApi: api, getWorkspaceUrl: () => workspaceUrl });

  await toggle.toggle();

  assert.deepEqual(calls, [["create", {}], ["remove", 2]]);
});

test("isVisible queries the current window and detects the workspace", async () => {
  const { api } = createTabsApi([{ id: 2, url: workspaceUrl, active: true, windowId: 9 }]);
  const toggle = createMainWorkspaceToggle({ tabsApi: api, getWorkspaceUrl: () => workspaceUrl });

  assert.equal(await toggle.isVisible(), true);
});

test('open focuses an active or background workspace and never closes it', async () => {
  for (const active of [true, false]) {
    const calls = [];
    const control = createMainWorkspaceToggle({
      tabsApi: {
        query: async query => { calls.push(['query', query]); return [
          { id: 7, windowId: 3, url: workspaceUrl, active }
        ]; },
        update: async (...args) => calls.push(['update', ...args]),
        remove: async () => { throw Error('must not close'); },
        create: async () => { throw Error('must not duplicate'); }
      },
      windowsApi: { update: async (...args) => calls.push(['window', ...args]) },
      getWorkspaceUrl: () => workspaceUrl
    });
    assert.equal(await control.open({ windowId: 3 }), true);
    assert.deepEqual(calls, [ ['query', { windowId: 3 }],
      ['update', 7, { active: true }], ['window', 3, { focused: true }] ]);
  }
});

test('open creates only when absent in the target window', async () => {
  const calls = [];
  const control = createMainWorkspaceToggle({
    tabsApi: { query: async () => [], create: async options => calls.push(options) },
    windowsApi: {}, getWorkspaceUrl: () => workspaceUrl
  });
  assert.equal(await control.open({ windowId: 9 }), true);
  assert.deepEqual(calls, [{ url: workspaceUrl, active: true, windowId: 9 }]);
});
