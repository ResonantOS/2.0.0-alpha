# Module Map

This map describes the current repository by runtime role. It does not make
every tracked module part of the 2.0.0 Alpha package. The normative shipped
boundary is the [Alpha runtime boundary](ALPHA_RUNTIME_BOUNDARY.md).

## Alpha Runtime

### Chrome Extension

`browser-first/resonantos-side-panel-extension/` is the Alpha user-facing
runtime.

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 permissions, service worker, content scripts, side panel, and new-tab registration |
| `src/background.js` | Extension lifecycle, message mediation, side-panel opening, and privileged Chrome API coordination |
| `src/content.js` and `src/lib/content-*.js` | Page observation, safe field classification, inline actions, and content-script boundaries |
| `src/side-panel.*` and `src/lib/side-panel-*.js` | Augmentor conversation, command routing, browser jobs, approval flow, and side-panel rendering |
| `src/main-workspace.*` and `src/lib/main-workspace-*.js` | New-tab workspaces for answers, artifacts, add-ons, memory, optional local services, and settings |
| `src/lib/browser-page-actions.js` | Governed page actions through Chrome APIs and content scripts |
| `src/lib/agent-control-*.js`, `src/lib/control-*.js` | Observe-plan-act-verify orchestration, preflight, consent, execution, and reporting |
| `src/lib/bridge-client.js` | Authenticated requests to the local Node bridge and scoped capability acquisition |
| `src/lib/*-store.js`, `src/lib/*-controller.js` | Browser-side session, job, preference, composer, and presentation state |

Browser state and page mutation stay in extension modules. Provider secrets,
local files, process launch, archive promotion, and other privileged local
operations cross the bridge.

### Authenticated Node Bridge

`browser-first/host/` is the Alpha privileged local runtime.

| Path | Responsibility |
| --- | --- |
| `run-bridge-minimal.mjs` | Compose route services, create bridge and capability tokens, start the listener, and generate extension config |
| `bridge-server.mjs` | Loopback listener, bridge authentication, capability checks, CORS, route dispatch, and optional local dashboard proxying |
| `provider-host-service.mjs` and `provider-bridge-service.mjs` | Provider status, session credentials, routing, diagnostics, chat, inline assistance, and approved endpoint calls |
| `provider-fabric-core.mjs` | Pure provider catalog, workload strategy, and route-selection policy |
| `agent-control-host-service.mjs` | Provider-backed control planning, next-action decisions, and bounded web news reads |
| `memory-host-service.mjs` | Memory and archive route registration with per-operation capabilities |
| `memory-source-settings-service.mjs` | External source settings, scans, source actions, and guarded move preflight/execute/rollback |
| `memory-source-intake-host-service.mjs` | Intake, synchronization, search, versioning, diff, wiki health, and lint orchestration |
| `archive-review-host-service.mjs` and archive policy modules | Intake, review artifacts, verification, promotion, restore, and trusted-memory policy |
| `addon-delegation-host-service.mjs` and `addon-delegation-service.mjs` | Optional add-on status, bounded local runtime control, delegation records, artifacts, and goals |
| `browser-diagnostics-host-service.mjs` | Redacted system/workspace diagnostics and capability-gated report/download actions |
| `extension-prefs-host-service.mjs` | External user-state persistence for extension preferences |
| `browser-first-*-utils.mjs` and focused policy modules | Shared pure helpers and narrow host implementation details |

The route registry is composed from named services. New privileged behavior
belongs in a focused service, not directly in the launcher or extension UI.

### Runtime Tests

`browser-first/test/` owns deterministic extension and bridge contract tests,
including authentication, route capabilities, provider routing, browser
actions, approval boundaries, memory flows, add-on delegation, and Alpha scope.

`scripts/run-browser-first-extension-tests.mjs` and
`scripts/browser-first-release-scope-audit.mjs` are the corresponding test and
scope-audit entrypoints.

## Shared And Supporting Source

These paths support development, contracts, manifests, optional services, or
future product work. They are not additional required Alpha processes.

