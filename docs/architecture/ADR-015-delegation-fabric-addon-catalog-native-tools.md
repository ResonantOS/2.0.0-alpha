# ADR-015: Delegation Fabric, Add-on Catalog, and Native Tool Fabric

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Delegation
- Decision date: Not recorded
- Alpha note: Governed delegation packets, bounded add-on handoff, and
  reviewable artifacts apply. Native desktop tool fabric does not apply.

## Decision

ResonantOS treats delegation as a first-class operating-system capability.

Augmentor is the trusted executive interface for the human. It should remain available for conversation, intent clarification, strategy, review, and continuity. Augmentor should not be the default worker. Most substantial work should be delegated to a suitable agent, add-on, runtime, deterministic script, or native tool flow.

The Resonant Engineer Agent is the trusted system repair specialist. It may perform or delegate technical recovery work, but every meaningful action must be logged and reviewable.

ResonantOS will use a structured **Delegation Packet** as the source of truth for delegated work. `TASK.md` is an interoperability artifact rendered from that packet for agents and tools that operate best from files, including OpenClaw, Codex, Claude Code, and OpenCode.

## Why

The old OpenClaw `TASK.md` pattern proved that high-quality delegation requires context, scope, constraints, verification requirements, and a clear return protocol. The weakness was that the main agent had to manually write enough context every time.

ResonantOS improves this by automatically enriching delegation from:

- System Architecture Memory
- scoped Living Archive context
- current workspace state
- provider/runtime policy
- add-on manifests and capability grants
- known user cost strategy
- prior task and artifact history

This lets worker agents operate with higher awareness while the human keeps one trusted front door: Augmentor.

## Core Roles

### Augmentor

Augmentor owns:

- human conversation
- intent interpretation
- high-level reasoning
- delegation decisions
- review of returned artifacts
- explanation back to the human
- archive intake requests for useful outputs

Augmentor should not normally:

- edit code directly
- run shell commands directly
- perform destructive filesystem actions
- write trusted Living Archive knowledge pages directly
- manage raw secrets
- disappear into long worker tasks while the human waits

### Resonant Engineer Agent

The Engineer owns:

- system diagnosis
- provider/runtime recovery
- add-on repair
- code/config inspection
- controlled technical edits
- recovery reports
- escalation back to Augmentor and the human

The Engineer may use stronger tools than Augmentor, but only through audited host services.

### Add-on Agents

Add-on agents are delegation targets, not trusted equals of Augmentor.

They may receive work only through:

- explicit capability grants
- a Delegation Packet
- a task workspace
- a declared return protocol

## Delegation Packet

The Delegation Packet is the canonical contract for a task.

Required fields:

- `id`
- `createdAt`
- `createdByAgentId`
- `targetAgentId`
- `targetRuntime`
- `taskType`
- `mission`
- `context`
- `sourceMemoryRefs`
- `systemMemoryRefs`
- `workspaceId`
- `filesInScope`
- `allowedTools`
- `forbiddenActions`
- `capabilityGrants`
- `providerPolicy`
- `costPolicy`
- `humanApprovalRequired`
- `verificationRequirements`
- `expectedArtifacts`
- `returnProtocol`
- `auditLogPath`

Rendered workspace shape:

```text
TaskWorkspace/
  delegation.packet.json
  TASK.md
  artifacts/
  logs/
  result.md
  verification.json
```

`delegation.packet.json` is the source of truth. `TASK.md` is generated and should not contain information that is absent from the packet unless explicitly marked as worker-local notes.

The v1 host implementation creates this workspace through `delegation_create_task_workspace`. This command is execution-free: it creates the files and audit scaffolding but does not dispatch an external agent.

The v1 host also exposes `delegation_read_task_workspace` and `delegation_finish_task_workspace` so the shell can start a previously created task through a trusted native agent and write the return artifacts back into the same workspace. Starting a task is intentionally separate from creating the workspace. The first implementation only supports an explicit Augmentor command to start a Resonant Engineer task; external add-on worker dispatch remains out of scope until the lifecycle manager and capability UX exist.

Start semantics:

