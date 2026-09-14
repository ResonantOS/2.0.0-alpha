// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/**
 * Augmentor (powered by DSH) — side panel UI.
 *
 * ResonantOS-style sidebar: click the toolbar icon to open this panel (the SW
 * owns the native port); renders the session event stream with GUI-parity
 * styling (markdown, Think blocks, compact tool rows, stats line).
 */

import { createChatUI } from './chat-render.js'
import { attachPromptLibrary } from './prompt-library.mjs'

const ui = createChatUI({
  log: document.getElementById('log'),
  title: document.getElementById('title'),
  model: document.getElementById('model-label'), // inner span: the chip is now a button
  stats: document.getElementById('stats'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  top: document.getElementById('top'),
})

// The model chip is a button wrapping a label span. The event stream
// (chat-render) writes the running model into the span; the model picker
// (below) re-asserts the catalog's display name. Keep the trigger hidden
// until a label exists so a fresh/disconnected panel shows no dead chip.
function showModel() {
  const m = document.getElementById('model')
  m.hidden = !document.getElementById('model-label').textContent
}
const modelObs = new MutationObserver(showModel)
modelObs.observe(document.getElementById('model-label'), { childList: true, characterData: true })

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, ...payload })
}

attachPromptLibrary({input:document.getElementById('input'),send,settingsButton:document.getElementById('prompt-settings')})

// F10 (audit): the header's three popovers (model picker, sessions, colors)
// each carried their own open/close/position/outside-click/Escape
// machinery — three near-identical copies of the same lifecycle. One factory
// now owns it; each call site keeps only what is genuinely different (the
// render step, the positioning direction, and per-call-site guards).
//
//   btn          trigger button (click toggles)
//   el           the [hidden] popover element
//   onOpen()     run AFTER the popover is visible, so render code can measure
//   canOpen()    optional guard (returns false -> the click does nothing)
//   above        open upward (footer chips) vs downward (header buttons)
//   align        'right' (popover's right edge at the button's right) or
//                'left' (popover's left edge at the button's left)
//   toggleClass  toggle btn.classList 'open' (styled triggers; the hue
//                button has no .open style and never had the class)
function popover({ btn, el, onOpen, canOpen, above = false, align = 'right', toggleClass = true }) {
  const open = () => {
    if (!el.hidden) return
    if (canOpen && !canOpen()) return
    el.hidden = false
    if (toggleClass) btn.classList.add('open')
    if (onOpen) onOpen() // render first: the measurement below needs real size
    const r = btn.getBoundingClientRect()
    const margin = 8
    el.style.top = above
      ? `${Math.max(margin, r.top - el.offsetHeight - 6)}px`
      : `${r.bottom + 6}px`
    const anchor = align === 'left' ? r.left : r.right - el.offsetWidth
    el.style.left = `${Math.max(margin, Math.min(anchor, window.innerWidth - el.offsetWidth - margin))}px`
  }
  const close = () => {
    if (el.hidden) return
    el.hidden = true
    if (toggleClass) btn.classList.remove('open')
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (el.hidden) open()
    else close()
  })
  document.addEventListener('mousedown', (e) => {
    if (!el.hidden && !el.contains(e.target) && !btn.contains(e.target)) close()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.hidden) close()
  })
  return { open, close }
}

// ── Model picker (the DSH composer's model seat) ────────────────────────────
// The catalog + selection ride along on every log/connect reply (the SW owns
// both, fetched from the bridge, which reads $DSH_HOME/settings.yaml — the
// DSH app's own model set). Picking a row switches the sidecar's model: the
// bridge restarts the runtime, and the conversation resumes from its
// persisted log. Switches land only while the turn is idle.
//
// Two DSH model-picker-augmented (the user's DSH model picker plugin)
// parities ride the same replies:
//  - search: live filter over the rows (model name/id or provider name,
//    case-insensitive; the DSH plugin matches name+provider, the id is added
//    here because the panel rows are addressed by id);
//  - pins: the plugin's pinned list renders as a Pinned section on top, in
//    the user's order — pinned rows are removed from their provider groups
//    (no dupes), and a pinned-but-hidden model (hidden in DSH settings) is
//    pinned nowhere, exactly as the DSH picker builds its rows.
const modelBtn = document.getElementById('model')
const modelLabel = document.getElementById('model-label')
const modelPop = document.getElementById('modelpop')
const modelPopBody = document.getElementById('modelpop-body')
const modelPopRefresh = document.getElementById('modelpop-refresh')
const modelPopFoot = document.getElementById('modelpop-foot')
const modelPopFootStatus = document.getElementById('modelpop-foot-status')
const modelPopSearchInput = document.getElementById('modelpop-search-input')
const modelPopSearchClear = document.getElementById('modelpop-search-clear')
let pickerCatalog = null // groups: [{provider, name, models: [{provider, model, name}]}]
let pickerSelection = null // {provider, model}
let pickerQuery = '' // search text (the input's value; '' shows everything)
let pickerPinned = [] // ordered "provider/model" keys from the DSH picker's settings
let pickerHidden = new Set() // keys the user hid in the DSH picker's settings

const CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3 7-7"/></svg>'
const PIN_SVG =
  '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.5S3.5 10.2 3.5 6.5a4.5 4.5 0 1 1 9 0C12.5 10.2 8 14.5 8 14.5z"/><circle cx="8" cy="6.5" r="1.5"/></svg>'

// Fold the model info out of a log/connect reply into picker state.
function applyModelInfo(res) {
  if (Array.isArray(res.models)) pickerCatalog = res.models
  if (res.model && typeof res.model === 'object' && res.model.provider && res.model.model) {
    pickerSelection = res.model
  }
  applyCuration(res)
  renderPicker()
}

// The curation (pinned order + hidden keys) rides the catalog replies as
// plain arrays; missing/empty means the DSH picker has no pins — the panel
// then renders the plain list.
function applyCuration(res) {
  if (Array.isArray(res.pinned)) pickerPinned = res.pinned
  if (Array.isArray(res.hidden)) pickerHidden = new Set(res.hidden)
}

// Reset the search between popover opens (a fresh open shows the full list;
// DSH parity — the query is not sticky across opens).
function resetSearch() {
  modelPopSearchInput.value = ''
  pickerQuery = ''
  modelPopSearchClear.hidden = true
}

