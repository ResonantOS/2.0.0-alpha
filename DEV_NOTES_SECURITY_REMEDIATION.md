# Alpha security remediation developer notes

## Branch and scope

- Branch: `security/alpha-remediation`
- Base: `7373fd4 docs: add Alpha security review report`
- Scope: the active browser-first Alpha extension, its authenticated bridge, provider/session services, archive review host, proxy, delegation helpers, and the release/test gates that exercise them.
- No real provider credentials were added, logged, or used. The bridge was not started as a user-facing runtime; the only smoke test used synthetic tokens and a private loopback listener that was closed before the command exited.
- The optional browser-host runtime is not installed or enabled on this Windows workstation. Findings that require that optional host remain design/acceptance items rather than claims that the host is currently exposed.

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

## Deliberate residuals / acceptance items

- A-03 remains a policy limitation: the capability matrix still has hand-declared security-critical entries and should be replaced with generated/verified route metadata before treating that item as fully closed.
- A-05 is not active on this machine because the optional browser-host surface is not installed or running.
- A-06 concerns the shared React application and is outside the active browser-first Alpha runtime; it was not silently changed here.
- Provider hostname validation is deliberately conservative and redirect-free, but a future defense-in-depth pass could add DNS-resolution pinning for hostile rebinding environments.
- OpenCode server Basic auth is used when its explicit username/password are configured; deployment policy should require those values whenever the sidecar is reachable beyond the loopback-only default.

## Verification evidence

Passing gates on this branch:

```text
npm test -- --run                         37 files / 312 tests passed
npm run build                             TypeScript + Vite build passed
npm run docs:check                        passed
npm run test:docs                         217 passed / 8 skipped / 0 failed
npm run test:security-pipeline            24 passed / 5 platform skips / 0 failed
focused bridge/content/host suites        passed (44 browser/bridge/content; 34 host)
focused scheduler/page-action/runner      passed
```

The eight documentation-gate skips and five runtime-registry skips are explicit Windows portability skips: this host cannot create symlinks without Developer Mode, and several production-derived registry fixtures describe POSIX Hermes/native-picker paths. They are not counted as passing Linux-runtime evidence.

The isolated smoke command started `startBridgeServer` on `127.0.0.1:0` with synthetic bridge/capability tokens, verified `200` for the authorized route and `403` without the capability token, then closed the listener. Port `47773` was checked afterward and was not listening.

## Resume / next safe step

```powershell
Set-Location G:\res-os
git switch security/alpha-remediation
npm test -- --run
npm run test:docs
npm run test:security-pipeline
```

Before enabling any real provider or extension runtime, review the residual items above, provide explicit test credentials through the approved secret store, and perform a separate authenticated end-to-end test in a disposable profile. Keep the bridge bound to loopback and retain practice/sandbox mode until that validation is recorded.
