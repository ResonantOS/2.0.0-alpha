# ADR-035: Electron Host + Rust Core Runtime

## Decision Metadata

- Decision status: Superseded
- Alpha applicability: Not applicable
- Superseded by: ADR-037
- Owner: Browser architecture
- Decision date: Not recorded
- Status date: 2026-05-25
- Alpha note: This Electron/Rust host direction is historical. Electron, Rust,
  and native desktop packaging are not Alpha runtime or validation requirements.

## Decision

ResonantOS should move from a Tauri-first desktop shell to an **Electron host shell with a Rust privileged core service** if the Electron spike proves Phantom Wallet and controlled browser operation.

The target runtime split is:

- Electron owns the desktop shell, Chromium browser surfaces, detachable windows, add-on UI surfaces, and human/AI visible workspaces.
- Rust owns privileged services: secrets, wallet/signing policy, filesystem access, local process orchestration, provider routing, recovery tooling, and add-on supervision.
- Add-ons remain replaceable modules mediated by ResonantOS capability grants.

This is not a move to an all-JavaScript security model. Electron is the product/browser surface; Rust remains the authority boundary.

## Why

ResonantOS is no longer a lightweight native settings dashboard. It is becoming a browser-like AI operating environment that must:

- run on macOS, Windows, and Linux
- host add-ons and replaceable product surfaces
- run or supervise open-source tools such as Hermes, OpenCode, OpenClaw, and local model services
- provide an internal browser that works for both the human and AI agents
- support wallet-compatible browser sessions for DAO and smart-contract flows
- let AI agents operate app surfaces and browser surfaces through governed, typed controls
- keep privileged operations auditable and capability-gated

Tauri’s platform webviews are not enough for this. On macOS, Tauri uses WKWebView; WKWebView does not provide Chrome extension compatibility. The CEF-in-Tauri experiment proved that standalone CEF can load pages and Phantom, but product embedding inside the Tauri/WKWebView process creates rendering, layering, and crash issues.

Electron is a better host runtime for this product because it ships Chromium consistently across operating systems and exposes mature `webContents`, session, extension, window, and DevTools Protocol primitives.

## Rules

- Do not continue investing in Tauri + in-process CEF as the product Browser path unless this ADR is rejected.
- Do not move secrets, signing, or privileged filesystem access into Electron renderer code.
- Remote pages and add-on UI surfaces must run with `nodeIntegration: false`, `contextIsolation: true`, and sandboxing enabled unless an ADR grants an explicit exception.
- Browser actions from AI must go through typed, auditable commands.
- Wallet signing must require explicit user approval and Rust-side policy mediation.
- Browser extensions may be loaded only from reviewed sources or user-approved local paths.
- Add-ons declare capabilities; ResonantOS mediates access.
- The Electron host must remain modular so Augmentor Chat, Living Archive, Browser, and other surfaces can remain replaceable add-ons.

## Required Spike

Before migration, implement an Electron host spike that proves:

- The shell opens a Chromium browser surface.
- A page can be loaded, read, clicked, typed into, and screenshotted.
- Phantom Wallet can be loaded from a reviewed unpacked local extension directory.
- A test page can detect `window.phantom.solana.isPhantom` or `window.solana.isPhantom`.
- The browser runs with Node disabled and context isolation enabled.
- A Rust-side command can be called through a narrow IPC proof without exposing secrets.
- The first Rust-side IPC method is `core.health`; no other privileged method is accepted by the spike.

## Acceptance Criteria

The migration is accepted only if deterministic tests pass for:

- Electron contract tests.
- Real Electron smoke test with local HTTP fixture.
- Real Electron Phantom provider-injection smoke test on a machine with Phantom installed.
- Production TypeScript build remains green.
- Rust tests remain green.

## Current Spike Result

As of 2026-05-25, the first Electron host spike passes:

- `npm run test:electron-host`
- `npm run electron-host:smoke`
- `npm run electron-host:rust-ipc`
- `npm run electron:smoke`
- `npm test -- --run`
- `npm run build`
- `cargo fmt --check`
- `cargo test`

The host smokes prove Electron Chromium can load a page, read it, click it,
type into it, capture a screenshot, keep Node unavailable inside the page,
detect Phantom's Solana provider from the locally installed unpacked Phantom
extension, and host the built ResonantOS React shell with an embedded
`BrowserView` controlled through the preload IPC bridge.

This is not yet full wallet product readiness. The current Electron smoke still
logs Phantom extension compatibility warnings and does not prove extension UI,
account persistence, signing confirmations, or production packaging. Those
remain mandatory gates before DAO wallet flows are exposed to users.

## Consequences

- Tauri remains useful as a reference implementation and may be kept temporarily while Electron host parity is built.
- ADR-025 becomes a historical CEF research record, not the product Browser decision.
- The Browser add-on should be rebuilt around Electron sessions or a controlled external Chromium profile, not Tauri WebView.
- The Rust service boundary from ADR-009 remains binding and becomes more important, not less.
- Packaging work must move to an Electron builder flow plus a Rust sidecar/core-service build.