// Trigger label = the selected model's catalog name (the event stream writes
// its own derivation into the span; this re-asserts the catalog's, which
// matches it by convention).
function renderPicker() {
  if (pickerSelection) {
    const g = (pickerCatalog ?? []).find((x) => x.provider === pickerSelection.provider)
    const m = g?.models.find((x) => x.model === pickerSelection.model)
    modelLabel.textContent = m?.name ?? pickerSelection.model
  }
  // Popover content (re-rendered on open, on every catalog/selection change,
  // and on every search keystroke; the open popover keeps its scroll
  // position on unrelated events only when nothing relevant changed — cheap
  // to just rebuild, it is tiny).
  if (modelPop.hidden) return
  modelPopBody.replaceChildren()
  if (!pickerCatalog || !pickerCatalog.length) {
    const strip = document.createElement('div')
    strip.className = 'mp-strip'
    const label = document.createElement('span')
    const ready = ui.state.phase === 'ready'
    label.textContent = ready
      ? ui.state.error ?? 'Model list unavailable'
      : ui.state.phase === 'connecting'
        ? 'Loading models…'
        : 'Not connected'
    strip.appendChild(label)
    if (ready) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = 'Retry'
      retry.addEventListener('click', fetchModels)
      strip.appendChild(retry)
    }
    modelPopBody.appendChild(strip)
    return
  }
  // Row addressing: "provider/model" keys, the same shape the DSH picker
  // plugin uses for its curation (pins are stored as those keys).
  const rowKey = (g, m) => `${g.provider}/${m.model}`
  const byKey = new Map()
  for (const g of pickerCatalog) for (const m of g.models) byKey.set(rowKey(g, m), { g, m })
  // Pinned section: the user's order, only keys that exist in THIS catalog
  // and are not hidden (DSH parity — a pin whose model left the catalog or
  // was hidden in DSH settings does not render).
  const pinned = []
  const pinnedSet = new Set()
  for (const key of pickerPinned) {
    const entry = byKey.get(key)
    if (entry && !pickerHidden.has(key)) {
      pinned.push(entry)
      pinnedSet.add(key)
    }
  }
  const q = pickerQuery.trim().toLowerCase()
  const matches = (g, m) =>
    q === '' || m.name.toLowerCase().includes(q) || m.model.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)
  const pinnedVisible = pinned.filter(({ g, m }) => matches(g, m))
  // Provider groups: pinned rows leave their group (no dupes), and groups
  // left empty by the search disappear.
  const visibleGroups = pickerCatalog
    .map((g) => ({ ...g, models: g.models.filter((m) => !pinnedSet.has(rowKey(g, m)) && matches(g, m)) }))
    .filter((g) => g.models.length > 0)
  const makeRow = (g, m) => {
    const sel = pickerSelection && pickerSelection.provider === m.provider && pickerSelection.model === m.model
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'mp-row'
    if (sel) row.classList.add('selected')
    row.title = `${g.provider} / ${m.model}`
    // Static check SVG markup (no user data) via innerHTML; the name is
    // textContent-only.
    row.innerHTML = '<span class="mp-name"></span><span class="mp-check">' + CHECK_SVG + '</span>'
    row.querySelector('.mp-name').textContent = m.name
    row.addEventListener('click', () => chooseModel(m))
    return row
  }
  if (pinnedVisible.length) {
    const h = document.createElement('div')
    h.className = 'mp-group pin'
    h.innerHTML = PIN_SVG + '<span></span>'
    h.querySelector('span').textContent = 'Pinned'
    modelPopBody.appendChild(h)
    for (const { g, m } of pinnedVisible) modelPopBody.appendChild(makeRow(g, m))
  }
  for (const g of visibleGroups) {
    const h = document.createElement('div')
    h.className = 'mp-group'
    h.textContent = g.name
    modelPopBody.appendChild(h)
    for (const m of g.models) modelPopBody.appendChild(makeRow(g, m))
  }
  if (!pinnedVisible.length && !visibleGroups.length) {
    const strip = document.createElement('div')
    strip.className = 'mp-strip'
    strip.textContent = `No models match${q ? ` “${pickerQuery.trim()}”` : ''}.`
    modelPopBody.appendChild(strip)
  }
}

// Fresh catalog fetch (the picker's Retry path; the SW answers from memory
// or the bridge).
async function fetchModels() {
  try {
    const res = await send('models')
    if (res?.ok) {
      pickerCatalog = res.groups
      if (res.selection) pickerSelection = res.selection
      applyCuration(res)
    } else if (res?.error) {
      modelPopBody.replaceChildren()
      const strip = document.createElement('div')
      strip.className = 'mp-strip err'
      strip.textContent = res.error
      modelPopBody.appendChild(strip)
      return
    }
  } catch {
    /* SW not ready */
  }
  renderPicker()
}

// Refresh button: the SW answers the picker from its handshake memory, so
// a model added to the DSH app (settings.yaml) while the panel is open
// never appears. 'models-refresh' forces the SW to re-ask the bridge,
// which reads the DSH app live. On error the previous list stays visible;
// the failure text rides the footer.
async function refreshModels() {
  if (modelPopRefresh.disabled) return
  modelPopRefresh.disabled = true
  modelPopFootStatus.textContent = ''
  modelPopFoot.classList.remove('err')
  try {
    const res = await send('models-refresh')
    if (res?.ok) {
      pickerCatalog = res.groups
      if (res.selection) pickerSelection = res.selection
      // Refresh re-reads the DSH settings too, so pins made in the DSH app
      // since the handshake land here.
      applyCuration(res)
    } else if (res?.error) {
      modelPopFootStatus.textContent = res.error
      modelPopFoot.classList.add('err')
    }
  } catch {
    /* SW not ready */
  }
  modelPopRefresh.disabled = false
  renderPicker()
}

modelPopRefresh.addEventListener('click', refreshModels)

// Live search: every keystroke re-renders the rows (pinned section and
// groups filter together; an empty query restores the full list). The
// clear button appears only while a query is active.
modelPopSearchInput.addEventListener('input', () => {
  pickerQuery = modelPopSearchInput.value
  modelPopSearchClear.hidden = pickerQuery === ''
  renderPicker()
})
modelPopSearchClear.addEventListener('click', () => {
  resetSearch()
  modelPopSearchInput.focus()
  renderPicker()
})
// First Escape clears the query (the popover's document-level Escape keeps
// closing only after the query is gone — DSH parity for the search field).
modelPopSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickerQuery !== '') {
    e.preventDefault()
    e.stopPropagation()
    resetSearch()
    renderPicker()
  }
})

