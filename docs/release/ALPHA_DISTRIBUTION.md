# Alpha Distribution

This document records the actual reviewer delivery path for ResonantOS
`2.0.0-alpha.0`: an unpacked Manifest V3 extension plus a local Node.js bridge.
It is not a public-store or native installer release.

## Release Authority

Release scope and waivers are decided in
[Project 2](https://github.com/orgs/ResonantOS/projects/2). Do not distribute a
candidate while the
[Alpha stabilization gate #209](https://github.com/ResonantOS/2.0.0-alpha/issues/209)
remains open unless the release owner records an explicit Project 2 disposition.

## Distribution Paths

### Source Checkout

This is the direct local-review path:

```bash
npm ci
npm run browser-first:bridge
```

The reviewer then opens `chrome://extensions`, enables Developer mode, chooses
**Load unpacked**, and selects
`browser-first/resonantos-side-panel-extension`. The bridge process must remain
running.

### GitHub Actions Artifact

`.github/workflows/alpha-build.yml` runs for relevant PRs and pushes to `dev`
or `main`, and can also be started with `workflow_dispatch`. After its checks,
the workflow:

1. Zips `browser-first/resonantos-side-panel-extension` to
   `resonantos-side-panel-extension.zip`.
2. Excludes `.DS_Store` and `src/bridge-config.generated.js`.
3. Runs `npm run pre-release:scan` against the package.
4. Uploads an Actions artifact named `resonantos-side-panel-extension` with a
   14-day retention period.

The artifact contains only the extension and deliberately omits the generated
authentication config. It can be inspected and loaded as the exact extension
packaging candidate, but starting the bridge from a separate source checkout
writes configuration into that checkout's extension directory, not into an
already extracted artifact. Bridge-connected review therefore uses the source
checkout path above until
[#200](https://github.com/ResonantOS/2.0.0-alpha/issues/200) and
[#209](https://github.com/ResonantOS/2.0.0-alpha/issues/209) have fresh-install
proof for the packaged bootstrap path.

There is no checked-in script that publishes a Chrome Web Store package, no
release installer, and no CI artifact that bundles the Node bridge.

## Candidate Checks

The `alpha-build` workflow is the reproducible candidate gate. It installs and
audits both Node dependency trees, then runs the unified gate:

```bash
npm run verify:alpha
```

That gate includes repository hygiene, documentation contracts, build,
frontend and browser suites, Living Archive suites, health and engineer checks,
the security pipeline, and the browser-first scope audit. CI then packages the
extension, runs `npm run pre-release:scan`, and uploads the artifact.

`verify:alpha` runs the security registry in certification mode. Every enabled
check must return `pass`; `skipped`, `warn`, and `fail` results reject the
candidate. Active runtime-hardening checks score production-derived spawn
records tied to their source sites, so a present surface without scored runtime
evidence cannot certify cleanly. The default non-certification security command
retains its policy-based observe behavior for local investigation.

Hermes and OpenCode runtime discovery ignores ambient `PATH` and accepts an
override only when it names a canonical executable under a fixed supported
install root. On Windows, OpenCode must be a directly executable `.exe`; command
shims are unsupported. This alpha also fixes host folder-picker and diagnostic
open/reveal tools to `C:\Windows`. The folder picker accepts only canonical
`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, executes it with
the command shell disabled, and rejects `.cmd` or `.bat` shims. Windows
installations whose system root is on another drive are not supported by these
host operations and will fail to find the required system executable rather
than trust `SystemRoot` or `WINDIR`.

Use `npm run browser-first:audit-scope:staged` on the intentionally staged
candidate paths. A strict scope audit is meaningful only when the index contains
the complete candidate and unrelated work is absent.

## Secret And State Boundary

Bridge startup writes
`browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js`
with local bridge URLs, a bridge token, and a capability-bootstrap token. The
file is generated with restrictive permissions, is ignored by Git, is excluded
from the CI ZIP, and must never be sent to another reviewer.

Do not distribute:

- provider credentials, generated bridge or capability tokens, or `.env` files;
- `ResonantOS_User/`, browser profiles, history databases, or local runtime
  state;
- local `output/`, `runs/`, screenshots containing personal data, or debug
  reports that have not been redacted;
- an add-on marked installed, enabled, or trusted by default for one reviewer.

The pre-release scan rejects provider-key-like strings, founder-specific paths
in built JavaScript, generated runtime files, and default-enabled add-on state.

## Reviewer Handoff

Record the source revision and Actions run URL with every candidate. Give the
reviewer the extension artifact or exact source checkout, the supported Node.js
version, and the repository installation instructions. Do not send tokens or
credentials; every reviewer configures their own local provider access.

Ask the reviewer to report setup and runtime evidence against the linked issue
in Project 2. Live product acceptance remains issue-tracked; a green unit suite
does not substitute for required browser proof in the
[capability matrix](../reference/CAPABILITY_MATRIX.md).

## Out of Scope

- Tauri, Electron, native CEF, Rust/Cargo, and native packaging are excluded
  from the Alpha candidate.
- Native signing, notarization, package repositories, and automatic updates are
  future work tracked in the [roadmap](../ROADMAP.md#native-future).
- Terminal and Audio2TOL workspaces are excluded from the Alpha distribution.
