# ADR-032: ResonantOS Compute Fabric

## Decision Metadata

- Decision status: Deferred
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Compute fabric
- Decision date: 2026-05-10
- Alpha note: The proposed Compute Fabric is not Alpha scope.

## Decision

ResonantOS will introduce a first-class **Compute Fabric** for managing local, LAN, VM, and cloud execution nodes under core operating-system policy.

The Compute Fabric is a core ResonantOS subsystem, not a ProgramBench add-on and not a general escape hatch for add-ons. Add-ons may request compute work through typed job contracts. ResonantOS owns node enrollment, trust, capability checks, network policy, secrets handling, execution, artifact collection, and audit.

ProgramBench, SWE-bench, OpenCode delegation, local model serving, CI-style test runners, browser automation workers, dataset jobs, and future long-running agent workspaces should consume the Compute Fabric instead of each implementing their own remote execution layer.

## Why

Users commonly own multiple machines or can provision Linux VMs and cloud instances. A desktop ResonantOS shell may run on macOS or Windows while useful work must execute elsewhere:

- a Linux amd64 machine for Docker benchmark images
- a GPU workstation for local inference
- an ARM Linux AI box for model serving
- a cloud VM for large builds, tests, or batch jobs
- a LAN host for private/offline workloads

The existing Provider Fabric already treats local and remote model runtimes as first-class routing targets. That is correct for inference, but it is not enough for general execution. Remote shell, containers, artifact sync, model serving, cleanroom jobs, and long-running worker services need their own policy and trust model.

Without a Compute Fabric, every heavyweight add-on would request broad `shell`, `network`, and `filesystem` grants and become its own runner manager. That would duplicate risk, weaken auditability, and make add-on permissions hard to reason about.

## Relationship To Existing ADRs

This ADR extends, but does not replace:

- `ADR-005: Provider Fabric & Routing`: inference routing remains core policy. Compute Fabric may discover and host model endpoints, but Provider Fabric decides whether those endpoints are routable for model calls.
- `ADR-006: Add-on Runtime & SDK`: add-ons remain capability-gated consumers. A compute request is not authority to execute unmanaged commands.
- `ADR-009: Rust Service IPC Boundary`: privileged compute actions are mediated by the host, not by renderer UI or add-on code.
- `ADR-015: Delegation Fabric`: delegated work should target compute jobs through structured packets and return protocols.
- `ADR-018: Add-on SDK V0`: add-on manifests declare needs; the host enforces capabilities close to resource access.
- `ADR-022: Portable User State & Secure Vault`: raw secrets remain in the vault and must not be copied into runners by default.

## Core Concepts

### Compute Node

A `ComputeNode` represents a machine or runtime endpoint capable of executing non-inference work.

Required fields:

- `id`
- `label`
- `kind`: `desktop-local`, `lan-remote`, `ssh-remote`, `cloud-vm`, `container-host`, `provider-managed`
- `trustTier`: `local-owned`, `user-owned-remote`, `organization-owned`, `ephemeral-cloud`, `untrusted`
- `enrollmentState`: `pending`, `enrolled`, `quarantined`, `revoked`
- `endpoint`
- `identityFingerprint`
- `supportedTransports`
- `roles`
- `healthState`
- `lastVerifiedAt`

Compute nodes are separate from Provider Runtime Nodes. A single physical machine may register both:

- a Compute Node for shell/container/artifact jobs
- a Provider Runtime Node for model-serving endpoints

### Node Roles

Compute nodes expose explicit roles:

- `shell-runner`
- `safe-command-runner`
- `container-runner`
- `cleanroom-runner`
- `artifact-store`
- `model-host`
- `browser-runner`
- `eval-runner`
- `service-host`

Roles are discovered and verified. They are not inferred from hostname, marketing description, or user labels.

### Capability Probe

The host can run bounded probes to discover:

- OS and architecture
- CPU and memory
- GPU, CUDA, ROCm, Metal, or accelerator availability
- Docker or Podman availability
- supported container architectures such as `linux/amd64`
- disk space and temporary workspace roots
- Python, Node, Rust, Go, and other toolchains
- model server endpoints such as OpenAI-compatible `/v1/models` or Ollama `/api/tags`
- browser automation runtimes

Passive and executable probes are separate APIs.

Passive probes must not:

- spawn subprocesses
- mutate files
- perform network scans
- start services
- pull images
- read secrets

Executable probes require explicit compute-probe authority and are audited.

### Compute Job

A `ComputeJob` is the only way add-ons and agents request execution.

Required fields:

- `id`
- `createdAt`
- `createdBy`
- `consumerId`
- `purpose`
- `jobType`
- `requiredNodeRoles`
- `constraints`
- `workspacePolicy`
- `networkPolicy`
- `filesystemPolicy`
- `secretPolicy`
- `artifactPolicy`
- `approvalPolicy`
- `costPolicy`
- `timeoutPolicy`
- `auditLogPath`