| Path | Responsibility | Alpha relationship |
| --- | --- | --- |
| `src/core/` | Shared contracts, provider/memory policies, state helpers, delegation shapes, and pure domain logic | Supporting source and tests; not a separate runtime process |
| `src/sdk/addons/` | Add-on manifest, capability, protocol, and validation contracts | Governs bundled and sideloaded add-on metadata |
| `src/sdk/resonant-context/` | Resonant Context contracts and SDK surface | Optional integration support |
| `src/modules/*/` | React domain workspaces and controllers from the broader product codebase | Feature reservoir/supporting source; not the MV3 Alpha UI unless explicitly imported by the extension |
| `src/App.tsx` | React composition shell for the broader source tree | Not an Alpha entrypoint |
| `public/addons/` | Bundled add-on manifests and catalog indexes | Read by add-on tooling and optional service discovery |
| `addons/resonant-browser-host/` | Separate browser-host add-on package and tests | Optional/supporting; not a required Alpha host |
| [`packages/addon-sdk-testing/`](../../packages/addon-sdk-testing/README.md) | In-process mock host + ADR-040 §7 F1–F10 negative-test harness for external-agent-runtime manifests | Optional test infrastructure; not a required Alpha host |
| `examples/` | MCP and service examples | Optional, never required Alpha runtime |
| `scripts/` | Build, test, health, security, docs, and release validation | Development and verification only |

## Domain Ownership In Shared Source

Where work touches the broader React/TypeScript source, ownership remains by
domain:

| Path | Primary domain |
| --- | --- |
| `src/modules/addons/` | Add-on catalog, grants, setup, and add-on workspace entrypoints |
| `src/modules/archive/` | Living Archive UI, intake, review, promotion, and source management |
| `src/modules/browser/` | Legacy/shared browser workspace presentation, not Alpha page actions |
| `src/modules/chat/` | Conversation UI and thread orchestration |
| `src/modules/compute/` | Deferred Compute Fabric UI model |
| `src/modules/delegation/` | Delegation monitoring and result review |
| `src/modules/hermes/`, `opencode/`, `paperclip/` | Optional add-on workspaces |
| `src/modules/obsidian/` | Deferred notes and vault workspace |
| `src/modules/recovery/` | Recovery product workflow |
| `src/modules/settings/` | Shared settings UI and controllers |
| `src/modules/shell/` | Shared shell hydration, selectors, and composition state |
| `src/modules/strategist/` | Strategist identity, channels, and thread organization |

Cross-domain contracts belong in `src/core/` or an established SDK package.
Feature modules do not gain Alpha runtime authority merely because similarly
named routes exist in `browser-first/host/`.

## Data And Trust Flow

1. Chrome invokes the extension service worker, side panel, new-tab page, or
   content scripts.
2. Extension controllers own browser UI state and use Chrome APIs for governed
   browser actions.
3. `bridge-client.js` sends authenticated requests to the loopback bridge.
4. `bridge-server.mjs` verifies bridge and scoped capability tokens.
5. One named host service validates input and accesses an approved provider,
   user-state path, or optional local service.
6. The bridge returns a bounded JSON result; secrets and raw privileged state
   remain host-side.

## Historical And Deferred Runtime Paths

Tauri, Electron, native CEF, Rust/Cargo services, custom Chromium packaging,
external-browser product sidecars, terminal workspaces, Audio2TOL, Compute
Fabric, and native wallet custody are not Alpha modules. ADRs and historical
documents can describe them, but current Alpha code, setup, and validation must
not depend on them.

## Composition Rules

- Keep extension entrypoints thin; move behavior into focused `src/lib/`
  controllers, stores, policies, and renderers.
- Keep `run-bridge-minimal.mjs` a composition root; route behavior belongs to a
  named host service.
- Keep bridge transport/authentication in `bridge-server.mjs`, not in domain
  services.
- Keep privileged resources behind both bridge authentication and the route's
  capability requirement.
- Add focused tests beside the owning test surface whenever behavior changes.
- Update this map and [module ownership](MODULE-OWNERSHIP.md) in the same change
  when responsibility moves.
