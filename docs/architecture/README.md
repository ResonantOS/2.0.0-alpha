# Architecture And ADR Index

This directory records current architecture, deferred direction, and decision
history. For the 2.0.0 Alpha runtime, begin with the
[Alpha runtime boundary](ALPHA_RUNTIME_BOUNDARY.md), then use the
[module map](MODULE_MAP.md) and [module ownership contract](MODULE-OWNERSHIP.md)
for the area being changed.

An ADR's **decision status** records what happened to the decision. Its
**Alpha applicability** records whether that decision governs the packaged
Alpha. These fields are independent: an accepted long-term decision can be
deferred or only partially applicable to Alpha.

Alpha applicability uses these values:

- **Applies**: governs shipped Alpha behavior or its required trust boundary.
- **Partial**: only the scope stated in the ADR index note applies to Alpha.
- **Deferred**: not required for Alpha; retained as accepted or proposed future
  direction.
- **Not applicable**: an alternative or historical runtime path that must not
  be used for Alpha.
- **Development only**: governs repository work, not the shipped runtime.

## Current Alpha Architecture

The only required runtime path is:

```text
Chrome Manifest V3 extension
  -> authenticated loopback Node.js bridge
  -> approved providers and local services
```

The unpacked extension and bridge are the Alpha package. ADR-037 remains the
accepted long-term browser-contained product target, but Alpha is not a custom
Chromium distribution.

### Out Of Scope

- Tauri shells and Rust/Cargo build paths
- Electron shells and native CEF hosts
- terminal workspaces and Audio2TOL

## Contributor Contracts

These retained references are implementation contracts, not Alpha runtime
components:

- [Add-on agent contract template](ADDON_AGENT_CONTRACT_TEMPLATE.md)
- [Add-on Augmentor skill template](ADDON_AUGMENTOR_SKILL_TEMPLATE.md)
- [Add-on engineer setup runbook template](ADDON_ENGINEER_SETUP_RUNBOOK_TEMPLATE.md)
- [Paperclip engineer setup](addon-runbooks/paperclip/ENGINEER_SETUP.md)
- [RecursiveMAS engineer setup](addon-runbooks/recursive-mas/ENGINEER_SETUP.md)

Add-on skill contracts:

- [Augmentor strategist conversation](addon-skills/augmentor-chat/STRATEGIST_CONVERSATION.md)
- [Hermes Augmentor skill](addon-skills/hermes/AUGMENTOR_SKILL.md)
- [Living Archive source intake](addon-skills/living-archive/SOURCE_TO_WIKI_INTAKE.md)
- [Logician verification policy](addon-skills/logician/VERIFICATION_POLICY_DESIGN.md)
- [Obsidian vault organization](addon-skills/obsidian/VAULT_ORGANIZATION_ASSIST.md)
- [OpenClaw task handoff](addon-skills/openclaw/TASK_HANDOFF.md)
- [OpenCode coding handoff](addon-skills/opencode/CODING_HANDOFF.md)
- [Paperclip Augmentor skill](addon-skills/paperclip/AUGMENTOR_SKILL.md)
- [R-Awareness context injection policy](addon-skills/r-awareness/CONTEXT_INJECTION_POLICY.md)
- [RecursiveMAS Augmentor skill](addon-skills/recursive-mas/AUGMENTOR_SKILL.md)
- [Shield security posture review](addon-skills/shield/SECURITY_POSTURE_REVIEW.md)
- [Telegram remote-channel conversation](addon-skills/telegram/REMOTE_CHANNEL_CONVERSATION.md)

## ADR Index

