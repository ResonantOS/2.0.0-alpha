# ADR-005: Provider Fabric & Routing

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Provider host
- Decision date: 2026-04-23
- Alpha note: The authenticated Node bridge owns provider credentials, workload
  routing, diagnostics, and approved provider or local-model requests.

## Decision

ResonantOS owns provider and runtime routing through a system policy engine. Add-ons, agents, and archive services may declare requirements and preferences, but they do not choose the final provider, runtime node, or model directly.

The provider fabric includes:

- cloud API providers
- subscription-capable providers
- local runtime nodes
- user-owned remote runtime nodes such as GX10

Remote user-owned machines are modeled as **provider runtime nodes**, not as add-ons.

## Why

- The product goal is sovereignty over all user-available intelligence and compute, not attachment to one vendor or one auth path.
- Central routing lets the system coordinate cost, latency, trust, fallback, and availability consistently across Strategist, Setup, Living Archive, and add-ons.
- User-owned local and remote runtimes must be first-class citizens, not second-class exceptions.

## Rules

- Routing authority belongs to ResonantOS policy, not to add-ons.
- Provider onboarding must be catalog-driven:
  - direct cloud providers
  - provider aggregators and gateways
  - local runtime software
  - user-owned runtime machines
  - custom OpenAI-compatible endpoints
- The catalog must distinguish **profile creation** from **routable execution**. A provider can be known to ResonantOS before a native execution adapter exists.
- Add-ons declare:
  - provider capabilities needed
  - model or quality preferences
  - latency or locality preferences
  - fallback tolerance
- The policy engine resolves:
  - provider profile
  - runtime node
  - model
  - auth mode
  - fallback route
  - execution adapter capabilities
- Provider/auth/runtime states must be explicit:
  - `supported`
  - `experimental`
  - `unavailable`
- Reverse-engineered or undocumented auth paths may exist only in the `experimental` tier.
- Experimental paths must be:
  - visible in product state
  - isolated from supported flows
  - degradable without breaking the core shell
- Per-agent fallback policies are allowed, but the final routing decision still belongs to the central policy engine.

## Fallback and Recovery

- ResonantOS must support a **resurrect / panic fallback path**.
- A local model does not need to stay resident in memory at all times.
- The system must be able to:
  - detect that normal routes are unavailable
  - deploy a prepared local fallback runtime on demand
  - wire that runtime to Strategist and Setup
- The global baseline is:
  - at least one deployable local fallback route exists
  - agents may also define narrower fallback preferences

## Interfaces Constrained By This ADR

### Provider Profile

Represents the provider-facing identity and policy surface.

Must include:

- `id`
- `provider_type`
- `auth_source`
- `auth_tier`
- `consumer_scopes`
- `allowed_models`
- `primary_model`
- optional `fallback_model`
- status / availability state

### Runtime Node

Represents where inference actually executes.

Must include:

- `id`
- `kind`: `cloud`, `local`, `remote-user-owned`
- `provider_profile_id`
- `endpoint`
- `locality`
- `health_state`
- `supported_models`
- `experimental`
- `deployable_on_demand`

### Routing Policy Input

A caller may declare:

- required capabilities
- preferred models
- acceptable auth tiers
- preferred runtime locality
- latency/cost sensitivity
- fallback tolerance

### Routing Decision Output

The policy engine returns:

- chosen provider profile
- chosen runtime node
- chosen model
- chosen auth tier
- fallback route
- routing reason / policy note
- execution adapter capability metadata, including whether streaming and provider/runtime abort are supported

### Execution Adapter Capability

Each execution adapter must declare:

- supported provider types
- supported runtime kinds
- supported auth methods
- whether reasoning effort is supported
- whether streaming is supported
- whether host-side abort is supported
- whether credentials are required
- whether the adapter is experimental

### Provider Catalog Template

Each setup template must express:

- provider or runtime label
- category: `direct-provider`, `aggregator`, `local-runtime`, `runtime-node`, or `custom`
- provider type and auth method
- default endpoint when known
- whether a secret or base URL is required
- optional starter model list only when the template refers to a documented cloud model catalog
- initial provider status
- initial runtime node health
- execution state:
  - `routable-now`: an existing host adapter can execute it today
  - `adapter-pending`: the profile can be stored, but routing must not select it until a native adapter exists
  - `profile-only`: the entry is recorded for inventory/planning only
- setup note explaining what the Engineer Agent should verify or complete

### Provider Setup Probe

The Engineer/setup path must verify provider setup through provider-owned or runtime-owned discovery APIs when available:

- OpenAI and OpenAI-compatible cloud/gateway routes use `GET /v1/models` with the saved credential.
- OpenAI-compatible gateways use their documented base URL plus `/models`.
- llama.cpp `llama-server` and other user-owned OpenAI-compatible LAN runtimes use `GET /v1/models` without a credential unless the user configured one.
- Ollama uses `GET /api/tags` against the selected local runtime endpoint.
- User-owned LAN runtimes such as GX10/DGX-class machines must start as non-routable placeholders until setup discovers a real HTTP runtime endpoint.
- LAN runtime setup may try the configured endpoint, known local host aliases, and bounded local subnet discovery for OpenAI-compatible `/v1/models` and Ollama `/api/tags`; routing is enabled only after a real model-list response.
- Unsupported native providers may be saved as profiles, but the probe must return `adapter-pending` instead of inventing a model list.
- The setup probe may update provider model lists only from discovery responses. User-owned runtime templates must not expose guessed model names in routable selectors.

### Fallback Policy

Must express:

- preferred fallback order
- whether experimental routes are permitted
- whether resurrection is allowed
- whether the route is hard-stop or degrade-on-failure

### Model Strategy Profile

The user and Resonant Engineer Agent must be able to maintain a workload-level strategy profile. This is where cost, subscription posture, locality, and quality expectations become explicit operating policy instead of hidden routing behavior.

Must express:

- workload owner: agent or system workload
- workload class: primary chat, recovery, archive ingest, routine/background work, coding, or future classes
- primary route: provider profile, runtime node, model, and cost posture
- fallback chain: ordered provider/runtime/model routes
- failure behavior: hard-stop or use agreed fallbacks
- emergency hard floor: a deployable local route that remains available when richer routes fail

Cost posture must be visible using at least these labels:

- `free-local`
- `subscription`
- `paid-api`
- `emergency-only`
- `unknown`

Routing still belongs to the provider fabric. The strategy profile is user-agreed policy input; it is not a bypass that lets an add-on choose unmanaged providers directly.

## Consequences

- Provider configuration becomes a core operating-system concern, not an add-on concern.
- Future provider UI, runtime health, and recovery UX must surface supported vs experimental distinctions clearly.
- Chat UX must not assume streaming or abort support unless the chosen execution adapter explicitly declares it.
- Contracts in `src/core/` should evolve toward `provider profile + runtime node + routing decision` instead of a single flattened provider concept.
