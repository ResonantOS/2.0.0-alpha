# Module Ownership

## Purpose

This document is the normative contributor-facing ownership contract. Use it
before adding a module, moving behavior across modules, changing shared state,
or changing an authenticated bridge route.

The [Alpha runtime boundary](ALPHA_RUNTIME_BOUNDARY.md) defines what ships. The
[module map](MODULE_MAP.md) describes the repository layout. The
[ADR index](README.md) separates decision status from Alpha applicability.

## Alpha Ownership

| Path | Owns | May read | May write or mutate | Must not own |
| --- | --- | --- | --- | --- |
| `browser-first/resonantos-side-panel-extension/src/background.js` | Extension lifecycle and privileged Chrome API message mediation | Chrome extension state and validated messages | Chrome tabs, side-panel state, and extension lifecycle state | Provider credentials, local files, provider routing, or local process state |
| `browser-first/resonantos-side-panel-extension/src/content.js` and `src/lib/content-*.js` | Page observation and bounded in-page interaction | Current page DOM and approved frame context | Page controls allowed by field safety and approval policy | Bridge secrets, provider credentials, wallet signing, login credentials, or unrestricted page execution |
| `browser-first/resonantos-side-panel-extension/src/side-panel.js` and `src/lib/side-panel-*.js` | Side-panel composition, conversation, command routing, browser jobs, and approvals | Extension session state, page observations, bounded bridge results | Browser-side UI/session/job state and approved Chrome actions | Host filesystem/process/provider state |
| `browser-first/resonantos-side-panel-extension/src/main-workspace.js` and `src/lib/main-workspace-*.js` | New-tab workspace composition and feature presentation | Bounded bridge results and extension state | Workspace UI state and explicit user intents | Privileged local mutations except through named bridge routes |
| `browser-first/resonantos-side-panel-extension/src/lib/bridge-client.js` | Bridge request transport and scoped capability-token acquisition | Generated bridge config and in-memory scoped tokens | Request headers and in-memory token cache | Route policy, provider secrets, or filesystem access |
| `browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js` and `src/lib/control-*.js` | Governed browser observation, planning flow, consent, action execution, and verification | Active tab/page snapshots, site/task consent, bounded plans | Chrome/page state allowed by approval policy | Wallet/payment/login/credential/public-submit authority or host privileges |
| `browser-first/host/run-bridge-minimal.mjs` | Bridge composition root, route-service wiring, token creation, startup, and shutdown | Service constructors and environment configuration | Listener lifecycle and generated bridge config | Domain route behavior that belongs in a service |
| `browser-first/host/bridge-server.mjs` | HTTP transport, listener binding, bridge auth, capability checks, CORS, and route dispatch | Route declarations and bridge configuration | Network listener and generated config file | Provider, memory, archive, add-on, or diagnostics policy |
| `browser-first/host/bridge-tls.mjs` | Bridge TLS certificate lifecycle, fixed OpenSSL resolution, and SAN inspection | Per-user bridge TLS state and fixed executable roots | Per-user CA, leaf certificate, key, request, and extension files | Ambient command resolution, bridge authentication policy, or unrelated user files |
| `browser-first/host/provider-host-service.mjs` and `provider-bridge-service.mjs` | Provider profiles, session credentials, routing, diagnostics, and model invocation | Exported environment credentials, configured local endpoints, provider preferences | Session secret memory and external provider requests | Extension UI state or direct browser-page mutation |
| `browser-first/host/agent-control-host-service.mjs` | Provider-backed plan/next-action decisions and bounded web reads | Sanitized page snapshots and provider routes | Approved provider/network requests | Browser action execution or human-only approval decisions |
| `browser-first/host/memory-host-service.mjs` and `memory-*.mjs` | Memory settings, approved sources, intake, sync, search, versions, wiki checks, and route capabilities | External user-state root and user-approved source roots | Capability-gated memory state, intake, and reversible source operations | Unapproved filesystem roots or direct trusted promotion bypasses |
| `browser-first/host/archive-review-host-service.mjs` and archive policy modules | Archive review, verification, promotion, restore, and trusted-write policy | Intake/review artifacts and verifier results | Governed archive artifacts and promoted pages | Unreviewed direct writes to trusted memory |
| `browser-first/host/addon-delegation-host-service.mjs`, `addon-delegation-service.mjs`, `hermes-runtime.mjs`, and `opencode-runtime.mjs` | Optional local add-on status/control, fixed-root runtime resolution, scoped delegation, artifacts, and goals | Reviewed add-on manifests, bounded workspace state, provider availability, and fixed runtime install roots | Capability-gated local runtime processes and delegation records | Core bridge authentication, ambient command lookup, raw provider secrets, wallet actions, or trusted-memory bypasses |
| `browser-first/host/browser-diagnostics-host-service.mjs` and `browser-diagnostics-service.mjs` | Redacted status, inspection, report export, and approved download open/reveal actions | Runtime metadata, bounded local diagnostics, and fixed platform executable roots | Capability-gated redacted reports and direct non-shell download actions | Secrets, ambient command lookup, unrestricted home paths, or provider/model execution |
| `browser-first/host/extension-prefs-host-service.mjs` | External user-state persistence for extension preferences | Stored preference document | Validated preference state | Provider credentials, route capabilities, or unrelated user files |
| `browser-first/test/` | Extension/bridge behavioral contracts and Alpha scope proof | Runtime modules and fixtures | Test-local state only | Product behavior |

## Shared Source Ownership

`src/`, `src/sdk/`, `public/addons/`, `addons/`, `examples/`, and `scripts/`
are supporting, shared, optional, or future-facing paths. They are not extra
required Alpha processes.