// Picked a row: ask the SW to switch (bridge restarts the runtime, the SW
// re-initializes it with the new selection, the session resumes from its
// persisted log).
async function chooseModel(sel) {
  closeModelPop()
  modelLabel.textContent = sel.name
  pickerSelection = { provider: sel.provider, model: sel.model }
  const res = await send('model', { provider: sel.provider, model: sel.model })
  if (res?.ok) {
    if (res.model) pickerSelection = res.model
    renderPicker()
  } else {
    ui.sendFail(res?.error ?? 'model switch failed')
  }
}

// F10: popover() owns the toggle / outside-click / Escape lifecycle. The
// menu opens ABOVE the chip (it sits at the panel bottom), is locked while a
// turn runs (DSH parity — the ui.setState override below), and renders the
// body while visible (renderPicker skips the body while hidden — the
// early-return keeps the 2 s polls cheap — so the measurement inside
// popover() sees its real height).
const modelPopCtl = popover({
  btn: modelBtn,
  el: modelPop,
  above: true,
  canOpen: () => !ui.state.running,
  onOpen: () => {
    // A fresh open shows the full list (the previous open's query is not
    // sticky — the input is cleared before the first render).
    resetSearch()
    renderPicker()
  },
})
function closeModelPop() {
  modelPopCtl.close()
}

// While a DSH session is open (viewSessionId set), the panel renders THAT
// session's events, not the SW's own sidecar transcript: the 2 s poll and
// event pushes are filtered to it, and the model chip reflects the DSH app's
// selection (fetched with the list), not the picker's.
let viewSessionId = null
let viewSessionTitle = null

async function refresh() {
  try {
    // sinceSeq: the panel already rendered up to this event seq, so the SW
    // trims the reply to genuinely new events. -1 (nothing rendered yet)
    // requests the full history — a fresh panel load replays the whole chat.
    const res = await send('log', { sinceSeq: ui.lastSeq })
    if (!res) return
    ui.setState({ phase: res.phase, error: res.error, running: viewSessionId ? false : res.running })
    if (!viewSessionId) updateSaveBadge(res)
    if (viewSessionId) return // DSH view: chrome only, no sidecar entries
    applyModelInfo(res)
    ui.applyLog(res.log)
  } catch {
    /* SW not ready yet */
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'evt') return
    ui.setState({ phase: msg.phase, error: msg.error, running: msg.running })
    // The SW pushes each new log entry with the event: render it directly.
    // The old per-event 'log' round-trip plus the 2 s poll is what made
    // streaming arrive in blocks.
    if (msg.entry) {
      // In a DSH view only that session's events render (the SW's own
      // transcript stays in its own log).
      if (!viewSessionId || msg.entry.sessionId === viewSessionId) ui.applyLog([msg.entry])
    } else refresh()
  })
}

// ── Sessions popover (M1: read the DSH app's own conversations) ─────────────
// "≣ Sessions" lists the live DSH app's sessions through the pipe; a row
// opens that session's history in this panel (the event vocabulary matches
// the renderer). "＋ New chat" always returns to a fresh Augmentor view.
const sessionsBtn = document.getElementById('sessions')
const sessionsPop = document.getElementById('sessionspop')
const sessionsPopBody = document.getElementById('sessionspop-body')

// F10: popover() owns the toggle / outside-click / Escape lifecycle. The
// list is left-aligned below the header button (the model menu is
// right-aligned above the footer chip). The load starts on open — its first
// await yields, so popover()'s positioning runs in the same tick as before.
const sessionsPopCtl = popover({
  btn: sessionsBtn,
  el: sessionsPop,
  align: 'left',
  onOpen: () => {
    renderSessionsList([])
    sessionsPopBody.firstElementChild.textContent = 'Loading sessions…'
    loadSessionsList()
  },
})
function closeSessionsPop() {
  sessionsPopCtl.close()
}

function renderSessionsList(items) {
  sessionsPopBody.replaceChildren()
  if (!items?.length) {
    const strip = document.createElement('div')
    strip.className = 'sp-strip'
    strip.textContent = 'No sessions in the DSH app'
    sessionsPopBody.appendChild(strip)
  }
  for (const item of items) {
    const title =
      item.projections?.values?.title || item.cwd?.split('/').pop() || item.sessionId.slice(0, 12)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'sp-row'
    row.title = item.cwd ?? item.sessionId
    // Stable handle for tests/future code: the DSH app rewrites session
    // titles asynchronously after a turn (often to the assistant's first
    // line), so anything that must identify a row must key on the id, not
    // the rendered title.
    row.dataset.sessionId = item.sessionId
    const dot = document.createElement('span')
    dot.className = 'sp-dot' + (item.running ? ' on' : '')
    const main = document.createElement('span')
    main.className = 'sp-main'
    const t = document.createElement('span')
    t.className = 'sp-title'
    t.textContent = title
    const s = document.createElement('span')
    s.className = 'sp-sub'
    s.textContent = new Date(item.updatedAt ?? 0).toLocaleString()
    main.append(t, s)
    row.append(dot, main)
    row.addEventListener('click', () => openDshSession(item, title))
    sessionsPopBody.appendChild(row)
  }
  // Fence probe strip: C1 evidence, persisted by the pipe to
  // trace/fence-probe.json.
  const strip = document.createElement('div')
  strip.className = 'sp-strip'
  const label = document.createElement('span')
  label.textContent = 'Trust-fence probe (this origin → DSH app)'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = 'Probe'
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = '…'
    try {
      const res = await send('fence/probe')
      strip.className = 'sp-strip ' + (res?.ok ? 'ok' : 'err')
      const api = res?.probe?.api
      const root = res?.probe?.root
      const apiTxt = api?.error ? `api: blocked (${api.error})` : `api: HTTP ${api.status}`
      const rootTxt = root?.error ? `control: blocked` : `control: HTTP ${root.status}`
      label.textContent = `${apiTxt} · ${rootTxt}`
      btn.textContent = 'Re-probe'
    } finally {
      btn.disabled = false
    }
  })
  strip.append(label, btn)
  sessionsPopBody.appendChild(strip)
}

