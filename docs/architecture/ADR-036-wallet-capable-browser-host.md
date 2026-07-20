# ADR-036: Resonant Browser Host Architecture

## Decision Metadata

- Decision status: Superseded
- Alpha applicability: Not applicable
- Superseded by: ADR-037
- Owner: Browser architecture
- Decision date: Not recorded
- Status date: 2026-05-25
- Alpha note: This external-browser sidecar direction is historical. It does
  not define the unpacked-extension Alpha package.

## Decision

Resonant Browser is a ResonantOS sidecar controlling a real browser host, not an Electron `BrowserView` with incomplete Chrome-extension support.

ResonantOS must not treat Electron `BrowserView`, Tauri webviews, or the current embedded CEF experiments as wallet-capable browser hosts.

Wallet-capable browsing is implemented through a dedicated real-browser host:

- Google Chrome, Brave, or another reviewed Chromium-compatible browser is launched or attached as an external runtime.
- The runtime uses a dedicated ResonantOS browser profile under `~/ResonantOS_User/BrowserProfiles/wallet-main`.
- ResonantOS controls the host through Chrome DevTools Protocol and narrow Browser commands.
- Phantom and similar wallets run only in the real browser profile, not inside Electron.
- Wallet approval, signing, seed phrase, private key, network switch, and public transaction submission remain human-only unless a future ADR defines a stricter audited approval protocol.

## Why

The previous Electron spike proved normal page rendering and provider injection, but failed the actual Phantom wallet popup. Phantom is a Manifest V3 Chrome extension that depends on Chrome extension APIs including `chrome.identity`, `sidePanel`, service workers, and wallet popup behavior. Electron logs those APIs as unavailable and Phantom crashes on `chrome.identity.getRedirectURL`.

This is an architectural incompatibility, not a styling or timing bug. Electron documents that it supports only a subset of Chrome extension APIs and does not provide full Chrome Web Store compatibility.

Comet and Brave point to the correct direction: use a real Chromium browser environment, then add AI control and ResonantOS capabilities around it.

## Rules

- Electron may host ResonantOS shell UI and non-wallet browser surfaces.
- Electron must label Phantom as unsupported when it only loads but cannot render or operate the wallet popup.
- Wallet-capable flows must use `browser.wallet_host.*` commands.
- The wallet browser host may navigate, read, list tabs, and collect evidence through governed commands.
- AI agents may not approve wallet transactions, reveal secrets, export keys, or click signing confirmations without a future explicit wallet approval protocol.
- Add-ons may request wallet-browser access, but ResonantOS mediates the real browser host.
- Browser profile state belongs in the Portable User State Root, not the source tree.

## Interfaces

### Wallet Browser Host

```ts
type WalletBrowserHostHealth = {
  ready: boolean;
  sessionId: string | null;
  engine: "external-chromium-wallet";
  browserName: string | null;
  executablePath: string | null;
  profilePath: string;
  url: string | null;
  title: string | null;
  walletSupport: "real-browser-profile" | "real-browser-required" | "unavailable";
  phantomInstallUrl: string;
};
```

### Commands

- `browser.wallet_host.health`
- `browser.wallet_host.start`
- `browser.wallet_host.open_url`
- `browser.wallet_host.read_page`
- `browser.wallet_host.inspect_dapp_gate`
- `browser.wallet_host.list_tabs`

## Consequences

- The current Electron extension host remains useful for proving extension detection and normal BrowserView behavior, but it is not a wallet product path.
- The first production-quality path is a managed Chrome/Brave profile controlled by CDP.
- A future deeper browser product may fork or embed Chromium, but only after the managed real-browser host proves the UX, security, and DAO workflows.
- Deterministic tests must distinguish “extension loaded” from “wallet usable.” A title string or provider injection is not enough.

## References

- Electron Chrome extension support: https://www.electronjs.org/docs/latest/api/extensions/
- Chrome Manifest V3 background service workers: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3
- Chrome DevTools Protocol: https://chromedevtools.github.io/devtools-protocol/
- Phantom browser extension setup: https://help.phantom.com/hc/en-us/articles/4412436271635-Set-up-the-Phantom-browser-extension
- Brave Chrome extension compatibility: https://brave.com/learn/using-chrome-extensions-in-brave/
