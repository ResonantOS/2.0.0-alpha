# ADR-025: Native Embedded Browser Host

## Decision Metadata

- Decision status: Superseded
- Alpha applicability: Not applicable
- Superseded by: ADR-035
- Owner: Browser architecture
- Decision date: Not recorded
- Status date: 2026-05-25
- Alpha note: This is a historical Tauri/CEF research record. Native CEF and
  Tauri are not Alpha runtime or validation requirements.

## Decision

Historical decision: Resonant Browser would move to a **native embedded Chromium host** that renders inside the ResonantOS center workspace. The Electron sidecar was rejected at the time because it opened a separate OS window and did not satisfy the embedded workspace requirement.

The selected direction is Option B: a native browser host integrated with the Tauri shell through a narrow Rust-owned boundary. The first candidate is CEF with Chrome Runtime enabled. CEF is now accepted as the primary macOS implementation candidate because deterministic tests prove embedded rendering, basic Manifest V3 execution, and Phantom provider injection. It is not yet complete until extension popup, persistence, signing, Bitwarden, and cross-platform packaging tests pass.

## Why

The Browser add-on has three non-negotiable requirements:

- It must be visually embedded inside the ResonantOS center workspace.
- The human and Augmentor must operate the same live browser session.
- Phantom Wallet and Bitwarden must work as first-class browser extensions.

Electron proved useful as a control and packaging spike, but it failed the embedded requirement. Tauri WebView can embed in the workspace, but it is not full Chromium and cannot provide Chrome extension compatibility. CEF can embed Chromium, but extension support is limited unless the Chrome Runtime path satisfies the specific target extensions.

## Binding Rules

- Historical rule, superseded by ADR-035: do not ship an Electron sidecar as Resonant Browser.
- Do not present screenshots, iframes, or external windows as the product browser.
- Do not claim full wallet/password-manager compatibility until deterministic host tests load, exercise, persist, and audit the target flows.
- The native host must expose one live session shared by user input and AI control.
- Extension install and wallet actions must remain host-mediated and auditable.
- Browser implementation must remain an add-on, not a core ResonantOS dependency.

## Required Native Host Contract

The native host must expose:

- `browser.native.probe`
- `browser.native.bridge_probe`
- `browser.native.start`
- `browser.native.attach_smoke`
- `browser.native.attach_view`
- `browser.native.set_bounds`
- `browser.native.open_url`
- `browser.native.back`
- `browser.native.forward`
- `browser.native.reload`
- `browser.native.read_page`
- `browser.native.click`
- `browser.native.type`
- `browser.native.scroll`
- `browser.native.extension.install`
- `browser.native.extension.list`
- `browser.native.extension.enable`
- `browser.native.extension.pin`
- `browser.native.extension.disable`
- `browser.native.wallet.confirmation_state`
- `browser.native.close`

## Acceptance Tests

The Browser add-on is not complete until deterministic tests prove:

- The browser renders inside the ResonantOS center workspace, not in a separate window.
- The same live session accepts human clicks, human typing, and host-mediated AI actions.
- Navigation, tabs, scroll, zoom, and address-bar state work at 100% page scale.
- Chrome Web Store or equivalent trusted extension install path works.
- Phantom Wallet loads from an approved unpacked source, injects its Solana provider, opens its extension UI, persists state, and exposes Solana wallet connection flows.
- Bitwarden installs, opens, persists state, and exposes login/autofill flows.
- Wallet signing requests require explicit human approval and are audited.
- Browser state survives workspace switching.
- macOS, Windows, and Linux packaging include all native runtime assets.

## Implementation Consequences

The current Electron host may remain only as a temporary research harness. It must not be launched automatically from the Browser workspace or represented as embedded.

The next implementation work is a native host spike that proves the hardest constraint first: embedded rendering plus Phantom/Bitwarden compatibility. If CEF cannot satisfy that, the Browser engine decision must escalate to a Chromium-source or Chrome-compatible host strategy before more UI is built.

Current implementation guardrail: ResonantOS exposes `browser_native_probe` and `browser_native_attach_smoke` before the native host is product-ready. The native add-on directory contains the CEF Chrome Runtime source scaffold, source-contract tests, and a locally buildable macOS ARM64 host binary.

