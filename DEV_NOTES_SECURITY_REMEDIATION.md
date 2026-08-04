# Alpha security remediation developer notes

## Branch and scope

- Branch: `security/alpha-remediation`
- Base: `7373fd4 docs: add Alpha security review report`
- Scope: the active browser-first Alpha extension, its authenticated bridge, provider/session services, archive review host, proxy, delegation helpers, and the release/test gates that exercise them.
- No real provider credentials were added, logged, or used. The bridge was not started as a user-facing runtime; the only smoke test used synthetic tokens and a private loopback listener that was closed before the command exited.
- The optional browser-host runtime is not installed or enabled on this Windows workstation. Findings that require that optional host remain design/acceptance items rather than claims that the host is currently exposed.

## Hermes/OpenCode enablement plan

The repository already contains the governed Hermes/OpenCode delegation paths. The enablement work is intentionally split from provider login:

- Hermes native Windows support now recognizes the official `%LOCALAPPDATA%\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe` layout and validates its Python adapter, while still rejecting ambient `PATH`, profile-selected binaries, and untrusted overrides.
- OpenCode native Windows support now recognizes the official npm prefix under `%LOCALAPPDATA%\\OpenCode\\node_modules\\opencode-ai\\bin\\opencode.exe`; command shims remain rejected.
- Hermes was installed with the official installer using `-SkipSetup`; no provider setup, OAuth login, or credential was entered.
- OpenCode `opencode-ai` `1.18.11` was installed into the dedicated local prefix and its direct executable passed `--version` (`1.18.11`).
- Runtime discovery currently reports both binaries as installed and canonical. Add-on execution remains opt-in and provider credentials remain unset until a separate human-approved setup step.
- Follow-up review narrowed OpenCode discovery to the exact package executable; the unused `%LOCALAPPDATA%\\OpenCode\\opencode.exe` prefix-root candidate was removed. Missing-runtime diagnostics now give the dedicated-prefix PowerShell command that produces a trusted executable instead of POSIX-only instructions.
- The follow-up full-gate run also exposed Node 24 rejecting direct `npm.cmd` child-process launches on Windows. `verify:alpha` now invokes npm's JavaScript CLI with the current trusted Node executable and keeps `shell: false`, so the gate is runnable without command-shell interpolation.
- The first complete rerun reached the browser-first suite and exposed a Windows temporary-directory cleanup race (`ENOTEMPTY`) after a memory versioning test had completed. That test now uses the documented bounded `fs.rm` retry controls; it does not relax any product assertion.
- The final pre-release step was also resolving the inaccessible WindowsApps `bash.exe` alias even though Git Bash was installed. A small shell-free Node launcher now selects Bash only from fixed system/Git installation roots and invokes the existing scan script with literal arguments.
- The strict committed-scope audit then identified the two intentional root-level security evidence files as unknown. The classifier now includes only `ALPHA_CODE_REVIEW_REPORT.md` and this remediation handoff by exact name; unrelated root or `docs/` Markdown still requires review.

Activation sequence:

1. Start the loopback bridge and confirm Hermes/OpenCode show `installed` in Settings → Add-ons/Diagnostics.
2. Enable only the desired add-on and grant its explicit shell/provider capability.
3. Configure a test provider through the authenticated host flow; do not put credentials in extension files, repository files, or global environment variables.
4. Run one bounded delegation in a disposable workspace, inspect the returned artifact, and verify cancellation/failure behavior before normal use.
5. Keep Hermes dashboard access loopback-only unless the bridge is separately deployed with TLS, an IP allowlist, and real Hermes auth/CSRF/WebSocket acceptance evidence.

## What was repaired

The implementation now includes the following protections from `ALPHA_CODE_REVIEW_REPORT.md`:

- R-01/R-02: bridge configuration is origin-bound; generated credentials are not inherited by a cross-origin override; capability tokens are cached per origin; proxy state-changing requests require bridge authentication; WebSocket upgrades require an allowed Origin.
- R-03/R-04: browser actions reject destructive, login, payment, password, and personal-contact controls; synthetic click/Enter duplication was removed; unsafe forms and unsafe selections stop with a human handoff.
- R-05: archive memory paths reject traversal and canonical symlink/junction escapes outside the intended root.
- R-06: OpenCode child processes receive a scoped environment and optional explicit Basic-auth headers instead of the parent process environment.
- R-07: delegated Hermes/OpenCode output and written result artifacts redact known provider secrets and common credential shapes.
- R-08/R-09: provider endpoints reject forged local-runtime authorization, metadata/link-local/private targets, credential-bearing URLs, and redirects; browser job ticks are single-flight; cached background responses use the actual context snapshot field.
- R-10: release verification resolves Windows npm/npx shims without a shell; repository hygiene has a safe fallback when `O_NOFOLLOW` is unavailable; release path filters cover the active browser-first code and host surfaces.
- R-11: engineer-runner scope is checked after required commands as well as before them.
- A-03: the security pipeline now performs TypeScript/JavaScript AST discovery of privileged process, network, credential, and filesystem sinks and fails when the reviewed baseline changes without an explicit update.
- A-05: the optional browser host now requires a per-launch JSON-RPC token, rejects caller-selected executables, restricts configured paths to canonical Chrome/Edge installs, and derives sensitive/high-impact approval from the live DOM.
- A-06: async chat commits rebase candidate changes onto the latest shell state, preserving concurrent keyed thread/provider/settings edits.
- A-09: renderer-only provider and Telegram secret saves now fail closed instead of writing an unauthenticated `__configured__` marker.
- Diagnostic history: memory source sync/move history now stores only `[path]/basename` labels, including paths beneath the OS home directory; intake and move self-tests verify that source paths are not persisted.

## Deliberate residuals / acceptance items

- A-03 now has a reviewed AST sink baseline. The baseline is intentionally review-gated: adding or changing a privileged sink requires a deliberate baseline update and security review.
- A-05 is not active on this machine because the optional browser-host surface is not installed or running; live Chromium behavior still needs a host with Playwright Chromium installed.
- A-06 is repaired in the shared React shell with a three-way rebase; a broader reducer migration is not required for the verified race case.
- A-08 remains a shared-shell integration item: the active browser-first chat client aborts its bridge fetch, while the legacy web transport still does not expose a full provider-stream AbortSignal/cost cancellation path.
- Provider hostname validation is deliberately conservative and redirect-free, but a future defense-in-depth pass could add DNS-resolution pinning for hostile rebinding environments.
- OpenCode server Basic auth is used when its explicit username/password are configured; deployment policy should require those values whenever the sidecar is reachable beyond the loopback-only default.

## Verification evidence

Passing gates on this branch:

```text
npm test -- --run                         38 files / 315 tests passed
npm run build                             TypeScript + Vite build passed
npm run docs:check                        passed
npm run test:docs                         217 passed / 8 skipped / 0 failed
npm run test:security-pipeline            26 passed / 5 platform skips / 0 failed
`npm run test:browser-host`                11 passed / 3 explicit environment skips / 0 failed
npm run test:browser-first                831 passed / 6 explicit platform skips / 0 failed
privileged sink AST gate                  511 sinks across 44 source files matched baseline
state-concurrency + chat controller tests 10 passed
focused bridge/content/host suites        passed (44 browser/bridge/content; 34 host)
focused scheduler/page-action/runner      passed
```

The eight documentation-gate skips, five runtime-registry skips, six browser-first skips, and three optional-host skips are explicit environment boundaries: this host cannot create symlinks without Developer Mode, several production-derived fixtures describe POSIX Hermes/native-picker paths, and the deterministic CLI fixtures cannot stand in for a signed direct Windows executable. They are not counted as passing Linux-runtime or live-Chromium evidence.

The isolated smoke command started `startBridgeServer` on `127.0.0.1:0` with synthetic bridge/capability tokens, verified `200` for the authorized route and `403` without the capability token, then closed the listener. Port `47773` was checked afterward and was not listening.

## Resume / next safe step

Follow-up audit state on 2026-08-04:

- `npm run verify:alpha` passes from start to finish on native Windows, including the build, browser-first suite, security certification, pre-release scan, and strict committed-scope audit.
- Hermes `0.20.0` and OpenCode `1.18.11` are installed and resolve from `fixed-localappdata-install-root` candidates.
- No listener was present on the normal ResonantOS bridge port `47773` or Hermes dashboard port `9119` after verification. The runtimes are installed, but the app and dashboard are not currently running.
- No provider credential, login, or live model call was used during this audit.

```powershell
Set-Location G:\res-os
git switch feature/hermes-opencode-enable
node --test browser-first/test/hermes-runtime.test.mjs browser-first/test/opencode-runtime.test.mjs
npm run verify:alpha
```

The practical forward sequence is: merge this branch into `dev`; start the loopback bridge; load/reload the unpacked extension; confirm both add-ons report `installed`; choose one provider/auth route; enable only one add-on with its explicit grants; and run one bounded disposable-workspace delegation before enabling the second. Before enabling any real provider or extension runtime, review the residual items above, provide explicit test credentials through the approved host flow, and perform a separate authenticated end-to-end test in a disposable profile. Keep the bridge bound to loopback and retain practice/sandbox mode until that validation is recorded.
