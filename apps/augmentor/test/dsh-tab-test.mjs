#!/usr/bin/env node

// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * DSH-session-tab protection test (extension/worktab.mjs + actions.mjs).
 *
 * The headline regression: when the user's active tab hosts the DSH web GUI
 * (the session the agent is talking through), the agent must NOT navigate it
 * away. Instead: browser_navigate opens a DEDICATED tab, and the read
 * actions fail with a directive error. workTab() also never picks a DSH
 * session tab as a recency fallback, and a sticky work tab the user has
 * navigated onto the DSH GUI loses its stickiness.
 *
 * Loads the real modules with a stubbed chrome API (the old
 * lab/worktab-test.mjs VM harness predates the F1 module split and cannot
 * import ESM; this test drives the split modules directly).
 *
 * Run: node test/dsh-tab-test.mjs
 */
import assert from 'node:assert/strict'

const DSH = 'http://127.0.0.1:3080'
const DSH_URL = DSH + '/some/session'

// -------------------------------------------------------------- chrome stub
// One stub for the whole run; `env` is mutated between scenarios. Listeners
// are registered by the modules at import time, so the stub must exist
// BEFORE the dynamic imports below.
const env = {
  focusedWindowId: 1,
  windowsPerm: true,
  tabs: [],
  created: [],
  activated: [],
}
const onActivated = []
const onRemoved = []
const onUpdated = []
globalThis.chrome = {
  runtime: {
    id: 'testextensionid',
    sendMessage: () => Promise.resolve(),
  },
  windows: {
    getLastFocused: () =>
      env.windowsPerm
        ? Promise.resolve({ id: env.focusedWindowId })
        : Promise.reject(new Error('no windows permission')),
  },
  tabs: {
    onActivated: { addListener: (fn) => onActivated.push(fn) },
    onRemoved: { addListener: (fn) => onRemoved.push(fn) },
    onUpdated: {
      addListener: (fn) => onUpdated.push(fn),
      removeListener: (fn) => {
        const i = onUpdated.indexOf(fn)
        if (i >= 0) onUpdated.splice(i, 1)
      },
    },
    query: (opts = {}) => {
      let tabs = env.tabs
      if (opts.windowId != null) tabs = tabs.filter((t) => t.windowId === opts.windowId)
      if (opts.currentWindow) tabs = tabs.filter((t) => t.windowId === env.focusedWindowId)
      if (opts.active) tabs = tabs.filter((t) => t.active)
      return Promise.resolve(tabs.map((t) => ({ ...t })))
    },
    get: (id) => {
      const t = env.tabs.find((x) => x.id === id)
      return t ? Promise.resolve({ ...t }) : Promise.reject(new Error('No tab with id ' + id))
    },
    update: async (id, props) => {
      const t = env.tabs.find((x) => x.id === id)
      if (!t) throw new Error('No tab with id ' + id)
      Object.assign(t, props)
      return { ...t }
    },
    create: async (props) => {
      const t = {
        id: 1000 + env.created.length,
        windowId: env.focusedWindowId,
        active: true,
        status: 'complete',
        ...props,
      }
      for (const x of env.tabs) if (x.windowId === t.windowId) x.active = false
      env.tabs.push(t)
      env.created.push(t)
      return { ...t }
    },
  },
  scripting: {
    executeScript: async () => [{ result: 'stub-injected' }],
  },
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    onChanged: { addListener: () => {} },
  },
}

// -------------------------------------------------------------- module load
const { state: swState } = await import('../extension/state.mjs')
swState.endpoint = DSH // what the pipe's initialize handshake would report
const { workTab, isDshTab } = await import('../extension/worktab.mjs')
const { handleBrowserAction } = await import('../extension/actions.mjs')

// -------------------------------------------------------------- scenarios
let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log('PASS  ' + name)
  } catch (e) {
    failures += 1
    console.log('FAIL  ' + name + ' — ' + e.message)
  }
}
function setTabs(defs) {
  env.tabs = defs.map((d, i) => ({
    id: i + 1,
    windowId: 1,
    active: false,
    status: 'complete',
    title: d.url.slice(0, 20),
    ...d,
  }))
  env.created = []
  swState.workTabId = null
  swState.overlayTabId = null
  swState.turnActive = false
}
const byUrl = (url) => env.tabs.find((t) => t.url === url)
async function rejectsDSH(promise) {
  let threw = null
  try {
    await promise
  } catch (e) {
    threw = e
  }
  assert.ok(threw, 'expected a throw')
  assert.match(String(threw.message), /DSH session/)
}

// 1. Control: the active normal tab wins (behavior unchanged).
await check('control: active normal tab is the work tab', async () => {
  setTabs([
    { url: 'https://amazon.com' },
    { url: 'https://wikipedia.org', active: true },
  ])
  const t = await workTab()
  assert.equal(t.url, 'https://wikipedia.org')
})

// 2. Regression R (from the old harness): an active NEW TAB beats the first
//    tab in the list, even without the "windows" permission.
await check('regression R: active new-tab page wins over first tab', async () => {
  env.windowsPerm = false
  setTabs([
    { url: 'https://amazon.com' },
    { url: 'chrome://newtab/', active: true },
  ])
  const t = await workTab()
  assert.equal(t.url, 'chrome://newtab/')
  env.windowsPerm = true
})

// 3. THE fix: user's active tab is the DSH session + another usable tab
//    exists — workTab() must throw the directive (navigate's catch becomes
//    the new-tab path), never hijack the other tab.
await check('DSH tab active: workTab throws the directive', async () => {
  setTabs([
    { url: DSH_URL, active: true },
    { url: 'https://amazon.com' },
  ])
  await rejectsDSH(workTab())
})

