# ADR-021: OpenCode Add-on Hosted Service

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: OpenCode add-on
- Decision date: 2026-04-28
- Alpha note: Optional bridge-mediated status and delegation routes exist.
  OpenCode is not a required Alpha runtime component.
- Revised: 2026-07-22 to define the governed live-session boundary.

Implementation status: the persisted consent, grant, workspace, runtime, and
provider-route preflight; authenticated child lifecycle; pinned SDK adapter;
session-bound bridge routes; bounded event relay; and truthful governance UI
are implemented with deterministic tests. The optional preview still requires
the live contract check and final certification described below before it may
be presented as release proof. It remains outside Alpha runtime requirements.

## Decision

OpenCode is an optional ResonantOS add-on, not part of the default ResonantOS core.

ResonantOS integrates OpenCode through a hosted local-service boundary:

- ResonantOS starts and stops a private `opencode serve --pure` child for one
  host-approved workspace.
- ResonantOS uses the pinned OpenCode SDK through an authenticated loopback
  service for session creation, prompts, permission replies, events, and stop.
- The current center surface is a ResonantOS governance and evidence view. It
  does not embed OpenCode's own web UI.
- Embedding OpenCode's web UI remains future work and requires a separate
  `ui-embedding` grant and security review.
- OpenCode does not replace Resonant Notes or the Obsidian add-on.

## Why

OpenCode already exposes a terminal UI, web UI, headless server, OpenAPI endpoint, and SDK. Rebuilding that coding interface inside ResonantOS would duplicate work and increase maintenance risk.

The safer split is:

- OpenCode owns coding execution and its native interfaces.
- ResonantOS owns add-on lifecycle, capability grants, workspace scope,
  provider routing policy, service credentials, permission presentation, task
  packets, and audit.

This keeps OpenCode powerful without making it a trusted core memory writer.

## Rules

- The bundled `addon.opencode` manifest declares the optional local-service
  surface; the host-owned settings below, not manifest presence, grant runtime
  authority.
- A live governance session requires persisted local-CLI consent, persisted
  live-session consent, and explicit `filesystem`, `shell`, and `providers`
  grants. Revoking any requirement hard-stops an active session.
- Launch requires a host-selected workspace path that resolves to the
  repository root or a descendant after symlinks are resolved.
- Request fields and one-shot execution environment flags cannot override live
  consent, grants, workspace, provider, model, command, host, or port.
- The bridge starts a new loopback child with generated Basic authentication,
  `--pure`, `shell: false`, an allowlisted environment, project configuration
  disabled, and external-directory access denied.
- Provider credentials and generated OpenCode server credentials remain in
  bridge memory and are never returned to the extension.
- OpenCode still runs as the current OS user. Workspace selection and OpenCode
  policy are governance controls, not an operating-system sandbox.
- The first workspace should be a disposable task folder or test vault, not a production vault.
- OpenCode may operate on Obsidian-compatible vault files only as a delegated power tool.
- Trusted Living Archive knowledge writes remain outside OpenCode and must flow through ResonantOS review/ingest.
- `archive-read` and `archive-intake-write` apply to governed delegation packets
  and returned artifact intake only. They are not live-session grants.
- Future write execution must require file snapshots, Git status, or equivalent version/audit evidence.

## Interfaces

Current packet and status commands:

- `opencode_status`
- `opencode_delegation_start`
- `opencode_delegation_status`
- `opencode_delegation_artifact`
- `opencode_delegation_cancel`

Implemented governed live-session bridge routes:

- `POST /opencode/session/start`
- `POST /opencode/session/prompt`
- `POST /opencode/session/permission`
- `POST /opencode/session/events`
- `POST /opencode/session/stop`

The start request is empty. Subsequent requests carry only the active
ResonantOS session identifier and operation-specific input. Responses never
contain the OpenCode base URL, Authorization header, service password, provider
credential, raw environment, or absolute workspace path.

Manifest contract:

- `addon.opencode`
- `runtimeType = local-service`
- `service.protocol = http-json`
- `service.entrypoint = browser-first/host/run-bridge-minimal.mjs`
- `service.healthCommand = /opencode/status`
- `service.shutdownCommand = /opencode/session/stop`
- the current surface is a ResonantOS `page`; it does not request or embed
  OpenCode's web UI

## Consequences

- ResonantOS can expose a focused OpenCode governance surface without
  redesigning or trusting OpenCode's full IDE.
- ResonantOS enforces add-on permissions before launch and before every
  session-bound operation.
- The OpenCode add-on remains optional and removable.
- The integration depends on the user installing OpenCode separately.
- The optional preview is not an Alpha runtime or release gate.
- A future web UI embedding path must be validated separately on macOS,
  Windows, and Linux before production use.

## Implementation Contract

The complete boundary, route, event-filtering, cleanup, and test requirements
are defined in
[Governed OpenCode Session Design](../superpowers/specs/2026-07-22-governed-opencode-session-design.md).

## Sources

- OpenCode Server docs: `https://opencode.ai/docs/server/`
- OpenCode Web docs: `https://opencode.ai/docs/web/`
- OpenCode SDK docs: `https://opencode.ai/docs/sdk/`