async function openDshSession(item, title) {
  closeSessionsPop()
  const res = await send('session/history', { sessionId: item.sessionId })
  if (!res?.ok) {
    ui.sendFail(res?.error ?? 'could not load the session history')
    return
  }
  // Reset the renderer's baseline so the DSH session's seqs don't collide
  // with the sidecar transcript's (they are different sequences entirely).
  viewSessionId = item.sessionId
  viewSessionTitle = title
  send('session/view', { sessionId: item.sessionId })
  ui.clear()
  ui.setState({ phase: 'ready', running: item.running })
  document.getElementById('title').textContent = title
  setViewComposer(false)
  ui.applyLog(res.events.map((h) => ({ kind: 'event', sessionId: item.sessionId, event: h.event })))
}

// F10: the open path is the popover() factory's (see above); this is the
// load it triggers — the list fetch, the one retry, and the cap footer.
async function loadSessionsList() {
  let res = await send('session/list')
  // 0.1.18: a not-ready SW (just woken, or mid-reconnect) already forces a
  // fresh handshake inside the SW (requireReady) — give it 1.5 s and retry
  // once before surfacing an error. This is what turns the old
  // "Error when communicating with the native messaging host." dead-end into
  // a list that simply takes a beat to appear.
  if (!res?.ok) {
    await new Promise((r) => setTimeout(r, 1500))
    const again = await send('session/list')
    if (again?.ok) res = again
  }
  if (!res?.ok) {
    sessionsPopBody.replaceChildren()
    const strip = document.createElement('div')
    strip.className = 'sp-strip err'
    strip.textContent = res?.error ?? 'session list failed'
    sessionsPopBody.appendChild(strip)
    return
  }
  renderSessionsList(res.items)
  // 0.1.22: the pipe ships only the latest N rows (LIST_MAX_ROWS) — make the
  // cap visible instead of letting older sessions look vanished.
  if (typeof res.total === 'number' && res.total > res.items.length) {
    const foot = document.createElement('div')
    foot.className = 'sp-strip'
    foot.textContent = `Latest ${res.items.length} of ${res.total} sessions`
    sessionsPopBody.appendChild(foot)
  }
}

// ── Updates popover (0.1.30, Phase 1) ──────────────────────────────────────
// In-place updates. The pipe answers updates/check (npm latest + GitHub
// latest release + the live plugin handshake → installed-vs-latest per
// component, each source degrading independently). Two actions:
//   Update   → the plugin runs `dsh plugin add dsh-augmentor@<ver>` in the
//              DSH profile (fire-and-poll; restarting the DSH session loads
//              the new code);
//   Download → the pipe fetches the canonical release zip and extracts it
//              over its own tree (reload in chrome://extensions activates
//              the new extension; the next pipe spawn runs the new pipe).
const updatesBtn = document.getElementById('updates')
const updatesPop = document.getElementById('updatespop')
const updatesPopBody = document.getElementById('updatespop-body')
const updatesStatus = document.getElementById('updates-status')
const updatesCheckBtn = document.getElementById('updates-check')

let updatesInfo = null // last updates/check value
let updatesPoll = null // plugin-update status poll timer
let updatesBusy = false // a check/update/download is in flight

function vcmp(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}
const v = (x) => (typeof x === 'string' && x ? `v${x}` : '—')

function updatesSetStatus(text, cls) {
  updatesStatus.textContent = text ?? ''
  updatesStatus.className = cls ?? ''
}

function upStrip(text, cls = '') {
  const d = document.createElement('div')
  d.className = 'up-strip' + (cls ? ` ${cls}` : '')
  d.textContent = text
  updatesPopBody.appendChild(d)
  return d
}

function renderUpdates() {
  updatesPopBody.replaceChildren()
  if (!updatesInfo) {
    upStrip('Checking installed vs latest…')
    return
  }
  const { installed, latest, errors } = updatesInfo
  // Row 1 — the plugin (npm, lives in the DSH profile).
  const pluginStale = installed.plugin && latest.plugin && vcmp(installed.plugin, latest.plugin) < 0
  const r1 = document.createElement('div')
  r1.className = 'up-row'
  const m1 = document.createElement('div')
  m1.className = 'up-main'
  const n1 = document.createElement('span')
  n1.className = 'up-name'
  n1.textContent = 'Plugin (dsh-augmentor)'
  const s1 = document.createElement('span')
  s1.className = 'up-versions' + (pluginStale ? ' stale' : installed.plugin && latest.plugin ? ' fresh' : '')
  s1.textContent = installed.plugin
    ? pluginStale
      ? `${v(installed.plugin)} → ${v(latest.plugin)} available`
      : `${v(installed.plugin)} — up to date`
    : 'unknown (plugin handshake unreachable)'
  m1.append(n1, s1)
  r1.appendChild(m1)
  if (pluginStale) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'up-btn primary'
    b.textContent = 'Update'
    b.disabled = updatesBusy
    b.addEventListener('click', () => startPluginUpdate())
    r1.appendChild(b)
  }
  updatesPopBody.appendChild(r1)
  // Row 2 — pipe + extension (one release artifact).
  const extStale = installed.extension && latest.extension && vcmp(installed.extension, latest.extension) < 0
  // After a download but before the reload, the files on disk are newer than
  // the version the browser has loaded — say so instead of re-offering it.
  const diskAhead = installed.pipeDisk && installed.extension && vcmp(installed.pipeDisk, installed.extension) > 0
  const r2 = document.createElement('div')
  r2.className = 'up-row'
  const m2 = document.createElement('div')
  m2.className = 'up-main'
  const n2 = document.createElement('span')
  n2.className = 'up-name'
  n2.textContent = 'Pipe + Extension'
  const s2 = document.createElement('span')
  s2.className = 'up-versions' + (extStale ? ' stale' : installed.extension && latest.extension ? ' fresh' : '')
  s2.textContent = installed.extension
    ? extStale
      ? `${v(installed.extension)} → ${v(latest.extension)} available`
      : diskAhead
        ? `${v(installed.extension)} (new files on disk — reload to activate)`
        : `${v(installed.extension)} — up to date`
    : 'unknown'
  m2.append(n2, s2)
  r2.appendChild(m2)
  if (extStale && latest.extAssetUrl) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'up-btn primary'
    b.textContent = 'Download'
    b.disabled = updatesBusy
    b.addEventListener('click', () => startDownload())
    r2.appendChild(b)
  }
  updatesPopBody.appendChild(r2)
  // Skew: releases ship all three in lockstep — a mismatch means one of the
  // update steps (restart / reload) has not happened yet.
  if (installed.plugin && installed.extension && installed.plugin !== installed.extension) {
    upStrip(
      `Version skew: plugin ${v(installed.plugin)} / extension ${v(installed.extension)} — releases ship in lockstep; finish the pending restart or reload.`,
      'warn',
    )
  }
  // Per-source check failures (each source degrades independently).
  const failed = []
  if (errors.npm) failed.push(`npm: ${errors.npm}`)
  if (errors.releases) failed.push(`releases: ${errors.releases}`)
  if (failed.length) upStrip('Check partially failed — ' + failed.join(' · '), 'warn')
  if (errors.plugin) upStrip(errors.plugin, 'warn')
}

