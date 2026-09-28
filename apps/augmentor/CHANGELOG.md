<!--
  Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
  Copyright © 2026 Manolo Remiddi
  SPDX-License-Identifier: MIT
  License: MIT — see LICENSE at the repository root.
-->

# Changelog

All notable changes to Augmentor (the `dsh-augmentor` plugin + the Chromium
extension). Versions are locked across `plugin/package.json` and
`extension/manifest.json`.

## 0.1.33 — 2026-09-15

### Changed

- Move pipe/extension update discovery and the canonical download authority to
  `ResonantOS/2.0.0-alpha`. Keep the strict version and exact-URL guards.
- Transitional bridge: publish the same ZIP in Manolo's original repository
  last, after the ResonantOS release exists, so installed 0.1.32 clients can
  migrate on their next update and native-host restart.
- Keep the native messaging host identity and the npm plugin's Node 22 support.

### Verification

- Add an offline native-messaging rehearsal using loopback GitHub API and asset
  stubs, real release packaging and in-place extraction, refusal checks, and
  a restart that checks the new update authority.

## 0.1.32 — 2026-09-10

### Fixed

- Support DSH 0.1.5-rc.1: update the tools SDK and migrate calls and live
  session streams to the public Typert API.
- Authenticate API calls and WebSockets using DSH's normal token-to-cookie
  exchange. The bootstrap endpoint requires the existing Augmentor secret,
  a loopback connection and Host, and no browser Origin. Credentials stay
  in the native host; failed or uncertain commands are never replayed.
- Disconnect superseded native ports before reconnecting. Ignore stale port
  messages, and terminate hosts when extension heartbeats stop. This also
  prevents browser-tool replies being routed into a different native host.
- Install the missing browser-agent preset for fresh users and migrate the
  persona setting from `text` to `prefix`, preserving a backup.
- Reconcile SDK dependencies on upgrades, support npm when pnpm is absent,
  and honor `DSH_HOME` consistently in the installer.
- Render DSH's terminal model errors in the chat.

### Verification

- The installation proof now opens the real Chromium side panel and creates
  a fresh chat using the shipped preset. It checks authentication refusal
  paths. The optional live-model leg verifies all five browser tools, page
  changes, the rendered response, history and Save/Unsave.
- CI tests both the exact supported DSH version and npm `latest` instead of
  masking incompatibilities behind the old 0.1.1-rc.2 pin.

- Fresh installation tests also install Model Picker Augmented 1.1.2 from its
  GitHub release and verify its settings UI alongside the extension.
- Installation instructions now include the complete GitHub bundle, local
  authentication, explicit version pins and upgrades from incompatible releases.

## 0.1.31 — 2026-09-04

### Added

- **Model picker search** — the side panel's model picker has a search
  field: live filtering over the rows by model name, model id, or provider
  group name (case-insensitive substring), a clear (×) button while a query
  is active, Escape clears the query first and closes the popover on the
  second press, a “No models match” strip when nothing hits, and groups the
  search empties disappear. The query is not sticky across opens — a fresh
  open always shows the full list.
- **Pinned section (DSH picker parity)** — when the DSH app runs the
  `model-picker-augmented` model-picker plugin, its pinned list now shows on
  top of the Augmentor picker too: the pipe's `augmentor/models` reads the
  plugin's `model-picker-augmented` settings section (`settings.describe`)
  alongside the catalog, and pinned models render in a **Pinned** section in
  the user's order, removed from their provider groups (no dupes), with
  pinned-but-hidden keys pinned nowhere — the same row-building rules the
  DSH plugin applies. Without the plugin, or without pins, the picker is
  exactly as before. The picker's Refresh re-reads the settings, so pins
  made in the DSH app while the panel is open land after Refresh (or
  reconnect).

### Fixed

- **Model switching was broken since 0.1.29** — the service worker's
  model-switch handler called `saveSelection` without importing it (lost in
  the Tier-3 module split, `eb431dc`), so every picker row click threw a
  `ReferenceError` in the SW: the switch never completed and the selection
  was never persisted. Caught by the new picker e2e leg below.

### Tests

- `test/panel-e2e.mjs` gains a picker leg — against the live DSH app: the
  full list's order versus the SW's own catalog (Pinned section included,
  conditional on the settings actually carrying pins), search filtering
  verified against an independently computed expected set, the no-match
  strip, Escape / clear-button query reset, and a model switch from a pinned
  row with the original selection restored before the probe prompt.
- `test/install-proof.mjs` boot detection now understands DSH 0.1.2's
  token-gated web surface (bare `GET /` returns 401; the banner URL's
  `?token=` is exchanged for a session cookie) — on older DSH the probes
  stay plain.

### Compatibility

- Proven against DSH CLI **0.1.1-rc.2** (the version both CI workflows are
  pinned to). **DSH 0.1.2-rc.1 (npm `latest` at release time) is not
  compatible with any Augmentor version**: it gates every `/api/*` request
  behind a browser session cookie — the launch token only serves the
  `GET /` → 303 cookie exchange, and there is no header/query credential for
  the API itself — so the background pipe cannot authenticate at all. Keep a
  0.1.1-series DSH (or the first 0.1.2 release that adds a local-client
  auth path) until the pin in `.github/workflows/release.yml` is bumped.

## 0.1.30 — 2026-09-01

### Added

