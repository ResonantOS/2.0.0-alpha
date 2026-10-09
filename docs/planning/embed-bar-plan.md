# ResonantOS Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep ResonantOS one click away above the unmodified Augmentor embed, with governed page sharing, workspace access, approvals, assistant selection, and status.

**Architecture:** The side-panel entry point composes a credential-free bar above the host iframe; separate pure policy and action adapters keep DOM code small. Reuse the current page resolver, permission store, job-history reader, and workspace toggle. The bridge owns availability and credentials; the existing host-page relay remains the only harness transport.

**Tech Stack:** Chrome Manifest V3, JavaScript ES modules, Node.js `node:test`, existing JSDOM, CSS tokens, existing Playwright live harness, authenticated Node HTTP bridge.

## Global Constraints

The following hard values and language are copied from the approved specification:

- “At most 36 px tall”; “fits a 320 px side panel” (36 px max height, 320 px min width).
- “The serialized context stays within 16,000 bytes.” (16,000-byte context limit; measure UTF-8 bytes, not JavaScript string length.)
- “`chrome.storage.local` under `resonantos.agentView` (`embed` or `normal`)” — storage key `resonantos.agentView`, values `embed|normal`.
- “`open-resonantos-workspace` (suggested key Alt+Shift+W)” — preserve the existing `open-augmentor-side-panel` command.
- Toolbar menu text: “Open ResonantOS workspace”; permission: `contextMenus`.
- Relay allowlist: `augmentor-prompt`, `augmentor-new-chat`, `augmentor-focus`, `augmentor-context`. “No new message types.”
- “The bar never receives bridge or harness credentials.” No credentials to the bar, its action adapter, markup, status text, or screenshots.
- “An explicit `?agentView=` query keeps precedence, as it does today.” An explicit human selection updates that parameter if present, then navigates/reloads; it cannot leave an old explicit query overriding the new choice.
- `GET /embed/status` (`addon-runtime-control`) returns `{ available, profile }` and never a credential. The existing bridge adds its normal `{ ok: true }` response envelope.
- “Page shared” is a local confirmation; do not wait for a context result that the harness does not send.
- Out of scope: “Keeping several copies of the harness panel in sync, showing the harness inside the workspace, page control by ResonantOS on the harness's behalf, and voice.”

Execution scope: use `~/2.0.0-alpha/.resonant-rig/worktrees/poc-augembed`, branch `testing/augmentor-embed-sidecar`. This is the approved testing-branch experiment, not a merge-ready change to `dev`. Commands and commits below are instructions for a later implementation run. This planning run changes only this file and performs no commits. Do not start a bridge, create generated credentials, run the live proof, or run mutations while merely writing this plan.

Approved source: [ResonantOS bar design](embed-bar-design.md).

## Findings

Paths and line numbers below refer to the pre-implementation checkout. The abbreviated `extension/` prefix in this section means `browser-first/resonantos-side-panel-extension/`; task file lists use full paths.

1. **Approvals: include the control; no new route.** `extension/src/lib/main-workspace-browser-jobs.js:12` exports `mainBrowserJobSnapshot({ activeJobId = "", jobs = [], maxConcurrent = 2 } = {})`; line 17 selects `status === "approval" && pendingApproval`, and lines 235–268 render that queue. The actual extension read path is `createMainWorkspaceBrowserJobController({ storage, storageKeys, ... } = {}).readJobs()` in `extension/src/lib/main-workspace-browser-job-controller.js:3` and `:19`: it reads `augmentorBrowserJobs` and `augmentorActiveBrowserJob`, validates the stored shapes, and returns `{ jobs, activeJobId, historyState }`, retaining an error state rather than inventing an empty queue. `extension/src/main-workspace.js:353` constructs it; `:402` calls `readJobs()`. Reuse its read method and the snapshot selector. On read failure show “Approvals unavailable”, never a false zero. Clicking opens/focuses the workspace and never approves anything.
2. **Page resolution is a governed selected-tab resolver, not `tabs.getCurrent()` or `active_tab_context`.** `extension/src/lib/browser-page-actions.js:135` defines `activeTab()`, exported in its returned object at `:1091`: retain a readable controlled tab unless it is a subframe lookalike, then rank current-window readable tabs, then all-window readable tabs; an active restricted tab is only the final fallback. `extension/src/lib/readable-tab-ranking.js:1` filters by the injected readability predicate and, when frame enumeration is available, sorts real pages before subframe lookalikes and active before inactive tabs. Its no-frame-API path preserves filtered order. `extension/src/side-panel.js:292` supplies `isControllableTabUrl(tab?.url)`; `extension/src/lib/control-target-classification.js:31` accepts only HTTP(S). `extension/src/lib/tab-context-controller.js:50` binds explicit mentions; `:92` registers activation/update refreshes. The bar starts a separate embed session with no controlled tab and reuses `createBrowserPageActions(...).activeTab()`, including its sticky selection semantics. `extension/src/background.js:167` sets the side-panel path without a tab-id query; there is no hidden `?tabId=` attachment contract to invent. The background `active_tab_context` handler at `:306` instead prefers `sender.tab`: that would pick the extension tab in a tab-hosted harness, so do not use it. `browser-first/test/embed-live.mjs:26` creates a page and `:49` opens the extension document as that tab. Make the local fixture the sole HTTP(S) tab in the isolated live profile; the extension and workspace tabs are excluded by the existing resolver. Assert the emitted sanitized URL equals the fixture URL before prompting.
3. **Site permission: reuse the strict reader and guard before sending.** `extension/src/lib/site-permission-store.js:20` defines `readSitePermissions()`, which throws `site-permissions-unavailable` if storage is missing/rejects; `:54` defines `permissionForUrl(url): Promise<string>` and calls that strict reader. The convenience `sitePermissions()` at `:15` swallows errors and must not authorize sharing. `extension/src/side-panel.js:362` constructs the store, using `SIDE_PANEL_STORAGE_KEYS.sitePermissions`, defined as `augmentorSitePermissions` in `extension/src/lib/side-panel-dom.js:15`. `extension/src/lib/browser-page-actions.js:289` (`readSpecificTabPage(tab, { includeBlocked = false } = {})`), `:320` (`sendContentAction(payload)`), and `:574` (direct page read) refuse unreadable permission storage and `blocked` before capture. `saveResearchTrailToArchive(rawTitle = "")` at `:963` calls `readSpecificTabPage(tab)` at `:978`, with no blocked override. From the bar adapter, construct `createSitePermissionStore({ storage: chromeApi.storage?.local, sitePermissionStorageKey: SIDE_PANEL_STORAGE_KEYS.sitePermissions })`, await `permissionForUrl(tab.url)`, refuse `blocked` and unknown modes, catch read errors, and send nothing. Read title/URL metadata only; do not request page DOM, content scripts, or an `includeBlocked` exception.
4. **Sanitizers:** `extension/src/lib/chat-turn-controller.js:6` exports `safeContextText(value, max = 1000): string`; `:24` exports `safeContextUrl(value): string`. Text is credential-pattern redacted, control-cleaned, trimmed and bounded. HTTP(S) URLs lose userinfo, query and fragment; unsupported schemes return an empty string. Page sharing validates HTTP(S) before calling the URL sanitizer, and measures the complete serialized message with `TextEncoder`. The bounded context is sent as `{ type: 'augmentor-context', context: { source: 'resonantos', page: { title, url } } }`; the live turn is the end-to-end protocol acceptance gate for this envelope.
5. **Manifest pins and permission documentation:** `extension/manifest.json:8` has nine permissions and no `contextMenus`; `:43` has only `open-augmentor-side-panel`, with Alt+Shift+A. In this checkout, no test pins the full permissions array or command dictionary: tracked-source searches for the command name and permission strings found only the manifest and background handler. `browser-first/test/alpha-browser-extension-scope.test.mjs:69` pins the absence of `audioCapture`; `:56` pins MV3/side-panel registration and `:70` onward pins CSP/content-script constraints. Preserve those and add deliberate exact permissions/commands assertions there. No current document enumerates this extension's complete permissions list. `docs/architecture/MODULE_MAP.md:16` describes the manifest as owning permissions; `browser-first/README.md:31` describes the extension boundary; `docs/architecture/ADR-037-browser-first-chromium-resonantos.md:86` requires explicit permission declarations. Add a current permissions/launcher paragraph to the component README, rather than claiming an existing list was updated. Historical/add-on permission contracts are not this extension's manifest list.
6. **DOM tests use both fakes and a real DOM library.** `browser-first/test/side-panel-entry.test.mjs:33` uses a small fake document/window for relay tests. `browser-first/test/main-workspace-browser-jobs.test.mjs:3` already imports `JSDOM` from `jsdom`. Use JSDOM for the bar/menu/accessibility DOM tests and entry composition tests; use injected Chrome event/storage/tab fakes for effects. No dependency changes. JSDOM cannot prove layout; the Playwright proof must measure real bounding boxes at 320 and 420 px.
7. **Capability routes:** `browser-first/host/embed-host-service.mjs:244` declares `{ method, path, requiredCapability, handler }` in `embedRoutes`; the bridge composes that array already. `browser-first/host/bridge-server.mjs:123` checks route authorization, `:1255` demonstrates the GET handler's empty body and `{ ok: true, ...result }` envelope, and `:1324` dispatches matching embed proxy traffic before normal routes. `embed-host-service.mjs:81` excludes only `/embed/session` today: also exclude the exact `/embed/status` raw path so it reaches the authenticated router; do not exempt malformed/encoded proxy paths. `extension/src/lib/bridge-client.js:26` owns the method/path capability map, `:149` exports `capabilityForBridgeRoute(route, method = 'GET')`, and `:394` onward attaches the token. Add `GET /embed/status` there. `browser-first/test/bridge-route-capability-audit.test.mjs:164` constructs `embedRoutes`; `:191` compares extension/host maps; `:204` rejects ungated routes; `:224` checks the capability catalog; `:235` checks composition coverage. Keep all four audits and add an exact embed-route contract. A disabled service currently has no routes (`embed-host-service.mjs:33`), so provide the gated status route even when disabled, returning `{ available: false, profile: null }`.

Additional implementation evidence: workspace behavior is owned by `extension/src/lib/main-workspace-toggle.js:45` (`createMainWorkspaceToggle(...)` returning `toggle()` and `isVisible()`). Extend it with `open()` for launchers/Approvals, so those never close an active workspace. The host relay's four-message allowlist and exact origin/source checks are at `browser-first/host/embed-host-service.mjs:161`. Existing live status fields are `online` and `busy` (`browser-first/test/embed-live.mjs:40`). The mutation tool at `~/.claude/skills/resonant-rig/scripts/rig-mutate:10` takes `<file> '<break-cmd>' '<test-cmd>'`, requires a green baseline, restores a byte-identical snapshot, and returns 0 only when mutation turns the test red. Root `RTK.md` is absent; the referenced instructions were resolved at `~/RTK.md`.

## File Structure

Every implementation file below has one responsibility. Existing shared readers and sanitizers remain unchanged.

