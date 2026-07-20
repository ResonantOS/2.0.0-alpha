# ADR-017: Resonant Browser Add-on And Live AI Control

## Decision Metadata

- Decision status: Superseded
- Alpha applicability: Not applicable
- Superseded by: ADR-025
- Owner: Browser architecture
- Decision date: Not recorded
- Alpha note: This embedded-browser decision is historical. Alpha browser UI
  and control live in the Chrome MV3 extension.

## Decision

Resonant Browser must be a **live internal browser**, not a screenshot viewer, iframe, or static evidence surface.

The Browser add-on must host an interactive Chromium-class browser surface inside the ResonantOS center workspace. The human and approved AI tools must operate the same live browser session. The Browser add-on remains optional and capability-gated, but when opened it must behave like a real browser: tabs, address bar, back/forward, reload, scrolling, clicking, typing, zoom/page scale, and live rendering.

The previous CDP screenshot prototype is explicitly rejected as the Browser UI foundation. It may remain useful only as a narrow evidence-capture or headless-research tool after a live browser exists, but it must not be presented to the user as Resonant Browser.

The product Browser engine path is now governed by ADR-025. Interim web frames, screenshots, and Electron sidecars are not product Browser implementations.

## Why

The product requirement is an internal browser that Augmentor can eventually control while the user remains inside ResonantOS. Screenshots do not satisfy that requirement because they are not live, they do not preserve native browser interaction, they make scrolling/clicking brittle, and they create the false impression that ResonantOS has a browser when it only has image capture.

ResonantOS currently runs on Tauri. Tauri's primary app surface is the operating-system WebView: WKWebView on macOS, WebView2 on Windows, and WebKitGTK on Linux. That is not the same as embedding a full Chromium browser view in the center workspace. A real live Chromium browser therefore requires a deliberate engine decision instead of more React/CSS work.

## Rules

- Browser is an add-on, not a core dependency.
- Browser must fill the center workspace when opened; it must not appear as a small nested card or settings panel.
- Browser must expose a live interactive browser viewport, not a rendered screenshot.
- Browser must use a Chromium-class engine for the target product unless this ADR is superseded.
- Interim center-workspace web-frame support is allowed only because it is live and user-operable; it must not be described as the final Chromium engine.
- Interim browser chrome may include menus, bookmarks, AI Mode, and extension-slot affordances, but it must clearly distinguish unavailable Chromium-only features from working features.
- Chrome extension installation, pinning, profiles, extension background pages, and extension-store compatibility require the final Chromium BrowserView/CEF host. They must not be presented as fully available on the Tauri OS WebView surface.
- The Playwright Chromium host is the current audited control foundation, not the final visible browser surface.
- Until the visible browser and control host share one session, Augmentor may use the host only for delegated browser tasks, not as proof that it controls the user's visible tab.
- Browser must keep Augmentor available in the right rail unless the user enters a full-screen workspace mode.
- Browser requires explicit `network`, `ui-embedding`, and `browser-control` grants.
- AI browser control must attach to the same live session the user sees.
- AI browser actions must route through audited host-mediated tools.
- Browser must gate high-risk actions: destructive, public posting, identity, account, payment, wallet, or credential actions require human approval.
- Browser cannot write trusted Living Archive knowledge pages. It may write browser artifacts only to archive intake when granted.
- API research remains preferred for ordinary lookup; Browser is used when visual inspection, login state, forms, or web app interaction are required.

## Engine Options

### Current Visible V1: Center-Workspace Web Frame

Use a live web frame inside the Browser workspace to create an immediate user-operable browsing surface.

Advantages:

- works inside the current Tauri shell
- gives the user a real live browsing surface immediately
- supports native scrolling, clicking, typing, page rendering, and workspace resizing
- removes the rejected screenshot-based UI

Limits:

- many sites can block embedding or restrict behavior
- it is not one consistent Chromium automation surface
- it cannot provide Chrome extension install/pin/profile compatibility
- it does not expose reliable DOM inspection, CDP, click/type automation, or page-read tooling against the same live session
- this cannot be the final AI-controlled Browser engine

Rule: the center-workspace web frame is acceptable as V1 user browsing, but Browser AI-control work must target a Chromium automation host.

### Current Control Foundation: Playwright Chromium Host

Use `addons/resonant-browser-host` as a standalone local service with a `stdio-json-rpc` command contract.

Advantages:

- real Chromium automation surface now
- deterministic tests for open/read/click/type/capture/close
- clean add-on boundary that can be disabled or replaced
- audited command stream suitable for future Augmentor delegation

Limits:

- the host is currently headless/tested as a control service
- it is not yet the same visible browser session shown in the center workspace
- it must be mediated by ResonantOS before agent access is exposed

Rule: this host is the implementation contract for browser tools. It should not be presented as the final product UI until the visible Chromium session is embedded or launched as a governed add-on window.

### Current Mediation Layer: Governed Browser Tool Runner

Use `src/core/browser-tools.ts` as the TypeScript-side policy gate before Augmentor or any delegated agent can call Browser tools.

Rules:

- Browser control calls must resolve against the Browser add-on manifest.
- Required tool capabilities must be granted on the Browser installation before transport execution.
- Sensitive typing requires explicit human approval.
- The runner calls a transport abstraction, not Playwright directly. This keeps the add-on host replaceable and prevents UI code from bypassing ResonantOS mediation.

### Rejected Product Path: Electron Browser Add-on Host

Use an Electron-based Browser add-on host with Chromium `BrowserWindow`, `BrowserView`, or `WebContentsView`.

