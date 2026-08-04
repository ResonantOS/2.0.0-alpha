# Browser-First Alpha Components

This directory owns the two active ResonantOS 2.0.0 Alpha runtime components:

- `resonantos-side-panel-extension/` is the Chrome Manifest V3 extension.
- `host/` is the authenticated local Node.js bridge.

Use the root [installation guide](../INSTALL.md) for the complete setup path and
the [Alpha runtime boundary](../docs/architecture/ALPHA_RUNTIME_BOUNDARY.md) for
security and scope rules.

## Run Locally

From the repository root:

```bash
npm install
npm run browser-first:bridge
```

The bridge binds to loopback by default and writes
`resonantos-side-panel-extension/src/bridge-config.generated.js`. That file
contains generated credentials, is ignored by Git, and must remain local.

Load `browser-first/resonantos-side-panel-extension` through **Load unpacked**
on `chrome://extensions`, then open the ResonantOS side panel. Keep the bridge
process running.

## Extension Boundary

The side panel communicates with the local bridge through authenticated,
capability-scoped routes. Browser Agent Control is mediated by typed extension
tools and visible browser state. Wallet approvals, signatures, payments,
credential entry, public submission, and destructive actions remain blocked or
human-only according to the capability contract.

Provider secrets and trusted memory writes are host-owned. Do not place secrets
in extension source, generated config, Chrome storage, fixtures, or diagnostics.

## Validate Changes

```bash
npm run test:browser-first
```

The [HRR-033 deterministic certification gate](test/hrr033-certification/README.md)
documents the focused context and Resonator evidence workflow used for deeper
browser-first regression certification. Implementation notes for the Alpha
demo-hardening pass — the workspace toggle, new-tab handling, task monitor, and
the launchd-managed bridge — are recorded in
[Augmentor demo hardening](docs/2026-07-20-augmentor-demo-hardening.md).

Bridge or shared-package changes may also require:

```bash
npm run test:browser-host
npm test -- --run
npm run build
```

## Optional Hermes and OpenCode runtimes

The delegation adapters are implemented but remain opt-in. On native Windows,
the host trusts only fixed direct executables: Hermes at
`%LOCALAPPDATA%\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe` and
OpenCode at `%LOCALAPPDATA%\\OpenCode\\node_modules\\opencode-ai\\bin\\opencode.exe`
inside its dedicated npm prefix. Ambient `PATH`
and `.cmd`/`.ps1` shims are not accepted. Install or update either tool through
its official installer, then verify the binary with `hermes --version` or
`opencode.exe --version` before enabling the add-on. Provider setup is a separate
step and must use the authenticated host flow.

For OpenCode on native Windows, use PowerShell so the installed location and
the host allowlist agree:

```powershell
npm install --global --prefix "$env:LOCALAPPDATA\OpenCode" opencode-ai
& "$env:LOCALAPPDATA\OpenCode\node_modules\opencode-ai\bin\opencode.exe" --version
```

Read the [bridge README](host/README.md) for host-specific details and
[CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request into `dev`.
Current responsibility, verified status, and release workflow are routed by
[Module Ownership](../docs/architecture/MODULE-OWNERSHIP.md),
[Status](../docs/STATUS.md), and
[Project Governance](../docs/PROJECT_GOVERNANCE.md).