| Operation | Exact file | Single responsibility |
| --- | --- | --- |
| Modify | `browser-first/host/embed-host-service.mjs` | Embed availability/session/proxy route ownership |
| Modify | `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js` | Capability selection for the new GET route |
| Create | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js` | Pure visibility, status, context, approval-count, and mode-URL decisions |
| Create | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js` | Governed page metadata sharing and preference/job-read adapters |
| Modify | `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-toggle.js` | Shared toggle and open/focus tab operations |
| Create | `browser-first/resonantos-side-panel-extension/src/lib/workspace-launchers.js` | Chrome command/action-menu registration |
| Modify | `browser-first/resonantos-side-panel-extension/src/background.js` | Install the launcher adapter in the existing service worker |
| Modify | `browser-first/resonantos-side-panel-extension/manifest.json` | Declare contextMenus and the second command |
| Create | `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js` | Credential-free bar DOM and event wiring |
| Modify | `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js` | Mode boot, availability probe, bar/frame composition, relay validation |
| Modify | `browser-first/resonantos-side-panel-extension/src/side-panel.html` | Mark the existing chat surface for unchanged normal-mode boot |
| Modify | `browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css` | Bar appearance and bar/frame/chat height allocation |
| Modify | `browser-first/test/embed-host-service.test.mjs` | HTTP status availability/auth and disabled-service behavior |
| Modify | `browser-first/test/bridge-route-capability-audit.test.mjs` | Exact status-route capability contract |
| Create | `browser-first/test/embed-bar-model.test.mjs` | Pure bar decisions and byte/sanitization bounds |
| Create | `browser-first/test/embed-bar-actions.test.mjs` | Real resolver, fail-closed sharing, storage/read adapters |
| Modify | `browser-first/test/main-workspace-toggle.test.mjs` | Open/focus without closing |
| Create | `browser-first/test/workspace-launchers.test.mjs` | Background launcher registration and dispatch |
| Modify | `browser-first/test/alpha-browser-extension-scope.test.mjs` | Explicit manifest permission and command pins |
| Create | `browser-first/test/embed-bar.test.mjs` | DOM/control/accessibility behavior |
| Modify | `browser-first/test/side-panel-entry.test.mjs` | Boot/relay/failure composition |
| Modify | `browser-first/test/embed-live.mjs` | Real-harness fixture-page, layout and mode-switch proof |
| Create | `browser-first/test/embed-bar-documentation.test.mjs` | Permission and ownership documentation acceptance |
| Modify | `browser-first/README.md` | Current extension permissions and launcher usage |
| Modify | `docs/architecture/MODULE-OWNERSHIP.md` | Bar/adapter ownership and gated availability route contract |

Only `docs/planning/embed-bar-plan.md` is written during planning. No package, dependency, bridge-server, normal chat-controller, upstream harness, or relay message-type changes are required.

### Task 1: Capability-gated availability in enabled and disabled configurations

**Files:**

- Modify: `browser-first/host/embed-host-service.mjs`
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js`
- Test/modify: `browser-first/test/embed-host-service.test.mjs`
- Test/modify: `browser-first/test/bridge-route-capability-audit.test.mjs`

**Interfaces:**

- Consumes: `createEmbedHostService({ env = process.env, now = Date.now } = {})`; existing `fixture(t, options = {})` and `auth` in the host test; `withBridgeRoutes(callback)` and `bridgeRouteKey(route)` in the audit.
- Produces: `GET /embed/status`, `handler(): Promise<{ available: boolean, profile: string | null }>` under `addon-runtime-control`; `capabilityForBridgeRoute('/embed/status', 'GET'): 'addon-runtime-control'`.

- [ ] **Write the failing tests.** Append to `browser-first/test/embed-host-service.test.mjs` (reuse its existing imports/helpers):

```js
test('embed status is gated, credential-free and never proxied', async t => {
  const f = await fixture(t);
  assert.equal(f.service.matches('/embed/status'), false);
  assert.equal(f.service.matches('/embed/status?probe=1'), false);
  assert.equal((await f.request('/embed/status')).response.status, 401);
  assert.equal((await f.request('/embed/status', {
    headers: { 'X-ResonantOS-Bridge-Token': 'bridge-test' }
  })).response.status, 403);
  const result = await f.request('/embed/status', { headers: auth });
  assert.equal(result.response.status, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true, available: true, profile: 'poc' });
  assert.equal(result.response.headers.get('set-cookie'), null);
  assert.equal(f.seen.length, 0);
  f.service.close();
  const route = f.service.embedRoutes.find(route => route.path === '/embed/status');
  assert.deepEqual(await route.handler(), { available: false, profile: null });
});