- creation creates intent, scope, files, and audit scaffolding only
- start reads the workspace, constructs the Engineer task prompt from `delegation.packet.json` and `TASK.md`, and runs through the audited Engineer recovery loop
- finish writes `result.md`, updates `verification.json`, appends `logs/audit.jsonl`, and reports paths back to Augmentor
- failed tool events must mark verification as `needs-review`
- no worker result is promoted into code, config, or Living Archive memory without a later review/approval action

The Delegation Monitor is the supervision surface for these workspaces. It does not replace Augmentor and must not invent tasks by itself. Its job is to list host-owned task workspaces, expose paths and status in a touch-friendly way, and let the human explicitly start or review work that Augmentor already prepared. Review controls may ask Augmentor to interpret a result or create a follow-up task, but they must not silently promote worker output into code, config, or Living Archive memory.

## Delegation Quality Rules

ResonantOS must reject or require revision for delegation packets that are too vague.

Blocking conditions:

- no task type
- no target
- no mission
- mission is equivalent to "investigate and fix"
- implementation task without files or workspace scope
- code task without verification requirements
- archive task without memory boundary
- public, financial, destructive, or identity-sensitive task without approval policy
- missing return protocol
- requested capabilities not granted

Warnings:

- more than three primary files in scope for a coding task
- high-cost model requested for routine work
- no deterministic check available
- stale System Architecture Memory
- missing Living Archive context for doctrine-sensitive work

## Native Tool Fabric

Native tools are trusted ResonantOS host capabilities, not add-ons.

Initial native tool families:

- `research.search_api`
- `research.fetch_url`
- `browser.session`
- `filesystem.read`
- `filesystem.search`
- `filesystem.patch`
- `process.safe_command`
- `provider.probe`
- `provider.route_select`
- `archive.search`
- `archive.read`
- `archive.intake_write`
- `delegation.create_packet`
- `delegation.render_task_markdown`
- `delegation.dispatch`
- `delegation.monitor`
- `delegation.collect_artifacts`
- `delegation.verify_result`
- `addon.health_check`
- `addon.enable_disable`

Browser use and API research are separate tools.

Rules:

- API search/fetch is preferred for normal research because it is faster, cheaper, easier to cite, and easier to audit.
- Browser sessions are reserved for visual inspection, authenticated web apps, form workflows, UI testing, and cases where API search/fetch is insufficient.
- Raw secrets remain behind Rust host services.
- File writes and process execution require narrow scopes and audit logs.

## Native Agent Tool Posture

### Augmentor

Default allowed:

- read System Architecture Memory
- read scoped Living Archive context
- use API research
- request browser sessions
- create delegation packets
- monitor delegated tasks
- collect artifacts
- write archive intake artifacts
- request human approval

Default restricted:

- direct code edits
- shell/process execution
- privileged filesystem writes
- add-on install/remove
- wallet/signing actions

### Engineer

Default allowed:

- read System Architecture Memory
- read scoped Living Archive context
- inspect files/config/logs
- search code
- run safe diagnostics
- use API research
- use browser sessions
- probe providers/runtime nodes
- create and dispatch repair delegations
- perform targeted audited patches
- produce recovery reports

Default restricted:

- destructive actions
- broad shell execution
- public/external communication
- wallet/signing actions
- trusted Living Archive knowledge page writes

## First Add-on Catalog

### Obsidian

Runtime category:

- `embedded-module`
- optional filesystem integration

Purpose:

- manage vaults and Markdown files connected to Living Archive
- provide mature user-facing editing for tags, backlinks, and wiki navigation

Initial capabilities:

- scoped filesystem read
- scoped filesystem write only for user-approved vault roots
- archive read
- archive intake write
- UI embedding

Delegation role:

- mostly workspace/add-on surface, not autonomous worker in v1

### Browser

Runtime category:

- `embedded-module`
- native tool bridge

Purpose:

- visual/authenticated browsing
- app inspection
- web UI testing

Initial capabilities:

- network
- browser session
- screenshots
- optional scoped credential/session storage

Delegation role:

- can receive research or inspection tasks when visual/browser interaction is needed

### OpenCode

Runtime category:

- `embedded-module`
- local service

Purpose:

- open-source coding workspace/IDE
- possible local model coding path

Initial capabilities:

- scoped filesystem read/write
- terminal/process through host mediation
- provider access when granted
- UI embedding