- **In-place updates — the "Updates" section of the side panel.** A download
  icon in the header opens the update popover:
  - **Version table** — installed vs latest for every component: the plugin
    (`dsh-augmentor`, latest from the npm registry, installed from the
    running DSH app's handshake), and pipe + extension (one release artifact;
    latest from GitHub Releases, extension version as the browser has it
    loaded). Each source degrades independently — a dead npm/GitHub/app shows
    as a warning strip, never as a broken check.
  - **Update** (plugin) — the plugin inside the running DSH app runs
    `dsh plugin add dsh-augmentor@<ver>` in the profile that drives this
    session (discovered from `$DSH_HOME/profiles`, the candidate whose
    installed version matches the running build). The spawn uses a fixed
    argv (no shell), a regex-validated version, a 5-minute cap, and a
    capped output tail; the button fires and the panel polls the job every
    2 s (the pnpm run outlives any single round trip). A finished update
    tells you to restart the DSH session to load the new plugin.
  - **Download** (pipe + extension) — the pipe fetches the canonical release
    zip (`releases/download/v<ver>/augmentor-<ver>-dist.zip` — the URL is
    allowlisted in the pipe, never fetched from the panel side) and extracts
    it over its own tree: ≤15 MB, atomic write-then-rename per file,
    path-traversal guard, wiped-then-rewritten trees so removed files don't
    linger. A finished download tells you to reload Augmentor in
    chrome://extensions — the next pipe spawn runs the new code.
  - **Skew warning** — releases ship plugin/pipe/extension in lockstep; a
    mismatch means the pending restart or reload has not happened yet, and
    the popover says which step is missing (including "new files on disk —
    reload to activate" between a download and the reload).
  - Source-mounted dev builds (the home-patch `?src=` row) refuse the
    in-panel plugin update with the manual path instead of running
    `dsh plugin add` against a setup where it would duplicate the loader
    entry and kill the next boot.
- **Release workflow** (`release.yml`, shipped in the 0.1.29 tree) — a
  pushed `v*` tag now cuts the release end to end: pack the dist zip,
  publish `dsh-augmentor` to npm, run the npm install-proof, and open the
  GitHub release with the asset. **From this tag on, releasing is
  `git tag v0.1.31 && git push origin master v0.1.31`.**
- **Pipe dependency: `fflate`** (zip extraction for Download). In-place
  downloads of future releases carry the new dependency set — the pipe
  detects an added dependency and tells you to run `pnpm install`.

### Tests

- `test/updates-e2e.mjs` (new) — live `updates/check` against the real DSH
  app (npm + GitHub + handshake, all three green), the download allowlist
  (non-canonical URL, malformed version, cross-version URL — refused before
  any fetch), and a full in-place download of the real release asset into a
  scratch copy: every archive entry byte-identical on disk and the next
  pipe spawn booting the new version.
- `plugin/tests/boot/run.sh` leg 7 — the plugin's update channel over the
  token-gated WS: `update-status` idle on a fresh boot, malformed versions
  refused before any discovery/spawn, source-mounted builds refused with
  the actionable message, and no job left behind by rejected requests.

### Notes

- **First update with the mechanism** — 0.1.30 ships the update UI, so the
  running 0.1.29 pipe cannot offer it to you yet: this one is manual
  (re-clone + `pnpm install`, or `dsh plugin add dsh-augmentor@0.1.30`,
  then reload the extension). From 0.1.30 forward, updates happen in the
  panel.

## 0.1.29 — 2026-09-01

### Added

- **DSH session-tab protection** — the agent never works in the tab that hosts
  the user's own DSH web session (the session it is talking through):
  `browser_navigate` opens a dedicated tab instead of navigating it away, read
  actions fail with a directive error, `browser_tabs_list` marks the tab with
  `[DSH session]` (`dsh: true`), and a sticky work tab the user navigates onto
  the DSH GUI loses its stickiness. Origin matching treats `localhost` and
  `127.0.0.1` as the same loopback server and rejects lookalikes
  (port `30800`, `3080.evil.example`, other ports, https-vs-http).
- **Model picker Refresh** (side panel) — a Refresh footer in the model
  popover forces a fresh catalog fetch from the running DSH app (live
  `settings.yaml` read via the bridge, no restart): a model added while the
  panel is open now appears; if the current selection fell out of the catalog
  it falls back to the catalog default (the same rule the handshake applies).

### Tests

- New hermetic suite `test/dsh-tab-test.mjs` (13 scenarios: sticky-tab
  survival, fallback exclusion, origin matching, dedicated-tab navigate,
  directive errors, `tabs_list` marking) — run with
  `node test/dsh-tab-test.mjs`.

## 0.1.27 — 2026-08-28

### Fixed

- Packaged dist: runtime deps (`ws`, `@deepseek-ai/dsh-tools`,
  `@deepseek-ai/schemastery`) externalized — the npm install resolves them from
  the profile's `node_modules` instead of inlining them.
- F8 audit: plugin-WS liveness heartbeat kills the zombie-pipe mode; the
  heartbeat also counts handshake pipes (F8b).
- Installer: `mkdir -p bin/` before writing the launcher (fresh clones), and
  the repo-root pipe dependencies are installed on first run in a fresh clone.
- Deterministic fresh-user install proof (`test/install-proof.mjs`) + the
  `install-proof` CI workflow on every push/PR.

## 0.1.26 — 2026-08-28

- Initial public npm release of `dsh-augmentor`.
