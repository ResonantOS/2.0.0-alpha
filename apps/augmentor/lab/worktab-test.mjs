#!/usr/bin/env node

// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * workTab() A/B test — loads extension/sw.js (or any sw source) into a VM
 * with a stubbed chrome API and exercises tab resolution.
 *
 * Run: node lab/worktab-test.mjs            (tests the working tree)
 *      node lab/worktab-test.mjs --git      (tests `git show HEAD:extension/sw.js`)
 *
 * Scenario R is the regression: the user is on a NEW TAB in the focused
 * window, the "windows" permission is missing (getLastFocused throws), and
 * Tab.lastFocusedWindow is absent. The agent must resolve to the new tab,
 * not the first tab in the browser.
 *
 * Scenario E is the overlay regression: the veil must follow ACTUAL browser
 * use — a text-only turn (e.g. "correct this text") raises no overlay at
 * prompt time and no phantom "Done ✓" at turn/end; the first browser action
 * of a turn raises it, and turn/end retires it with "Done ✓".
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const useGit = process.argv.includes('--git')
let src
if (useGit) {
  const { execSync } = await import('node:child_process')
  src = execSync('git show HEAD:extension/sw.js', { cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') }).toString()
} else {
  src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'sw.js'), 'utf8')
}

// ------------------------------------------------------------- chrome stub
function makeChrome(scenario) {
  // scenario: { tabs: [{id, url, title, active, windowId}], focusedWindowId,
  //             windowsPerm: boolean }
  const activatedListeners = []
  const removedListeners = []
  const messageListeners = []
  // Fake native host port: answers initialize/session/prompt like the real
  // bridge, so the SW reaches phase 'ready' and the test can drive the full
  // prompt -> session.event lifecycle (scenario E).
  const portListeners = []
  const port = {
    onMessage: { addListener: (fn) => portListeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => {
      if (msg.method === 'initialize') {
        setTimeout(() => portListeners.forEach((fn) => fn({ id: msg.id, result: { serverInfo: { name: 'stub-bridge' } } })), 0)
      } else if (msg.method === 'session/prompt') {
        setTimeout(() => portListeners.forEach((fn) => fn({ id: msg.id, result: { messageId: `stub-${msg.id}` } })), 0)
      }
    },
  }
  const scriptCalls = [] // every chrome.scripting.executeScript the SW makes
  const chrome = {
    runtime: {
      id: 'testextensionid',
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      sendMessage: () => Promise.resolve(),
      connectNative: () => port,
    },
    sidePanel: {
      setPanelBehavior: () => {},
      setOptions: () => {},
    },
    windows: {
      getLastFocused: () => {
        if (!scenario.windowsPerm) {
          return Promise.reject(new Error('Cannot access a chrome remote object without the windows permission.'))
        }
        return Promise.resolve({ id: scenario.focusedWindowId })
      },
    },
    tabs: {
      onActivated: { addListener: (fn) => activatedListeners.push(fn) },
      onRemoved: { addListener: (fn) => removedListeners.push(fn) },
      onUpdated: { addListener: () => {} },
      query: (opts = {}) => {
        let tabs = scenario.tabs
        if (opts.windowId != null) tabs = tabs.filter((t) => t.windowId === opts.windowId)
        if (opts.active) tabs = tabs.filter((t) => t.active)
        if (opts.currentWindow) tabs = tabs.filter((t) => t.windowId === scenario.focusedWindowId)
        return Promise.resolve(tabs.map((t) => ({ ...t })))
      },
      get: (id) => {
        const t = scenario.tabs.find((x) => x.id === id)
        return t ? Promise.resolve({ ...t }) : Promise.reject(new Error('No tab with id'))
      },
      update: () => Promise.resolve({}),
      create: () => Promise.resolve({}),
    },
    scripting: {
      executeScript: (opts) => {
        scriptCalls.push(opts)
        return Promise.resolve([{ result: 'stub-injected' }])
      },
    },
  }
  return { chrome, activatedListeners, messageListeners, portListeners, scriptCalls }
}

function loadSw(srcText, scenario) {
  const { chrome, activatedListeners, messageListeners, portListeners, scriptCalls } = makeChrome(scenario)
  const sandbox = {
    chrome,
    console,
    crypto,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Map,
    Promise,
    Error,
    String,
    Number,
    Array,
    // sw.js does importScripts('theme-tokens.js'): run the real file in the
    // same context so the veil code gets its color math.
    importScripts: (file) => {
      vm.runInContext(readFileSync(path.join(here, '..', 'extension', file), 'utf8'), sandbox)
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(srcText, sandbox, { filename: 'sw.js' })
  return { sandbox, activatedListeners, messageListeners, portListeners, scriptCalls }
}

// ---------------------------------------------------------------- scenarios
function newTabScenario() {
  // The regression: window 1 (focused) holds an old amazon tab (index 0)
  // and the user's NEW tab page (active). No windows permission, no
  // lastFocusedWindow property.
  return {
    windowsPerm: false,
    focusedWindowId: 1,
    tabs: [
      { id: 101, url: 'https://www.amazon.com/dp/B0H5RNZ43D', title: 'old session tab', active: false, windowId: 1 },
      { id: 102, url: 'https://en.wikipedia.org/wiki/Chromium', title: 'another tab', active: false, windowId: 1 },
      { id: 202, url: 'chrome://newtab/', title: 'New Tab', active: true, windowId: 1 },
    ],
  }
}

function normalActiveScenario() {
  return {
    windowsPerm: true,
    focusedWindowId: 1,
    tabs: [
      { id: 101, url: 'https://www.amazon.com/', title: 'amazon', active: false, windowId: 1 },
      { id: 202, url: 'https://en.wikipedia.org/wiki/Foo', title: 'wiki', active: true, windowId: 1 },
    ],
  }
}

function unworkableActiveScenario() {
  // The user is looking at chrome://settings; two usable tabs exist.
  // Activation history (set by the test): 101 activated first, 303 second.
  return {
    windowsPerm: true,
    focusedWindowId: 1,
    tabs: [
      { id: 101, url: 'https://a.example/', title: 'A', active: false, windowId: 1 },
      { id: 303, url: 'https://b.example/', title: 'B', active: false, windowId: 1 },
      { id: 404, url: 'chrome://settings/', title: 'Settings', active: true, windowId: 1 },
    ],
  }
}

// -------------------------------------------------------------------- tests
let failures = 0
function check(name, cond, detail) {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`${mark}  ${name}${detail ? `  (${detail})` : ''}`)
}

console.log(`\n=== sw source: ${useGit ? 'git HEAD' : 'working tree'} ===`)

// R: the regression — new tab page is the active tab.
{
  const { sandbox } = loadSw(src, newTabScenario())
  const tab = await sandbox.workTab()
  check('R: resolves to the NEW tab the user is on', tab.id === 202, `got tab ${tab?.id} ${tab?.url}`)
}

// A: ordinary active page.
{
  const { sandbox } = loadSw(src, normalActiveScenario())
  const tab = await sandbox.workTab()
  check('A: resolves to the active page tab', tab.id === 202, `got tab ${tab?.id}`)
}

// B: active tab is chrome://settings -> most recently activated usable tab.
{
  const { sandbox, activatedListeners } = loadSw(src, unworkableActiveScenario())
  const fire = ({ tabId }) => activatedListeners.forEach((fn) => fn({ tabId, windowId: 1 }))
  fire({ tabId: 101 })
  await new Promise((r) => setTimeout(r, 5))
  fire({ tabId: 303 })
  const tab = await sandbox.workTab()
  check('B: unworkable active tab -> most recently activated usable', tab.id === 303, `got tab ${tab?.id}`)
}

// C: sticky within a turn, re-resolved on the next user message.
{
  const sc = {
    windowsPerm: false,
    focusedWindowId: 1,
    tabs: [
      { id: 101, url: 'https://a.example/', title: 'A', active: true, windowId: 1 },
      { id: 202, url: 'https://b.example/', title: 'B', active: false, windowId: 1 },
    ],
  }
  const { sandbox, messageListeners } = loadSw(src, sc)
  const t1 = await sandbox.workTab()
  // user flips to tab B mid-turn:
  sc.tabs[0].active = false
  sc.tabs[1].active = true
  const t2 = await sandbox.workTab()
  check('C1: mid-turn the work tab stays sticky', t1.id === 101 && t2.id === 101, `t1=${t1?.id} t2=${t2?.id}`)
  // next user message (the sidepanel 'prompt' handler clears workTabId):
  messageListeners.forEach((fn) => fn({ type: 'prompt', text: 'find me something' }, {}, () => {}))
  const t3 = await sandbox.workTab()
  check('C2: new user message -> the tab the user is on now', t3.id === 202, `t3=${t3?.id}`)
}

// C3: a turn started from ANY source (panel, DSH app UI, CLI) re-resolves:
// the downlink turn/start for this session clears the sticky work tab.
{
  const sc = {
    windowsPerm: false,
    focusedWindowId: 1,
    tabs: [
      { id: 101, url: 'https://a.example/', title: 'A', active: true, windowId: 1 },
      { id: 202, url: 'https://b.example/', title: 'B', active: false, windowId: 1 },
    ],
  }
  const { sandbox, messageListeners, portListeners } = loadSw(src, sc)
  // SESSION_ID is a top-level `let` in the VM context (not a property), so
  // read it the way the panel does: via the 'connect' response.
  let sessionId = null
  messageListeners.forEach((fn) => fn({ type: 'connect' }, {}, (res) => { sessionId = res.sessionId }))
  const t1 = await sandbox.workTab()
  // user flips to tab B; the turn is still running — sticky:
  sc.tabs[0].active = false
  sc.tabs[1].active = true
  const t2 = await sandbox.workTab()
  check('C3a: mid-turn the work tab stays sticky', t2.id === 101, `t2=${t2?.id}`)
  // a new turn starts (downlink from any source):
  portListeners.forEach((fn) =>
    fn({ method: 'session.event', params: { sessionId, event: { type: 'turn/start', seq: 9 } } }),
  )
  await new Promise((r) => setTimeout(r, 5))
  const t3 = await sandbox.workTab()
  check('C3b: turn/start (any source) -> the tab the user is on now', t3.id === 202, `t3=${t3?.id}`)
}

// D: tabs_list marks exactly the tab the user is looking at.
{
  const { sandbox } = loadSw(src, newTabScenario())
  const out = await sandbox.handleBrowserAction('t1', { action: 'tabs_list' })
  const marked = out.tabs.filter((t) => t.focusedWindow)
  check('D: tabs_list.focusedWindow marks only the user\'s tab', marked.length === 1 && marked[0].id === 202, `marked=${JSON.stringify(marked.map((t) => t.id))}`)
}

// E: the veil follows ACTUAL browser use. A text-only turn raises nothing
// (no "Thinking…" at prompt, no phantom "Done ✓" at turn/end); the first
// browser action of a turn raises the veil; turn/end retires it.
{
  const sc = {
    windowsPerm: true,
    focusedWindowId: 1,
    tabs: [
      { id: 202, url: 'https://en.wikipedia.org/wiki/Foo', title: 'wiki', active: true, windowId: 1 },
    ],
  }
  const { sandbox, messageListeners, portListeners, scriptCalls } = loadSw(src, sc)
  // Connect the (stub) native port so prompts are accepted (phase 'ready').
  let sessionId = null
  messageListeners.forEach((fn) => fn({ type: 'connect' }, {}, (res) => { sessionId = res.sessionId }))
  await new Promise((r) => setTimeout(r, 25))
  check('E0: handshake with stub bridge completes', sessionId != null, `sessionId=${sessionId}`)
  // A text-only turn (the regression: "correct this text I wrote"):
  messageListeners.forEach((fn) => fn({ type: 'prompt', text: 'correct this text' }, {}, () => {}))
  await new Promise((r) => setTimeout(r, 25))
  check('E1: text-only prompt shows no overlay', scriptCalls.length === 0, `injections=${scriptCalls.length}`)
  portListeners.forEach((fn) => fn({ method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 1 } } }))
  await new Promise((r) => setTimeout(r, 25))
  check('E2: turn/end after a text-only turn shows no "Done ✓"', scriptCalls.length === 0, `injections=${scriptCalls.length}`)
  // A browser turn: the first browser action raises the veil…
  messageListeners.forEach((fn) => fn({ type: 'prompt', text: 'open example.com' }, {}, () => {}))
  await new Promise((r) => setTimeout(r, 5))
  await sandbox.handleBrowserAction('t1', { action: 'tabs_list' })
  await new Promise((r) => setTimeout(r, 25))
  check('E3: first browser action of a turn shows the overlay', scriptCalls.length >= 2, `injections=${scriptCalls.length}`)
  // …and turn/end retires it with "Done ✓".
  const before = scriptCalls.length
  portListeners.forEach((fn) => fn({ method: 'session.event', params: { sessionId, event: { type: 'turn/end', seq: 2 } } }))
  await new Promise((r) => setTimeout(r, 25))
  const doneShow = scriptCalls.slice(before).some((c) => Array.isArray(c.args) && c.args[0] === 'Done ✓')
  check('E4: turn/end shows "Done ✓" on the visible veil', doneShow, `injections=${scriptCalls.length - before}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