| Path | Primary owner | Boundary |
| --- | --- | --- |
| `src/core/` | Shared contracts and pure cross-domain policy | No feature-specific UI or privileged process/filesystem behavior |
| `src/sdk/addons/` | Add-on manifests, capabilities, protocols, and validation | SDK contracts do not grant runtime capabilities |
| `src/modules/addons/` | Add-on catalog, grants, setup, and workspace entrypoints | Host mutations stay behind add-on routes and SDK capability policy |
| `src/modules/archive/` | Living Archive UI, intake, review, promotion, and source management | Trusted writes stay behind archive review and promotion routes |
| `src/modules/browser/` | Shared/legacy browser workspace presentation | Alpha page actions stay in extension controllers |
| `src/modules/chat/` | Conversation UI, composer, threads, and turn orchestration | Provider credentials and routing stay host-side |
| `src/modules/compute/` | Deferred Compute Fabric UI model | No privileged execution authority |
| `src/modules/delegation/` | Delegation monitoring and result review | Runtime execution stays behind host-mediated add-on routes |
| `src/modules/hermes/` | Optional Hermes workspace presentation | Hermes is not a core or required runtime |
| `src/modules/obsidian/` | Deferred notes and vault workspace | Filesystem access stays host-mediated |
| `src/modules/opencode/` | Optional OpenCode workspace presentation | OpenCode remains an optional local service |
| `src/modules/overview/` | Shared overview and workbench framing | UI navigation only |
| `src/modules/paperclip/` | Deferred Paperclip workspace presentation | Development-only add-on boundary |
| `src/modules/recovery/` | Recovery product workflow | Recovery tools remain bounded and audited |
| `src/modules/settings/` | Shared settings UI and controllers | Secrets stay host-side |
| `src/modules/shell/` | Shared React shell hydration, selectors, and composition | Keep domain mutations in their feature owners |
| `src/modules/strategist/` | Strategist identity, channels, and thread organization | Chat execution remains in the chat owner |
| `src/App.tsx` | React composition only | Route, mount, wire, and pass callbacks; do not accumulate domain behavior |
| `public/addons/` | Bundled manifest/catalog data | Manifest presence is not install, enablement, or grant authority |
| `addons/resonant-browser-host/` | Optional browser-host add-on package | Not the required Alpha bridge or browser runtime |
| `examples/` | Optional examples | Never required for Alpha startup |
| `scripts/` | Repository validation and development tooling | Not shipped runtime authority |

If two domains need the same data shape or pure helper, place it in
`src/core/` or the established SDK layer. Shared placement does not transfer
ownership of behavior.

## State And Data Flow

1. Extension modules may read browser state and bounded bridge responses.
2. Extension modules mutate browser/page state only through Chrome APIs,
   content-script controls, and approval policy.
3. Privileged local reads and writes cross `bridge-client.js` and a declared
   bridge route.
4. `bridge-server.mjs` authenticates transport; the named route service owns
   domain validation and resource policy.
5. Provider credentials remain in bridge process memory or the exported bridge
   environment. They never become browser storage or repository state.
6. Local state defaults to `~/ResonantOS_User`; approved external source roots
   remain explicit inputs, not implicit filesystem authority.
7. Wallet, payment, login, credential, signing, transfer, destructive, and
   public-submit actions remain human-only regardless of UI consent state.

## Host And IPC Boundary

`src-tauri/src/` is not present in this checkout and has no Alpha ownership.
The authenticated Node bridge is the current IPC-like privileged boundary.

### Host Route Contract

Every new or changed host route must identify:

- one primary owner service;
- its method and exact path;
- whether the bridge token alone is sufficient or which scoped capability is
  required;
- the provider, network endpoint, process, or filesystem roots it may access;
- input validation and redaction rules;
- focused tests in `browser-first/test/` or the owning package.

Do not add domain behavior directly to `run-bridge-minimal.mjs`. Do not move
authentication or capability enforcement out of `bridge-server.mjs`. Do not
treat an extension button, hidden control, or confirmation copy as an
authorization boundary.

## Historical Runtime Ownership

Tauri, Electron, native CEF, Rust/Cargo, custom Chromium packaging, external
browser sidecars, terminal workspaces, and Audio2TOL have no Alpha runtime
ownership. Historical ADRs may describe those systems, but new Alpha work must
not assign routes, secrets, process control, packaging, or validation to them.

Future native/browser-distribution work requires an explicit release scope and
an ownership update before implementation. It does not inherit Alpha bridge
authority automatically.

## Pull Request Checklist Hook

When a pull request adds a module, moves behavior between modules, changes
shared state, or changes a bridge route, answer all of these:

- Which path owns the behavior after this change?
- What state does it read, and what state may it mutate?
- Does any shared contract belong in `src/core/` or an SDK package?
- Does the change cross browser, provider, network, process, filesystem,
  credential, archive-promotion, or human-approval boundaries?
- Which bridge capability protects the route?
- Which focused test proves the boundary?
- Do this ownership contract, the module map, the Alpha boundary, or an ADR
  need an update in the same pull request?

Run the focused ownership check:

```bash
node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs
```

## Drift Handling

- If an entrypoint accumulates domain logic, move it to the named owner.
- If a route service mixes unrelated provider, filesystem, process, or policy
  responsibilities, split it before adding another privileged operation.
- If docs and executable paths disagree, treat the executable Alpha path as
  evidence, correct the normative docs, and record a new ADR when the decision
  itself changes.
- If ownership cannot be named, stop and resolve it before implementation.