async function doCheck() {
  if (updatesBusy) return false
  updatesBusy = true
  updatesCheckBtn.disabled = true
  updatesSetStatus('Checking npm + GitHub…')
  try {
    const res = await send('updates/check')
    if (!res?.ok) throw new Error(res?.error ?? 'check failed')
    updatesInfo = res.value
    renderUpdates()
    updatesSetStatus('')
    return true
  } catch (e) {
    updatesSetStatus(e.message, 'err')
    return false
  } finally {
    updatesBusy = false
    updatesCheckBtn.disabled = false
  }
}

async function startPluginUpdate() {
  if (updatesBusy || !updatesInfo?.latest?.plugin) return
  const version = updatesInfo.latest.plugin
  const from = updatesInfo.installed.plugin
  const text = `Update the DSH plugin (dsh-augmentor)${from ? ` ${v(from)} → ` : ''}${v(version)}?\n\nThis runs "dsh plugin add" in your DSH profile. When it finishes, restart the DSH session to load the new version.`
  if (!confirm(text)) return
  updatesBusy = true
  renderUpdates() // disables the row buttons
  updatesSetStatus(`Updating plugin to ${v(version)}…`)
  try {
    const res = await send('updates/plugin', { version })
    if (!res?.ok) throw new Error(res?.error ?? 'update failed to start')
    // Plugin-side rejections ride in the payload ({ok:false,error}) — the
    // relay round trip itself succeeded.
    const inner = res.value ?? {}
    if (inner.ok === false) throw new Error(inner.error ?? 'update failed to start')
    pollPluginUpdate()
  } catch (e) {
    updatesBusy = false
    updatesSetStatus(e.message, 'err')
    renderUpdates()
  }
}

// The pnpm add outlives any single round trip, so the panel polls the job
// state every 2 s (the pipe keeps the SW alive via the open port).
function pollPluginUpdate() {
  if (updatesPoll) clearInterval(updatesPoll)
  updatesPoll = setInterval(async () => {
    let res
    try {
      res = await send('updates/plugin-status')
    } catch {
      return // SW hiccup: the job keeps running; retry next tick
    }
    if (!res?.ok) return
    const job = res.value?.job ?? { status: 'idle' }
    if (job.status === 'running') {
      const tail = (job.output || '').trim().split('\n').pop() || 'working…'
      updatesSetStatus(`Updating plugin (${job.profile ?? 'profile'}) — ${tail.slice(0, 90)}`)
      return
    }
    clearInterval(updatesPoll)
    updatesPoll = null
    updatesBusy = false
    if (job.status === 'done') {
      updatesSetStatus(`Plugin updated to ${v(job.version)} — restart the DSH session to load it.`, 'ok')
    } else if (job.status === 'error') {
      const tail = (job.output || '').trim().split('\n').pop() || `exit code ${job.exitCode ?? 'unknown'}`
      updatesSetStatus(`Plugin update failed — ${tail.slice(0, 160)}`, 'err')
    } else {
      // 'idle': the job is gone (e.g. the DSH app restarted mid-update).
      updatesSetStatus('No plugin update in flight (no job) — check the plugin version and retry.', 'warn')
    }
    renderUpdates()
  }, 2000)
}

async function startDownload() {
  if (updatesBusy) return
  const { latest } = updatesInfo
  if (!latest?.extension || !latest?.extAssetUrl) return
  const version = latest.extension
  const text = `Download and install pipe + extension ${v(version)} in place?\n\nThe release artifact is extracted over this install. After it finishes: reload Augmentor in chrome://extensions (the next pipe start runs the new code). This part does not touch your DSH sessions.`
  if (!confirm(text)) return
  updatesBusy = true
  renderUpdates()
  updatesSetStatus(`Downloading ${v(version)} from GitHub…`)
  let warnings = []
  try {
    const res = await send('updates/download', { version, url: latest.extAssetUrl })
    if (!res?.ok) throw new Error(res?.error ?? 'download failed')
    const val = res.value ?? {}
    if (!val.ok) throw new Error((val.warnings ?? []).join(' — ') || `download failed (${val.failures?.length ?? 0} file(s))`)
    warnings = val.warnings ?? []
    // Re-check so the rows reflect the new files (the running pipe still
    // reports its boot-time version until the next spawn).
    await doCheck()
    const note = warnings.length ? `\n${warnings.join('\n')}` : ''
    updatesSetStatus(`Files updated to ${v(version)} (${val.files} written) — reload Augmentor in chrome://extensions to activate.${note}`, warnings.length ? 'warn' : 'ok')
  } catch (e) {
    updatesSetStatus(e.message, 'err')
  } finally {
    updatesBusy = false
    updatesCheckBtn.disabled = false
  }
}

// F10: the popover() factory owns the toggle / outside-click / Escape
// lifecycle; opening triggers the first check (the rows render synchronously,
// so the factory's measurement sees the real height).
popover({
  btn: updatesBtn,
  el: updatesPop,
  align: 'left',
  onOpen: () => {
    renderUpdates()
    if (!updatesInfo) void doCheck()
  },
})
updatesCheckBtn.addEventListener('click', () => void doCheck())