test('disabled embed status is a gated route with no session capability', async t => {
  const service = createEmbedHostService({ env: {} });
  const server = await startBridgeServer({
    host: '127.0.0.1', port: 0, bridgeToken: 'bridge-test',
    bridgeCapabilityTokens: { 'addon-runtime-control': 'cap-test' },
    routes: service.embedRoutes, embedService: service
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/embed/status`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, {
    headers: { 'X-ResonantOS-Bridge-Token': 'bridge-test' }
  })).status, 403);
  assert.deepEqual(await (await fetch(url, { headers: auth })).json(),
    { ok: true, available: false, profile: null });
  assert.equal(service.embedRoutes.some(route => route.path === '/embed/session'), false);
});
```

Append to `browser-first/test/bridge-route-capability-audit.test.mjs`:

```js
test('embed routes have exactly the declared capability boundary', async () => {
  await withBridgeRoutes(async (_routes, arrays) => {
    assert.deepEqual(arrays.embedRoutes.map(route =>
      [bridgeRouteKey(route), route.requiredCapability]), [
      ['GET /embed/status', 'addon-runtime-control'],
      ['POST /embed/session', 'addon-runtime-control']
    ]);
    assert.equal(capabilityForBridgeRoute('/embed/status?probe=1', 'GET'),
      'addon-runtime-control');
  });
});
```

- [ ] **Run and observe red.** `node --test browser-first/test/embed-host-service.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs`. Expected: new status assertions fail (proxy matches status / disabled route absent / audit missing GET). Existing tests remain green before changing disabled semantics.
- [ ] **Implement the route.** Replace `disabledService` with these complete declarations:

```js
const embedStatusRoute = (readStatus) => ({
  method: 'GET', path: '/embed/status', requiredCapability: 'addon-runtime-control',
  handler: async () => readStatus()
});
const disabledService = () => ({
  enabled: false,
  embedRoutes: [embedStatusRoute(() => ({ available: false, profile: null }))],
  matches: () => false,
  setPublicOrigin() {},
  close() {}
});
```

Replace the single bootstrap exemption in `matches` with:

```js
if (target.rawPath === '/embed/session' || target.rawPath === '/embed/status') return false;
```

Replace the returned `embedRoutes` property, preserving the rest of the returned service:

```js
embedRoutes: [
  embedStatusRoute(() => ({ available: !closed, profile: closed ? null : config.profile })),
  { method: 'POST', path: '/embed/session', requiredCapability: 'addon-runtime-control', handler: async () => {
    if (closed) throw new Error('Embed service unavailable');
    for (const [ticket, expiry] of tickets) if (expiry <= now()) tickets.delete(ticket);
    const ticket = opaqueId();
    tickets.set(ticket, now() + 60_000);
    return { hostPath: `/embed-host/?ticket=${ticket}` };
  } }
],
```

Insert this exact member into `BRIDGE_ROUTE_CAPABILITIES` in `bridge-client.js`:

```js
"GET /embed/status": "addon-runtime-control",
```

Deliberately replace both existing `assert.deepEqual(service.embedRoutes, []);` assertions in `embed-host-service.test.mjs` (default-disabled and unsafe-token-file cases) with:

```js
assert.deepEqual(service.embedRoutes.map(({ method, path, requiredCapability }) =>
  ({ method, path, requiredCapability })), [
  { method: 'GET', path: '/embed/status', requiredCapability: 'addon-runtime-control' }
]);
```

Availability means the configured service is enabled, not that the upstream is online. Only relayed status determines online/busy. No upstream request, ticket, token-file path or credential belongs in the response.

- [ ] **Run and pass.** `node --test browser-first/test/embed-host-service.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs`. Expected: exit 0, including existing raw-path, relay, cookie, WebSocket, and credential-file tests.
- [ ] **Commit.**

```bash
git add browser-first/host/embed-host-service.mjs browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js browser-first/test/embed-host-service.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs
git commit -m "feat(embed): expose capability-gated availability"
```

### Task 2: Pure bar policy and fail-closed page/approval adapters

**Files:**

- Create: `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js`
- Create: `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js`
- Create/test: `browser-first/test/embed-bar-model.test.mjs`
- Create/test: `browser-first/test/embed-bar-actions.test.mjs`

**Interfaces:**

- Consumes: `safeContextText(value, max = 1000): string`, `safeContextUrl(value): string`; `createBrowserPageActions(deps).activeTab(): Promise<Tab | undefined>`; `isControllableTabUrl(url): boolean`; `createSitePermissionStore({ storage, sitePermissionStorageKey }).permissionForUrl(url): Promise<string>`; `createMainWorkspaceBrowserJobController({ storage, storageKeys }).readJobs(): Promise<{ jobs, activeJobId, historyState }>`; `mainBrowserJobSnapshot({ jobs, activeJobId }).approvalJobs`; `SIDE_PANEL_STORAGE_KEYS`.
- Produces pure functions: `embedBarVisible(mode, available): boolean`, `embedStatusLabel(status): string`, `pageContextMessage(tab): object | null`, `pendingApprovalCount(history): number | null`, `agentViewUrl(href, mode): string`.
- Produces adapter: `createEmbedBarActions({ chromeApi, locationRef, sendContext }).sharePage(): Promise<string>`, `.selectAssistant(mode): Promise<void>`, `.readApprovals(): Promise<number | null>`. `sendContext(message): boolean` is synchronous and accepts only a bounded `augmentor-context` message; no bridge configuration enters this adapter.

- [ ] **Write the failing tests.** Create `browser-first/test/embed-bar-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { embedBarVisible, embedStatusLabel, pageContextMessage, pendingApprovalCount,
  agentViewUrl } from '../resonantos-side-panel-extension/src/lib/embed-bar-model.js';

test('visibility and relay status are explicit', () => {
  assert.equal(embedBarVisible('embed', false), true);
  assert.equal(embedBarVisible('normal', false), false);
  assert.equal(embedBarVisible('normal', true), true);
  assert.equal(embedStatusLabel(null), 'Offline');
  assert.equal(embedStatusLabel({ online: false, busy: true }), 'Offline');
  assert.equal(embedStatusLabel({ online: true, busy: false }), 'Online · idle');
  assert.equal(embedStatusLabel({ online: true, busy: true }), 'Busy');
});

test('context is sanitized and bounded by serialized UTF-8 bytes', () => {
  const message = pageContextMessage({ title: 'Authorization: Bearer private12345',
    url: 'https://user:pass@example.test/article?token=private#secret' });
  assert.deepEqual(message, { type: 'augmentor-context', context: {
    source: 'resonantos', page: { title: 'Authorization: Bearer [redacted]',
      url: 'https://example.test/article' }
  } });
  assert.equal(pageContextMessage({ url: 'chrome-extension://abc/src/side-panel.html' }), null);
  const bounded = pageContextMessage({ title: '🦉'.repeat(12000), url: 'https://example.test/' });
  assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= 16000);
  assert.equal(pageContextMessage({ title: 'Big URL', url: `https://example.test/${'x'.repeat(17000)}` }), null);
});

test('approval count uses the existing queue and never masks unreadable history', () => {
  assert.equal(pendingApprovalCount({ historyState: 'error', jobs: [] }), null);
  assert.equal(pendingApprovalCount({ historyState: 'ready', jobs: [
    { id: 'a', status: 'approval', pendingApproval: { reason: 'Review', step: { type: 'click' } } },
    { id: 'b', status: 'completed' }, { id: 'c', status: 'approval' }
  ] }), 1);
});

test('selection replaces an explicit query and preserves unrelated URL state', () => {
  const explicit = new URL(agentViewUrl('https://test.invalid/p?agentView=embed&x=1#anchor', 'normal'));
  assert.equal(explicit.searchParams.get('agentView'), 'normal');
  assert.equal(explicit.searchParams.get('x'), '1');
  assert.equal(explicit.hash, '#anchor');
  assert.equal(agentViewUrl('https://test.invalid/p', 'embed'), 'https://test.invalid/p');
  assert.throws(() => agentViewUrl('https://test.invalid/p', 'other'), /Invalid assistant/);
});
```

Create `browser-first/test/embed-bar-actions.test.mjs`:

```js
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
```

- [ ] **Run and observe red.** `node --test browser-first/test/embed-bar-model.test.mjs browser-first/test/embed-bar-actions.test.mjs`. Expected: `ERR_MODULE_NOT_FOUND` for the two new modules.
- [ ] **Implement the complete modules.** `embed-bar-model.js`:

```js
import { safeContextText, safeContextUrl } from './chat-turn-controller.js';
import { mainBrowserJobSnapshot } from './main-workspace-browser-jobs.js';

export function embedBarVisible(mode, available) {
  return mode === 'embed' || (mode === 'normal' && available === true);
}
export function embedStatusLabel(status) {
  if (status?.online !== true) return 'Offline';
  return status.busy === true ? 'Busy' : 'Online · idle';
}
export function pageContextMessage(tab) {
  if (!/^https?:\/\//i.test(tab?.url ?? '')) return null;
  const url = safeContextUrl(tab.url);
  if (!url) return null;
  const message = { type: 'augmentor-context', context: {
    source: 'resonantos', page: { title: safeContextText(tab.title, 1000), url }
  } };
  return new TextEncoder().encode(JSON.stringify(message)).byteLength <= 16000 ? message : null;
}
export function pendingApprovalCount(history) {
  if (history?.historyState !== 'ready') return null;
  return mainBrowserJobSnapshot(history).approvalJobs.length;
}
export function agentViewUrl(href, mode) {
  if (!['embed', 'normal'].includes(mode)) throw new Error('Invalid assistant');
  const url = new URL(href);
  if (url.searchParams.has('agentView')) url.searchParams.set('agentView', mode);
  return url.href;
}
```

`embed-bar-actions.js`:

```js
import { createBrowserPageActions } from './browser-page-actions.js';
import { isControllableTabUrl } from './control-target-classification.js';
import { createSitePermissionStore } from './site-permission-store.js';
import { SIDE_PANEL_STORAGE_KEYS } from './side-panel-dom.js';
import { createMainWorkspaceBrowserJobController } from './main-workspace-browser-job-controller.js';
import { pageContextMessage, pendingApprovalCount, agentViewUrl } from './embed-bar-model.js';

export function createEmbedBarActions({ chromeApi, locationRef, sendContext }) {
  let controlledTabId = null;
  // Construct the existing resolver; no capture or mutation methods are called.
  const { activeTab } = createBrowserPageActions({
    chrome: chromeApi,
    getControlledTabId: () => controlledTabId,
    setControlledTabId: value => { controlledTabId = value; },
    isReadableBrowserTab: tab => isControllableTabUrl(tab?.url)
  });
  const { permissionForUrl } = createSitePermissionStore({
    storage: chromeApi?.storage?.local,
    sitePermissionStorageKey: SIDE_PANEL_STORAGE_KEYS.sitePermissions
  });
  const { readJobs } = createMainWorkspaceBrowserJobController({
    storage: chromeApi?.storage?.local, storageKeys: SIDE_PANEL_STORAGE_KEYS
  });
  async function sharePage() {
    let tab;
    try { tab = await activeTab(); } catch { return 'No readable page'; }
    if (!isControllableTabUrl(tab?.url)) return 'No readable page';
    let mode;
    try { mode = await permissionForUrl(tab.url); }
    catch { return 'Site permissions unavailable'; }
    if (mode === 'blocked') return 'Page sharing blocked';
    if (!['read-only', 'ask-before-action', 'trusted-for-safe-actions'].includes(mode)) {
      return 'Site permissions unavailable';
    }
    const message = pageContextMessage(tab);
    if (!message) return 'Page context unavailable';
    try { return sendContext(message) === true ? 'Page shared' : 'Assistant offline'; }
    catch { return 'Assistant offline'; }
  }
  async function selectAssistant(mode) {
    const nextUrl = agentViewUrl(locationRef.href, mode);
    if (typeof chromeApi?.storage?.local?.set !== 'function') throw new Error('Preferences unavailable');
    await chromeApi.storage.local.set({ 'resonantos.agentView': mode });
    locationRef.assign(nextUrl);
  }
  async function readApprovals() { return pendingApprovalCount(await readJobs()); }
  return { sharePage, selectAssistant, readApprovals };
}
```

- [ ] **Run and pass.** `node --test browser-first/test/embed-bar-model.test.mjs browser-first/test/embed-bar-actions.test.mjs`. Expected: exit 0; blocked/error tests assert zero sends, not merely a notice.
- [ ] **Prove the permission guard is non-vacuous and restored.** Run exactly:

```bash
~/.claude/skills/resonant-rig/scripts/rig-mutate \
  browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js \
  'python3 -c '\''from pathlib import Path; p=Path("browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js"); s=p.read_text(); old="mode = await permissionForUrl(tab.url)"; assert s.count(old) == 1; p.write_text(s.replace(old, "mode = \"read-only\""))'\''' \
  'node --test --test-name-pattern="site-permission guard" browser-first/test/embed-bar-actions.test.mjs'
node --test browser-first/test/embed-bar-actions.test.mjs
```

Expected: tool exit 0, `NON-VACUOUS`, “byte-identical” restoration, then green test exit 0. This mutation is syntactically valid and bypasses the actual permission read, so failure must come from the blocked/unreadable assertions. Do not accept a syntax/import error as mutation evidence. The mutation tool prints only its fixed verdict; run the mutated command manually in the tool's break command only if diagnosis is needed, never commit the mutation.

- [ ] **Commit.**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js browser-first/test/embed-bar-model.test.mjs browser-first/test/embed-bar-actions.test.mjs
git commit -m "feat(embed): add governed page and approval bar adapters"
```

### Task 3: Workspace open/focus launchers and explicit manifest pins

**Files:**

- Modify: `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-toggle.js`
- Create: `browser-first/resonantos-side-panel-extension/src/lib/workspace-launchers.js`
- Modify: `browser-first/resonantos-side-panel-extension/src/background.js`
- Modify: `browser-first/resonantos-side-panel-extension/manifest.json`
- Test/modify: `browser-first/test/main-workspace-toggle.test.mjs`
- Create/test: `browser-first/test/workspace-launchers.test.mjs`
- Test/modify: `browser-first/test/alpha-browser-extension-scope.test.mjs`

**Interfaces:**

- Consumes: `createMainWorkspaceToggle({ tabsApi, windowsApi, getWorkspaceUrl, workspacePath } = {})`, existing `.toggle(): Promise<boolean>` and `.isVisible(): Promise<boolean>`; Chrome `commands`, `contextMenus`, `runtime.onInstalled`, `runtime.onStartup` events.
- Produces: `.open({ windowId } = {}): Promise<true>`; `installWorkspaceLaunchers({ chromeApi, openWorkspace }): void`, where `openWorkspace({ windowId }): Promise<boolean>` opens/focuses and never closes.

- [ ] **Write the failing tests.** Append to `browser-first/test/main-workspace-toggle.test.mjs`:

```js
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
```

Create `browser-first/test/workspace-launchers.test.mjs`:

```js
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
```

Append to `browser-first/test/alpha-browser-extension-scope.test.mjs`:

```js
test('extension deliberately pins permissions and both human workspace launchers', async () => {
  const manifest = await readJson('browser-first/resonantos-side-panel-extension/manifest.json');
  assert.deepEqual(manifest.permissions, [
    'activeTab', 'clipboardRead', 'clipboardWrite', 'contextMenus', 'history',
    'scripting', 'sidePanel', 'storage', 'tabs', 'webNavigation'
  ]);
  assert.deepEqual(manifest.commands, {
    'open-augmentor-side-panel': {
      suggested_key: { default: 'Alt+Shift+A', mac: 'Alt+Shift+A' },
      description: 'Open the Augmentor side panel'
    },
    'open-resonantos-workspace': {
      suggested_key: { default: 'Alt+Shift+W', mac: 'Alt+Shift+W' },
      description: 'Open ResonantOS workspace'
    }
  });
});
```

- [ ] **Run and observe red.** `node --test browser-first/test/main-workspace-toggle.test.mjs browser-first/test/workspace-launchers.test.mjs browser-first/test/alpha-browser-extension-scope.test.mjs`. Expected: missing `open`, missing launcher module, and manifest array/dictionary mismatch.
- [ ] **Implement.** Inside `createMainWorkspaceToggle`, before its return, add:

```js
async function open({ windowId } = {}) {
  const query = windowId === undefined ? { currentWindow: true } : { windowId };
  const tabs = await tabsApi.query(query);
  const target = tabs.find(tab => isMainWorkspaceUrl(tab.url, { workspacePath }));
  if (target) {
    await tabsApi.update(target.id, { active: true });
    if (target.windowId !== undefined && windowsApi?.update) {
      await windowsApi.update(target.windowId, { focused: true });
    }
  } else {
    const options = { url: getWorkspaceUrl(), active: true };
    if (windowId !== undefined) options.windowId = windowId;
    await tabsApi.create(options);
  }
  return true;
}
```

Replace its return with `return { toggle, isVisible, open };`. Preserve the existing toggle logic, including last-tab protection.

Create `workspace-launchers.js`:

```js
const WORKSPACE_COMMAND = 'open-resonantos-workspace';
export function installWorkspaceLaunchers({ chromeApi, openWorkspace }) {
  const open = tab => Promise.resolve().then(() =>
    openWorkspace({ windowId: tab?.windowId })).catch(() => undefined);
  const installMenu = async () => {
    if (!chromeApi.contextMenus) return;
    await chromeApi.contextMenus.remove(WORKSPACE_COMMAND).catch(() => undefined);
    await new Promise(resolve => chromeApi.contextMenus.create({
      id: WORKSPACE_COMMAND, title: 'Open ResonantOS workspace', contexts: ['action']
    }, () => { void chromeApi.runtime.lastError; resolve(); }));
  };
  chromeApi.runtime.onInstalled.addListener(installMenu);
  chromeApi.runtime.onStartup.addListener(installMenu);
  chromeApi.commands.onCommand.addListener((command, tab) => {
    if (command === WORKSPACE_COMMAND) return open(tab);
  });
  chromeApi.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === WORKSPACE_COMMAND) return open(tab);
  });
}
```

Add imports next to the other imports in `background.js` and register once immediately after them; retain the existing side-panel command listener:

```js
import { createMainWorkspaceToggle } from './lib/main-workspace-toggle.js';
import { installWorkspaceLaunchers } from './lib/workspace-launchers.js';
const workspaceLauncher = createMainWorkspaceToggle();
installWorkspaceLaunchers({ chromeApi: chrome, openWorkspace: workspaceLauncher.open });
```

Replace only the manifest `permissions` and `commands` properties with these exact JSON values; preserve key, CSP, host permissions, icons, content scripts and side-panel fields:

```json
"permissions": ["activeTab", "clipboardRead", "clipboardWrite", "contextMenus", "history", "scripting", "sidePanel", "storage", "tabs", "webNavigation"],
"commands": {
  "open-augmentor-side-panel": {
    "suggested_key": { "default": "Alt+Shift+A", "mac": "Alt+Shift+A" },
    "description": "Open the Augmentor side panel"
  },
  "open-resonantos-workspace": {
    "suggested_key": { "default": "Alt+Shift+W", "mac": "Alt+Shift+W" },
    "description": "Open ResonantOS workspace"
  }
}
```

- [ ] **Run and pass.** `node --test browser-first/test/main-workspace-toggle.test.mjs browser-first/test/workspace-launchers.test.mjs browser-first/test/alpha-browser-extension-scope.test.mjs browser-first/test/background-startup-source.test.mjs`. Expected: exit 0; old toggle and side-panel startup contracts retained.
- [ ] **Commit.**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/main-workspace-toggle.js browser-first/resonantos-side-panel-extension/src/lib/workspace-launchers.js browser-first/resonantos-side-panel-extension/src/background.js browser-first/resonantos-side-panel-extension/manifest.json browser-first/test/main-workspace-toggle.test.mjs browser-first/test/workspace-launchers.test.mjs browser-first/test/alpha-browser-extension-scope.test.mjs
git commit -m "feat(extension): add workspace command and toolbar menu"
```

### Task 4: Credential-free bar DOM, keyboard access and layout

**Files:**

- Create: `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js`
- Modify: `browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css`
- Modify: `browser-first/resonantos-side-panel-extension/src/side-panel.html`
- Create/test: `browser-first/test/embed-bar.test.mjs`

**Interfaces:**

- Consumes: `embedStatusLabel(status): string`; callbacks `toggleWorkspace(): Promise<boolean>`, `workspaceVisible(): Promise<boolean>`, `openWorkspace(): Promise<boolean>`, `selectAssistant(mode): Promise<void>`, `sharePage(): Promise<string>`, `readApprovals(): Promise<number | null>`.
- Produces: `mountEmbedBar({ documentRef, parent, mode, toggleWorkspace, workspaceVisible, openWorkspace, selectAssistant, sharePage, readApprovals }): { root: HTMLElement, ready: Promise<void>, refresh(): Promise<void>, setStatus(status): void, destroy(): void }`. `status` has only boolean `online` and `busy`; `mode` is `embed|normal`. The bar receives no Chrome API, bridge client, configuration or harness credential.

- [ ] **Write the failing tests.** Create `browser-first/test/embed-bar.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountEmbedBar } from '../resonantos-side-panel-extension/src/lib/embed-bar.js';

function fixture(mode = 'embed') {
  const dom = new JSDOM('<body><main></main></body>');
  const calls = [];
  let visible = false, count = 2;
  const bar = mountEmbedBar({ documentRef: dom.window.document,
    parent: dom.window.document.body, mode,
    toggleWorkspace: async () => { calls.push('toggle'); return visible = !visible; },
    workspaceVisible: async () => visible,
    openWorkspace: async () => { calls.push('open'); return true; },
    selectAssistant: async value => calls.push(value),
    sharePage: async () => { calls.push('page'); return 'Page shared'; },
    readApprovals: async () => count
  });
  return { dom, bar, calls, setCount: value => { count = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('embed bar orders all five controls, confirms locally and reflects workspace state', async t => {
  const f = fixture(); t.after(() => { f.bar.destroy(); f.dom.window.close(); });
  await f.bar.ready;
  const root = f.bar.root;
  assert.deepEqual([...root.querySelectorAll('[data-control]')].map(node => node.dataset.control),
    ['workspace', 'assistant', 'page', 'approvals', 'status']);
  for (const button of root.querySelectorAll('button')) {
    assert.ok(button.getAttribute('aria-label'));
    assert.ok(button.title);
  }
  const workspace = root.querySelector('[data-control=workspace]');
  assert.equal(workspace.getAttribute('aria-pressed'), 'false');
  workspace.click(); await settle();
  assert.equal(workspace.getAttribute('aria-pressed'), 'true');
  root.querySelector('[data-control=page]').click(); await settle();
  assert.equal(root.querySelector('[role=status]').textContent, 'Page shared');
  root.querySelector('[data-control=approvals]').click(); await settle();
  assert.deepEqual(f.calls, ['toggle', 'page', 'open']);
  assert.match(root.querySelector('[data-control=approvals]').getAttribute('aria-label'), /2/);
  f.setCount(null); await f.bar.refresh();
  assert.equal(root.querySelector('[data-control=approvals]').title, 'Approvals unavailable');
  f.bar.setStatus({ online: true, busy: false });
  assert.equal(root.querySelector('[data-control=status]').textContent, 'Online · idle');
  f.bar.setStatus({ online: true, busy: true });
  assert.equal(root.querySelector('[data-control=status]').textContent, 'Busy');
  f.bar.setStatus(null);
  assert.equal(root.querySelector('[data-control=status]').textContent, 'Offline');
});

test('normal bar contains only Assistant; Escape restores focus and choices are named', async t => {
  const f = fixture('normal'); t.after(() => { f.bar.destroy(); f.dom.window.close(); });
  await f.bar.ready;
  const root = f.bar.root;
  assert.deepEqual([...root.querySelectorAll('[data-control]')].map(node => node.dataset.control), ['assistant']);
  const assistant = root.querySelector('[data-control=assistant]');
  assistant.click();
  const menu = root.querySelector('[role=menu]');
  assert.equal(menu.hidden, false);
  menu.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.hidden, true);
  assert.equal(f.dom.window.document.activeElement, assistant);
  assistant.click();
  root.querySelector('[data-mode=embed]').click(); await settle();
  assert.deepEqual(f.calls, ['embed']);
  assistant.click();
  root.querySelector('[data-mode=normal]').click(); await settle();
  assert.deepEqual(f.calls, ['embed', 'normal']);
});

test('bar failures are inline and do not disable Workspace or Assistant', async t => {
  const dom = new JSDOM('<body></body>'); t.after(() => dom.window.close());
  const bar = mountEmbedBar({ documentRef: dom.window.document, parent: dom.window.document.body,
    mode: 'embed', toggleWorkspace: async () => false, workspaceVisible: async () => false,
    openWorkspace: async () => true, readApprovals: async () => null,
    sharePage: async () => 'Page sharing blocked',
    selectAssistant: async () => { throw Error('secret diagnostic'); }
  });
  t.after(() => bar.destroy()); await bar.ready;
  bar.root.querySelector('[data-control=page]').click(); await settle();
  assert.equal(bar.root.querySelector('[role=status]').textContent, 'Page sharing blocked');
  bar.root.querySelector('[data-control=assistant]').click();
  bar.root.querySelector('[data-mode=normal]').click(); await settle();
  assert.equal(bar.root.querySelector('[role=status]').textContent, 'Assistant switch unavailable');
  assert.equal(bar.root.textContent.includes('secret diagnostic'), false);
  assert.equal(bar.root.querySelector('[data-control=workspace]').disabled, false);
  assert.equal(bar.root.querySelector('[data-control=assistant]').disabled, false);
});

test('CSS declares bounded one-row layout, keyboard focus, light colors and reduced motion', async () => {
  const css = await readFile(new URL('../resonantos-side-panel-extension/src/styles/side-panel/base-layout.css', import.meta.url), 'utf8');
  assert.match(css, /--embed-bar-height:\s*36px/);
  assert.match(css, /\.embed-bar\s*\{[^}]*max-height:\s*36px/s);
  assert.match(css, /\.embed-bar button:focus-visible/);
  assert.match(css, /prefers-color-scheme:\s*light/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  const html = await readFile(new URL('../resonantos-side-panel-extension/src/side-panel.html', import.meta.url), 'utf8');
  assert.match(html, /id="normal-chat-root" class="chat-shell"/);
});
```

- [ ] **Run and observe red.** `node --test browser-first/test/embed-bar.test.mjs`. Expected: missing `embed-bar.js` before implementation; CSS/HTML assertions fail until layout changes land.
- [ ] **Implement the full DOM module.** Create `embed-bar.js`:

```js
import { embedStatusLabel } from './embed-bar-model.js';

export function mountEmbedBar({ documentRef, parent, mode, toggleWorkspace,
  workspaceVisible, openWorkspace, selectAssistant, sharePage, readApprovals }) {
  const root = documentRef.createElement('nav');
  root.id = 'resonantos-bar';
  root.className = 'embed-bar';
  root.setAttribute('aria-label', 'ResonantOS');
  const notice = documentRef.createElement('span');
  notice.className = 'embed-bar-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.hidden = true;
  let disposed = false;
  const announce = text => {
    if (disposed) return;
    notice.textContent = text;
    notice.title = text;
    notice.hidden = !text;
  };
  function button(name, control, path) {
    const node = documentRef.createElement('button');
    node.type = 'button'; node.title = name;
    node.setAttribute('aria-label', name);
    node.dataset.control = control;
    const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const shape = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', path); svg.append(shape); node.append(svg); root.append(node);
    return node;
  }
  const run = (action, failure) => Promise.resolve().then(action).catch(() => announce(failure));
  let workspace, approvals, status;
  if (mode === 'embed') {
    workspace = button('Workspace', 'workspace', 'M3 4h18v16H3z M9 4v16');
    workspace.setAttribute('aria-pressed', 'false');
    workspace.addEventListener('click', () => run(async () => {
      workspace.setAttribute('aria-pressed', String(await toggleWorkspace()));
    }, 'Workspace unavailable'));
  }
  const assistant = button('Assistant', 'assistant', 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4');
  assistant.setAttribute('aria-haspopup', 'menu');
  assistant.setAttribute('aria-expanded', 'false');
  assistant.setAttribute('aria-controls', 'embed-assistant-menu');
  const menu = documentRef.createElement('div');
  menu.id = 'embed-assistant-menu'; menu.className = 'embed-assistant-menu';
  menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Assistant'); menu.hidden = true;
  const choices = [];
  function closeMenu() { menu.hidden = true; assistant.setAttribute('aria-expanded', 'false'); }
  for (const [value, label] of [['embed', 'Augmentor'], ['normal', 'ResonantOS']]) {
    const choice = documentRef.createElement('button');
    choice.type = 'button'; choice.textContent = label; choice.title = label;
    choice.dataset.mode = value; choice.setAttribute('aria-label', label);
    choice.setAttribute('role', 'menuitemradio');
    choice.setAttribute('aria-checked', String(mode === value));
    choice.addEventListener('click', () => {
      closeMenu(); assistant.focus();
      void run(() => selectAssistant(value), 'Assistant switch unavailable');
    });
    choices.push(choice); menu.append(choice);
  }
  assistant.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false; assistant.setAttribute('aria-expanded', 'true');
    choices[mode === 'embed' ? 0 : 1].focus();
  });
  const keydown = event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault(); closeMenu(); assistant.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = choices.indexOf(documentRef.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (current + 1) % 2;
      choices[index].focus();
    } else if (event.key === 'Tab') closeMenu();
  };
  const outside = event => { if (!root.contains(event.target)) closeMenu(); };
  documentRef.addEventListener('keydown', keydown);
  documentRef.addEventListener('pointerdown', outside);
  if (mode === 'embed') {
    const page = button('Page', 'page', 'M5 3h10l4 4v14H5z M14 3v5h5 M8 12h8 M8 16h6');
    page.addEventListener('click', () => {
      if (page.disabled) return;
      page.disabled = true;
      void run(async () => announce(await sharePage()), 'Page context unavailable')
        .finally(() => { page.disabled = false; });
    });
    approvals = button('Approvals unavailable', 'approvals', 'M5 4h14v16H5z M8 12l3 3 5-6');
    const count = documentRef.createElement('span'); count.className = 'embed-approval-count';
    count.setAttribute('aria-hidden', 'true'); count.textContent = '—'; approvals.append(count);
    approvals.addEventListener('click', () => run(() => openWorkspace(), 'Workspace unavailable'));
    status = documentRef.createElement('span'); status.dataset.control = 'status';
    status.className = 'embed-bar-status'; status.setAttribute('aria-live', 'polite');
    root.append(status);
  }
  root.append(menu, notice);
  parent.prepend(root);
  function setStatus(value) {
    if (!status || disposed) return;
    const label = embedStatusLabel(value);
    status.textContent = label; status.title = label;
    status.setAttribute('aria-label', `Status: ${label}`);
    status.dataset.state = value?.online === true ? (value.busy === true ? 'busy' : 'online') : 'offline';
  }
  async function refresh() {
    if (mode !== 'embed' || disposed) return;
    const [visible, count] = await Promise.all([
      Promise.resolve().then(workspaceVisible).catch(() => false),
      Promise.resolve().then(readApprovals).catch(() => null)
    ]);
    if (disposed) return;
    workspace.setAttribute('aria-pressed', String(visible));
    const label = count === null ? 'Approvals unavailable' : `Approvals: ${count} pending`;
    approvals.title = label; approvals.setAttribute('aria-label', label);
    approvals.querySelector('span').textContent = count === null ? '—' : String(count);
  }
  setStatus(null);
  const ready = refresh();
  return { root, ready, refresh, setStatus, destroy() {
    disposed = true;
    documentRef.removeEventListener('keydown', keydown);
    documentRef.removeEventListener('pointerdown', outside);
    root.remove();
  } };
}
```

In `side-panel.html`, replace only the opening `<main class="chat-shell" aria-label="Augmentor chat">` with:

```html
<main id="normal-chat-root" class="chat-shell" aria-label="Augmentor chat">
```

In `base-layout.css`, replace the five-line trailing embed spike block with the following complete CSS. Keep the rest of the existing stylesheet unchanged:

```css
:root {
  --embed-bar-height: 36px;
  --embed-bar-bg: #111315;
  --embed-bar-text: #eef1f4;
  --embed-bar-line: #3b4149;
  --embed-bar-hover: #282e35;
  --embed-bar-focus: #7fc4ff;
}
html.embed-mode, .embed-mode body { height: 100%; margin: 0; overflow: hidden; }
.embed-mode .chat-shell { display: none; }
.embed-mode #embed-root {
  width: 100%; height: calc(100vh - var(--embed-bar-height)); min-height: 0;
  overflow: hidden;
}
.embed-mode #embed-root iframe { display: block; width: 100%; height: 100%; border: 0; }
html.has-embed-bar:not(.embed-mode) .chat-shell { height: calc(100vh - var(--embed-bar-height)); }
.embed-bar {
  position: relative; z-index: 10; display: flex; flex-wrap: nowrap;
  align-items: center; gap: 3px; padding: 2px 6px;
  width: 100%; min-width: 320px; height: var(--embed-bar-height); max-height: 36px;
  color: var(--embed-bar-text); background: var(--embed-bar-bg);
  border-bottom: 1px solid var(--embed-bar-line); box-sizing: border-box;
}
.embed-bar button {
  display: inline-flex; align-items: center; justify-content: center; gap: 2px;
  flex: 0 0 auto; height: 30px; min-width: 30px; padding: 4px;
  border: 0; border-radius: 5px; background: transparent; color: inherit;
}
.embed-bar button:hover, .embed-bar button[aria-pressed="true"] { background: var(--embed-bar-hover); }
.embed-bar button:focus-visible { outline: 2px solid var(--embed-bar-focus); outline-offset: -2px; }
.embed-bar svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; }
.embed-approval-count { font-size: 10px; max-width: 22px; overflow: hidden; }
.embed-bar-status { flex: 0 0 auto; font-size: 11px; white-space: nowrap; }
.embed-bar-notice { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10px; }
.embed-assistant-menu {
  position: absolute; top: 100%; left: 6px; min-width: 150px; padding: 4px;
  background: var(--embed-bar-bg); color: var(--embed-bar-text);
  border: 1px solid var(--embed-bar-line); border-radius: 6px;
  box-shadow: 0 5px 20px #0006;
}
.embed-assistant-menu button { display: flex; width: 100%; justify-content: flex-start; padding: 4px 8px; }
.embed-assistant-menu button[aria-checked="true"] { background: var(--embed-bar-hover); }
.embed-bar [hidden] { display: none; }
@media (prefers-color-scheme: light) {
  .embed-bar { --embed-bar-bg: #f4f6f8; --embed-bar-text: #18212b;
    --embed-bar-line: #c4ccd5; --embed-bar-hover: #dde6ef; --embed-bar-focus: #0869ae; }
}
@media (prefers-reduced-motion: reduce) {
  .embed-bar, .embed-bar * { animation: none !important; transition: none !important; }
}
```

The status has no animation in either preference. Menu overflow is intentional; the row remains 36 px. Hidden normal-mode bar leaves the existing chat height/styles untouched.

- [ ] **Run and pass.** `node --test browser-first/test/embed-bar.test.mjs`. Expected: exit 0. Real height/width assertions are deferred to Task 6, not inferred from JSDOM.
- [ ] **Commit.**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js browser-first/resonantos-side-panel-extension/src/styles/side-panel/base-layout.css browser-first/resonantos-side-panel-extension/src/side-panel.html browser-first/test/embed-bar.test.mjs
git commit -m "feat(embed): add accessible ResonantOS bar"
```

### Task 5: Side-panel mode composition and resilient relay lifecycle

**Files:**

- Modify: `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js`
- Test/modify: `browser-first/test/side-panel-entry.test.mjs`

**Interfaces:**

- Consumes: `mountEmbedBar(options)` and `createEmbedBarActions({ chromeApi, locationRef, sendContext })`; `createMainWorkspaceToggle(options)`; `resolveBridgeConfig(): Promise<Config>`, `initCapabilityTokens(config): Promise<void>`, `createBridgeClient(config): (route, options) => Promise<object>`.
- Produces: unchanged `selectAgentViewMode(search = '', storage = globalThis.chrome?.storage?.local): Promise<'embed'|'normal'>`; `createEmbedConnection(): Promise<{ bridgeUrl: string, request: Function }>` (entry-private transport dependency, never passed into bar); `probeEmbedAvailability(getConnection = createEmbedConnection): Promise<boolean>`; `mountEmbedView({ documentRef, windowRef, chromeApi, locationRef, getConnection } = {}): Promise<{ bar, root, state }>`; `bootSidePanel({ search, storage, loadNormal, mountEmbed, probeAvailability, mountNormalBar } = {}): Promise<unknown>`.
- `window.__resonantosEmbed` retains `{ ready, last, send(message): boolean }` for the existing explicit live proof. The outbound four-type set remains exact. The inbound status adapter passes only `{ online, busy }` into the bar after source/origin validation.

- [ ] **Write failing tests.** Replace `browser-first/test/side-panel-entry.test.mjs` with this complete suite; it retains query precedence, exclusive boot, forged-message rejection, bounded history, origin targeting and redacted failure checks:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { selectAgentViewMode, bootSidePanel, mountEmbedView, probeEmbedAvailability }
  from '../resonantos-side-panel-extension/src/side-panel-entry.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('explicit query overrides local storage; unavailable preferences default to normal', async () => {
  const storage = value => ({ get: async () => ({ 'resonantos.agentView': value }) });
  assert.equal(await selectAgentViewMode('?agentView=embed', storage('normal')), 'embed');
  assert.equal(await selectAgentViewMode('?agentView=normal', storage('embed')), 'normal');
  assert.equal(await selectAgentViewMode('', storage('embed')), 'embed');
  assert.equal(await selectAgentViewMode('', storage('normal')), 'normal');
  assert.equal(await selectAgentViewMode('?agentView=unknown', storage('embed')), 'embed');
  let reads = 0;
  const unavailable = { get() { reads++; throw Error('unavailable'); } };
  assert.equal(await selectAgentViewMode('?agentView=normal', unavailable), 'normal');
  assert.equal(await selectAgentViewMode('?agentView=embed', unavailable), 'embed');
  assert.equal(reads, 0);
  assert.equal(await selectAgentViewMode('', unavailable), 'normal');
});