| ADR | Decision status | Alpha applicability | Superseded by | Owner | Alpha scope note |
| --- | --- | --- | --- | --- | --- |
| [ADR-001: Platform Stack](ADR-001-platform-stack.md) | Accepted | Partial | - | Core architecture | React, TypeScript, and capability boundaries apply; legacy desktop host choices do not. |
| [ADR-002: Modular Codebase Structure](ADR-002-modular-codebase.md) | Accepted | Applies | - | Core architecture | Domain ownership and thin composition rules apply to Alpha source. |
| [ADR-003: Engineering Standards](ADR-003-engineering-standards.md) | Accepted | Development only | - | Engineering workflow | Governs repository implementation and review. |
| [ADR-004: Strategist Chat Rail](ADR-004-chat-rail.md) | Accepted | Partial | - | Extension experience | Conversation and composer rules apply; desktop-shell rail placement does not. |
| [ADR-005: Provider Fabric & Routing](ADR-005-provider-fabric-routing.md) | Accepted | Applies | - | Provider host | Implemented through bridge-owned provider routing and approved endpoints. |
| [ADR-006: Add-on Runtime & SDK](ADR-006-addon-runtime-sdk.md) | Accepted | Applies | - | Add-on SDK | Manifest validation, provenance, capabilities, and host mediation apply. |
| [ADR-007: Living Archive Boundaries](ADR-007-living-archive-boundaries.md) | Accepted | Partial | - | Living Archive | Intake, review, and trusted-write boundaries apply; legacy desktop-host ownership does not. |
| [ADR-008: Wallet & Web3 Security](ADR-008-wallet-web3-security.md) | Accepted | Partial | - | Browser safety | Read-only detection and human-only wallet boundaries apply; wallet custody and signing are not Alpha capabilities. |
| [ADR-009](ADR-009-rust-service-ipc-boundary.md) | Accepted | Not applicable | - | Historical host boundary | This legacy privileged host/IPC decision does not define Alpha; the authenticated Node bridge owns privileged routes. |
| [ADR-010: Recovery Ladder & Engineer Promotion Flow](ADR-010-recovery-ladder.md) | Accepted | Deferred | - | Recovery | Recovery product workflow is not required for Alpha. |
| [ADR-011: Living Archive Host Service](ADR-011-living-archive-host-service.md) | Accepted | Partial | [ADR-013](ADR-013-living-archive-memory-domains.md) (library/domain portion) | Living Archive | Host mediation applies through Node bridge services; legacy desktop command details do not. |
| [ADR-012: Living Archive Approval Policy](ADR-012-living-archive-approval-policy.md) | Accepted | Applies | - | Living Archive | Tiered review and trusted promotion policy applies. |
| [ADR-013: Living Archive Memory Domains](ADR-013-living-archive-memory-domains.md) | Accepted | Applies | - | Living Archive | Memory domains, intake, source management, and explicit move approval apply. |
| [ADR-014: System Architecture Memory](ADR-014-system-architecture-memory.md) | Accepted | Deferred | - | Living Archive | Long-term system-memory direction is retained but is not an Alpha release requirement. |
| [ADR-015: Delegation Fabric, Add-on Catalog, and Native Tool Fabric](ADR-015-delegation-fabric-addon-catalog-native-tools.md) | Accepted | Partial | - | Delegation | Governed delegation packets and reviewable artifacts apply; native desktop tool fabric does not. |
| [ADR-016: Context Memory Compaction](ADR-016-context-memory-compaction.md) | Accepted | Deferred | - | Conversation memory | Full host-owned compaction pipeline is not an Alpha requirement. |
| [ADR-017: Resonant Browser Add-on And Live AI Control](ADR-017-resonant-browser-addon.md) | Superseded | Not applicable | [ADR-025](ADR-025-native-embedded-browser-host.md) | Browser architecture | Historical embedded-browser decision; Alpha browser control lives in the Chrome extension. |
| [ADR-018: Add-on SDK V0](ADR-018-addon-sdk-v0.md) | Accepted | Applies | - | Add-on SDK | Internal manifest and capability contracts apply. |
| [ADR-019: Obsidian Add-on Embedded Workspace](ADR-019-obsidian-addon-embedded-workspace.md) | Accepted | Deferred | - | Notes add-on | Hosted Obsidian-compatible workspace is future work. |
| [ADR-020: Resonant Notes Clean-Room Workspace](ADR-020-resonant-notes-clean-room-workspace.md) | Accepted | Deferred | - | Notes add-on | Clean-room notes workspace is future work. |
| [ADR-021: OpenCode Add-on Hosted Service](ADR-021-opencode-addon-hosted-service.md) | Accepted | Partial | - | OpenCode add-on | Optional bridge-mediated local-service status and delegation exist; OpenCode is not required runtime. |
| [ADR-022: Portable User State & Secure Vault Boundary](ADR-022-portable-user-state-secure-vault.md) | Accepted | Partial | - | Local state | External user-state root applies; encrypted vault persistence is deferred and provider credentials remain session-only. |
| [ADR-023: Add-on Repository And Registry Model](ADR-023-addon-repository-registry-model.md) | Accepted | Partial | - | Add-on registry | Bundled manifests and provenance apply; external registry distribution is deferred. |
| [ADR-024: Add-on Store And Commerce Model](ADR-024-addon-store-commerce.md) | Accepted | Deferred | - | Add-on store | Store and commerce are not Alpha scope. |
| [ADR-025: Native Embedded Browser Host](ADR-025-native-embedded-browser-host.md) | Superseded | Not applicable | [ADR-035](ADR-035-electron-host-rust-core-runtime.md) | Browser architecture | Historical native-host research; the decision is outside Alpha. |
| [ADR-026: Minimal Kernel And Replaceable Default Add-ons](ADR-026-minimal-kernel-replaceable-default-addons.md) | Accepted | Applies | - | Core and add-ons | Replaceable chat, memory, and add-on boundaries apply. |
| [ADR-027: Living Archive LLM Wiki Compliance](ADR-027-living-archive-llm-wiki-compliance.md) | Accepted | Applies | - | Living Archive | Source preservation, review, verification, and governed promotion apply. |
| [ADR-028: Paperclip Add-on Organizational Runtime](ADR-028-paperclip-addon-organizational-runtime.md) | Accepted | Deferred | - | Paperclip add-on | Development-only connector; not in the Alpha default catalog. |
| [ADR-029: Living Archive MCP Bridge](ADR-029-living-archive-mcp-bridge.md) | Accepted | Deferred | - | Living Archive MCP | Optional external MCP services are not required Alpha runtime. |
| [ADR-030: RecursiveMAS Runtime Node And Add-on](ADR-030-recursive-mas-runtime-addon.md) | Accepted | Deferred | - | RecursiveMAS add-on | Experimental and disabled by default. |
| [ADR-031: Agent Add-on SDK Lessons From Hermes](ADR-031-agent-addon-sdk-lessons-from-hermes.md) | Accepted | Partial | - | Agent add-on SDK | Host mediation and approval boundaries apply; optional Hermes runtime is not required. |
| [ADR-032: ResonantOS Compute Fabric](ADR-032-resonantos-compute-fabric.md) | Deferred | Deferred | - | Compute fabric | Proposed compute fabric is not Alpha scope. |
| [ADR-033: Local Model Engineering Loop](ADR-033-local-model-engineering-loop.md) | Accepted | Development only | - | Engineering workflow | Governs local-model contribution work, not the shipped runtime. |
| [ADR-034: Engineer Runner Guardrails](ADR-034-engineer-runner-guardrails.md) | Accepted | Development only | - | Engineer runner | Governs repository task verification, not the shipped runtime. |
| [ADR-035](ADR-035-electron-host-rust-core-runtime.md) | Superseded | Not applicable | [ADR-037](ADR-037-browser-first-chromium-resonantos.md) | Browser architecture | Historical desktop-host direction; its components do not ship in Alpha. |
| [ADR-036: Resonant Browser Host Architecture](ADR-036-wallet-capable-browser-host.md) | Superseded | Not applicable | [ADR-037](ADR-037-browser-first-chromium-resonantos.md) | Browser architecture | Historical external-browser sidecar direction; it is not the Alpha package. |
| [ADR-037: Browser-First Chromium ResonantOS](ADR-037-browser-first-chromium-resonantos.md) | Accepted | Partial | - | Browser architecture | Browser-contained product direction applies; Alpha is the unpacked Chrome extension plus bridge, not a custom Chromium build. |
| [ADR-038: Resonant Extension Framework](ADR-038-resonant-extension-framework.md) | Pending | Partial | - | Add-on SDK | Outline stage; extends ADR-006/018, records RESOLUTIONS_V0.1.md as the conflict-resolution input, and references the runtime hardening notes for the Phase 3.5 caller-attributed bridge work. |

## Authority Rules

- The Alpha boundary document wins for shipped components and privileged
  process flow.
- The module ownership contract wins for current source ownership.
- ADR bodies remain decision history. Their metadata and this index state how
  each decision applies now.
- Historical diagrams, audits, and research do not become current authority by
  linking to an accepted ADR.