// Keep the footer's Send/Stop pair in lock-step with the run state: Stop shows
// only while a turn is active; Send returns the moment the agent goes idle.
// The SW (via session.status) and the 2 s poll both funnel through setState.
// The model picker is locked for the duration of a turn (DSH parity): a
// switch restarts the runtime, which would cut the live turn.
const _setState = ui.setState
ui.setState = (s) => {
  _setState(s)
  const running = ui.state.running
  document.getElementById('send').hidden = running
  document.getElementById('stop').hidden = !running
  modelBtn.disabled = running
  modelBtn.title = running ? 'Finish the current turn to switch models' : 'Switch model'
  if (running && !modelPop.hidden) closeModelPop()
}

// ── Theme + color settings ────────────────────────────────────────────────
// Dark is the default (the GUI's dark palette); light rebinds every token on
// :root[data-theme="light"] and flips color-scheme so the native scrollbar
// follows. On top of that, three tunable colors (all restored pre-paint by
// theme-boot.js, which reads them from localStorage):
//   augmentor-neut-hue       tint of the neutral surfaces (0..360)
//   augmentor-neut-bright    lightness offset, applies in BOTH themes (-15..15)
//   augmentor-accent-hue     accent: panel brand + browser-control overlay
//   augmentor-accent-bright  accent lightness offset (-15..15)
// The hue icon (#hue) opens the popover; a copy of the values also lands in
// chrome.storage.local because the SW (a separate context) needs the accent
// hue to theme the veil and the click pulse (sw.js).
const T = globalThis.__dshAugTheme

const settings = (() => {
  const num = (k, d) => {
    let raw
    try { raw = localStorage.getItem(k) } catch { raw = null }
    // guard raw first: Number(null) is 0, which would mean red
    if (raw == null) return d
    const v = Number(raw)
    return Number.isFinite(v) ? v : d
  }
  return {
    neutHue: num('augmentor-neut-hue', T.DEFAULTS.neutHue),
    neutBright: num('augmentor-neut-bright', T.DEFAULTS.neutBright),
    accentHue: num('augmentor-accent-hue', T.DEFAULTS.accentHue),
    accentBright: num('augmentor-accent-bright', T.DEFAULTS.accentBright),
  }
})()