test('boot shows all embed controls without probing; normal shows only an available bar', async () => {
  for (const available of [true, false]) {
    const calls = [];
    const options = { storage: null,
      loadNormal: async () => calls.push('normal'), mountEmbed: async () => calls.push('embed'),
      probeAvailability: async () => { calls.push('probe'); return available; },
      mountNormalBar: () => calls.push('bar') };
    await bootSidePanel({ ...options, search: '?agentView=embed' });
    assert.deepEqual(calls, ['embed']);
    calls.length = 0;
    await bootSidePanel({ ...options, search: '?agentView=normal' });
    assert.deepEqual(calls, available ? ['normal', 'probe', 'bar'] : ['normal', 'probe']);
  }
});

test('availability projection fails closed and calls GET only', async () => {
  assert.equal(await probeEmbedAvailability(async () => ({ request: async (route, options) => {
    assert.equal(route, '/embed/status'); assert.equal(options.method, 'GET');
    return { available: true, profile: 'poc' };
  } })), true);
  assert.equal(await probeEmbedAvailability(async () => ({ request: async () => ({ available: false }) })), false);
  assert.equal(await probeEmbedAvailability(async () => { throw Error('private diagnostic'); }), false);
  const calls = [];
  await bootSidePanel({ search: '?agentView=normal', storage: null,
    loadNormal: async () => calls.push('normal'), probeAvailability: async () => { throw Error('failed'); },
    mountNormalBar: () => calls.push('bar') });
  assert.deepEqual(calls, ['normal']);
});

