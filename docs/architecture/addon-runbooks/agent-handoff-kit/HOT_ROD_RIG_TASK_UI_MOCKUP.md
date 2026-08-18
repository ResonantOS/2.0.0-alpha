# Hot Rod Rig Task UI Mockup

## Intent

This mockup proposes a dedicated task-ingestion and execution-control surface for the Agent Handoff Kit / Hot Rod Rig add-on family. It is a design artifact only. It does not grant shell, provider, wallet, public-send, schedule, or trusted memory-write authority.

Reviewable mockup:

- `docs/architecture/addon-runbooks/agent-handoff-kit/mockups/hot-rod-rig-task-control.html`

## Design Requirements

- Intake must produce the two required Z-Rig inputs: `run_config.json` and `task_description.json`.
- Mode selection must expose the one-way lattice: `MICRO -> STANDARD -> FULL`.
- The UI must show why Micro is eligible or why a run escalates.
- Execution must be orchestrator-owned. Builders, verifiers, red-team seats, and panelists are stateless lanes that return artifacts.
- Every wave must show gate status, artifact references, and ledger-backed evidence.
- Independent agent lanes must show family, role packet, bundle hash, isolation id, and output artifact state.
- Human escalation must be visible as a frozen pause state with explicit resume, retry, or abort actions. No timeout may auto-approve or auto-resume.
- Provenance must be first-class: event log counts, claim-scan status, artifact hashes, and disclosure footer preview must be visible before reporting success.
- Actions that could execute providers or shell work must remain disabled until preflight and human approval gates are satisfied.

## Proposed Screen

The mockup uses the existing browser-first workspace structure:

- Left shell navigation remains unchanged.
- The main surface is split into ingestion, execution, and evidence rails.
- The intake panel collects objective, artifact class, stakes, domain tags, target files, deterministic gates, role-packet preset, and evidence sources.
- The mode panel recommends Micro, Standard, or Full and records escalation rationale.
- The execution board shows the run state machine from draft through preflight, waves, human pause, final panel, deployment/report, and archive.
- The agent lanes make independence and cross-family diversity visible.
- The ledger rail separates runtime facts from model claims.

## Review Questions

1. Should the first production version support only Micro/Standard creation, with Full shown as review-only?
2. Should Hot Rod Rig execution live inside Agent Handoff Kit, or become a separate `addon.hot-rod-rig` manifest with Agent Handoff Kit as the documentation context?
3. Which provider families should be selectable in the first implementation, and which should be shown as unavailable until runtime adapters exist?
4. Should reports write only to Living Archive intake, or also create repo-local `docs/reviews/` artifacts when a repository target is selected?
