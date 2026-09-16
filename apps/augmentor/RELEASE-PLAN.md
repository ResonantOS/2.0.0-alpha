<!--
  Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
  Copyright © 2026 Manolo Remiddi
  SPDX-License-Identifier: MIT
  License: MIT — see LICENSE at the repository root.
-->

# Release & update roadmap

Durable plan for: (a) promoting Augmentor, (b) making releases a two-second
tag push, (c) giving users a way to update the plugin + extension.
Supersedes the ad-hoc promotion checklist of 2026-09-01.

## Status snapshot (2026-09-01)

| item | state |
|---|---|
| npm `dsh-augmentor` 0.1.27 | published 2026-08-28 (safe baseline) |
| 0.1.29 tree | committed `e95cc19`, tag `v0.1.29` pushed, CI install-proof green, site live at v0.1.29 |
| 0.1.29 npm publish | **PENDING — manual, by the user** (first release predates the release workflow; npm versions are immutable, so this one stays a hand publish) |
| npm 2FA | **TODO (user)** — the package drives browsers; enable before the audience grows |
| npm provenance provider | **TODO (user, one-time)** — see Phase 0 below |

## Phase 0 — tag-triggered release workflow ✅ (this change)

Goal: from 0.1.30 on, releasing = `git tag v0.1.30 && git push origin master v0.1.30`.

`.github/workflows/release.yml` (tag `v*` push, or manual dispatch of an
existing tag) does, in order:

1. **verify** — tag format `vX.Y.Z`; three-way lockstep tag ↔ `plugin/package.json` ↔ `extension/manifest.json`; CHANGELOG section for the version exists (`scripts/pack-release.sh`)
2. **pack** — build the user-facing dist zip `augmentor-<ver>-dist.zip` (allowlist copy: extension/, pipe.mjs, wire.mjs, install-native-host.sh, presets/, root package.json + lock, plugin/ minus node_modules, README, LICENSE, CHANGELOG, .env.example)
3. **proof (local)** — `install-proof` PROOF_SOURCE=local on the tagged tree
4. **publish** — `npm publish --provenance` (OIDC trusted publishing, no token in the repo); idempotent — skips when the version is already published
5. **proof (npm)** — `install-proof` PROOF_SOURCE=npm PROOF_NPM_SPEC=`dsh-augmentor@<ver>` — the exact journey users take, pinned to the just-published version (pin sidesteps pnpm ≥ 11's 24h release-age gate)
6. **release** — GitHub Release from the tag, notes = the CHANGELOG section, asset = the dist zip

**One-time npm-side setup (user, ~2 min):** npmjs.com → *Account* →
**Provenance** → add provider **GitHub** → select this repo. Until then,
`--provenance` fails with a clear registry error. No npm token is ever stored.

**Conventions the workflow enforces/relies on:**
- tag = tip of `master` (the npm proof clones the default branch for the
  extension) — tag and push master + tag together
- version lockstep: bump `plugin/package.json` **and** `extension/manifest.json`
  in the same commit (AGENTS.md), and the tag must equal both
- a CHANGELOG.md section `## <version> — <date>` must exist before tagging

**Release procedure (from 0.1.30 on):**

```sh
# 1. bump version in plugin/package.json + extension/manifest.json (lockstep)
# 2. add the CHANGELOG.md section
# 3. test battery + commit + push master
# 4. release:
git tag v0.1.30 && git push origin master v0.1.30
```

**For 0.1.29 (the hand publish):** after `npm publish` succeeds, optionally
run the workflow once via *Actions → release → Run workflow* (input
`v0.1.29`) to create the GitHub Release + dist asset — the publish step
detects the version is already out and skips.

## Phase 1 — "Updates" section in the side panel (next release)

**Status: complete — shipped in 0.1.30.** One deliberate deviation from the
original note: the download extracts **in place over the tree the pipe runs
from** (atomic write-then-rename per file, wiped-then-rewritten trees,
path-traversal guard) instead of a separate stable copy — the NMH manifest
path is unchanged by construction, the next pipe spawn runs the new code,
and the pipe diffs `package.json` to flag a grown dependency set. The
in-panel plugin update also refuses source-mounted dev builds (home-patch
`?src=` rows) with the manual path, since `dsh plugin add` there would
duplicate the loader entry.

An About/Updates block in the panel's settings area (the panel owns the UI per
proposal M3 — no DSH packaging risk):