// 4. DSH session is the ONLY tab open: same directive (navigate creates a
//    dedicated tab).
await check('DSH tab only: workTab throws the directive', async () => {
  setTabs([{ url: DSH_URL, active: true }])
  await rejectsDSH(workTab())
})

// 5. Sticky: the agent's own work tab stays put when the user flips to the
//    DSH tab mid-turn.
await check('sticky work tab survives the user switching to the DSH tab', async () => {
  setTabs([
    { url: 'https://agent-tab.example' },
    { url: DSH_URL },
  ])
  env.tabs[0].active = true
  let t = await workTab()
  assert.equal(t.url, 'https://agent-tab.example')
  env.tabs[0].active = false
  env.tabs[1].active = true // user flips to their DSH session
  t = await workTab()
  assert.equal(t.url, 'https://agent-tab.example')
})

// 6. The user navigates the agent's sticky tab onto the DSH GUI:
//    stickiness is dropped; resolution goes to the tab now on screen.
await check('sticky tab navigated onto the DSH GUI loses stickiness', async () => {
  setTabs([
    { url: 'https://agent-tab.example' },
    { url: 'https://wikipedia.org' },
  ])
  env.tabs[0].active = true
  let t = await workTab()
  assert.equal(t.url, 'https://agent-tab.example')
  env.tabs[0].url = DSH_URL // user typed the DSH URL into it
  env.tabs[0].active = false
  env.tabs[1].active = true // user then clicks back to wikipedia
  t = await workTab()
  assert.equal(t.url, 'https://wikipedia.org')
})

// 7. Recency fallback (active tab is chrome://internal): the DSH session
//    tab is never a candidate.
await check('recency fallback never picks the DSH tab', async () => {
  setTabs([
    { url: 'chrome://settings/', active: true },
    { url: DSH_URL },
    { url: 'https://wikipedia.org' },
  ])
  onActivated.forEach((fn) => fn({ tabId: 3 }))
  const t = await workTab()
  assert.equal(t.url, 'https://wikipedia.org')
})

// 8. Origin matching: exact, localhost-equivalent, and not fooled by
//    prefix lookalikes (port 30800, subdomain-style tricks, other ports).
await check('isDshTab: exact origin + localhost equivalence, no lookalikes', async () => {
  assert.equal(isDshTab({ url: DSH_URL }), true)
  assert.equal(isDshTab({ url: DSH + '/' }), true)
  assert.equal(isDshTab({ url: 'http://localhost:3080/x' }), true)
  assert.equal(isDshTab({ url: 'http://127.0.0.1:30800/x' }), false)
  assert.equal(isDshTab({ url: 'http://127.0.0.1:3080.evil.example/x' }), false)
  assert.equal(isDshTab({ url: 'http://127.0.0.1:3081/x' }), false)
  assert.equal(isDshTab({ url: 'https://127.0.0.1:3080/x' }), false)
  assert.equal(isDshTab({ url: 'https://amazon.com' }), false)
  assert.equal(isDshTab({ url: null }), false)
})

// 9. Endpoint unknown (handshake not done): no DSH awareness, legacy
//    behavior — a 3080 tab is an ordinary tab.
await check('endpoint null: legacy behavior (no protection)', async () => {
  const saved = swState.endpoint
  swState.endpoint = null
  try {
    setTabs([{ url: DSH_URL, active: true }])
    const t = await workTab()
    assert.equal(t.url, DSH_URL)
  } finally {
    swState.endpoint = saved
  }
})

// 10. HEADLINE, through the real action executor: user is on the DSH
//     session, the agent navigates — a dedicated tab is created, the DSH
//     tab is untouched.
await check('navigate with DSH tab active creates a dedicated tab', async () => {
  setTabs([
    { url: DSH_URL, active: true },
    { url: 'https://amazon.com' },
  ])
  const out = await handleBrowserAction('t10', { action: 'navigate', url: 'https://example.com/' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(out.ok, undefined, `expected ok result, got ${JSON.stringify(out)}`)
  assert.equal(out.newTab, true)
  assert.equal(env.created.length, 1)
  assert.equal(env.created[0].url, 'https://example.com/')
  assert.equal(byUrl(DSH_URL).url, DSH_URL, 'the DSH tab must not be navigated')
  assert.equal(out.tabId, env.created[0].id)
})

// 11. Control: navigate with a normal active tab REUSES it (no tab spray).
await check('navigate with a normal active tab reuses it', async () => {
  setTabs([{ url: 'https://amazon.com', active: true }])
  const out = await handleBrowserAction('t11', { action: 'navigate', url: 'https://example.org/' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(out.newTab, undefined)
  assert.equal(env.created.length, 0)
  assert.equal(env.tabs[0].url, 'https://example.org/')
})

// 12. Read actions on the DSH session tab fail with the directive error.
await check('snapshot with DSH tab active fails with the directive', async () => {
  setTabs([{ url: DSH_URL, active: true }])
  const out = await handleBrowserAction('t12', { action: 'snapshot' })
  assert.equal(out.ok, false)
  assert.match(String(out.error), /DSH session/)
})

// 13. tabs_list marks the DSH session tab (model-facing visibility).
await check('tabs_list marks the DSH session tab', async () => {
  setTabs([
    { url: DSH_URL, active: true },
    { url: 'https://wikipedia.org' },
  ])
  const out = await handleBrowserAction('t13', { action: 'tabs_list' })
  const rows = out.tabs
  assert.equal(rows.length, 2)
  const dshRow = rows.find((r) => r.url === DSH_URL)
  const wikiRow = rows.find((r) => r.url === 'https://wikipedia.org')
  assert.equal(dshRow.dsh, true)
  assert.equal(wikiRow.dsh, undefined)
})

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