let storageTimer = 0
function persistSettings() {
  try {
    localStorage.setItem('augmentor-neut-hue', String(settings.neutHue))
    localStorage.setItem('augmentor-neut-bright', String(settings.neutBright))
    localStorage.setItem('augmentor-accent-hue', String(settings.accentHue))
    localStorage.setItem('augmentor-accent-bright', String(settings.accentBright))
  } catch { /* storage unavailable */ }
  clearTimeout(storageTimer)
  storageTimer = setTimeout(() => {
    try {
      chrome.storage.local.set({
        'augmentor-neut-hue': settings.neutHue,
        'augmentor-neut-bright': settings.neutBright,
        'augmentor-accent-hue': settings.accentHue,
        'augmentor-accent-bright': settings.accentBright,
      }).catch(() => {})
    } catch { /* SW context not available */ }
  }, 250)
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

const hueBtn = document.getElementById('hue')
const pop = document.getElementById('huepop')
const neutHueEl = document.getElementById('neut-hue')
const neutBrightEl = document.getElementById('neut-bright')
const accentHueEl = document.getElementById('accent-hue')
const accentBrightEl = document.getElementById('accent-bright')
const accentSwatch = document.getElementById('accent-swatch')
const brightVal = document.getElementById('neut-bright-val')
const accentBrightVal = document.getElementById('accent-bright-val')
const veilPreview = document.getElementById('veil-preview')
const veilDot = veilPreview.querySelector('.vp-dot')

const signed = (n) => (n > 0 ? `+${n}` : String(n))

// Rebind every tunable token for the active theme and refresh the popover's
// live previews (accent swatch, brightness readout, mini veil pill).
function applyColorSettings() {
  T.applyPanelTheme(
    document.documentElement,
    currentTheme(),
    settings.neutHue,
    settings.neutBright,
    settings.accentHue,
    settings.accentBright,
  )
  accentSwatch.style.background = T.panelTheme(
    currentTheme(), settings.neutHue, settings.neutBright, settings.accentHue, settings.accentBright,
  )['--brand']
  // Mini veil pill: the overlay palette is theme-independent (it always
  // floats over page content, so it keeps the dark-pill look).
  const p = T.veilPalette(settings.accentHue, settings.accentBright)
  veilPreview.style.background =
    `linear-gradient(180deg, ${T.rgbaStr(p.pillBg1, 0.94)}, ${T.rgbaStr(p.pillBg2, 0.94)})`
  veilPreview.style.borderColor = T.rgbaStr(p.dotDone, 0.28)
  veilPreview.style.boxShadow =
    `0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 1px ${T.rgbaStr(p.dot, 0.18)}`
  veilPreview.style.color = T.rgbStr(p.label)
  veilDot.style.background = T.rgbStr(p.dot)
  brightVal.textContent = signed(settings.neutBright)
  accentBrightVal.textContent = signed(settings.accentBright)
}

function syncPopInputs() {
  neutHueEl.value = settings.neutHue
  neutBrightEl.value = settings.neutBright
  accentHueEl.value = settings.accentHue
  accentBrightEl.value = settings.accentBright
}

// F10: popover() owns the lifecycle. The hue button has no .open style (the
// class never lived here — toggleClass off); it opens below, right-aligned,
// like the model menu's geometry.
const huePopCtl = popover({
  btn: hueBtn,
  el: pop,
  toggleClass: false,
  onOpen: () => {
    syncPopInputs()
    applyColorSettings()
  },
})
function closePop() {
  huePopCtl.close()
}

for (const [el, key] of [
  [neutHueEl, 'neutHue'],
  [neutBrightEl, 'neutBright'],
  [accentHueEl, 'accentHue'],
  [accentBrightEl, 'accentBright'],
]) {
  el.addEventListener('input', () => {
    settings[key] = Number(el.value)
    applyColorSettings()
    persistSettings()
  })
}

document.getElementById('hue-reset').addEventListener('click', () => {
  settings.neutHue = T.DEFAULTS.neutHue
  settings.neutBright = T.DEFAULTS.neutBright
  settings.accentHue = T.DEFAULTS.accentHue
  settings.accentBright = T.DEFAULTS.accentBright
  syncPopInputs()
  applyColorSettings()
  persistSettings()
})

// Tokens are already applied pre-paint by theme-boot.js; this just refreshes
// the popover previews (and slider positions) on load.
syncPopInputs()
applyColorSettings()

// Light/dark switch — top of the Colors popover (moved out of the header so
// theme can be toggled while the colors are open).
const themeSeg = document.getElementById('theme-seg')
function setTheme(theme) {
  const root = document.documentElement
  if (theme === 'light') root.dataset.theme = 'light'
  else delete root.dataset.theme
  try {
    if (theme === 'light') localStorage.setItem('augmentor-theme', 'light')
    else localStorage.removeItem('augmentor-theme')
  } catch { /* storage unavailable: theme still toggles for this open */ }
  syncThemeSeg()
  applyColorSettings()
}
function syncThemeSeg() {
  const active = currentTheme()
  for (const b of themeSeg.querySelectorAll('button')) {
    const on = b.dataset.themeOpt === active
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
  }
}
for (const b of themeSeg.querySelectorAll('button'))
  b.addEventListener('click', () => setTheme(b.dataset.themeOpt))
syncThemeSeg()

// M1's DSH view is read-only: prompts land in M2 (session.create/prompt).
// The composer is disabled while a DSH session is open.
function setViewComposer(enabled) {
  document.getElementById('input').disabled = !enabled
  document.getElementById('send').disabled = !enabled
}

// ── M3 chat lifecycle: Save badge + Open-in-DSH ─────────────────────────────
// The SW's 2 s poll (refresh → 'log') carries the chat-lifecycle state: the
// running session id, the running DSH app's base URL, and the set of sessions
// saved to the Augmentor Chat workspace. The badge mirrors whether THIS chat
// is in that set; the button toggles save/unsave.
let m3SessionId = null
let m3Endpoint = null
let m3Saved = new Set()
const saveBtn = document.getElementById('save')
function updateSaveBadge(res) {
  if (typeof res.sessionId === 'string') m3SessionId = res.sessionId
  if (typeof res.endpoint === 'string') m3Endpoint = res.endpoint
  if (Array.isArray(res.saved)) m3Saved = new Set(res.saved)
  const saved = m3SessionId !== null && m3Saved.has(m3SessionId)
  // Icon-only button: state rides the .saved class (the star FILLS in the
  // accent) — never textContent, which would destroy the SVG child.
  saveBtn.classList.toggle('saved', saved)
  saveBtn.title = saved
    ? 'This chat is saved in DSH under Augmentor Chat — tap to unsave'
    : 'Save this chat to the Augmentor Chat workspace in DSH (tap again to unsave)'
}
saveBtn.addEventListener('click', async () => {
  const res = await send(m3Saved.has(m3SessionId) ? 'unsave' : 'save')
  if (res?.ok === false) {
    ui.sendFail(res.error)
    return
  }
  if (res?.savedSet) m3Saved = new Set(res.savedSet)
  updateSaveBadge({ sessionId: m3SessionId, endpoint: m3Endpoint, saved: [...m3Saved] })
})
document.getElementById('openindsh').addEventListener('click', () => {
  // Option A (proposal §5.3): plain app-open, no deep link — a new tab at the
  // running DSH app. The saved chat is visible there under Augmentor Chat.
  // UX framing (0.1.16): this EXPANDS the sidecar into the full running DSH
  // session — hence the tooltip copy.
  if (m3Endpoint) window.open(m3Endpoint.replace(/\/$/, '') + '/', '_blank', 'noopener')
})

// ── Chat title: double-click to rename ─────────────────────────────────────
// Swaps the #title span for an inline input (pre-filled, selected). Enter or
// blur commits through the SW → DSH `session.rename`; Esc cancels. A user-set
// title is PINNED in DSH (auto-titling never overwrites it), and the host
// pushes the session/title event back, which chat-render re-asserts. The M1
// browse view is read-only — renaming only applies to the live Augmentor chat.
const $title = document.getElementById('title')
let titleEditing = false
$title.addEventListener('dblclick', () => {
  if (titleEditing || viewSessionId || !m3SessionId) return
  const input = document.createElement('input')
  input.id = 'title-edit'
  input.value = $title.textContent
  input.setAttribute('spellcheck', 'false')
  $title.hidden = true
  $title.after(input)
  input.focus()
  input.select()
  titleEditing = true
  let done = false
  const finish = (commit) => {
    if (done) return
    done = true
    const val = input.value.trim()
    const cur = $title.textContent
    input.remove()
    $title.hidden = false
    titleEditing = false
    if (!commit || !val || val === cur) return
    send('session/rename', { sessionId: m3SessionId, title: val }).then((res) => {
      if (res?.ok === false) {
        ui.sendFail(res.error)
        return
      }
      $title.textContent = res?.title ?? val
    })
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
  })
  input.addEventListener('blur', () => finish(true))
})

// "＋ New chat": the SW mints a fresh sessionId (the runtime lazily creates
// the agent+session pair on the next prompt) and clears its log. Also exits
// the DSH view (M1), returning to a fresh Augmentor transcript.
// 0.1.18: a LONG PRESS (450 ms hold) no longer starts a chat — it opens the
// approval-mode menu that lived in the removed bottom-strip pill. Short
// press = new chat, exactly as before.
const $newchat = document.getElementById('newchat')
const LONG_PRESS_MS = 450
let lpTimer = null
let suppressClick = false
$newchat.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  clearTimeout(lpTimer)
  lpTimer = setTimeout(() => {
    lpTimer = null
    suppressClick = true
    openAccessMenu()
  }, LONG_PRESS_MS)
})
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) {
  $newchat.addEventListener(t, () => { clearTimeout(lpTimer); lpTimer = null })
}
$newchat.addEventListener('click', async (e) => {
  if (suppressClick) {
    // The click that released a long press: the menu just opened — swallow
    // it (stopPropagation so the document-level closer doesn't eat the menu).
    suppressClick = false
    e.stopPropagation()
    return
  }
  if (viewSessionId) {
    viewSessionId = null
    viewSessionTitle = null
    send('session/view', { sessionId: null })
    document.getElementById('title').textContent = 'Augmentor'
    setViewComposer(true)
  }
  const res = await send('newchat')
  if (res?.ok) ui.clear()
  refresh()
})