function fixture(t) {
  const dom = new JSDOM('<body><main id="normal-chat-root" class="chat-shell"></main></body>',
    { url: 'https://extension.test/src/side-panel.html?agentView=embed' });
  const calls = [], writes = [], assigned = [];
  const chromeApi = {
    runtime: { getURL: file => `chrome-extension://abc/${file}` },
    tabs: { query: async () => [], create: async value => calls.push(value),
      onActivated: { addListener() {}, removeListener() {} },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} } },
    windows: {}, storage: { local: { get: async () => ({}), set: async value => writes.push(value) },
      onChanged: { addListener() {}, removeListener() {} } }
  };
  t.after(() => dom.window.close());
  return { dom, chromeApi, calls, writes, assigned, options: {
    documentRef: dom.window.document, windowRef: dom.window, chromeApi,
    locationRef: { href: dom.window.location.href, assign: url => assigned.push(url) }
  } };
}

test('mounted embed preserves relay boundaries, history and bar placement', async t => {
  const f = fixture(t);
  const sent = [];
  const view = await mountEmbedView({ ...f.options, getConnection: async () => ({
    bridgeUrl: 'http://127.0.0.1:18873', request: async (route, options) => {
      assert.equal(route, '/embed/session'); assert.equal(options.method, 'POST');
      return { hostPath: `/embed-host/?ticket=${'a'.repeat(43)}` };
    }
  }) });
  t.after(() => view.bar.destroy());
  const frame = view.root.querySelector('iframe');
  frame.contentWindow.postMessage = (...args) => sent.push(args);
  assert.equal(f.dom.window.document.body.firstElementChild, view.bar.root);
  assert.equal(view.bar.root.nextElementSibling, view.root);
  assert.equal(frame.src, `http://127.0.0.1:18873/embed-host/?ticket=${'a'.repeat(43)}`);
  const relay = (source, origin, data) => f.dom.window.dispatchEvent(
    new f.dom.window.MessageEvent('message', { source, origin, data }));
  relay({}, 'http://127.0.0.1:18873', { type: 'augmentor-ready' });
  relay(frame.contentWindow, 'http://evil.test', { type: 'augmentor-ready' });
  relay(frame.contentWindow, 'http://evil.test', { type: 'augmentor-status', online: true });
  assert.equal(view.state.ready, false); assert.equal(view.state.last.length, 0);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Offline');
  relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-ready' });
  relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-status', online: true, busy: false });
  assert.equal(view.state.ready, true);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Online · idle');
  for (let i = 0; i < 60; i++) relay(frame.contentWindow, 'http://127.0.0.1:18873', { type: 'augmentor-event', i });
  assert.equal(view.state.last.length, 50); assert.equal(view.state.last[0].i, 10);
  for (const type of ['augmentor-focus', 'augmentor-prompt', 'augmentor-new-chat', 'augmentor-context']) {
    assert.equal(view.state.send({ type }), true);
  }
  assert.equal(view.state.send({ type: 'execute' }), false);
  assert.equal(view.state.send({ type: 'augmentor-context', context: 'x'.repeat(16000) }), false);
  assert.equal(sent.length, 4);
  assert.ok(sent.every(([, origin]) => origin === 'http://127.0.0.1:18873'));
  frame.dispatchEvent(new f.dom.window.Event('error'));
  assert.equal(view.state.ready, false);
  assert.equal(view.state.send({ type: 'augmentor-focus' }), false);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Offline');
});