Advantages:

- real Chromium surface
- mature tab/navigation APIs
- best path to Chrome extension compatibility, pinned extension UI, profiles, and Chromium menu behavior
- direct DevTools Protocol access to the same live session
- strong fit for AI control, page inspection, and automation
- faster path to the intended product than CEF-native integration

Tradeoffs:

- adds a second desktop runtime beside the Tauri shell
- requires process lifecycle, window/view embedding, packaging, signing, and update policy
- needs a clear IPC bridge between ResonantOS and the Browser add-on host
- Electron can load local unpacked extensions, but it does not automatically provide Chrome's full extension toolbar, Chrome Web Store install flow, or pinning UI. ResonantOS must provide its own extension manager and pinned-extension surface.

Rejection rule:

- Electron sidecar work may remain as a temporary research harness only.
- It must not be launched automatically from the Browser workspace.
- It must not be represented as embedded in ResonantOS.
- It must not be used to claim Phantom or Bitwarden readiness.

### Selected Product Direction: Native Embedded Chromium Host

Use a native embedded Chromium host while keeping the Tauri shell. The first candidate is CEF with Chrome Runtime enabled, but it is accepted only if Phantom Wallet and Bitwarden pass deterministic compatibility tests.

Advantages:

- keeps the main ResonantOS shell architecture intact
- can produce a true live Chromium viewport
- can attach the browser surface to the center workspace instead of opening another app window

Tradeoffs:

- significantly more native integration work
- more fragile cross-platform packaging
- higher maintenance burden for macOS, Windows, and Linux
- CEF extension support is limited and must be tested against Phantom and Bitwarden before building UI on top of it

### Rejected For Product Browser UI

- Screenshot/CDP surface: useful for evidence capture, not a live browser.
- `iframe`: many sites block embedding and it gives the wrong security/control boundary.
- Tauri OS WebView as final Browser: live, but not Chromium-class on all platforms and limited for the intended AI-control model.
- External browser window only: can be useful as a fallback, but does not satisfy the internal center-workspace product requirement.

## Interfaces

Browser manifest requirements:

- runtime type: `local-service`
- surface: `embedded-pane`
- required capabilities: `network`, `ui-embedding`, `browser-control`
- optional capability: `archive-intake-write`
- service: live browser host process, not screenshot-only capture
- first tools: `browser.open_url`, `browser.read_page`, `browser.click`, `browser.type`, `browser.navigate`, `browser.capture_evidence`, `browser.close_session`
- extension tools: `browser.extensions.list`, `browser.extensions.load_unpacked`, `browser.extensions.set_pinned`, `browser.extensions.disable`
- delegation task types: `research`, `browser-inspection`
- artifact return types: `summary`, `markdown`, `log`, `citation-bundle`, `diagnostic-report`

Live session contract:

```ts
type LiveBrowserSession = {
  sessionId: string;
  windowId: string;
  activeTabId: string;
  url: string;
  title: string;
  engine: "chromium";
  scale: 1;
  controlMode: "human" | "ai-assisted" | "ai-running";
};

type BrowserExtensionState = {
  extensionId: string;
  name: string;
  version: string;
  installed: boolean;
  pinned: boolean;
  enabled: boolean;
  source: "chrome-web-store" | "local-unpacked" | "resonantos-registry";
  requestedCapabilities: string[];
};

type BrowserSessionCommand =
  | { type: "open_url"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "click"; target: BrowserTarget }
  | { type: "type"; target: BrowserTarget; text: string; sensitive?: boolean }
  | { type: "read_page"; selector?: string }
  | { type: "capture_evidence"; reason: string };
```

Execution boundary:

- React owns shell composition and Browser workspace routing.
- The Browser add-on host owns the live Chromium surface, tab state, navigation, and page lifecycle.
- Rust/Tauri owns privileged grants, process lifecycle mediation, secrets, filesystem boundaries, and audit persistence.
- Agents request browser actions; ResonantOS grants, mediates, logs, and can stop execution.
- Extension loading is treated as privileged because extensions can observe pages, access storage, and affect authenticated sessions.
- Extension disable/unpin actions are host-mediated lifecycle controls. Add-ons and agents must not mutate extension state directly.

## Consequences

- The current screenshot prototype must not be extended as the product Browser.
- The Browser workspace should use the live center-workspace web frame while the final Chromium engine host is selected and implemented.
- Building the real Browser is a platform decision, not a cosmetic UI task.
- Before AI-control implementation resumes, choose either Electron Browser add-on host or CEF child-view host and document the selected packaging/lifecycle path.
- ADR-025 chooses the native embedded browser host path and requires extension compatibility proof before product UI expansion.

## Current Implementation State

- `public/addons/browser.json` declares the Browser add-on as a bundled SDK V0 add-on.
- `src/modules/browser/BrowserWorkspace.tsx` creates a live center-workspace web frame when Browser grants are present.
- `addons/resonant-browser-host` provides the first tested Chromium control service for delegated browser actions.
- `addons/resonant-browser-native` defines the native embedded Browser host contract.
- `addons/resonant-browser-host/src/electron-visible-host.mjs` is retained only as a research harness.
- The live web frame is user-operable and replaces the screenshot UI, but it is not the final Chromium-class AI-control engine.
- `src-tauri/src/browser_service.rs` still contains the rejected CDP screenshot prototype and should be treated as deprecated until either removed or repurposed as a non-UI evidence-capture service.
- Browser add-on install/grant UI exists, but this does not mean the live browser engine exists.
