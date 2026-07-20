# Alpha Runtime Boundary

## Normative Boundary

ResonantOS 2.0.0 Alpha has exactly two required runtime components:

1. The Chrome Manifest V3 extension in
   `browser-first/resonantos-side-panel-extension/`.
2. The authenticated local Node.js bridge started by
   `npm run browser-first:bridge`, implemented under `browser-first/host/`.

The only privileged request path is:

```text
Chrome MV3 extension
  -> authenticated bridge request on loopback
  -> capability-gated Node bridge route
  -> approved provider endpoint or local service
```

The extension owns browser UI and browser-page interaction. The bridge owns
provider credentials, provider calls, local filesystem state, process-backed
add-ons, Living Archive mutation, diagnostics export, and other privileged
local operations. No web page or add-on iframe is a privileged authority.

## Extension Boundary

The extension manifest, background worker, content scripts, side panel, and
new-tab workspace live under
`browser-first/resonantos-side-panel-extension/`.

The extension may:

- read and mutate browser state through declared Chrome extension permissions;
- run governed browser actions through extension controllers;
- maintain browser-side session, job, preference, and presentation state;
- call bridge routes through `src/lib/bridge-client.js`;
- request only the route capabilities needed for the active operation.

The extension must not persist provider credentials, scoped route-capability
tokens, wallet secrets, private keys, or privileged filesystem state as product
data. An operator-configured bridge target is the narrow exception: its bridge
token and capability-bootstrap token are stored in the local Chrome extension
profile so the selected target survives a browser restart. Clearing the bridge
override removes that local record. Wallet signing, payments, credentials,
login, public submission, and other irreversible value actions remain
human-only.

## Bridge Boundary

`browser-first/host/run-bridge-minimal.mjs` composes the bridge route services.
`browser-first/host/bridge-server.mjs` owns listener setup, request
authentication, capability-token checks, route dispatch, CORS handling, and
generated extension configuration.

The default bridge binds to `127.0.0.1`. Alpha documentation and validation
assume loopback operation. A non-loopback bind is an explicit operator
configuration and does not change the Alpha release boundary.

Every JSON route requires the bridge token. Privileged route families also
require a scoped capability token. Capability tokens are minted from a
separate bootstrap token and are checked again by the Node bridge; UI state or
an extension control is not an authorization boundary.

The bridge may connect only to configured provider endpoints and local
services requested through named route owners. Direct page-to-provider,
page-to-filesystem, and page-to-process paths are outside the architecture.

## Route Owners

| Route family | Primary owner | Privileged resources |
| --- | --- | --- |
| `/providers/*`, `/augmentor/chat`, `/augmentor/inline` | `provider-host-service.mjs` and `provider-bridge-service.mjs` | Session-held provider credentials, provider routing, approved cloud or local model endpoints |
| `/augmentor/control-plan`, `/augmentor/next-action`, `/web/news` | `agent-control-host-service.mjs` | Provider-backed planning and approved network reads |
| `/memory/*`, `/archive/*` | `memory-host-service.mjs`, memory source services, and `archive-review-host-service.mjs` | User-approved source roots, Living Archive intake/review/promotion state |
| `/addons/*`, `/hermes/*`, `/opencode/*`, `/goals` | `addon-delegation-host-service.mjs` and `addon-delegation-service.mjs` | Optional local runtimes, scoped workspaces, delegation artifacts |
| `/status`, `/workspace/inspect`, `/browser/*`, `/diagnostics/report` | `browser-diagnostics-host-service.mjs` | Redacted local diagnostics and approved download actions |
| `/settings/extension-prefs` | `extension-prefs-host-service.mjs` | External user-state preference storage |

New routes must declare one owner, the required capability, and focused bridge
tests. Route registration does not grant authority by itself.

## Generated And Local State

Starting the bridge writes:

`browser-first/resonantos-side-panel-extension/src/bridge-config.generated.js`

The generated file contains the bridge URL and authentication material. It is
ignored, machine-local, mode `0600` when supported, and must never be committed
or packaged.

The Settings bridge-target override stores its URL, bridge token, and
capability-bootstrap token in `chrome.storage.local`. This is local browser
profile state, not repository or user-data-root state. Raw scoped
route-capability tokens are minted at runtime and are not written to extension
storage.

The default user-state root is `~/ResonantOS_User`, overridable for development
with `RESONANTOS_BROWSER_FIRST_USER_ROOT`. Memory, diagnostics, delegation
artifacts, and extension preferences belong outside the repository.

Provider credentials entered through Settings are held in bridge process
memory for the session. The bridge may read supported environment variables
exported into its process. The launcher does not load dotenv files.

## Approved Destinations

Bridge egress is limited by the owning service:

- provider services use configured provider profiles or approved local model
  endpoints;
- memory and archive services use the external user-state root and explicitly
  approved source paths;
- optional add-on services use reviewed loopback endpoints or bounded process
  launchers;
- browser diagnostics export redacted data and excludes credentials, bridge
  tokens, wallet secrets, private keys, and unrestricted home-directory data.

An approved destination does not remove a route's capability or human-approval
requirements.

The following are historical, deferred, experimental, or supporting code. They
are not shipped Alpha runtime components and are not Alpha build prerequisites:

## Out Of Scope

- Tauri shells and `src-tauri` paths;
- Electron shells or `BrowserView` hosts;
- native CEF or other embedded native browser hosts;
- Rust and Cargo toolchains;
- custom Chromium distributions or native browser packaging;
- external Chrome/Brave CDP sidecar profiles as the product browser;
- terminal workspaces and terminal add-ons;
- Audio2TOL;
- Compute Fabric, add-on commerce, native wallet custody, and automated wallet
  signing.

`src/`, `src/sdk/`, `public/addons/`, `addons/`, `examples/`, and development
scripts can supply shared contracts, manifests, optional services, tests, or
future product work. Their presence does not add a third required Alpha runtime
component.

## Change Rules

- Extension or bridge changes must preserve bridge-token and route-capability
  enforcement.
- Provider, filesystem, process, archive-promotion, credential, and diagnostics
  operations stay behind a named bridge service.
- Browser-page code never receives provider credentials or local filesystem
  authority.
- Work on an out-of-scope runtime requires separate release scope and must not
  be added to Alpha installation, build, or verification instructions.
- A change to the privileged path must update this document, the
  [module map](MODULE_MAP.md), and the
  [module ownership contract](MODULE-OWNERSHIP.md) when ownership changes.