test('session failure retains working Workspace and Assistant with offline status', async t => {
  const f = fixture(t);
  const view = await mountEmbedView({ ...f.options, getConnection: async () => {
    throw Error('private diagnostic');
  } });
  t.after(() => view.bar.destroy());
  assert.match(view.root.textContent, /Unable to open/);
  assert.equal(view.root.textContent.includes('private diagnostic'), false);
  assert.equal(view.bar.root.querySelector('[data-control=status]').textContent, 'Offline');
  view.bar.root.querySelector('[data-control=workspace]').click(); await settle();
  assert.equal(f.calls[0].url, 'chrome-extension://abc/src/main-workspace.html');
  view.bar.root.querySelector('[data-control=assistant]').click();
  view.bar.root.querySelector('[data-mode=normal]').click(); await settle();
  assert.deepEqual(f.writes, [{ 'resonantos.agentView': 'normal' }]);
  assert.equal(new URL(f.assigned[0]).searchParams.get('agentView'), 'normal');
});
```

- [ ] **Run and observe red.** `node --test browser-first/test/side-panel-entry.test.mjs`. Expected: missing `probeEmbedAvailability` export; once exports exist, the old implementation fails availability, bar-order and failure-survival assertions.
- [ ] **Implement the complete entry point.** Replace `side-panel-entry.js` with:

```js
import { resolveBridgeConfig, initCapabilityTokens, createBridgeClient } from './lib/bridge-client.js';
import { createMainWorkspaceToggle } from './lib/main-workspace-toggle.js';
import { createEmbedBarActions } from './lib/embed-bar-actions.js';
import { mountEmbedBar } from './lib/embed-bar.js';
import { embedBarVisible } from './lib/embed-bar-model.js';

