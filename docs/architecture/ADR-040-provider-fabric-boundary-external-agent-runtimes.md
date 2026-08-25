# ADR-040: Provider Fabric Boundary for External Agent Runtimes

## Decision Metadata

- Decision status: **Deferred**
- Superseded by: None
- Alpha applicability: Applies
- Owner: Provider host / Delegation
- Decision date: **pending** (will be set on acceptance)
- Source: derived from ADR-005 ("Routing authority belongs to ResonantOS policy, not to add-ons"), ADR-015 ("Add-on agents are delegation targets, not trusted equals of Augmentor"), ADR-038 §7 Runtime Boundary and §8 Phase 3.5 caller-attributed capability tokens; modeled against `examples/addons/recursive-mas.json` (local-service add-on pattern) and proposed integrations with DeepSeek Harness (https://deepseek.com/harness/) and Agent Zero (https://www.agent-zero.ai/).

## 1. Decision

External agent runtimes — third-party systems that themselves can plan, call tools, and execute multi-step agentic loops — are integrated into ResonantOS as **local-service add-ons** under ADR-038's manifest contract. They are governed by a strict boundary that prevents them from holding raw provider credentials, choosing their own provider profile, or executing outside the host-mediated service boundary.

ResonantOS owns:

- **Provider credentials.** The provider fabric (ADR-005) is the only authority that holds raw API keys, OAuth tokens, and provider secrets. External agent runtimes never receive raw credentials.
- **Provider routing.** The policy engine is the only authority that chooses the provider profile, runtime node, model, auth tier, and fallback route for any model request. External agent runtimes request routing decisions; they do not make them.
- **Capability grants.** The host (per ADR-015 and ADR-038 §8) is the only authority that grants, scopes, and revokes capabilities on external agent runtimes.
- **Lifecycle.** The host installs, enables, monitors, disables, and removes external agent runtimes under the standard add-on lifecycle.

The external agent runtime owns:

- **Local task execution.** Given a Delegation Packet (ADR-015), an approved scope, and routing decisions, the runtime performs the work in its own environment (subprocess, container, or sandbox).
- **Tool planning.** Within the granted capability surface, the runtime may plan, sequence, and invoke tools; the host validates each tool call against the current grant set before mediation.
- **Local artifact production.** The runtime produces artifacts in its task workspace and returns them to the host via the standard artifact return protocol.
- **Internal state.** The runtime's own memory, context, session, and trajectory logs are its own concern; they may be exposed to the host only through declared surfaces and never substitute for the host's audit log.

## 2. Principle

> The external agent runtime is a worker, not an authority. ResonantOS holds the keys; ResonantOS picks the model; ResonantOS grants the capabilities; the runtime does the work.

The boundary is a privilege boundary, not a directory or process boundary. Whether the external agent runtime runs as a Node subprocess, a Python container, a Docker sidecar, or a remote LAN service is irrelevant to the contract. What matters is which side of the boundary holds each authority.

## 3. Boundary Rules

These rules apply to any add-on whose manifest declares the `providers` capability together with the `agent-delegation` capability (the "external agent runtime" marker). Manifests declaring only `providers` (e.g., a thin provider-fabric adapter without delegation) are governed by ADR-005 alone; manifests declaring only `agent-delegation` (e.g., a delegation-routing add-on without model execution) are governed by ADR-015 alone. The conjunction triggers this ADR.

**Rule 1 — No raw credentials.** The runtime MUST NOT be passed raw API keys, OAuth tokens, cookies, or any other credential material. ResonantOS invokes the runtime with **routed model handles**: opaque references that the runtime forwards back to the host's provider-fabric adapter for actual execution. The runtime never sees the underlying credential.

**Rule 2 — No provider selection.** The runtime MUST NOT choose its own provider profile, runtime node, model, or auth tier. Each model request from the runtime carries a Routing Decision (ADR-005 §Routing Decision Output) supplied by the host. The runtime uses that decision; it does not override it. The runtime MAY include preferences in its request (preferred locality, latency, cost posture), and the host's policy engine resolves them; the runtime does not bypass the policy engine.

**Rule 3 — Host-mediated tool surface.** Every tool the runtime can invoke must be declared in the runtime's `tools[]` block (per `examples/addons/recursive-mas.json`), each with its `requiredCapabilities`, `inputSchema`, `outputSchema`, and `audit` block. The host validates each invocation against the runtime's current capability grants before mediation. Tools not declared are unreachable.

**Rule 4 — Scoped filesystem and shell.** Filesystem and shell capabilities granted to the runtime are scoped to the runtime's task workspace by default. The runtime MAY request a broader scope via a `grantPreset` (which the user must accept explicitly per ADR-015 §Delegation Quality Rules). The host enforces scope at every mediation; the runtime cannot escape its workspace by direct file or shell access.

**Rule 5 — Capability-gated mediation.** Every privileged action by the runtime (file read/write, shell exec, network, archive read/write, knowledge page write) goes through a host-mediated bridge route. The runtime holds no privileged capability directly. The bridge enforces caller-attributed capability tokens (ADR-038 §8 Phase 3.5); tokens minted for the runtime's `callerId` are scoped to the runtime's current grant set and cannot be transferred.

**Rule 6 — Delegation Packet only.** The runtime accepts work only via an ADR-015 Delegation Packet. It MUST NOT accept free-form user prompts directly. The packet's `mission`, `context`, `providerPolicy`, `costPolicy`, `allowedTools`, `forbiddenActions`, `capabilityGrants`, and `verificationRequirements` are authoritative; the runtime MAY add local notes but MUST NOT relax the packet's constraints.

**Rule 7 — Audit before return.** Every tool call, model request, file access, and shell execution by the runtime emits an audit record through the host's bridge before the runtime can return artifacts. The runtime cannot "skip" audit by returning artifacts directly to the calling agent; the artifact return path itself runs through the host's audit layer.

**Rule 8 — Approval before irreversible work.** Any tool call marked `requiresHumanApproval: true` in the manifest blocks until the host has surfaced an approval prompt and recorded the user's decision. The runtime cannot proceed around this. Per ADR-015, all `run_task`-style tools that take an approved Delegation Packet carry this flag by default.

## 4. Credential Mediation

External agent runtimes never receive raw provider credentials. The mediation flow:

```text
Runtime model request
       |
       v
Runtime sends { prompt, routing_decision } to host provider-fabric adapter
       |
       v
Host validates routing decision against current policy
       |
       v
Host invokes the chosen provider profile with raw credentials
       |
       v
Host returns model response (and streamed tokens) to runtime
       |
       v
Runtime sees the response; never the credential
```

The "routed model handle" is the wire contract:

```json
{
  "routingDecisionId": "rd-2026-08-24-001",
  "providerProfileId": "resonant-deepseek-v4-pro",
  "runtimeNodeId": "rn-local-user-mac",
  "model": "deepseek-v4-pro",
  "authTier": "subscription",
  "costPosture": "paid-api",
  "fallbackChain": ["rn-emergency-local", "rn-degraded-bypass"],
  "expiresAt": "2026-08-24T01:00:00Z"
}
```

The runtime uses the `routingDecisionId` to make subsequent calls (streaming, follow-ups, cancellation). The host resolves the ID back to a stored decision; the credential never appears on the wire. Decisions expire (default: 5 minutes; configurable in the host); the runtime must request a fresh decision if its current one expires.

**What the runtime sees:** opaque IDs and the model name. **What the runtime never sees:** the API key, OAuth token, base URL secret, or any provider-internal auth material.

This mirrors the Phase 3.5 caller-attributed capability token design (ADR-038 §8): an opaque, scoped, expiring handle that the host can revoke at any time. Revoking a routing decision mid-task causes the runtime's next model call to fail with `routing-decision-revoked`; the runtime is expected to surface this to its calling agent and request a new decision.

## 5. Model Routing

The runtime requests a routing decision; the host's policy engine returns one. The runtime does not pick.

```text
Runtime -> Host: { taskClass, localityPreference, costPosturePreference,
                   latencySensitivity, fallbackTolerance, modelHints }
Host -> Policy Engine: resolve
Policy Engine -> Runtime: { routingDecisionId, chosenProfile,
                            chosenRuntime, chosenModel, chosenAuthTier,
                            fallbackChain, routingReason,
                            executionAdapterCapabilities }
Runtime: stores routingDecisionId, uses it for all model calls
```

Fields the runtime MAY set as preferences:

- `taskClass`: `primary-chat`, `recovery`, `archive-ingest`, `routine`, `coding`, `specialist-reasoning` (extensible).
- `localityPreference`: `local-only`, `prefer-local`, `prefer-cloud`, `cloud-only`.
- `costPosturePreference`: `free-local`, `subscription`, `paid-api`, `emergency-only`.
- `latencySensitivity`: `interactive`, `batch`, `background`.
- `fallbackTolerance`: `strict`, `moderate`, `aggressive`.
- `modelHints`: free-form (e.g., "needs 1M context", "function-calling preferred"). Hints are advisory; the policy engine may ignore them.

Fields the runtime MAY NOT set:

- `providerProfileId` — chosen by policy.
- `runtimeNodeId` — chosen by policy.
- `model` — chosen by policy.
- `authTier` — chosen by policy.

The runtime MAY use experimental routes only if the manifest declares `providerRequirements.allowExperimentalAuth: true` AND the host's policy engine has experimental routes enabled. Otherwise, requests that can only be satisfied by experimental routes return `routing-failed-experimental-required`.

## 6. Capability Map

External agent runtimes declared as local-service add-ons declare their capability set explicitly. The canonical mapping for the conjunction of `providers` + `agent-delegation` is:

| Capability | Required for external agent runtime? | Notes |
| --- | --- | --- |
| `providers` | Yes (consume-side) | Runtime consumes ResonantOS provider profiles via routed handles. Never receives raw credentials. |
| `agent-delegation` | Yes | Runtime accepts Delegation Packets; emits artifact returns; respects packet constraints. |
| `network` | Yes (scoped) | Runtime must reach its own subprocess endpoint (e.g. `http://127.0.0.1:4891`) and the host's provider-fabric adapter. Scope: `self` for runtime's own port; `shared` for host adapter. |
| `shell` | Optional | Granted only via a `grantPreset` that the user explicitly accepts. Scope: `system` only if the runtime needs to escape its task workspace, which is rare. Default: not granted. |
| `filesystem` | Yes (scoped) | Scope: the runtime's task workspace by default. Broader scopes (`workspace`, `shared`) require `grantPresets` and explicit user approval. |
| `archive-read` | Optional | If the runtime needs scoped Living Archive context. |
| `archive-intake-write` | Optional | If the runtime returns artifacts via intake (recommended for delegation returns). |
| `ui-embedding` | Optional | Only if the runtime surfaces a panel inside ResonantOS. |
| `notifications` | Optional | Long-running task status notifications. |
| `memory-provider` | V1 deferred | Per ADR-038 §12.3 (capability separation deferred). Runtime may store its own memory locally; the host does not consume it as a memory-provider slot until V1. |
| `browser-control` | Optional | Only if the runtime hosts a headless browser. |
| `channel.send` / `channel.account-write` | N/A | External agent runtimes are not channels. Channels (Telegram, Discord, etc.) use these; runtimes do not. |

The runtime's manifest declares its capabilities in `requestedCapabilities`. The runtime cannot request a capability it doesn't list. The host validates the conjunction: declaring `providers` without `agent-delegation` is the standard provider-fabric adapter pattern (ADR-005 only); declaring `agent-delegation` without `providers` is the delegation-routing pattern (ADR-015 only); declaring **both** triggers this ADR's additional rules.

## 7. Failure Modes

The boundary must be testable. These failure modes are the negative tests for any external agent runtime integration:

**F1 — Credential exfiltration attempt.** A runtime stores an inbound model request that contains an API key in a header, then forwards it as part of a `network` call. Expected: host blocks at the bridge; emits denied-audit record with reason `credential-in-payload`; revokes the routing decision.

**F2 — Provider self-selection.** A runtime declares its own model (`model: "gpt-4o"`) in a tool call payload, bypassing the routing decision. Expected: host rejects the model request; returns `provider-self-selection-rejected`; the runtime must use its routing decision's model.

**F3 — Workspace escape.** A runtime uses `shell` to `cat` a file outside its task workspace. Expected: host blocks at the bridge; denied-audit with reason `workspace-escape`; the runtime's `shell` grant is revoked if `revocationBehavior` is `hard-stop`.

**F4 — Capability escalation.** A runtime claims it needs `archive-intake-write` mid-task and tries to call the archive intake route. Expected: host rejects at the bridge (caller-attributed token does not grant `archive-intake-write`); denied-audit with reason `capability-denied`.

**F5 — Undeclared tool.** A runtime invokes a tool that is not in its manifest's `tools[]` block. Expected: host rejects; denied-audit with reason `unknown-tool`.

**F6 — Audit bypass.** A runtime attempts to return artifacts directly to its calling agent without going through the artifact return protocol. Expected: host rejects; denied-audit with reason `audit-bypass-attempt`.

**F7 — Approval skip.** A runtime invokes a `run_task`-style tool marked `requiresHumanApproval: true` without the user having approved. Expected: host blocks until approval; if approval denied, runtime receives `approval-denied` and must abort the task.

**F8 — Stale routing decision.** A runtime uses a `routingDecisionId` whose `expiresAt` has passed. Expected: host rejects; returns `routing-decision-expired`; runtime requests a new decision.

**F9 — Revoked routing decision.** A runtime uses a `routingDecisionId` after the host revoked it (e.g., user disabled the runtime). Expected: same as F8 with reason `routing-decision-revoked`.

**F10 — Experimental route attempt without declaration.** A runtime requests an experimental route without `allowExperimentalAuth: true`. Expected: rejected with `experimental-route-not-declared`.

Each F-number becomes a test case in `packages/addon-sdk-testing/` (B4 deliverable) and in the runtime's own manifest review.

## 8. Compatibility

**With ADR-005 (Provider Fabric & Routing).** Unchanged. This ADR adds an explicit boundary for the external-agent-runtime case; ADR-005 remains authoritative for provider routing in all other cases.

**With ADR-015 (Delegation Fabric).** Tightened. ADR-015 established that add-on agents are delegation targets; this ADR adds the credential and provider-selection constraints that make that policy enforceable for external agent runtimes. The Delegation Packet's `providerPolicy` field (newly formalized in this ADR) is the runtime's input to the routing request.

**With ADR-038 (REF).** Compatible. ADR-038 §7 Runtime Boundary and §8 Phase 3.5 caller-attributed tokens are the mechanism this ADR relies on. The Phase 3.5 hardened bridge is what prevents the runtime from directly invoking privileged routes. The C2 / option (a) "per-caller grant store" decision (ADR-038 §8) is what gives the runtime a `callerId` distinguishable from first-party subsystems.

**With `examples/addons/recursive-mas.json`.** Compatible. The recursive-mas manifest is an existing local-service add-on with `providers` + `agent-delegation`. It pre-dates this ADR but satisfies its rules in their current form; no manifest changes required. The recursive-mas runbook (`docs/architecture/addon-runbooks/recursive-mas/ENGINEER_SETUP.md`) should be reviewed against §4 (Credential Mediation) and either confirmed compliant or amended.

**With future ADRs (V1 capability separation).** Per ADR-038 §12.3, the V1 split between `PublicCapability` and `InternalCapability` may introduce a new visibility tier for "delegation-routing primitives" that this ADR doesn't constrain. External agent runtimes declared under this ADR are always at the public tier; they cannot request V1-internal capabilities.

## 9. Reference Implementations

Two concrete add-ons are anticipated under this ADR:

1. **`addon.deepseek-harness`** — local-service add-on bridging ResonantOS to the DeepSeek Harness (https://deepseek.com/harness/) Cordis kernel runtime. Service: `http-json`, entrypoint `http://127.0.0.1:3080`. Capabilities per §6. Runbook to follow.

2. **`addon.agentzero`** — local-service add-on bridging ResonantOS to the Agent Zero (https://www.agent-zero.ai/) Docker container runtime. Service: `http-json`, entrypoint `http://127.0.0.1:<agent-zero-port>`. Capabilities per §6. Runbook to follow.

Both manifests will be siblings of `examples/addons/recursive-mas.json`. Both will satisfy every §3 rule, every §6 capability mapping, and every §7 failure-mode negative test before they can be installed.

Neither manifest lands in this ADR; they land as separate add-on commits after B4 (SDK cutover) so they can be authored against the V0.1 SDK package.

## 10. Open Questions

These are explicit deferrals, not omissions:

- **ProviderProfileId exposure in the routed handle.** §4 includes `providerProfileId` in the routed handle for observability. Some teams argue this leaks routing intent to the runtime. Argument: the runtime needs to know which profile it's on for logging and user-facing explanations. Counter-argument: opaque IDs are sufficient; the host can map back at audit time. **Deferred to a follow-on review.** Current decision: include for V0.1; remove in V1 if it proves leaky.

- **Cross-runtime credential isolation.** When two runtimes are installed (DSH and A0), can one runtime's routing decision be presented to another as its own? **Expected: no.** The routed handle binds to the `callerId` of the requesting runtime. Cross-presentation is a denial-audit event. This is a Phase 3.5 enforcement property; ADR-038 §8 records it. **No follow-on work needed; just calling it out.**

- **Runtime-supplied model name as a hint.** Some external agent runtimes have hard-coded "I prefer model X" defaults. §5 lets the runtime pass `modelHints` but not a hard selection. Some teams want a `modelPreference: "strict"` flag that causes the policy engine to fail rather than substitute. **Deferred to V1.**

- **Long-running task support.** DeepSeek Harness sessions can run for hours; Agent Zero subordinates can persist. §3 Rule 7's audit-before-return implies every tool call is logged. For a 4-hour agent loop with 2000 tool calls, the audit volume is large. **No ADR-040 change; logged as a future perf concern for the audit pipeline.**

## 11. Source

- ADR-005: Provider Fabric & Routing (`docs/architecture/ADR-005-provider-fabric-routing.md`)
- ADR-015: Delegation Fabric, Add-on Catalog, and Native Tool Fabric (`docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md`)
- ADR-038: Resonant Extension Framework (`docs/architecture/ADR-038-resonant-extension-framework.md`), especially §7 Runtime Boundary, §8 Phase 3.5, §12.3 deferred capability separation
- `src/core/contracts.ts` AddOnManifest `providerRequirements` block (lines 547-555)
- `src/sdk/addons/contracts.ts` AddOnSdkManifest (lines 26-43)
- `examples/addons/recursive-mas.json` (canonical local-service add-on pattern)
- `docs/architecture/addon-runbooks/recursive-mas/ENGINEER_SETUP.md`
- `docs/addons/resonant-extension-framework/RESOLUTIONS_V0.1.md` C2 (Phase 3.5 hardening), C3 (privilege-not-directory boundary), C5 (mapping table ownership)
- `docs/addons/resonant-extension-framework/ADDON_SDK_CODE_REVIEW_FEEDBACK_2026-08-24.md` Finding 6 (SDK validation, approval, and runtime authority must stay separate)
- `docs/addons/resonant-extension-framework/REF_HARDENING_NOTES_V0.1.md` H1/H2/H3 caller-attributed token design

## 12. Appendix — Negotiation Summary

Before drafting this ADR, the following question was discussed:

> When we integrate DeepSeek Harness (an external agent runtime) and Agent Zero (also an external agent runtime) into ResonantOS, what shape do their manifests take, and which side of the boundary holds which authority?

The answer in one sentence: **ResonantOS holds the keys; ResonantOS picks the model; ResonantOS grants the capabilities; the runtime does the work.** This ADR records that answer as a reusable contract so future external agent runtimes (LangChain, AutoGPT, OpenHands, etc.) follow the same boundary without rediscovery.

Two integration-shape alternatives were considered and rejected:

- **Embedded harness** (DSH runs as a managed subprocess *inside* ResonantOS as a local-service add-on, with full trust). Rejected: gives the runtime authority it should not hold, especially provider selection and credential storage.
- **Provider runtime node** (DSH registered as an OpenAI-compatible endpoint in the provider fabric). Rejected at the V0.1 level because DSH's primary interface is Cordis JSON-RPC, not `/v1/models`. May be revisited as an adapter in V1.

The "subordinate agent bridge" shape — local-service add-on with `providers` + `agent-delegation`, governed by this ADR — is the canonical path.
