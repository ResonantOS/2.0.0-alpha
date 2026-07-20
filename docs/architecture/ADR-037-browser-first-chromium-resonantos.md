# ADR-037: Browser-First Chromium ResonantOS

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Browser architecture
- Decision date: Not recorded
- Alpha note: Browser-contained product direction applies, but Alpha is an
  unpacked Chrome MV3 extension plus authenticated local Node bridge, not a
  custom Chromium distribution. This ADR supersedes ADR-035 and ADR-036.

## Decision

ResonantOS must become a browser-first application: a Chromium-family browser that contains ResonantOS capabilities, not a ResonantOS dashboard that opens or controls another browser.

The product target is a Comet-style browser:

- the browser viewport is the primary surface
- ResonantOS capabilities live inside browser chrome as first-class panels, overlays, commands, and services
- Augmentor is a browser-native assistant panel with access to the active tab through governed APIs
- Living Archive, add-ons, task monitor, delegation, wallet state, and provider routing are integrated into the browser shell
- Phantom and other Chrome-compatible extensions must run inside the same browser profile the human uses
- AI browser control and human browser control operate on the same active tab/session

## Why

The previous paths failed the product requirement:

- Tauri/WebView is not a Chrome-compatible browser.
- Electron `BrowserView` is Chromium-based but does not provide full Chrome extension API compatibility. Electron documents extension support as a subset of Chrome extension APIs, which is insufficient for Phantom-class wallet behavior.
- An external Chrome/Brave profile controlled through CDP proves automation feasibility but violates the requirement for one single browser app.
- A sidecar browser creates user confusion and splits wallet/session state away from ResonantOS.

Comet’s public documentation describes Comet as Chromium-based and Chrome-extension compatible. That validates the direction: ResonantOS must be a Chromium-derived browser with AI and memory layers integrated into browser chrome.

## Binding Rules

- Do not present external Chrome/Brave CDP control as the product Browser.
- Do not invest further in Phantom-in-Electron as a product path.
- Do not represent screenshots, iframes, Tauri OS WebView, or Electron sidecars as “the ResonantOS browser.”
- Product Browser work must target a Chromium-family browser shell or Chromium-source overlay.
- The default ResonantOS user experience is browser-first: tabs, address bar, navigation, extension UI, and Augmentor panel in one window.
- Browser extension compatibility is a release gate, not a later nice-to-have.
- Phantom Wallet must run in the same browser profile and browser chrome as the human’s active tab.
- Wallet approvals, signatures, seed/export flows, password-manager actions, and public submissions remain human-only approval gates.
- AI control must use typed, auditable browser tools. No raw CDP, raw filesystem, raw extension, or raw credential access is exposed to add-ons or chat commands.
- The browser-to-ResonantOS bridge must not accept unauthenticated localhost requests. The preview implementation uses a per-session bridge token and restricted CORS.
- Production wallet/DAO release requires replacing the preview localhost token bridge with native messaging, signed IPC, or an equivalent authenticated browser-shell channel. This is a **P1 pre-release security gate**, not optional cleanup.
- The preview token bridge may be used for local development and internal testing, but it must be labelled as insufficient against same-user local malware.

## Product Shape

```text
ResonantOS Browser
├─ Browser chrome
│  ├─ tabs
│  ├─ address bar
│  ├─ navigation controls
│  ├─ extension toolbar
│  └─ profile/session controls
├─ Web contents
│  └─ active tab, controlled by both human input and mediated AI tools
├─ ResonantOS side panel
│  ├─ Augmentor
│  ├─ task monitor
│  ├─ Living Archive context
│  ├─ add-on surfaces
│  └─ wallet/action approval monitor
└─ Privileged host services
   ├─ provider fabric
   ├─ secure storage
   ├─ archive service
   ├─ add-on lifecycle
   └─ audited browser/action bridge
```

## Implementation Strategy

Phase 1 creates a browser-contained ResonantOS layer as a Chromium extension-style surface:

- side panel UI
- content script bridge for active-tab context
- background service worker for command routing
- explicit permission declarations
- no privileged local actions from page JavaScript

Phase 2 embeds that layer into a Chromium-family shell:

- Chromium source fork or equivalent browser-shell build
- bundled ResonantOS extension/layer
- real extension toolbar and profile storage
- Phantom installed and exercised in the same profile
- Augmentor side panel shipped by default

Phase 3 moves privileged ResonantOS services behind native host boundaries:

- provider vault
- Living Archive service
- add-on service manager
- wallet/signing audit monitor
- typed browser tools exposed to Augmentor
- native messaging or signed IPC for the browser-to-host bridge before public wallet/DAO readiness

## Current Preview Bridge

The current browser-first preview launches a local bridge server on loopback and writes a per-session bridge config for the bundled ResonantOS side-panel extension.

Binding rules for this preview bridge:

- every non-`OPTIONS` bridge route must require `X-ResonantOS-Bridge-Token`
- requests without the correct token must return `401`
- bridge responses must not use wildcard CORS
- generated bridge config is session material and must not be committed
- the bridge token reduces accidental and web-origin localhost abuse, but it is not a defense against malware already running as the same OS user
- public wallet/DAO readiness remains blocked until native messaging, signed IPC, or an equivalent authenticated browser-shell channel replaces this preview bridge

## Required Interfaces

```ts
type BrowserFirstTab = {
  tabId: string;
  windowId: string;
  url: string;
  title: string;
  status: "loading" | "ready" | "blocked" | "error";
};

type BrowserFirstPanel = {
  panelId: "augmentor" | "archive" | "tasks" | "addons" | "wallet-approvals";
  visibility: "open" | "collapsed" | "detached";
  activeTabId: string;
};

type BrowserFirstActionRequest = {
  requestId: string;
  tabId: string;
  actor: "human" | "augmentor" | "addon";
  action: "navigate" | "read_page" | "click" | "type" | "submit" | "wallet_connect" | "wallet_sign";
  riskTier: "safe" | "sensitive" | "wallet" | "public" | "destructive";
  humanApproval: "not_required" | "required" | "granted" | "denied";
};
```

## Acceptance Tests

The browser-first product is not complete until deterministic tests prove:

- one ResonantOS browser window owns tabs, address bar, active page, Augmentor panel, and extension toolbar
- Phantom installs or is bundled through an approved Chrome-compatible extension path
- Phantom UI opens inside the browser chrome
- wallet provider injection is visible to a local dApp fixture
- wallet connection and signing requests are surfaced as human approval gates
- Augmentor can read and navigate the active tab through typed tools
- Augmentor cannot approve/sign/export/reveal wallet material
- unauthenticated localhost requests to the browser bridge are rejected
- production bridge traffic uses native messaging, signed IPC, or an equivalent authenticated browser-shell channel before wallet/DAO release
- Living Archive and add-ons receive scoped browser artifacts only through mediated APIs
- macOS, Windows, and Linux builds are reproducible

## Consequences

- Existing Tauri and Electron work becomes transitional scaffolding, not the final app architecture.
- The external wallet-host work remains useful only as a research proof for CDP automation and Phantom requirements.
- The next implementation target is a Chromium-family browser shell with ResonantOS bundled into browser chrome.
- The codebase must keep browser-first assets separate so community work on the old dashboard does not contaminate the new product path.

## References

- Comet Browser Help Center: Comet is Chromium-based and supports Chrome extensions.
- Electron documentation: Electron supports only a subset of Chrome extension APIs.
- Chrome extension documentation: Manifest V3 and side panel APIs are browser-level surfaces that ResonantOS must treat as part of the product browser architecture.