Delegation role:

- coding task workspace
- returns diffs, changed files, tests, and risks

### Hermes

Runtime category:

- `agent-addon`
- `channel-addon`

Purpose:

- communication, coordination, message workflows

Initial capabilities:

- notifications
- scoped network/API
- channel credentials
- archive intake write for communication logs when granted

Delegation role:

- communication and coordination tasks
- should not make public/external sends without explicit approval

### OpenClaw

Runtime category:

- `agent-addon`
- local service / terminal integration

Purpose:

- external multi-agent execution runtime
- compatibility with existing OpenClaw task workflows

Initial capabilities:

- scoped filesystem
- process/service control
- provider access only through ResonantOS grants when possible
- archive intake write for returned artifacts

Delegation role:

- high-power task delegation target
- receives generated `TASK.md` plus `delegation.packet.json`
- starts degraded if OpenClaw service/config is unavailable

## Policy Engine: Mangle/Shield And LangGraph

ResonantOS should separate deterministic policy enforcement from agent workflow orchestration.

### Mangle / Shield-style deterministic policy

Best for:

- capability checks
- spawn/delegation permission
- protected paths
- destructive command blocks
- sensitive data checks
- verification claim checks
- model-cost policy checks
- repository boundary checks

This layer should remain deterministic and host-enforced. It should not depend on LLM reasoning.

### LangGraph-style workflow orchestration

LangGraph is a candidate for delegation workflow orchestration, not a replacement for Shield.

Official LangGraph docs describe it as a low-level framework/runtime for long-running stateful agents with durable execution, streaming, human-in-the-loop, memory, and subgraph-style orchestration. Its documented persistence/checkpoint model supports human-in-the-loop workflows, memory, time travel, and fault tolerance. Its interrupt model supports approval, review/edit, and tool-call interruption patterns.

Potential fit:

- durable delegation workflows
- persisted task state
- pause/resume around approvals
- multi-step task graphs
- task replay/debugging
- sub-agent/subgraph orchestration
- recovery workflows with checkpoints

Risks:

- Python runtime adds another stack beside Rust/Tauri/TypeScript
- LangSmith/LangGraph cloud ecosystem must remain optional
- raw privileged actions still need Rust mediation
- ResonantOS cannot let LangGraph bypass capability policy
- adoption should not force user data into third-party observability services

Decision:

- Do not adopt LangGraph as core immediately.
- Define the Delegation Packet and host policy contracts first.
- Build a small local proof of concept later as an optional orchestration backend.
- If adopted, LangGraph runs behind a ResonantOS service boundary and uses ResonantOS tools/capabilities rather than direct secrets/filesystem access.

References:

- LangGraph overview: https://docs.langchain.com/oss/python/langgraph/overview
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph durable execution: https://docs.langchain.com/oss/python/langgraph/durable-execution
- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts

## Implementation Sequence

1. Define `DelegationPacket`, `DelegationTarget`, `TaskWorkspace`, `ArtifactReturn`, and native tool capability types in `src/core/contracts.ts`.
2. Add a deterministic Delegation Packet validator.
3. Add a packet-to-`TASK.md` renderer.
4. Add bundled mock manifests for Obsidian, Browser, OpenCode, Hermes, and OpenClaw with delegation metadata.
5. Add a task workspace creator that writes `delegation.packet.json` and `TASK.md`.
6. Add a no-execution delegation path from Augmentor to a mock target.
7. Add artifact return and verification status types.
8. Only after the contract works, wire real add-on execution one add-on at a time.

## Consequences

- Add-ons must declare whether they can receive delegated tasks.
- Augmentor remains responsive because substantial work moves into task workspaces.
- Engineer gains structured repair delegation without bypassing audit controls.
- OpenClaw compatibility is maintained through generated `TASK.md`, but ResonantOS owns the stronger structured packet.
- LangGraph can be evaluated without making it foundational too early.

**See also:** [ADR-040: Provider Fabric Boundary for External Agent Runtimes](ADR-040-provider-fabric-boundary-external-agent-runtimes.md) — extends the delegation-fabric policy to external agent runtimes by locking credential mediation, provider-routing authority, and capability enforcement at the bridge boundary.
