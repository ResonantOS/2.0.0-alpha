# ADR-030: RecursiveMAS Runtime Node And Add-on

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: RecursiveMAS add-on
- Decision date: 2026-05-05
- Alpha note: V0 is experimental, disabled by default, and not required for
  Alpha.

## Decision

RecursiveMAS should be integrated into ResonantOS as an optional experimental **recursive reasoning runtime add-on**.

The add-on id is reserved as `addon.recursive-mas`.

RecursiveMAS is not a core ResonantOS service, not the default Augmentor brain, and not a replacement for Augmentor Chat. It is a specialist reasoning runtime that ResonantOS can use for delegated tasks when local or user-owned open-model compute is available.

The integration has two separate concepts:

- `addon.recursive-mas`: the add-on that owns setup UI, runbook, local service lifecycle, status, and declared tools.
- RecursiveMAS runtime node: a provider-fabric runtime node that exposes recursive multi-agent inference as a routed execution option.

ResonantOS remains the outer authority for provider routing, fallback policy, cost policy, delegation packets, capability grants, audit logs, and Living Archive boundaries.

## Why

RecursiveMAS is valuable because it explores a different computation pattern from ordinary chat or RAG. Instead of having multiple agents exchange verbose natural-language intermediate messages, RecursiveMAS coordinates agents through latent hidden-state recursion and emits text only at the final answer boundary.

That makes it a possible fit for:

- local or remote user-owned GPU reasoning
- cheaper specialist deliberation before escalating to expensive cloud models
- recursive verification and challenge passes
- benchmark-like reasoning tasks
- archive review support where a second model should challenge an ingest result
- delegated research synthesis when final text is enough but intermediate traces do not need to be chat-visible

It should not be treated like OpenAI, MiniMax, Claude, or Gemini APIs because true RecursiveMAS operation requires access to open-model internals, adapters, and runtime weights. Closed provider APIs cannot expose the required latent-state exchange path.

## Binding Rules

- RecursiveMAS is optional and replaceable.
- RecursiveMAS must not be installed, enabled, or granted capabilities by default.
- RecursiveMAS must remain in the experimental tier until deterministic setup, inference, and artifact-return tests pass on supported platforms.
- RecursiveMAS may not bypass ResonantOS provider routing.
- RecursiveMAS may not choose final provider/model/runtime for a workload directly.
- RecursiveMAS may declare supported styles, model families, hardware requirements, latency/cost estimates, and fallback tolerance.
- ResonantOS policy chooses whether a workload may route to RecursiveMAS.
- RecursiveMAS may not read raw provider secrets.
- RecursiveMAS may not write trusted Living Archive knowledge pages.
- RecursiveMAS may write only intake artifacts and task artifacts when granted.
- RecursiveMAS outputs must return as Delegation Packet artifacts unless a future provider adapter explicitly supports direct chat routing.
- RecursiveMAS latent traces are internal runtime data by default. The add-on should expose final text, citations if available, style, model/runtime metadata, timing, token/step estimates, and audit summaries rather than raw hidden states.
- Any install, model download, checkpoint loading, adapter loading, or service launch must be mediated by reviewed host commands and audit logs.

## Runtime Category

`addon.recursive-mas` is a hybrid add-on:

- `local-service` for the RecursiveMAS service wrapper
- `agent-addon` for declared specialist reasoning targets
- optional `panel` or `background-task-monitor` UI surfaces for status, model/style selection, and run logs

It should not be modeled as an orchestrator like Paperclip. RecursiveMAS is a reasoning runtime for task execution, not an organizational control plane.

## Provider Fabric Mapping

RecursiveMAS should appear in Provider Fabric as one or more runtime nodes.

Example node kinds:

- desktop-local RecursiveMAS service
- LAN remote RecursiveMAS service on user-owned GPU hardware
- WAN remote user-owned RecursiveMAS service, if explicitly configured

