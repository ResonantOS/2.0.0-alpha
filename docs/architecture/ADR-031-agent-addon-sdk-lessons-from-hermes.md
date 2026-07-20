# ADR-031: Agent Add-on SDK Lessons From Hermes

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Partial
- Superseded by: None
- Owner: Agent add-on SDK
- Decision date: 2026-05-07
- Alpha note: Host mediation, compatibility checks, bounded delegation, and
  human approval boundaries apply. Hermes remains optional local service.

## Decision

ResonantOS will promote the Hermes add-on lessons into first-class Add-on SDK contracts.

Agent add-ons are not only UI panels. They are local or remote runtimes with identity, models, memory, tools, dashboards, delegated work, installation state, and human approval boundaries. The SDK must make those obligations explicit in the manifest so future agent integrations are designed, reviewed, tested, and used consistently.

## Lessons

The Hermes integration exposed these recurring failure modes:

- The add-on may need to reuse an existing local installation instead of owning a clean install directory.
- Existing local profiles may be outdated, customized, partially broken, or configured with incompatible runtimes.
- Installer behavior must preserve user identity, skills, memory, sessions, and provider configuration.
- Compatibility audit can be passive or executable. Passive audit must not run profile-local binaries, shell commands, network calls, or provider checks.
- UI gates are not security boundaries. Every host command must enforce the same capability grants declared by the manifest.
- Workspace quick actions must grant only workspace launch capabilities. Provider, archive, network, install, and write grants need separate user-visible actions.
- Local dashboards must bind to loopback unless a broader bind is explicitly approved and tested.
- User-selected profile paths are untrusted roots. Running binaries discovered inside those roots is a shell-capability operation.
- A successful terminal command is not the same as a successful chat integration; TUI banners, ANSI frames, setup logs, and resume trailers must not leak into the chat rail.
- The chat rail needs immediate user-message append, busy state, duplicate-send protection, and moving activity feedback before the agent reply returns.
- Agent identity must be visible to the human. Replies should say the add-on agent name, not the primary Augmentor name.
- Embedded dashboards should be workspace-first, auto-start when appropriate, and keep setup controls hidden unless the human opens them.
- Model metadata must be read from the actual runtime, shown accurately, and routed back into execution when the human changes the selector.
- Living Archive access must be read-only context unless an intake boundary is explicitly granted.
- Delegated work needs approval gates and reviewable artifacts, especially before public, external, financial, or identity-sensitive sends.
- Deterministic smoke tests must run before asking the human to test manually.

## SDK Additions

Agent add-ons may now declare:

- `install`: discovery, installer, approval, config preservation, credential setup, and expected artifacts.
- `audit`: compatibility checks and remediation policy.
- `embeddedWorkspace`: workspace surface, dashboard start behavior, settings visibility, health tool, and required capabilities.
- `agentRuntime`: invocation tool, visible author label, display-name source, streaming/cancel/model support, output filtering, and capabilities.
- `memoryAccess`: archive read/write modes, citation requirements, and direct knowledge-write prohibition.
- `smokeTests`: deterministic host-run tests with tool, input, expected output pattern, timeout, and required capabilities.

These fields are optional for non-agent add-ons and backward-compatible for older manifests. When present, validation enforces tool references, requested capability boundaries, Living Archive write restrictions, and installation safety.

## Implementation Rules

- `detect-existing-or-install` add-ons must preserve existing user configuration.
- External installation requires explicit human approval.
- Installation, audit, workspace, model, runtime, and smoke-test tools must be declared in `tools`.
- Contract required capabilities must be a subset of `requestedCapabilities`.
- Runtime host commands must enforce the capabilities of the manifest tool they implement.
- Status or audit tools must declare whether they are passive or executable. Executable audit requires the relevant shell/process capability.
- Workspace presets may grant only the capabilities required to open that workspace, not the complete requested capability list.
- Dashboard/service tools must default to loopback bind/probe behavior.
- Agent chat should use `outputFiltering: "assistant-reply-only"` unless the user explicitly opens a diagnostic log view.
- Direct trusted Living Archive knowledge writes remain forbidden. Intake writes are allowed only through `archive-intake-write`.
- Every agent add-on that can be invoked from chat should ship at least one deterministic smoke test.

## Consequences

Future agent add-ons should start from the Hermes contract shape rather than from a blank manifest. This gives the shell enough metadata to:

- guide installation and repair without destroying user state,
- give Augmentor operational knowledge about the add-on,
- show accurate agent identity and model state,
- run preflight checks automatically,
- keep archive access auditable,
- and produce consistent delegated work artifacts.

The SDK remains V0-compatible because these fields are additive.