Job types include:

- `passive-probe`
- `executable-probe`
- `safe-command`
- `container-job`
- `cleanroom-container-job`
- `service-start`
- `service-stop`
- `artifact-collect`
- `model-endpoint-probe`
- `benchmark-eval`
- `delegated-agent-workspace`

### Job Constraints

Constraints are machine-readable, for example:

```json
{
  "os": ["linux"],
  "arch": ["amd64"],
  "containerRuntime": ["docker", "podman"],
  "containerPlatform": ["linux/amd64"],
  "minRamGb": 32,
  "minDiskGb": 100,
  "gpu": "optional",
  "networkModes": ["none", "allowlist"],
  "maxWallClockMinutes": 240
}
```

Add-ons may request constraints. ResonantOS selects the node.

## Capability Model

The existing broad add-on capabilities are insufficient for distributed compute. Compute Fabric must introduce narrower native tool capabilities before exposing general runner functionality.

Initial native capabilities:

- `runner.probe.passive`
- `runner.probe.executable`
- `runner.node.enroll`
- `runner.node.revoke`
- `runner.job.submit`
- `runner.job.cancel`
- `runner.job.status`
- `runner.command.safe`
- `runner.container.run`
- `runner.cleanroom.run`
- `runner.service.start`
- `runner.service.stop`
- `runner.artifact.read`
- `runner.artifact.write`
- `runner.artifact.export`
- `runner.network.egress`
- `runner.model.endpoint_probe`

Add-on manifests should keep requesting high-level capabilities such as `shell`, `network`, `filesystem`, `providers`, and `agent-delegation` until the SDK gains explicit compute capabilities. The host command layer must still enforce the narrower native tool capabilities internally.

## Trust And Enrollment

Compute nodes must be enrolled before use.

Enrollment must verify:

- node identity fingerprint
- transport security
- claimed OS and architecture
- available roles
- runner agent version
- workspace root
- audit-log support
- artifact transfer support

Accepted transport options:

- SSH with pinned host key
- local host command
- mutually authenticated HTTPS
- future signed ResonantOS runner agent protocol

Rejected defaults:

- unauthenticated HTTP runner endpoints
- trusting LAN hostnames without key pinning
- executing commands on a node just because it responded to a probe
- copying provider secrets to the node as environment variables

If a node fingerprint changes, the node moves to `quarantined` until the human re-approves it.

## Secrets Policy

Raw provider credentials, wallet secrets, SSH private keys, and vault contents must not be sent to compute nodes by default.

Compute jobs receive only:

- short-lived job IDs
- scoped artifact upload/download tokens
- explicitly approved runtime credentials
- provider route references when model calls remain host-mediated

If a job genuinely requires a secret, it must declare:

- which secret class is needed
- why it is needed
- where it will be exposed
- whether logs and artifacts can contain it
- how it is revoked after completion

The default answer for benchmark, CI, and delegated coding jobs is no raw secrets.

## Network Policy

Every job must declare a network mode:

- `none`: no outbound network
- `loopback-only`
- `lan-only`
- `allowlist`
- `internet-approved`

Network policy must be enforced by the runner where possible, not only by prompt instruction.

Cleanroom jobs use `none` or a narrow `allowlist` by default. This is required for benchmark integrity and for reproducible delegated work.

Redirects, DNS resolution, and container runtime pulls must be evaluated under the declared policy. Image pulls and dataset sync are setup jobs, not hidden side effects of cleanroom execution.

## Filesystem And Workspace Policy

Compute jobs must run in explicit workspaces.

Workspace policies include:

- `ephemeral`
- `persistent-per-project`
- `read-only-source`
- `write-artifacts-only`
- `cleanroom`

The runner must normalize paths and enforce root containment. Symlink escapes, absolute path injection, archive traversal, and artifact overwrite attacks must be treated as security bugs.

Destructive cleanup is allowed only inside host-owned ephemeral workspaces.

## Artifact Policy

Artifacts are untrusted until reviewed.

Artifact records must include:

- path
- type
- size
- hash
- producer job
- producer node
- createdAt
- retention policy
- sensitivity label

Artifact limits must cover:

- file size
- total job output size
- file count
- directory depth
- log length
- extraction size for archives

Artifacts may be written to Living Archive intake only through `archive-intake-write` boundaries. Compute output must never promote directly into trusted Living Archive knowledge pages.

## Audit And Observability

Every non-passive job writes an audit trail:

- submitted job spec
- selected node and reason
- effective capabilities
- approval state
- network mode
- workspace root
- command or container image digest
- start and end timestamps
- exit status
- log pointers
- artifact hashes
- cancellation reason

Logs must redact known secret patterns and provider credentials. Redaction is defense in depth; secrets should not be sent to runners in the first place.

## Add-on Contract

Add-ons do not own compute nodes.

Add-ons may declare:

- required node roles
- job constraints
- artifact expectations
- preferred locality
- cleanroom requirements
- cost posture
- whether human approval is required

Add-ons may not:

- register a remote command endpoint as their own private runner
- bypass Compute Fabric to run arbitrary SSH or shell commands
- receive raw provider vault secrets
- silently broaden network mode
- write compute artifacts directly into trusted memory
- mark their own job results as verified without host-visible evidence

## Provider Fabric Integration

Compute Fabric can discover and manage machines that host model servers, but Provider Fabric remains the authority for model routing.

Flow:

1. Compute Fabric enrolls or probes a node.
2. Compute Fabric discovers model endpoint candidates.
3. Provider setup probe verifies `/v1/models`, `/api/tags`, or provider-specific metadata.
4. Provider Fabric creates or updates Provider Runtime Nodes.
5. Provider Fabric decides whether a workload may use that route.

This prevents a benchmark or worker add-on from choosing unmanaged models directly.

## Delegation Fabric Integration

Delegation Packets may reference Compute Jobs, but a packet is not execution authority by itself.

The host must still check:

- target agent/add-on authority
- requested tools
- granted capabilities
- workspace scope
- approval requirements
- provider/cost policy
- compute node policy

Delegated agents receive job results and artifacts through the return protocol, not unrestricted node access.

## Example Consumers

### ProgramBench

The ProgramBench add-on requests:

- a `cleanroom-runner` with `linux/amd64` container support
- a model route selected by Provider Fabric
- artifact collection for `submission.tar.gz` and evaluation JSON
- no-internet solve jobs
- setup jobs for image/blob sync outside the cleanroom phase

The add-on never owns the remote runner.

### OpenCode Delegation

The OpenCode add-on requests:

- a scoped workspace
- a safe command or service host
- optional container execution
- artifacts for diff, logs, and verification

Shell authority stays with Compute Fabric and existing host gates.

### Local Model Machine

A machine such as a user-owned AI workstation may expose:

- `model-host` role to Compute Fabric
- Provider Runtime Node entries to Provider Fabric
- no shell/container role unless separately approved

This allows a machine to be used for inference without becoming a general execution host.

## Implementation Phases

### Phase 1: Contracts And Passive Registry

- Add core Compute Fabric types.
- Add node registry UI/state.
- Add passive node records and manual labels.
- Add passive local diagnostics.
- Add ADR-backed validation tests for job specs and node records.

### Phase 2: Local Host Runner

- Add a local runner adapter for bounded safe commands and container probes.
- Split passive and executable probes.
- Add host-owned audit logs.
- Add artifact records with hashes and limits.

### Phase 3: Remote Node Enrollment

- Add SSH or mTLS enrollment.
- Pin node identity.
- Add executable probes for enrolled nodes.
- Add job cancellation and timeout enforcement.
- Add quarantine on fingerprint drift.

### Phase 4: Container And Cleanroom Jobs

- Add container job execution.
- Add `networkMode` enforcement.
- Add image digest recording.
- Add cleanroom workspace mode.
- Add setup-vs-execution job separation.

### Phase 5: Add-on Consumption

- Let add-ons request compute jobs through host-mediated tools.
- Add ProgramBench as a proof consumer.
- Add OpenCode/CI-style consumers after policy tests pass.

## Acceptance Criteria

Compute Fabric is not ready for add-on use until deterministic tests prove:

- add-ons cannot submit jobs without required capabilities
- passive probes do not spawn processes, mutate files, or access network
- executable probes require explicit authority
- remote node fingerprint drift causes quarantine
- job specs reject unknown roles and unsafe network defaults
- cleanroom jobs run with network disabled or enforced allowlists
- secrets are not serialized into job specs, logs, or artifacts by default
- artifact paths are root-contained and symlink-safe
- artifact limits prevent unbounded output
- canceled jobs terminate their process/container tree
- host audit records include node, policy, command/image, timestamps, exit status, and artifact hashes
- Living Archive writes are intake-only
- Provider Fabric, not an add-on, selects model routes

## Consequences

Compute Fabric becomes a core operating-system surface. It increases ResonantOS power and risk at the same time.

The benefit is a reusable execution layer for many future add-ons instead of bespoke remote-control logic in each one.

The cost is that runner enrollment, job policy, artifact handling, and audit must be implemented before high-risk consumers are enabled.

The design intentionally slows down ProgramBench implementation. That is acceptable because the reusable fabric is the long-term product capability.

## Open Questions

- Should the first remote transport be SSH with pinned host keys or a dedicated ResonantOS runner daemon?
- Should cloud VMs be provisioned by ResonantOS or only registered after the user creates them?
- How much container network enforcement should be implemented directly versus delegated to Docker/Podman/firewall primitives?
- What is the minimum artifact retention policy for large benchmark and CI outputs?
- Which compute job types are allowed to run without human approval after a node is trusted?
- How should organization/team-owned nodes be shared without creating cross-user data leakage?
