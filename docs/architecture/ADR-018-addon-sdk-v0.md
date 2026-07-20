# ADR-018: Add-on SDK V0

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Applies
- Superseded by: None
- Owner: Add-on SDK
- Decision date: 2026-04-27
- Alpha note: Internal manifest, capability, provenance, and validation
  contracts apply to Alpha add-on surfaces.

## Decision

ResonantOS will maintain a first-party **Add-on SDK V0** before adding heavyweight add-ons such as the Chromium Browser engine.

The SDK is not a public marketplace SDK yet. It is the binding internal standard that all bundled, curated, and sideloaded add-ons must follow.

The SDK lives under `src/sdk/addons` and defines:

- manifest validation
- stable capability names
- runtime and service categories
- UI surface contracts
- host-mediated tool contracts
- safety rules that prevent add-ons from bypassing core authority

## Why

The Browser, Obsidian, OpenClaw, Hermes, Audio2TOL, and future community add-ons must not become one-off integrations.

Without an SDK, every add-on would invent its own install shape, permission shape, tool shape, and service boundary. That would make ResonantOS harder to secure, harder to test, and harder to extend.

The Browser add-on especially requires a real SDK boundary because AI-controlled Chromium introduces network access, UI embedding, browser automation, screenshots, downloads, and future authenticated web sessions.

## Rules

- Every add-on must have a manifest.
- Manifest loading must pass through SDK validation before the add-on is trusted by the shell.
- Add-ons request capabilities explicitly.
- Preset grant bundles may only grant capabilities already requested by the manifest.
- Add-on tools may only require capabilities already requested by the manifest.
- Add-ons may write only to permitted intake boundaries, never directly to trusted Living Archive knowledge pages.
- Archive read scopes require the `archive-read` capability.
- Archive intake write scopes require the `archive-intake-write` capability.
- Shared provider profiles require the `providers` capability.
- Embedded add-ons and `embedded-pane` surfaces require the `ui-embedding` capability.
- Shell `ui-module` panel add-ons should not request `ui-embedding` unless they expose an embedded pane.
- Local-service add-ons should declare a service entrypoint before host execution.
- Sideloaded add-ons are treated as unverified unless host verification explicitly proves otherwise.
- Runtime-specific implementation must sit behind host-mediated service or UI contracts, not direct privileged access.

## SDK V0 Contracts

### Manifest

Required fields:

- `id`
- `name`
- `version`
- `author`
- `category`
- `description`
- `runtimeType`
- `surfaces`
- `requestedCapabilities`
- `providerRequirements`
- `archiveIntegration`
- `health`
- `installHooks`
- `compatibility`

Optional V0 fields:

- `sdkVersion`
- `provenance`
- `runtimeIsolation`
- `grantPresets`
- `service`
- `tools`
- `delegation`
- `agents`
- `workflowBoundaries`
- `skills`
- `connectors`
- `scripts`
- `hooks`
- `engineerSetup`
- `augmentorSkills`
- `install`
- `audit`
- `embeddedWorkspace`
- `agentRuntime`
- `memoryAccess`
- `smokeTests`

### Workflow Scaffold Contract

Add-ons are workflow packages, not just app tiles. A manifest may explicitly describe the scaffold it adds around the agent so humans, Augmentor, the Engineer, and future marketplace reviewers can understand what is being installed.

The scaffold fields are:

- `workflowBoundaries`: the bounded job the add-on packages, its user value, owner, repeatability, and non-goals.
- `skills`: reusable operating methods, normally markdown-backed, that teach an agent how to do repeated work.
- `connectors`: access paths to external systems, MCP servers, app connectors, APIs, local runtimes, or filesystem views.
- `scripts`: deterministic checks or actions that should not rely on the LLM remembering to be careful.
- `hooks`: lifecycle or workflow events that run reviewed handlers before/after install, enablement, health checks, task completion, or archive intake.

Rules:

- Prompts are for one-off work and should not be encoded as add-on authority.
- Skills are for reusable process knowledge and do not grant authority by themselves.
- Connectors require explicit capabilities and must use host-mediated configuration scopes.
- Scripts and hooks may only require capabilities requested by the manifest.
- Scripts that mutate system state, launch services, alter filesystem content, or touch external accounts require host policy and may require human approval.
- Deterministic verification is owned by the Logician workstream. Add-ons declare the checks and hooks; Logician or host-side services execute and report them.
- Workflow boundaries must state non-goals so add-ons do not silently expand into broad, unsafe automation.

This contract is the implementation-facing expression of the prompt/skill/add-on/connector/script distinction:

- If it is done once, use a prompt.
- If it is repeated process knowledge, use a skill.
- If it packages skills, tools, connectors, UI, scripts, or hooks, use an add-on.
- If it accesses another system, declare a connector.
- If it must be verified deterministically, declare a script or hook and route execution through Logician/host policy.

### Runtime Types

Supported runtime categories:

- `ui-module`
- `embedded-module`
- `local-service`
- `agent-addon`
- `channel-addon`

### Shell Surface Navigation

Add-on surfaces may declare optional `shellNavigation` metadata when the host has a reviewed workspace route for that surface.

The field lives on a `surfaces[]` entry:

- `sectionId`: the host-owned shell section opened by the dock item.
- `dockIcon`: a reviewed icon identifier supported by the shell.
- `eyebrow`: short dock metadata shown under the label.
- `order`: optional sort order among manifest-declared add-on dock routes.
- `requiredCapabilities`: optional grants that must be present before the route appears.

Rules:

- `shellNavigation` is discovery metadata, not authority.
- The shell must only route to host-supported `sectionId` values.
- The SDK resolver must check installation and enablement before exposing a route.
- If `requiredCapabilities` is present, every listed capability must be granted before the dock route is shown.
- Add-ons that need to remain discoverable for setup should omit `requiredCapabilities` and let the workspace render a capability gate.

### Categories

Supported V0 categories:

- `agent`
- `channel`
- `memory`
- `security`
- `knowledge`
- `tool`
- `integration`
- `orchestration`

### Capabilities

Supported V0 capabilities:

- `filesystem`
- `archive-read`
- `archive-intake-write`
- `chat-interface`
- `memory-provider`
- `providers`
- `shell`
- `network`
- `ui-embedding`
- `browser-control`
- `agent-delegation`
- `notifications`
- `device-integration`

### Engineer Setup Runbook Contract

Add-ons that need installation, local service wiring, external account setup, provider/profile wiring, or repair should declare an `engineerSetup` contract in the manifest.

The setup runbook is an instruction file for the Resonant Engineer Agent. It lets the Engineer set up the add-on for the human through ResonantOS-mediated commands, while keeping authorization inside the manifest, capability grants, and host policy.

The manifest field must declare:

- `documentPath`
- `objective`
- `requiredCapabilities`
- `allowedHostCommands`
- `expectedInputs`
- `expectedOutputs`
- `requiresHumanApprovalBeforeExecution`
- `auditLogRequired`

Rules:

- `requiredCapabilities` may only reference capabilities already requested by the manifest.
- `allowedHostCommands` must list reviewed host commands, not arbitrary shell commands.
- Raw provider credentials must stay inside the ResonantOS provider vault.
- The Engineer may use provider profile references and mediated provider routes, not unmanaged secrets by default.
- The runbook is not an authorization grant; it is constrained by the same capability system as the add-on.
- Privileged setup actions require audit logging.
- Human approval is required before install, filesystem mutation, service launch, provider/profile wiring, or external account mutation unless a future signed enterprise policy explicitly grants otherwise.

Template: `docs/architecture/ADDON_ENGINEER_SETUP_RUNBOOK_TEMPLATE.md`

### Augmentor Skill Contract

Add-ons may declare `augmentorSkills` when the add-on needs a specific operating method for Augmentor, not just raw tools.

This is different from `engineerSetup`:

- `engineerSetup` tells the Resonant Engineer how to install, configure, verify, and repair the add-on.
- `augmentorSkills` tell Augmentor how to use the add-on strategically with the human.

An Augmentor skill is appropriate when an add-on requires domain workflow, human intent discovery, research, planning, approval gates, delegated execution, or artifact return.

The manifest field must declare, per skill:

- `documentPath`
- `objective`
- `requiredCapabilities`
- `requiredTools`
- `workflowPhases`
- `approvalGates`
- `expectedInputs`
- `expectedOutputs`
- `producesDelegationPackets`
- `auditLogRequired`

Rules:

- `requiredCapabilities` may only reference capabilities already requested by the manifest.
- `requiredTools` may only reference tools declared by the manifest.
- The skill may guide Augmentor's reasoning and workflow, but it does not grant extra authority.
- The skill should define where Augmentor must consult the human before implementation.
- Research-driven skills must define how evidence and sources are returned.
- Skills that create tasks must produce Delegation Packets or equivalent host-owned task contracts.
- Add-on skills should make the add-on easier to use without hiding provider cost, external-risk, archive, or approval boundaries from the human.

Template: `docs/architecture/ADDON_AUGMENTOR_SKILL_TEMPLATE.md`