- version table: plugin / pipe / extension — installed vs latest, "update
  available" chip. Installed versions already ride the wire (handshake
  `version`, pipe banner, `chrome.runtime` manifest). Latest: registry via the
  pipe (the extension has no host permission for npmjs.org; the pipe is Node),
  GitHub latest release for the extension.
- **Update plugin** — confirm → the plugin (in-process, full Node) spawns
  `dsh plugin --profile <current> add dsh-augmentor@<latest>` (pinned version;
  `dsh plugin` is a pnpm forwarder that reconciles `dsh.profile.bundles`
  against installed state — stock, source-verified). Version arg validated
  against `^0?\.\d+\.\d+$`; fixed command shape, no arbitrary shell. After
  success: "restart your DSH session" (a node_modules change does not
  hot-reload the app's cached module — honest v1 behavior).
  - verify empirically: pnpm ≥ 11's 24h minimum-release-age gate vs a pinned
    spec (the README documents the pin as the workaround; the proof's pin path
    exercises it).
- **Download extension** — pipe fetches the dist zip (GitHub release asset) →
  extracts to a **stable directory** (e.g. `~/Augmentor-extension/`, so the NMH
  manifest path keeps working) → instruction: reload Augmentor in
  `chrome://extensions` (no Chrome API can reload an unpacked extension — one
  user click, unavoidable until the store).
- version-skew warning when the plugin and extension halves disagree (lockstep
  is a documented invariant — surface it).
- security posture: user-confirmed, fixed command shape; pipe fetching
  registry/GitHub over HTTPS is no new trust surface (same local process the
  install relies on).

## Phase 1.5 — installer provisions the agent preset (small gap found 2026-09-01)

`presets/augmentor/` is the persona source, but **nothing copies it into
`$DSH_HOME/.agent-presets/augmentor`** — the installer doesn't, the README
doesn't, and the plugin degrades silently to the deployment default when the
preset is absent. Fix: `install-native-host.sh` copies `presets/augmentor` →
`$DSH_HOME/.agent-presets/augmentor` (idempotent, skip-if-identical) + README
note. The dist zip already ships `presets/`. Do before the first zip-user
arrives.

## Phase 2 — "more integration with DSH" settings

Surface the existing config keys through the panel's `settings.describe`/
`settings.mutate` plumbing (already proxies the stock DSH settings API):
`chatDir`, `workspaceTitle`, `agentPreset`, `commandTimeoutMs`. Then pick 1–2
real integrations (not all): default model for Augmentor sessions;
DSH-session-tab protection toggle (default on, power-user opt-out). Resist
settings sprawl.

## Phase 3 — DSH in-page settings card (deferred, priced)

Proposal §10 verdict stands: host half (`installSettingsSection` +
`settingsNamespace` from `dsh-settings`) is stock, but the browser-side card
must be packaged as a `dsh.client`/`./client` **lazy-CJS artifact** — real
packaging risk for a surface the panel already covers. Do the **host half only**
(persisted namespace + schema, so settings storage is DSH-standard for every
surface); revisit the in-page card only if the panel seat proves insufficient.

## Phase 4 — Chrome Web Store (scaling decision)

Only route to true extension auto-update (`update_url` +
`chrome.runtime.requestUpdateCheck()`). Store review lead time + the NMH flow
stays either way. The site already frames it as a separate decision — keep it
that way until the audience justifies it.

## npm hygiene (standing rules)

- versions are immutable: a fix is the next version (`npm deprecate` the bad
  one if needed)
- 2FA on the npm account (authenticator or hardware key) before promotion
- trusted publishing (OIDC) — no long-lived npm token in the repo, CI, or the
  machine's shell history
- pnpm ≥ 11 release-age gate: bare-name installs resolve the previous release
  for ~24h after a publish; pin `dsh-augmentor@<version>` in announcements for
  the first day (documented in README + site)