Provider profile relationship:

- provider type should be `local` or `custom` until a dedicated provider type exists
- auth method should be `local-runtime` for desktop-local service
- auth tier should be `experimental`
- runtime kind should be `local` or `remote-user-owned`
- locality should be `desktop-local`, `lan-remote`, or `wan-remote`

Routing input should include:

- workload class
- reasoning style
- acceptable experimental tier
- local/remote preference
- max runtime budget
- model family requirements
- whether final-only output is acceptable
- whether the task can tolerate non-streaming execution

Routing output should include:

- chosen RecursiveMAS endpoint
- selected style
- selected model family or checkpoint
- recursion depth or phase plan
- execution adapter capability metadata
- policy reason
- fallback path if service/model/checkpoint is unavailable

## Required Capabilities

Minimum useful grants:

- `providers`: expose RecursiveMAS as a routed runtime node through ResonantOS policy
- `network`: connect to a local or user-owned remote RecursiveMAS endpoint
- `agent-delegation`: accept Delegation Packets for specialist reasoning tasks
- `notifications`: report long-running task state and degraded status

Required for managed local setup:

- `shell`: run reviewed setup/service commands only
- `filesystem`: scoped to approved RecursiveMAS install, model, cache, and run-output roots

Optional grants:

- `archive-read`: retrieve scoped Living Archive context for delegated tasks
- `archive-intake-write`: queue final reports and run artifacts into intake

Denied by default:

- `archive-page-write`
- unrestricted `filesystem`
- unrestricted `shell`
- wallet/signing actions
- raw secure-vault access
- direct provider secret read

## Host Commands

Initial host commands should be narrow and execution-audited:

- `recursive_mas_status`
- `recursive_mas_detect_install`
- `recursive_mas_configure_service`
- `recursive_mas_start_service`
- `recursive_mas_stop_service`
- `recursive_mas_verify_service`
- `recursive_mas_list_models`
- `recursive_mas_list_styles`
- `recursive_mas_estimate_task`
- `recursive_mas_run_task`
- `recursive_mas_cancel_task`
- `recursive_mas_collect_artifacts`
- `recursive_mas_queue_archive_intake`
- `recursive_mas_collect_logs`

Commands that mutate local state or start execution must include:

- actor id
- add-on installation id
- capability grant proof
- runtime node id
- source Delegation Packet id when applicable
- approved root paths
- audit log path or event id

## Service Contract

The service wrapper should expose a small HTTP JSON contract before deeper SDK work:

- `GET /health`
- `GET /models`
- `GET /styles`
- `POST /estimate`
- `POST /run`
- `POST /cancel`
- `GET /runs/{runId}`
- `GET /runs/{runId}/artifacts`

Required run output:

- run id
- status
- selected style
- selected model/checkpoint metadata
- runtime node metadata
- final answer
- optional citations
- run statistics
- artifact paths
- warnings/degraded notes
- audit event ids

## Supported V0 Styles

V0 should start with one style only:

- `sequential_light`

This keeps the first integration deterministic and avoids building UI around unverified collaboration modes.

Future styles may include:

- peer debate
- expert ensemble
- verifier/challenger
- archive-review challenger
- code-review challenger
- research synthesis committee

Each style must declare:

- minimum model/checkpoint requirements
- expected hardware profile
- whether it can use scoped archive context
- whether it can produce citations
- whether it can run offline
- whether it is appropriate for sensitive user memory

## Delegation Mapping

RecursiveMAS receives work through Delegation Packets.

Good task types:

- `research`
- `design`
- `knowledge-organization`
- `archive-prep`
- `system-diagnosis`
- future code-review or verification task types when added

Default target runtime:

- `local-service`

Return artifacts:

- `summary`
- `markdown`
- `diagnostic-report`
- `verification-report`
- `archive-intake-bundle`
- `log`