### Agent Add-on Operating Contracts

The Hermes integration proved that agent add-ons need more than a surface, a tool list, and broad capability grants. They need explicit contracts for existing local installs, compatibility audit, chat output filtering, model metadata, workspace embedding, memory boundaries, and deterministic verification.

Agent add-ons may declare these additional manifest fields:

- `install`
- `audit`
- `embeddedWorkspace`
- `agentRuntime`
- `memoryAccess`
- `smokeTests`

Rules:

- Add-ons that can reuse existing local software should use `install.mode: "detect-existing-or-install"` and must set `preservesExistingUserConfig: true`.
- Host-mediated installation of external software requires `requiresHumanApprovalBeforeInstall: true`.
- Installer and audit contracts may only use capabilities requested by the manifest.
- Installer, audit, workspace, model, runtime, and smoke-test tool references must point to tools declared by the same manifest.
- Agent chat integrations should return assistant-visible reply text, not terminal banners, ANSI/TUI frames, setup logs, or session trailers.
- If an agent supports model selection, `agentRuntime.modelSelection` must declare the source of truth and required capabilities.
- Embedded dashboards should declare whether they auto-start and where settings live; workspace-first dashboards should normally use `settingsVisibility: "hidden-collapsible"`.
- Agent memory access must stay read-only for trusted Living Archive knowledge. Writes must go through intake boundaries.
- Agent add-ons should ship deterministic smoke tests that prove the installed/runtime path can answer a bounded prompt before asking the human to test manually.

Recommended baseline for a local agent add-on:

```json
{
  "install": {
    "mode": "detect-existing-or-install",
    "detectionTool": "<addon>.audit",
    "installTool": "<addon>.install",
    "requiredCapabilities": ["network", "shell"],
    "requiresHumanApprovalBeforeInstall": true,
    "preservesExistingUserConfig": true,
    "credentialSetup": "user-guided",
    "auditLogRequired": true,
    "expectedArtifacts": ["diagnostic-report", "log"]
  },
  "audit": {
    "tool": "<addon>.audit",
    "checks": ["version", "runtime", "identity", "skills", "memory", "model"],
    "requiredCapabilities": ["shell"],
    "remediationPolicy": "approval-gated",
    "auditLogRequired": true
  },
  "agentRuntime": {
    "invocationTool": "<addon>.chat",
    "chatAuthorLabel": "<Agent Name>",
    "displayNameSource": "runtime-profile",
    "supportsStreaming": false,
    "supportsCancellation": true,
    "supportsModelSelection": true,
    "outputFiltering": "assistant-reply-only",
    "requiredCapabilities": ["shell", "providers"]
  },
  "memoryAccess": {
    "archiveReadMode": "retrieval-with-citations",
    "archiveWriteMode": "intake-only",
    "citationRequired": true,
    "directKnowledgeWriteAllowed": false
  }
}
```

Template: `docs/architecture/ADDON_AGENT_CONTRACT_TEMPLATE.md`

### Service Contract

Local service add-ons may declare:

- `protocol`
- `entrypoint`
- `healthCommand`
- `shutdownCommand`

Supported V0 protocols:

- `stdio-json-rpc`
- `http-json`
- `websocket-json`
- `host-command`

### Tool Contract

Add-on tools expose host-mediated actions to Augmentor, Engineer, or delegated agents.

Each tool must declare:

- `name`
- `description`
- `requiredCapabilities`
- `inputSchema`
- `outputSchema`
- `audit`
- optional `requiresHumanApproval`

The host must verify capability grants before executing any tool.

## Consequences

- Browser development should proceed against the SDK, not as a bespoke component.
- The Browser add-on can move from embedded iframe prototype to Chromium engine without changing the shell-level add-on contract.
- Existing manifests can continue to load, but SDK validation will prevent unsafe patterns from becoming executable.
- The SDK creates a stable target for future public documentation and third-party add-on creation.
- Add-on setup becomes an Engineer-assisted flow instead of a human-only manual checklist, without giving add-ons direct privileged access.

## Experimental Tier

SDK V0 permits experimental service implementations, but the manifest contract is not experimental.

Experimental add-ons must still:

- validate successfully
- request capabilities explicitly
- run behind host mediation
- preserve auditability
- respect Living Archive write boundaries

## Implementation References

- SDK entrypoint: `src/sdk/addons/index.ts`
- Manifest validation: `src/sdk/addons/validation.ts`
- Shared core types: `src/core/contracts.ts`
- Runtime manifest loading: `src/core/runtime.ts`