const RELAY_COMMANDS = new Set(['augmentor-prompt', 'augmentor-new-chat', 'augmentor-focus', 'augmentor-context']);
function bounded(work, ms = 8000) {
  let timer;
  return Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Embed unavailable')), ms);
  })]).finally(() => clearTimeout(timer));
}
export async function selectAgentViewMode(search = '', storage = globalThis.chrome?.storage?.local) {
  const queryMode = new URLSearchParams(search).get('agentView');
  if (queryMode === 'embed' || queryMode === 'normal') return queryMode;
  try {
    const values = await storage?.get('resonantos.agentView');
    if (values?.['resonantos.agentView'] === 'embed') return 'embed';
  } catch { /* Unavailable preferences preserve normal startup. */ }
  return 'normal';
}
export async function createEmbedConnection() {
  const config = await resolveBridgeConfig();
  await initCapabilityTokens(config);
  return { bridgeUrl: config.bridgeUrl, request: createBridgeClient(config) };
}
export async function probeEmbedAvailability(getConnection = createEmbedConnection) {
  try {
    return await bounded(async () => {
      const { request } = await getConnection();
      const result = await request('/embed/status', { method: 'GET' });
      return result.available === true;
    });
  } catch { return false; }
}
function mountSidePanelBar({ mode, sendContext = () => false,
  documentRef = globalThis.document, windowRef = globalThis.window,
  chromeApi = globalThis.chrome, locationRef = globalThis.location } = {}) {
  const workspace = createMainWorkspaceToggle({ tabsApi: chromeApi?.tabs,
    windowsApi: chromeApi?.windows,
    getWorkspaceUrl: () => chromeApi.runtime.getURL('src/main-workspace.html') });
  const actions = createEmbedBarActions({ chromeApi, locationRef, sendContext });
  const bar = mountEmbedBar({ documentRef, parent: documentRef.body, mode,
    toggleWorkspace: workspace.toggle, workspaceVisible: workspace.isVisible,
    openWorkspace: workspace.open, ...actions });
  documentRef.documentElement.classList.add('has-embed-bar');
  const refresh = () => { void bar.refresh(); };
  const storageChanged = (changes, area) => {
    if (area === 'local' && (changes.augmentorBrowserJobs || changes.augmentorActiveBrowserJob)) refresh();
  };
  const events = [chromeApi?.tabs?.onActivated, chromeApi?.tabs?.onUpdated, chromeApi?.tabs?.onRemoved];
  for (const event of events) event?.addListener(refresh);
  chromeApi?.storage?.onChanged?.addListener(storageChanged);
  const destroy = bar.destroy;
  const onPageHide = () => bar.destroy();
  bar.destroy = () => {
    for (const event of events) event?.removeListener(refresh);
    chromeApi?.storage?.onChanged?.removeListener(storageChanged);
    windowRef.removeEventListener('pagehide', onPageHide);
    documentRef.documentElement.classList.remove('has-embed-bar');
    destroy();
  };
  windowRef.addEventListener('pagehide', onPageHide, { once: true });
  return bar;
}
export async function mountEmbedView({ documentRef = globalThis.document,
  windowRef = globalThis.window, chromeApi = globalThis.chrome,
  locationRef = globalThis.location, getConnection = createEmbedConnection } = {}) {
  documentRef.documentElement.classList.add('embed-mode');
  const root = documentRef.createElement('section'); root.id = 'embed-root';
  documentRef.body.prepend(root);
  let frame = null, origin = '', online = false;
  const state = { ready: false, last: [], send(message) {
    if (!state.ready || !online || !frame?.contentWindow || !RELAY_COMMANDS.has(message?.type)) return false;
    try {
      if (message.type === 'augmentor-context' &&
          new TextEncoder().encode(JSON.stringify(message)).byteLength > 16000) return false;
      frame.contentWindow.postMessage(message, origin); return true;
    } catch { return false; }
  } };
  windowRef.__resonantosEmbed = state;
  const bar = mountSidePanelBar({ mode: 'embed', documentRef, windowRef, chromeApi,
    locationRef, sendContext: state.send });
  const offline = () => { state.ready = false; online = false; bar.setStatus(null); };
  const relay = event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    if (!event.data || typeof event.data !== 'object') return;
    state.last.push(event.data);
    if (state.last.length > 50) state.last.splice(0, state.last.length - 50);
    if (event.data.type === 'augmentor-ready') state.ready = true;
    if (event.data.type === 'augmentor-status') {
      online = event.data.online === true;
      bar.setStatus({ online, busy: event.data.busy === true });
    }
  };
  windowRef.addEventListener('message', relay);
  const destroy = bar.destroy;
  bar.destroy = () => {
    windowRef.removeEventListener('message', relay);
    offline(); destroy();
  };
  try {
    const connection = await bounded(getConnection);
    const { hostPath } = await bounded(() => connection.request('/embed/session', { method: 'POST', body: {} }));
    if (typeof hostPath !== 'string' || !/^\/embed-host\/\?ticket=[A-Za-z0-9_-]{43}$/.test(hostPath)) {
      throw new Error('Invalid embed session');
    }
    origin = new URL(connection.bridgeUrl).origin;
    frame = documentRef.createElement('iframe'); frame.title = 'Augmentor'; frame.allow = 'clipboard-write';
    frame.addEventListener('error', offline);
    frame.src = `${connection.bridgeUrl.replace(/\/$/, '')}${hostPath}`;
    root.append(frame);
  } catch {
    offline();
    root.textContent = 'Unable to open the embedded chat. Check that the PoC bridge is running and try again.';
  }
  return { bar, root, state };
}
export async function bootSidePanel({ search = globalThis.location?.search ?? '',
  storage = globalThis.chrome?.storage?.local,
  loadNormal = () => import('./side-panel.js'), mountEmbed = mountEmbedView,
  probeAvailability = probeEmbedAvailability,
  mountNormalBar = () => mountSidePanelBar({ mode: 'normal' }) } = {}) {
  const mode = await selectAgentViewMode(search, storage);
  if (mode === 'embed') return mountEmbed();
  const normal = await loadNormal();
  let available = false;
  try { available = await probeAvailability(); } catch { /* Hide unavailable normal-mode affordance. */ }
  if (embedBarVisible(mode, available)) mountNormalBar();
  return normal;
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') void bootSidePanel();
```

The bar mounts before any bridge await. A session timeout/bad ticket/upstream frame failure leaves its DOM and switching callbacks alive. A frame that never sends status stays Offline. A failed normal-mode probe adds neither bar nor layout class. The known diagnostic hook retains bounded incoming history for existing proof; neither that hook nor credentials is handed to `mountEmbedBar`.

- [ ] **Run and pass.** `node --test browser-first/test/side-panel-entry.test.mjs browser-first/test/embed-bar.test.mjs browser-first/test/embed-bar-actions.test.mjs browser-first/test/embed-bar-model.test.mjs`. Expected: exit 0, with session-failure recovery and forged status tests passing.
- [ ] **Commit.**

```bash
git add browser-first/resonantos-side-panel-extension/src/side-panel-entry.js browser-first/test/side-panel-entry.test.mjs
git commit -m "feat(embed): compose resilient bar and mode switching"
```

### Task 6: Real-harness proof with a deterministic fixture page

**Files:**

- Modify/test: `browser-first/test/embed-live.mjs`
- Modify: `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js` (one callback indirection, shown below)

**Interfaces:**

- Consumes: live `window.__resonantosEmbed.{ ready, last, send(message) }`; `augmentor-status { online, busy }`; `augmentor-event { event: 'turn.finished' }`; `augmentor-prompt { requestId, text, send, fresh }`; selectors defined in Tasks 4–5.
- Produces helper functions: `statusOnline(): Promise<void>`, `verifyLayout(width): Promise<void>` for numeric viewport widths, and `chooseAssistant(value): Promise<void>` for `embed|normal`. Produces artifacts: `embed-summary.json` with boolean checks and bounded protocol-type/timing metadata, `bar-embed.png`, `bar-normal.png`, and a nonzero process exit on failed live assertions. Artifacts stay at `/private/tmp/resonantos-embed-bar-proof`, never in Git.

This task is an explicit manual live gate against the already-running, real PoC bridge and harness. Do not substitute a fake status or canned model response. The current generated bridge configuration must belong to this worktree; it is neither read into the plan nor committed. This test opens the side-panel document as a tab, so the isolated profile must contain exactly one readable HTTP(S) fixture page when sharing.

- [ ] **Write the failing live acceptance assertion.** Add `import assert from 'node:assert/strict';` to `embed-live.mjs`. Immediately before its existing `summary.pass = true;`, insert this complete test assertion:

```js
assert.deepEqual(summary.checks, {
  layout420: true, layout320: true, online: true, workspace: true,
  fixtureContext: true, fixtureReply: true, normal: true, backToEmbed: true
});
```

- [ ] **Run and observe red.** With the existing PoC bridge/harness available, run:

```bash
RESONANTOS_EMBED_LIVE_OUT=/private/tmp/resonantos-embed-bar-proof node browser-first/test/embed-live.mjs
```

Expected: the old marker-reply proof completes but the new acceptance assertion fails because `summary.checks` is undefined; exit 1. If the old proof cannot reach the real harness, record that prerequisite failure and repair the local test environment before claiming this red gate. No private error text or token-bearing URLs go in the report.

- [ ] **Implement the complete expanded live test.** In `side-panel-entry.js` change only the bar adapter callback to this exact line (inside the existing `mountSidePanelBar` call):

```js
locationRef, sendContext: message => state.send(message) });
```

This preserves the production protocol and lets the existing explicit proof hook observe the outbound Page call. Replace `browser-first/test/embed-live.mjs` with the complete script:

```js
#!/usr/bin/env node
// Manual real-harness proof; excluded from deterministic *.test.mjs discovery.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const out = process.env.RESONANTOS_EMBED_LIVE_OUT;
if (!out) throw new Error('RESONANTOS_EMBED_LIVE_OUT is required');
await mkdir(out, { recursive: true });
const extensionPath = path.resolve(import.meta.dirname, '../resonantos-side-panel-extension');
const profile = await mkdtemp(path.join(os.tmpdir(), 'resonantos-embed-live-'));
const started = Date.now();
const summary = { pass: false, checks: {}, messageTypes: [], timingsMs: {}, stage: 'fixture' };
const fixtureTitle = `Resonant Fixture ${randomUUID()}`;
const fixtureServer = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html><head><title>${fixtureTitle}</title></head><body><h1>Local page sharing fixture</h1><p>Read the document title.</p></body></html>`);
});
let context, page;
const observedTypes = new Set();
async function statusOnline() {
  await page.waitForFunction(() => {
    const node = document.querySelector('#resonantos-bar [data-control=status]');
    return ['online', 'busy'].includes(node?.dataset.state);
  }, null, { timeout: 90000 });
}
async function verifyLayout(width) {
  await page.setViewportSize({ width, height: 900 });
  const metrics = await page.evaluate(() => {
    const bar = document.querySelector('#resonantos-bar');
    const root = document.querySelector('#embed-root');
    const frame = root.querySelector('iframe');
    const b = bar.getBoundingClientRect(), f = frame.getBoundingClientRect();
    return { barHeight: b.height, top: b.top, bottom: b.bottom, frameTop: f.top,
      frameBottom: f.bottom, height: innerHeight, width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      sibling: bar.nextElementSibling === root };
  });
  assert.ok(metrics.barHeight > 0 && metrics.barHeight <= 36);
  assert.equal(metrics.top, 0);
  assert.equal(metrics.sibling, true);
  assert.ok(Math.abs(metrics.frameTop - metrics.bottom) <= 1);
  assert.ok(Math.abs(metrics.frameBottom - metrics.height) <= 1);
  assert.ok(metrics.scrollWidth <= metrics.width);
}
async function chooseAssistant(value) {
  await page.locator('#resonantos-bar [data-control=assistant]').click();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator(`#resonantos-bar [data-mode=${value}]`).click()
  ]);
  assert.equal(await page.evaluate(async () =>
    (await chrome.storage.local.get('resonantos.agentView'))['resonantos.agentView']), value);
  assert.equal(new URL(page.url()).searchParams.get('agentView'), value);
}
try {
  fixtureServer.listen(0, '127.0.0.1');
  await once(fixtureServer, 'listening');
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/fixture`;
  summary.stage = 'launch';
  context = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: { width: 420, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
      '--no-first-run', '--no-default-browser-check'],
    ...(process.env.RESONANTOS_LIVE_CHROME_PATH ? { executablePath: process.env.RESONANTOS_LIVE_CHROME_PATH } : {})
  });
  // Close only pages in this new, test-owned profile; never attach to a personal profile.
  const initialPages = context.pages();
  const fixturePage = await context.newPage();
  await fixturePage.goto(fixtureUrl);
  for (const initialPage of initialPages) await initialPage.close();
  page = await context.newPage();
  await page.addInitScript(() => {
    window.__embedProofTypes = new Set();
    window.__embedProofFinished = false;
    window.addEventListener('message', event => {
      const frame = document.querySelector('#embed-root iframe');
      if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
      const data = event.data;
      const allowed = ['augmentor-ready', 'augmentor-result', 'augmentor-status', 'augmentor-event',
        'augmentor-settings', 'augmentor-hide', 'augmentor-link'];
      if (allowed.includes(data?.type)) window.__embedProofTypes.add(data.type);
      if (window.__embedProofPromptSent && data?.type === 'augmentor-event' && data.event === 'turn.finished') {
        window.__embedProofFinished = true;
      }
    });
  });
  summary.stage = 'ready';
  const readyStarted = Date.now();
  const url = 'chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl/src/side-panel.html?agentView=embed';
  while (true) {
    try { await page.goto(url, { timeout: 10000 }); break; }
    catch {
      if (Date.now() - readyStarted >= 90000) throw new Error('Extension did not open');
      await page.waitForTimeout(250);
    }
  }
  await page.waitForFunction(() => window.__resonantosEmbed?.ready === true, null, { timeout: 90000 });
  summary.timingsMs.ready = Date.now() - readyStarted;
  await statusOnline(); summary.checks.online = true;
  summary.stage = 'layout';
  await verifyLayout(420); summary.checks.layout420 = true;
  await verifyLayout(320); summary.checks.layout320 = true;
  await page.setViewportSize({ width: 420, height: 900 });
  summary.stage = 'workspace';
  const workspacePromise = context.waitForEvent('page');
  await page.locator('#resonantos-bar [data-control=workspace]').click();
  const workspace = await workspacePromise;
  await workspace.waitForURL('**/src/main-workspace.html');
  await page.waitForFunction(() =>
    document.querySelector('#resonantos-bar [data-control=workspace]')?.getAttribute('aria-pressed') === 'true');
  summary.checks.workspace = true;
  await page.bringToFront();
  summary.stage = 'fixture-context';
  // Verify the production resolver has only one readable HTTP(S) candidate.
  const readable = await page.evaluate(async () =>
    (await chrome.tabs.query({ currentWindow: true })).filter(tab => /^https?:\/\//i.test(tab.url ?? '')).map(tab => tab.url));
  assert.deepEqual(readable, [fixtureUrl]);
  await page.evaluate(() => {
    window.__barProofContexts = [];
    const state = window.__resonantosEmbed;
    const original = state.send;
    state.send = message => {
      const accepted = original(message);
      if (message?.type === 'augmentor-context' && accepted) {
        window.__barProofContexts.push(message.context);
      }
      return accepted;
    };
  });
  await page.locator('#resonantos-bar [data-control=page]').click();
  await page.locator('#resonantos-bar [role=status]').filter({ hasText: 'Page shared' }).waitFor();
  const shared = await page.evaluate(() => window.__barProofContexts);
  assert.deepEqual(shared, [{ source: 'resonantos', page: { title: fixtureTitle, url: fixtureUrl } }]);
  summary.checks.fixtureContext = true;
  const inner = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame()
    && new URL(frame.url()).pathname.startsWith('/embed/'));
  assert.ok(inner, 'Embedded panel frame missing');
  // A title already displayed in a context badge must not count as a model reply.
  const exactTitleBefore = await inner.getByText(fixtureTitle, { exact: true }).count();
  summary.stage = 'fixture-turn';
  const turnStarted = Date.now();
  const accepted = await page.evaluate(requestId => {
    window.__embedProofPromptSent = true;
    window.__embedProofFinished = false;
    return window.__resonantosEmbed.send({ type: 'augmentor-prompt', requestId,
      text: 'What is the title of the page shared by ResonantOS? Reply with exactly that title and no other text.',
      send: true, fresh: true });
  }, randomUUID());
  assert.equal(accepted, true);
  await page.waitForFunction(() => window.__embedProofFinished === true, null, { timeout: 180000 });
  const replyDeadline = Date.now() + 10000;
  while (await inner.getByText(fixtureTitle, { exact: true }).count() <= exactTitleBefore) {
    if (Date.now() >= replyDeadline) throw new Error('Fixture title reply missing');
    await page.waitForTimeout(100);
  }
  summary.timingsMs.turn = Date.now() - turnStarted;
  summary.checks.fixtureReply = true;
  await statusOnline();
  await page.screenshot({ path: path.join(out, 'bar-embed.png') });
  for (const type of await page.evaluate(() => [...window.__embedProofTypes])) observedTypes.add(type);
  summary.stage = 'normal';
  await chooseAssistant('normal');
  await page.locator('#normal-chat-root #command-input').waitFor({ state: 'visible' });
  await page.locator('#resonantos-bar [data-control=assistant]').waitFor();
  assert.deepEqual(await page.locator('#resonantos-bar [data-control]').evaluateAll(nodes =>
    nodes.map(node => node.dataset.control)), ['assistant']);
  assert.equal(await page.locator('#embed-root').count(), 0);
  summary.checks.normal = true;
  await page.screenshot({ path: path.join(out, 'bar-normal.png') });
  summary.stage = 'back-to-embed';
  await chooseAssistant('embed');
  await page.waitForFunction(() => window.__resonantosEmbed?.ready === true, null, { timeout: 90000 });
  await statusOnline(); await verifyLayout(420);
  summary.checks.backToEmbed = true;
  assert.deepEqual(summary.checks, {
    layout420: true, layout320: true, online: true, workspace: true,
    fixtureContext: true, fixtureReply: true, normal: true, backToEmbed: true
  });
  summary.pass = true; summary.stage = 'complete';
} catch {
  summary.error = `Embed live proof failed at ${summary.stage}`;
  process.exitCode = 1;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'bar-fail.png') }).catch(() => {});
} finally {
  if (page && !page.isClosed()) {
    for (const type of await page.evaluate(() => [...(window.__embedProofTypes ?? [])]).catch(() => [])) observedTypes.add(type);
  }
  summary.messageTypes = [...observedTypes].sort();
  summary.timingsMs.total = Date.now() - started;
  try { await context?.close(); }
  finally {
    fixtureServer.closeAllConnections();
    if (fixtureServer.listening) await new Promise(resolve => fixtureServer.close(resolve));
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(out, 'embed-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
}
console.log(JSON.stringify(summary));
```

The prompt deliberately contains neither the fixture title nor its random suffix: a canned title echo cannot satisfy the gate. Compare the exact rendered title count after a completed turn against the count before prompting; retain the actual visible screenshot for human inspection of the assistant reply. No page text, messages, cookies or ticket-bearing URLs are logged. Keep the local fixture open through both assistant switches. If the real harness's context envelope differs, stop on this failed gate and reconcile against its actual protocol source; do not weaken the title assertion or add a fifth relay type.

- [ ] **Run and pass.**

```bash
node --test browser-first/test/side-panel-entry.test.mjs
RESONANTOS_EMBED_LIVE_OUT=/private/tmp/resonantos-embed-bar-proof node browser-first/test/embed-live.mjs
```

Expected: both exit 0, all eight `checks` true, nonempty `bar-embed.png` and `bar-normal.png`. Inspect both images: one bar above the unchanged harness at 420 px, no clipping, correct visible assistant reply; normal mode has only Assistant above the existing chat. Also use keyboard Tab/Enter/Escape in the live page and Chrome's toolbar action context menu/Alt+Shift+W manually to confirm Chrome accepted the command binding (OS shortcut conflicts can be reassigned in `chrome://extensions/shortcuts`). Emulate light color scheme and reduced motion in DevTools and verify the token variant and still status; retain any extra evidence outside Git.

- [ ] **Commit only source, never proof output or generated config.**

```bash
git add browser-first/test/embed-live.mjs browser-first/resonantos-side-panel-extension/src/side-panel-entry.js
git commit -m "test(embed): prove bar layout page context and assistant switching"
```

### Task 7: Document ownership and run the complete required gates

**Files:**

- Modify: `browser-first/README.md`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md`
- Create/test: `browser-first/test/embed-bar-documentation.test.mjs`
- Test: all touched test files listed in the final command below.

**Interfaces:**

- Consumes: completed Tasks 1–6 and their exact function/route contracts; repository npm validation scripts.
- Produces: documented ownership and permission/launcher behavior; final deterministic checks and independently recorded manual/mutation proof. No new runtime API.

- [ ] **Write the failing documentation acceptance test.** Create `browser-first/test/embed-bar-documentation.test.mjs`:

```js
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
```

- [ ] **Run and observe red.** `node --test browser-first/test/embed-bar-documentation.test.mjs`. Expected: absent current README permission/launcher text and missing bar ownership rows.
- [ ] **Implement the complete documentation additions.** Add the following section after “Extension Boundary” and before “Context Session Persistence” in `browser-first/README.md`:

```markdown
## Extension Permissions And Workspace Launchers

The extension declares `activeTab`, `clipboardRead`, `clipboardWrite`,
`contextMenus`, `history`, `scripting`, `sidePanel`, `storage`, `tabs`, and
`webNavigation`, with HTTP(S) host permissions. `contextMenus` adds the
extension toolbar's right-click item, **Open ResonantOS workspace**. It does
not add a page context-menu action. The command `open-resonantos-workspace`
suggests **Alt+Shift+W** and opens or focuses the workspace; it never closes it.
The existing side-panel shortcut remains **Alt+Shift+A**. Chrome or the OS may
require assigning a shortcut in `chrome://extensions/shortcuts`.

On the opt-in embed testing branch, the ResonantOS bar sits above the unchanged
harness panel. Workspace retains the existing open/focus/close toggle behavior.
Assistant stores `resonantos.agentView` as `embed` or `normal` and reloads the
side-panel document; an explicit `agentView` query takes precedence at boot.
An explicit Assistant choice also updates that query when it is present.

Page shares only sanitized title and URL metadata after checking the current
site permission. Blocked or unreadable permission state sends nothing; “Page
shared” confirms local dispatch. Approvals reads the existing browser-job queue
and only opens/focuses the workspace for human review. Status comes from the
harness relay. Session failure leaves Workspace and Assistant usable. In normal
mode, only Assistant appears, and only after successful embed availability.
The bar receives no credentials and does not control pages for the harness.

Testing-branch design and execution details are in the
[approved bar design](../docs/planning/embed-bar-design.md) and
[bar implementation plan](../docs/planning/embed-bar-plan.md).
```

Add these complete rows to the Alpha Ownership table in `docs/architecture/MODULE-OWNERSHIP.md`:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-model.js` | Pure bar visibility, status labels, bounded page-context projection and approval counts | Sanitized candidate metadata and existing job snapshots | Detached return values only | DOM, Chrome APIs, bridge requests or credentials |
| `browser-first/resonantos-side-panel-extension/src/lib/embed-bar-actions.js` | Page metadata sharing and assistant preference/job-read adapters | Existing page resolver, strict site permission store and job-history reader | User-selected mode preference and allowed context callback | Bridge credentials, page DOM capture, approval decisions or harness execution |
| `browser-first/resonantos-side-panel-extension/src/lib/embed-bar.js` | Bar DOM, menu access and callback wiring | Mode, boolean status, counts and narrow callbacks | Bar DOM and explicit user intents | Chrome APIs, bridge configuration, credentials or iframe internals |
| `browser-first/resonantos-side-panel-extension/src/side-panel-entry.js` | Mode boot, availability probing and validated embed relay composition | Selected mode, bridge client results and exact-source/origin relay events | Side-panel bar/frame lifecycle and bounded live-proof history | Harness credential custody, normal chat behavior or new relay message types |
| `browser-first/resonantos-side-panel-extension/src/lib/workspace-launchers.js` | Workspace keyboard command and toolbar action-menu registration | Explicit Chrome user events | Open/focus requests through the workspace toggle adapter | Page actions, assistant approvals or bridge credentials |
```

In the existing `embed-host-service.mjs` ownership row, replace its “May write or mutate” cell with this complete text:

```text
In-memory tickets, sessions and owned tunnels; GET /embed/status and POST /embed/session require addon-runtime-control; status projects availability/profile only, including unavailable state when disabled; /embed-host/ consumes a ticket and /embed/<profile>/ requires the session cookie and origin/fetch checks
```

- [ ] **Run and pass all final gates, in this order.** First the complete touched-test command, then repository gates:

```bash
node --test browser-first/test/embed-host-service.test.mjs browser-first/test/bridge-route-capability-audit.test.mjs browser-first/test/embed-bar-model.test.mjs browser-first/test/embed-bar-actions.test.mjs browser-first/test/main-workspace-toggle.test.mjs browser-first/test/workspace-launchers.test.mjs browser-first/test/alpha-browser-extension-scope.test.mjs browser-first/test/embed-bar.test.mjs browser-first/test/side-panel-entry.test.mjs browser-first/test/embed-bar-documentation.test.mjs
npm run test:browser-first
npm run docs:check
npm run test:docs
node scripts/security-pipeline/run-check.mjs
npm run verify:alpha
```

Expected: every command exits 0. `embed-live.mjs` remains manual and is deliberately excluded from `node --test` discovery; its Task 6 command is a separate required gate. `verify:alpha` is included because the repository requires it for cross-module final certification. If any command fails, record its exact name/failure and distinguish an existing baseline issue from this change; do not call the implementation certified, disable tests, or rewrite gates to hide it. Fix only owned changes, rerun affected checks, then finish the gate sequence. Verify the mutation restored the guard and the manual report includes both screenshots before declaring this testing-branch plan implemented.

- [ ] **Commit after scope review.** Run `git diff --check` and `git status --short`; ensure only assigned source/tests/docs are staged and no generated config, token file, profile, screenshot or report is staged. Then:

```bash
git add browser-first/README.md docs/architecture/MODULE-OWNERSHIP.md browser-first/test/embed-bar-documentation.test.mjs
git commit -m "docs(embed): document bar boundaries permissions and validation"
```

Do not push or merge this testing-branch experiment as part of these tasks.

## Self-review

**Spec coverage:**

| Approved spec item | Task |
| --- | --- |
| Slim row outside and above harness; frame uses remaining height | 4, 5; measured in 6 |
| Embed shows all controls; normal shows only Assistant when available; no normal-mode UI change otherwise | 1, 4, 5 |
| Workspace reuses toggle; aria-pressed tracks visible active tab | 3, 4, 5; live in 6 |
| Assistant Augmentor/ResonantOS, storage values, reload and explicit-query precedence | 2, 4, 5; round trip in 6 |
| Page uses existing resolver and sanitizers, exact context data, 16,000-byte bound, local confirmation | 2, 5; local fixture/title turn in 6 |
| Blocked/unreadable site sends nothing | 2; non-vacuous mutation in 2 |
| Conditional Approvals decision, count and workspace focus | Findings 1; 2, 3, 4, 5; included via existing storage read path |
| Relayed online/idle, busy, offline; accessible status, reduced motion | 2, 4, 5; online proof in 6 |
| GET /embed/status and addon-runtime-control; no credentials | 1; composition in 5; ownership in 7 |
| Alt+Shift+W and action context-menu launcher; contextMenus and command pins | 3; current permissions documented in 7 |
| 36 px height, 320 px fit, icons/tooltips/names, keyboard focus, Escape, dark/light tokens | 4; real 320/420 px measurements and human inspection in 6 |
| Four-message allowlist, unchanged upstream, credential boundary and excluded features | 1, 2, 4, 5, 7 |
| Embed failure preserves Workspace/Assistant; normal probe failure hides bar | 4, 5 |
| node:test coverage, live screenshots bar-embed.png/bar-normal.png, Page reply and assistant round trip | 1–6 |
| Final required checks and documentation ownership | 7 |

**Placeholder scan result:** No unfinished implementation markers or omitted code blocks. All code edits are given as complete new modules, complete replacement functions/properties, exact insertions, or complete test/script bodies. No task delegates unspecified code to a later implementer. Generated credentials and the real harness are explicit external live-test prerequisites, not invented fixtures.

**Name/signature consistency check:** `sharePage`, `selectAssistant`, and `readApprovals` from `createEmbedBarActions` match the names consumed by `mountEmbedBar`. The workspace adapter provides `toggle`, `isVisible`, and `open`; composition maps them to `toggleWorkspace`, `workspaceVisible`, and `openWorkspace`. Availability uses `GET /embed/status` in host, client map, audit, and probe. Context uses one `augmentor-context` envelope with a `context` property and only `source/page/title/url` inside it; the complete serialized envelope is byte-bounded. DOM selectors and mode values in the live script match the bar and entry modules. Task 6's callback indirection preserves the same `send(message): boolean` contract. Route and storage ownership stay in their existing modules.

Planning validation: `npm run test:docs` passed (293 tests). `npm run docs:check` reported the existing tracked `docs/planning/embed-bar-design.md` as unreachable from a canonical entrypoint. The plan-only scope leaves that file and the router unchanged; Task 7 adds the missing canonical README links during implementation. JavaScript and shell snippets were syntax-checked in memory, with function/property insertion fragments wrapped in their declared context; no proposed implementation was executed.

Planning validation is distinct from implementation evidence: the red/green expectations above have not been executed against the proposed implementation during this plan-only task. The real harness's context consumption and rendered reply are certified only by the explicit live gate, never by a stub or source assertion.