RecursiveMAS should not receive broad coding tasks by default. If later used for coding, it should initially act as a reviewer/challenger rather than an unsupervised file editor.

## Augmentor Usage

Augmentor should suggest RecursiveMAS when:

- the user wants local or lower-cost reasoning before expensive model escalation
- a task benefits from multiple reasoning perspectives
- a result should be challenged by an independent local runtime
- archive ingest, strategy, or design work needs a verifier pass
- latency is acceptable and final-only output is enough

Augmentor should not use RecursiveMAS when:

- the user expects fast interactive chat
- the task needs a closed provider's current world knowledge
- the task needs direct browser interaction
- the task requires file edits or shell execution
- the task involves wallet/signing/secrets
- the add-on is degraded, unverified, or missing required models

## Living Archive Boundary

RecursiveMAS may support the Living Archive only through scoped APIs.

Allowed when granted:

- read scoped archive context
- receive selected System Architecture Memory references
- return reasoning reports to intake
- return verifier/challenger reports for review

Denied:

- direct trusted AI Memory page writes
- direct mutation of `index.md` or `log.md`
- direct source-library reorganization
- silent promotion of final answers into memory

Useful archive workflows:

- challenge an ingest-review artifact
- produce contradiction notes for semantic lint
- compare two candidate wiki page updates
- produce a low-cost first-pass synthesis that Augmentor or the ingest service later reviews

## Engineer Setup Runbook

`addon.recursive-mas` must ship an Engineer setup runbook so the Resonant Engineer can help install, configure, verify, and repair the runtime without requiring the human to perform brittle manual setup.

Initial planned runbook:

`docs/architecture/addon-runbooks/recursive-mas/ENGINEER_SETUP.md`

## Augmentor Skill

`addon.recursive-mas` must ship an Augmentor skill so Augmentor knows when and how to use recursive local reasoning without overusing it.

Initial planned skill:

`docs/architecture/addon-skills/recursive-mas/AUGMENTOR_SKILL.md`

## Add-on Manifest Shape

The first manifest should declare:

- `id = addon.recursive-mas`
- category: `agent`
- runtime: `local-service`
- service protocol: `http-json`
- status/health endpoint
- panel or background monitor surface
- provider/runtime capability
- delegation metadata for research/design/knowledge-organization/archive-prep/system-diagnosis
- archive integration as read-scoped and intake-only
- Engineer setup runbook
- Augmentor skill
- compatibility as experimental across macOS, Linux, and Windows

## Validation Requirements

V0 is not complete until deterministic checks prove:

- manifest validates through Add-on SDK V0
- status works when service is missing
- status works when a mock service is running
- model/style listing works against a mock service
- a mock recursive run returns a Delegation Packet artifact
- cancellation works against a mock long-running run
- archive intake write is blocked without grant
- direct trusted page write is impossible
- provider routing marks the runtime as experimental
- degraded state is visible in the add-on UI

Real-model validation is separate and must prove:

- a known supported checkpoint loads
- `sequential_light` completes a small deterministic reasoning task
- run artifacts are written under the approved output root
- no raw hidden-state data is written to Living Archive intake by default
- macOS, Linux, and Windows behavior is documented separately

## Consequences

- Provider Fabric needs an execution adapter for experimental local-service reasoning runtimes before RecursiveMAS can participate in routing like a provider.
- Delegation Monitor should be able to display RecursiveMAS runs as task workspaces with final artifacts and run metadata.
- Cost policy can treat RecursiveMAS as local/free after setup, but hardware, energy, latency, and model download costs should be visible.
- The add-on should start as a sideloadable/developer-local manifest until the upstream project has stable install/inference commands and ResonantOS has deterministic wrapper tests.

## Sources

- RecursiveMAS project page: `https://recursivemas.github.io/`
- RecursiveMAS repository: `https://github.com/RecursiveMAS/RecursiveMAS`
- RecursiveMAS paper: `https://arxiv.org/abs/2604.25917`
