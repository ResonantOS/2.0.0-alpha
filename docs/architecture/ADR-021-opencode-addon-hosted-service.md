# ADR-021: OpenCode Add-on Hosted Service

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: OpenCode add-on
- Decision date: 2026-04-28
- Alpha note: Optional bridge-mediated status and delegation routes exist.
  OpenCode is not a required Alpha runtime component.

## Decision

OpenCode is an optional ResonantOS add-on, not part of the default ResonantOS core.

ResonantOS will integrate OpenCode through a hosted local-service boundary:

- ResonantOS starts and stops `opencode web` or `opencode serve` for a scoped workspace.
- ResonantOS embeds OpenCode's own web UI when the user wants the OpenCode workspace.
- ResonantOS uses the OpenCode server/API or SDK layer for governance, status, future task dispatch, diffs, and audit.
- OpenCode does not replace Resonant Notes or the Obsidian add-on.

## Why

OpenCode already exposes a terminal UI, web UI, headless server, OpenAPI endpoint, and SDK. Rebuilding that coding interface inside ResonantOS would duplicate work and increase maintenance risk.

The safer split is:

- OpenCode owns the coding workspace UI.
- ResonantOS owns add-on lifecycle, capability grants, workspace scope, provider routing policy, task packets, and audit.

This keeps OpenCode powerful without making it a trusted core memory writer.

## Rules

- OpenCode is launched only after the `addon.opencode` manifest is installed and enabled.
- Launch requires explicit `filesystem`, `shell`, and `ui-embedding` grants.
- Launch requires a user-selected workspace path.
- The first workspace should be a disposable task folder or test vault, not a production vault.
- OpenCode may operate on Obsidian-compatible vault files only as a delegated power tool.
- Trusted Living Archive knowledge writes remain outside OpenCode and must flow through ResonantOS review/ingest.
- Future write execution must require file snapshots, Git status, or equivalent version/audit evidence.

## Interfaces

Host commands:

- `opencode_status`
- `opencode_start_service`
- `opencode_stop_service`

Runtime contract:

- `OpenCodeStatus`
- `OpenCodeServiceResult`
- `OpenCodeLaunchMode`

Manifest contract:

- `addon.opencode`
- `service.protocol = host-command`
- `service.entrypoint = opencode_start_service`
- `service.healthCommand = opencode_status`
- `service.shutdownCommand = opencode_stop_service`

## Consequences

- ResonantOS can embed OpenCode without redesigning the OpenCode UI.
- ResonantOS can still enforce add-on permissions before launch.
- The OpenCode add-on remains optional and removable.
- The integration depends on the user installing OpenCode separately.
- The web UI embedding path must be validated on macOS, Windows, and Linux before production use.

## Sources

- OpenCode Server docs: `https://opencode.ai/docs/server/`
- OpenCode Web docs: `https://opencode.ai/docs/web/`
- OpenCode SDK docs: `https://opencode.ai/docs/sdk/`