The macOS ARM64 host now has real native CEF smoke tests. One boots the external CEF probe app, loads `https://example.com/`, verifies a main-frame HTTP 200 load, and exits with status `0`. Another opens Chromium extension entry points and records whether `chrome://extensions` and the Chrome Web Store are ready, blocked, or consent-gated. Another loads a temporary unpacked Manifest V3 extension and verifies content-script execution through a native title-change event. A final smoke loads the shared in-process bridge, creates a real macOS `NSWindow`/`NSView`, attaches CEF into that view, runs the Cocoa loop, verifies a main-frame HTTP 200 load, and exits with status `0`.

This proves native embedded CEF rendering is viable on the target machine, Rust/Tauri has a concrete C ABI to call, and the CEF candidate can execute a basic unpacked Manifest V3 extension. A dedicated Phantom smoke now loads the locally installed Phantom extension directory (`bfnaelmomeimhlpmgjnjophhpkkoljpa`) and verifies that `window.phantom.solana.isPhantom` or the legacy `window.solana.isPhantom` provider appears on an HTTPS page. This proves the core Solana provider-injection path that DAO sites need. It does not yet prove Chrome Web Store installation, extension popup behavior, wallet account persistence, signing confirmations, or Bitwarden. On the current test machine, `chrome://extensions` loads but the Chrome Web Store target redirects to Google's consent gate, so production extension installation remains an explicit future gate.

Important CEF finding: CEF logs `Chrome style is not supported for this browser` when using the child-view embed path. Therefore the embedded path proves Chromium rendering, content-script execution, and Phantom provider injection, but it still does not prove full Chrome Runtime UI behavior. Extension popups and wallet confirmation windows remain blocked until dedicated deterministic tests exercise those surfaces.

Current app-routing rule: `BrowserWorkspace` must call the native CEF/Tauri bridge first through `browser_native_webview_show` and resize it through `browser_native_webview_resize`. The Tauri OS webview remains only a clearly named fallback when the native Chromium bridge is unavailable. Tests must fail if default Browser navigation silently returns to the Tauri webview or screenshot/CDP preview path.

Current same-session control proof: the in-process bridge exports `resonant_browser_native_click_json`, `resonant_browser_native_type_text_json`, and `resonant_browser_native_scroll_json`, and Rust exposes them through `browser_native_webview_click`, `browser_native_webview_type_text`, and `browser_native_webview_scroll`. A deterministic macOS harness opens one embedded CEF child view, loads a local HTML page, clicks a real button, focuses an input, types text into that same page, scrolls the same page, and verifies page-observed title changes. This proves the native bridge can control the same visible Browser session that the human sees. It still does not prove selector-based read/click, extension popup interaction, wallet signing approval, or safe public-submit workflows.

The smoke host disables macOS Keychain integration with Chromium's mock-keychain/basic-password-store flags. This is required for deterministic testing because CEF initialization can otherwise block inside macOS Keychain lookup. This does not grant production credential access; wallet and password-manager actions remain subject to the Browser add-on capability model.

The attach smoke test records a hard boundary discovered on macOS: Tauri can expose the app `NSView`, but that object pointer is process-local. An external CEF executable cannot safely attach to it. Therefore the compiled external host is useful only as a CEF build/probe artifact; the product Browser direction must move CEF/Chromium embedding into the Tauri process or another platform-native in-process integration.

The native add-on now includes an in-process C ABI bridge target. Rust/Tauri loads this bridge, prepares the macOS application before the Tauri shell starts, and calls attach/resize/close through narrow host commands. The probe must keep product readiness blocked until Phantom/Bitwarden smoke tests are present.

Packaging rule: the native host app must not be added directly to `tauri.conf.json` resources. Tauri's resource recursion can corrupt or misread Chromium `.framework` internals. The accepted packaging path is `npm run browser-native:build`, which stages the bridge dylib and a zipped `ResonantBrowserNativeHost.app` under `build/native-browser/`. ResonantOS bundles that stable staging directory and Rust unpacks the host zip before CEF initialization.

Alpha packaging rule: native Browser assets are optional until the host has cross-platform deterministic packaging. `npm run browser-native:build` may skip staging when the platform or ignored CEF vendor bundle is unavailable, allowing ResonantOS alpha packages to build without pretending the native Browser is product-ready. CI or local alpha builds may also set `RESONANT_SKIP_NATIVE_BROWSER=1` for an explicit skip. Dedicated native Browser verification must use `npm run browser-native:build:required` or set `RESONANT_BUILD_NATIVE_BROWSER=1`; in that mode missing CEF assets or unsupported platforms fail hard.