// ── Approval mode (long-press on New Chat, 0.1.18) ──────────────────────────
// The DSH permission preset decides what the agent may do and whether it
// asks first: read-only / workspace-write (manual approval for wider actions)
// / danger-full-access (automatic, no prompts). It is a USER SETTING (ns
// "permission", path defaultPreset) — the same knob the DSH GUI's own
// settings row writes — and per DSH's settings-store contract it applies to
// subsequently created sessions, not the one already running.
// Scope (audit S2): the preset gates DSH's file/execution approvals — it does
// not bind the agent model, and it does not gate the browser_* tools: the
// browser is the user's own surface, driven from this panel.
// First-run default (audit S2): Manual (workspace write) — the safer preset
// is what a fresh install inherits. Written only when the setting has no
// defaultPreset at all, so existing installs keep their saved choice; full
// access stays one long-press away (behind its risk confirmation).
const ACCESS_PRESETS = [
  { value: 'read-only', label: 'Read only', desc: 'Nothing is written; attempts ask for approval.' },
  { value: 'workspace-write', label: 'Manual (workspace write)', desc: 'Writes inside the workspace; wider actions ask you first.' },
  { value: 'danger-full-access', label: 'Automatic (full access)', desc: 'Everything allowed automatically — no approval prompts.' },
]
const DEFAULT_ACCESS = 'workspace-write'
let accessCurrent = null
let accessRevision = null
let accessMenu = null

function accessLabel(value) {
  const p = ACCESS_PRESETS.find((x) => x.value === value)
  return p ? p.label : value ?? 'unknown'
}

function accessTitle() {
  return `Approval mode: ${accessLabel(accessCurrent)} — applies to new chats. Hold New Chat to change.`
}

async function loadAccess() {
  const res = await send('settings/describe', { ns: 'permission' })
  if (!res?.ok) return
  const view = (res.value?.namespaces ?? []).find((n) => n.ns === 'permission')
  if (!view) return
  accessCurrent = view.value?.defaultPreset ?? null
  accessRevision = view.revision ?? null
  if (accessCurrent === null) {
    // No preset chosen yet (fresh install) → default to Manual
    // (workspace write), once. An explicit user choice is never overridden.
    const set = await send('settings/mutate', {
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: DEFAULT_ACCESS }],
      ...(accessRevision !== null ? { expectedRevision: accessRevision } : {}),
    })
    if (set?.ok) {
      accessCurrent = set.value?.value?.defaultPreset ?? DEFAULT_ACCESS
      accessRevision = set.value?.revision ?? accessRevision
    }
  }
  $newchat.title = accessTitle()
}
loadAccess()
// First paint may race the SW's auto-connect: one retry covers it.
setTimeout(loadAccess, 3000)

function closeAccessMenu() {
  accessMenu?.remove()
  accessMenu = null
}

function openAccessMenu() {
  closeAccessMenu()
  accessMenu = document.createElement('div')
  accessMenu.id = 'access-menu'
  const head = document.createElement('div')
  head.className = 'access-head'
  head.textContent = 'Approval mode — new chats'
  accessMenu.appendChild(head)
  for (const p of ACCESS_PRESETS) {
    const opt = document.createElement('button')
    opt.type = 'button'
    opt.className = 'access-opt' + (p.value === accessCurrent ? ' current' : '')
    const name = document.createElement('span')
    name.className = 'a-name'
    name.textContent = p.value === accessCurrent ? '✓ ' + p.label : p.label
    const desc = document.createElement('span')
    desc.className = 'a-desc'
    desc.textContent = p.desc
    opt.append(name, desc)
    opt.addEventListener('click', (ev) => { ev.stopPropagation(); pickAccess(p.value) })
    accessMenu.appendChild(opt)
  }
  document.body.appendChild(accessMenu)
  // Anchor under the New Chat icon (fixed — the old pill seat is gone).
  const r = $newchat.getBoundingClientRect()
  const top = Math.min(r.bottom + 6, window.innerHeight - accessMenu.offsetHeight - 8)
  const left = Math.max(8, Math.min(r.left, window.innerWidth - accessMenu.offsetWidth - 8))
  accessMenu.style.top = `${top}px`
  accessMenu.style.left = `${left}px`
}
document.addEventListener('click', closeAccessMenu)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccessMenu() })

async function pickAccess(value) {
  closeAccessMenu()
  if (value === accessCurrent) return
  // The DSH GUI gates the full-access preset behind an explicit risk
  // confirmation; mirror that stance here.
  if (value === 'danger-full-access' &&
      !window.confirm('Switch to Automatic (full access)?\n\nNo approval prompts will appear — every action is allowed automatically. Applies to new chats.')) {
    return
  }
  const res = await send('settings/mutate', {
    ns: 'permission',
    ops: [{ op: 'set', path: ['defaultPreset'], value }],
    ...(accessRevision !== null ? { expectedRevision: accessRevision } : {}),
  })
  if (res?.ok === false) {
    ui.sendFail('Switch approval mode: ' + (res.error ?? 'failed'))
    return
  }
  const view = res.value
  accessCurrent = view?.value?.defaultPreset ?? value
  accessRevision = view?.revision ?? accessRevision
  $newchat.title = accessTitle()
}

async function doSend() {
  if (viewSessionId) return // DSH view is read-only in M1
  const input = document.getElementById('input')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  const res = await send('prompt', { text })
  if (res?.ok === false) ui.sendFail(res.error)
  refresh()
}

document.getElementById('send').addEventListener('click', doSend)
document.getElementById('input').addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    doSend()
  }
})
// Stop the live run: the SW aborts the turn (session/interrupt → agent.cancel).
// The turn settles with a `turn/end` (aborted) and the agent goes idle, so the
// Stop button swaps back to Send and a new prompt resumes the same session.
document.getElementById('stop').addEventListener('click', async () => {
  const res = await send('stop')
  if (res?.ok === false) ui.sendFail(res.error)
})

// Test hook: sidepanel.html?task=<text> auto-connects and sends once
// ready (used for the automated browser-leg runs).
const taskParam = new URLSearchParams(location.search).get('task')
if (taskParam) {
  document.getElementById('input').value = taskParam
  send('connect')
  const waitForSend = setInterval(() => {
    const sendBtn = document.getElementById('send')
    if (!sendBtn.disabled) {
      clearInterval(waitForSend)
      doSend()
    }
  }, 500)
  setTimeout(() => clearInterval(waitForSend), 60000)
}

refresh()
const poll = setInterval(refresh, 2000)
window.addEventListener('pagehide', () => clearInterval(poll))
