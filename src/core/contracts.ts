// Intent citation: docs/architecture/ADR-005-provider-fabric-routing.md
// Intent citation: docs/architecture/ADR-006-addon-runtime-sdk.md

export type Capability =
  | "filesystem"
  | "archive-read"
  | "archive-intake-write"
  | "chat-interface"
  | "memory-provider"
  | "providers"
  | "shell"
  | "network"
  | "ui-embedding"
  | "browser-control"
  | "agent-delegation"
  | "notifications"
  | "device-integration";

export type CapabilityScope = "none" | "self" | "workspace" | "shared" | "system" | "intake-only";
export type RevocationBehavior = "hard-stop" | "degrade" | "hide-surface";
export type AddOnRuntimeType = "ui-module" | "embedded-module" | "local-service" | "agent-addon" | "channel-addon";
export type AddOnServiceProtocol = "stdio-json-rpc" | "http-json" | "websocket-json" | "host-command";
export type AddOnSurfaceType =
  | "page"
  | "panel"
  | "rail"
  | "floating-window"
  | "embedded-pane"
  | "modal"
  | "tool-action"
  | "background-task-monitor"
  | "channel";
export type AddOnCategory =
  | "agent"
  | "channel"
  | "memory"
  | "security"
  | "knowledge"
  | "tool"
  | "integration"
  | "orchestration";
// Core (non-replaceable) shell sections. Add-on sections are registered at runtime via the add-on manifest.
export type CoreSectionId = "overview" | "strategist" | "archive" | "delegation" | "compute" | "addons" | "settings";
// Open union: autocomplete works for CoreSectionId values; add-on manifests may supply any string.
export type ShellSectionId = CoreSectionId | (string & {});
// Core dock icon provided by the shell. Add-ons supply their own icon names via their manifests.
export type CoreDockIconName = "browser";
// Open union: autocomplete works for CoreDockIconName; add-on manifests may supply any string.
export type AddOnDockIconName = CoreDockIconName | (string & {});
export type SystemSlotId = "primary-agent" | "chat-interface" | "memory-system" | "communication-channel";
export type TrustTier = "core" | "addon" | "external";
export type WorkspaceBehavior = "primary" | "delegated" | "background";
export type ChannelType = "desktop" | "telegram" | "voice" | "mobile";
export type WorkspaceKind = "main" | "delegated" | "embedded-tool";
export type WorkspaceVisibility = "user-facing" | "background";
export type ProviderType = "openai" | "anthropic" | "google" | "minimax" | "openai-compatible" | "local" | "custom";
export type AuthSource = "shared-vault" | "addon-private" | "manual";
export type AuthTier = "supported" | "experimental" | "unavailable";
export type ProviderAuthMethod = "api-key" | "subscription" | "oauth" | "local-runtime" | "custom";
export type ProviderStatus = "ready" | "fallback" | "missing";
export type RuntimeNodeKind = "cloud" | "local" | "remote-user-owned";
export type RuntimeNodeLocality = "cloud" | "desktop-local" | "lan-remote" | "wan-remote";
export type RuntimeNodeHealthState = "ready" | "degraded" | "deployable" | "unavailable";
export type ProviderExecutionAdapterId = "cloud-openai-compatible" | "cloud-minimax-compatible" | "local-ollama";
export type ProviderCostPosture = "free-local" | "subscription" | "paid-api" | "emergency-only" | "unknown";
export type RoutingResolutionReason =
  | "primary-healthy"
  | "fallback-in-policy"
  | "resurrection-available"
  | "no-viable-route";
export type WorkloadClass =
  | "primary-chat"
  | "coding"
  | "agentic-coding"
  | "routine"
  | "archive-ingest"
  | "recovery"
  | "background";
export type InstallationStatus = "available" | "installed" | "enabled" | "disabled" | "degraded" | "update-available" | "incompatible";
export type CoreServiceStatus = "ready" | "attention" | "planned";
export type ArchiveActorType = "core-agent" | "addon" | "service";
export type ArchiveAction = "archive-read" | "archive-intake-write" | "archive-knowledge-write" | "archive-ingest-request";
export type ConversationRole = "user" | "assistant";
export type ConversationMessageStatus = "complete" | "interrupted" | "failed";
export type ChatRunPhase = "idle" | "thinking" | "retrieving" | "streaming" | "tool-running" | "interrupted" | "failed" | "completed";
export type ChatRunEventPhase = Exclude<ChatRunPhase, "idle"> | "command" | "search";
export interface ChatRunEvent {
  id: string;
  runId: string;
  createdAt: string;
  phase: ChatRunEventPhase;
  label: string;
  detail?: string;
  transient: boolean;
}
export type ConversationTranscriptEventAction =
  | "thread-created"
  | "thread-branched"
  | "message-appended"
  | "message-edit-requested"
  | "message-deleted"
  | "generation-interrupted"
  | "context-compacted"
  | "context-memory-edited";
export type AddOnProvenanceTier = "bundled-core" | "curated-signed" | "enterprise-signed" | "sideloaded-unverified";
export type ManifestVerificationState = "verified" | "unverified" | "not-applicable" | "failed";
export type GrantRecommendationSource = "manifest-request" | "preset-bundle" | "manual";
export type AddOnRegistrySource = "bundled-catalog" | "curated-registry" | "sideloaded-local" | "developer-local";
export type AddOnRegistryReviewState = "unreviewed" | "reviewed" | "approved" | "blocked" | "deprecated";
export type AddOnArtifactType = "manifest" | "service-bundle" | "ui-bundle" | "release-archive" | "signature";
export type RuntimeIsolationBoundary =
  | "shell-ui"
  | "embedded-surface"
  | "host-mediated-service"
  | "host-mediated-agent"
  | "host-mediated-channel";
export type DelegationTaskType =
  | "code-change"
  | "bug-fix"
  | "research"
  | "browser-inspection"
  | "knowledge-organization"
  | "archive-prep"
  | "communication"
  | "system-diagnosis"
  | "system-repair"
  | "design"
  | "routine-work";
export type DelegationTargetRuntime =
  | "native-agent"
  | "addon-agent"
  | "embedded-workspace"
  | "local-service"
  | "terminal-service"
  | "external-agent";
export type DelegationArtifactType =
  | "summary"
  | "markdown"
  | "diff"
  | "file-list"
  | "log"
  | "citation-bundle"
  | "diagnostic-report"
  | "verification-report"
  | "archive-intake-bundle";
export type DelegationApprovalReason = "destructive" | "public-action" | "financial" | "identity-sensitive" | "broad-filesystem";
export type NativeToolCapability =
  | "research.search_api"
  | "research.fetch_url"
  | "browser.session"
  | "filesystem.read"
  | "filesystem.search"
  | "filesystem.patch"
  | "process.safe_command"
  | "provider.probe"
  | "provider.route_select"
  | "archive.search"
  | "archive.read"
  | "archive.intake_write"
  | "delegation.create_packet"
  | "delegation.render_task_markdown"
  | "delegation.dispatch"
  | "delegation.monitor"
  | "delegation.collect_artifacts"
  | "delegation.verify_result"
  | "addon.health_check"
  | "addon.enable_disable"
  | "runner.probe.passive"
  | "runner.probe.executable"
  | "runner.node.enroll"
  | "runner.node.revoke"
  | "runner.job.submit"
  | "runner.job.cancel"
  | "runner.job.status"
  | "runner.command.safe"
  | "runner.container.run"
  | "runner.cleanroom.run"
  | "runner.service.start"
  | "runner.service.stop"
  | "runner.artifact.read"
  | "runner.artifact.write"
  | "runner.artifact.export"
  | "runner.network.egress"
  | "runner.model.endpoint_probe";

export type ComputeNodeKind =
  | "desktop-local"
  | "lan-remote"
  | "ssh-remote"
  | "cloud-vm"
  | "container-host"
  | "provider-managed";
export type ComputeNodeTrustTier =
  | "local-owned"
  | "user-owned-remote"
  | "organization-owned"
  | "ephemeral-cloud"
  | "untrusted";
export type ComputeNodeEnrollmentState = "pending" | "enrolled" | "quarantined" | "revoked";
export type ComputeNodeHealthState = "ready" | "degraded" | "unavailable" | "unknown";
export type ComputeNodeTransport = "local-host-command" | "ssh" | "mtls-http" | "runner-agent";
export type ComputeNodeRole =
  | "shell-runner"
  | "safe-command-runner"
  | "container-runner"
  | "cleanroom-runner"
  | "artifact-store"
  | "model-host"
  | "browser-runner"
  | "eval-runner"
  | "service-host";
export type ComputeJobType =
  | "passive-probe"
  | "executable-probe"
  | "safe-command"
  | "container-job"
  | "cleanroom-container-job"
  | "service-start"
  | "service-stop"
  | "artifact-collect"
  | "model-endpoint-probe"
  | "benchmark-eval"
  | "delegated-agent-workspace";
export type ComputeNetworkMode = "none" | "loopback-only" | "lan-only" | "allowlist" | "internet-approved";
export type ComputeWorkspaceMode =
  | "ephemeral"
  | "persistent-per-project"
  | "read-only-source"
  | "write-artifacts-only"
  | "cleanroom";
export type ComputeArtifactSensitivity = "public" | "internal" | "sensitive" | "secret-adjacent";
export type ComputeJobStatus =
  | "queued"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface CapabilityGrant {
  capability: Capability;
  granted: boolean;
  scope: CapabilityScope;
  revocationBehavior: RevocationBehavior;
}

export interface AddOnSurface {
  id: string;
  type: AddOnSurfaceType;
  label: string;
  description: string;
  shellNavigation?: {
    sectionId: ShellSectionId;
    dockIcon: AddOnDockIconName;
    eyebrow: string;
    order?: number;
    requiredCapabilities?: Capability[];
  };
}

export interface AddOnGrantPreset {
  id: string;
  label: string;
  description: string;
  grants: CapabilityGrant[];
}

export interface AddOnProvenance {
  tier: AddOnProvenanceTier;
  verificationState: ManifestVerificationState;
  signed: boolean;
  signer?: string;
  signatureRef?: string;
}

export interface AddOnRuntimeIsolation {
  boundary: RuntimeIsolationBoundary;
  supportsDegradedMode: boolean;
  requiresReviewedGrant: boolean;
}

export interface AddOnDelegationContract {
  acceptsTasks: boolean;
  taskTypes: DelegationTaskType[];
  artifactReturnTypes: DelegationArtifactType[];
  defaultTargetRuntime: DelegationTargetRuntime;
  requiresHumanApprovalBeforeExecution: boolean;
  notes?: string[];
}

export interface AddOnToolDefinition {
  name: string;
  description: string;
  requiredCapabilities: Capability[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  audit: {
    logRequest: boolean;
    logResult: boolean;
    artifactTypes: DelegationArtifactType[];
  };
  requiresHumanApproval?: boolean;
}

export interface AddOnLocalServiceDefinition {
  protocol: AddOnServiceProtocol;
  entrypoint: string;
  visibleEntrypoint?: string;
  healthCommand?: string;
  shutdownCommand?: string;
}

export interface AddOnEngineerSetupRunbook {
  documentPath: string;
  objective: string;
  requiredCapabilities: Capability[];
  allowedHostCommands: string[];
  expectedInputs: string[];
  expectedOutputs: string[];
  requiresHumanApprovalBeforeExecution: boolean;
  auditLogRequired: boolean;
}

export interface AddOnAugmentorSkill {
  documentPath: string;
  objective: string;
  requiredCapabilities: Capability[];
  requiredTools: string[];
  workflowPhases: string[];
  approvalGates: string[];
  expectedInputs: string[];
  expectedOutputs: string[];
  producesDelegationPackets: boolean;
  auditLogRequired: boolean;
}

export type AddOnWorkflowRepeatability = "one-off" | "repeatable" | "workflow-package";
export type AddOnWorkflowOwner = "human" | "augmentor" | "engineer" | "addon-agent" | "external-system";
export type AddOnConnectorType = "mcp-server" | "app-connector" | "api" | "local-runtime" | "filesystem";
export type AddOnConnectorConfigScope = "host-vault" | "addon-private" | "user-config" | "none";
export type AddOnScriptRunPolicy = "manual" | "preflight" | "postflight" | "scheduled" | "on-demand";
export type AddOnHookEvent =
  | "before-install"
  | "after-install"
  | "before-enable"
  | "after-enable"
  | "before-disable"
  | "health-check"
  | "before-task-complete"
  | "before-archive-ingest"
  | "after-archive-intake";
export type AddOnHookFailurePolicy = "block" | "degrade" | "warn";
export type AddOnSkillInvocation = "manual" | "agent-suggested" | "automatic";

export interface AddOnWorkflowBoundary {
  id: string;
  label: string;
  jobToBeDone: string;
  userValue: string;
  repeatability: AddOnWorkflowRepeatability;
  owner: AddOnWorkflowOwner;
  nonGoals: string[];
}

export interface AddOnSkillDefinition {
  id: string;
  name: string;
  description: string;
  documentPath: string;
  invocation: AddOnSkillInvocation;
  requiredCapabilities: Capability[];
  requiredTools?: string[];
}

export interface AddOnConnectorDefinition {
  id: string;
  name: string;
  type: AddOnConnectorType;
  description: string;
  requiredCapabilities: Capability[];
  configScope: AddOnConnectorConfigScope;
}

export interface AddOnScriptDefinition {
  id: string;
  name: string;
  description: string;
  commandRef: string;
  runPolicy: AddOnScriptRunPolicy;
  deterministic: boolean;
  requiredCapabilities: Capability[];
  producesArtifacts: DelegationArtifactType[];
  requiresHumanApproval: boolean;
}

export interface AddOnHookDefinition {
  id: string;
  event: AddOnHookEvent;
  handlerRef: string;
  requiredCapabilities: Capability[];
  failurePolicy: AddOnHookFailurePolicy;
}

export type LogicianExecutionStatus = "passed" | "failed" | "blocked" | "degraded" | "unsupported";
export type LogicianExecutionKind = "script" | "hook";
export type EvidenceTrustTier = "observed" | "host-reported" | "self-reported" | "transcript-claim" | "unknown";
export type VerifyAgentStatus = "pass" | "warn" | "fail";
export type VerifyAgentFindingSeverity = "low" | "medium" | "high";

export interface LogicianEvidenceItem {
  id: string;
  label: string;
  kind: "manifest" | "installation" | "capability" | "runtime" | "artifact" | "hook" | "policy" | "event";
  trustTier: EvidenceTrustTier;
  source: string;
  detail?: string;
}

export interface VerifyAgentFinding {
  code: string;
  severity: VerifyAgentFindingSeverity;
  message: string;
  evidenceRefs: string[];
}

export interface VerifyAgentReport {
  schemaVersion: "verify-agent-report/vnext-1";
  status: VerifyAgentStatus;
  nextAction: string;
  evidenceTrustCounts: Record<EvidenceTrustTier, number>;
  evidence: LogicianEvidenceItem[];
  findings: VerifyAgentFinding[];
}

export interface LogicianExecutionArtifact {
  id: string;
  addonId: string;
  kind: LogicianExecutionKind;
  targetId: string;
  label: string;
  commandRef: string;
  status: LogicianExecutionStatus;
  summary: string;
  detail: string;
  requiredCapabilities: Capability[];
  missingCapabilities: Capability[];
  producedArtifacts: DelegationArtifactType[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  evidence: Record<string, unknown>;
  verifyAgentReport?: VerifyAgentReport;
}

export type AddOnInstallMode = "detect-existing-only" | "detect-existing-or-install" | "bundled" | "manual";
export type AddOnCredentialSetupMode = "none" | "user-guided" | "host-vault" | "external";
export type AddOnAuditRemediationPolicy = "suggest-only" | "approval-gated" | "automatic-safe";
export type AddOnEmbeddedWorkspaceMode = "hosted-dashboard" | "native-panel" | "terminal" | "browser";
export type AddOnSettingsVisibility = "hidden-collapsible" | "visible" | "separate-panel";
export type AddOnModelMetadataSource = "runtime-audit" | "provider-profile" | "manifest-default" | "user-config";
export type AddOnOutputFilteringMode = "assistant-reply-only" | "structured-events" | "raw-log";

export interface AddOnInstallContract {
  mode: AddOnInstallMode;
  detectionTool?: string;
  installTool?: string;
  repairTool?: string;
  requiredCapabilities: Capability[];
  requiresHumanApprovalBeforeInstall: boolean;
  preservesExistingUserConfig: boolean;
  credentialSetup: AddOnCredentialSetupMode;
  auditLogRequired: boolean;
  expectedArtifacts: DelegationArtifactType[];
}

export interface AddOnAuditContract {
  tool: string;
  checks: string[];
  requiredCapabilities: Capability[];
  remediationPolicy: AddOnAuditRemediationPolicy;
  auditLogRequired: boolean;
}

export interface AddOnEmbeddedWorkspaceContract {
  surfaceId: string;
  mode: AddOnEmbeddedWorkspaceMode;
  autoStart: boolean;
  settingsVisibility: AddOnSettingsVisibility;
  healthTool?: string;
  requiredCapabilities: Capability[];
}

export interface AddOnModelSelectionContract {
  source: AddOnModelMetadataSource;
  currentModelField: string;
  selectable: boolean;
  changeTool?: string;
  requiredCapabilities: Capability[];
  fallbackPolicy?: string;
}

export interface AddOnMemoryAccessContract {
  archiveReadMode: "none" | "read-only-context" | "retrieval-with-citations";
  archiveWriteMode: "none" | "intake-only";
  citationRequired: boolean;
  directKnowledgeWriteAllowed: false;
}

export interface AddOnAgentRuntimeContract {
  invocationTool: string;
  chatAuthorLabel: string;
  displayNameSource: "manifest" | "runtime-profile";
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  supportsModelSelection: boolean;
  modelSelection?: AddOnModelSelectionContract;
  outputFiltering: AddOnOutputFilteringMode;
  requiredCapabilities: Capability[];
}

export interface AddOnDeterministicSmokeTest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  expectedOutputPattern: string;
  timeoutMs: number;
  requiredCapabilities: Capability[];
}

export interface AddOnManifest {
  sdkVersion?: string;
  id: string;
  name: string;
  version: string;
  author: string;
  category: AddOnCategory;
  description: string;
  runtimeType: AddOnRuntimeType;
  surfaces: AddOnSurface[];
  requestedCapabilities: CapabilityGrant[];
  provenance?: AddOnProvenance;
  grantPresets?: AddOnGrantPreset[];
  runtimeIsolation?: AddOnRuntimeIsolation;
  providerRequirements: {
    sharedProfiles: string[];
    supportsPrivateCredentials: boolean;
    recommendedPrimaryModel?: string;
    recommendedFallbackModel?: string;
    preferredRuntimeKinds?: RuntimeNodeKind[];
    allowExperimentalAuth?: boolean;
    fallbackPolicyId?: string;
  };
  systemSlots?: Array<{
    id: SystemSlotId;
    role: "default-provider" | "alternative-provider" | "supporting-provider";
    replaceable: boolean;
    requiredForFirstRun?: boolean;
    recommended?: boolean;
  }>;
  archiveIntegration: {
    readScopes: string[];
    intakeWriteScopes: string[];
    canRequestIngest: boolean;
    canWriteKnowledgePages: boolean;
  };
  health: {
    strategy: string;
    endpoint?: string;
  };
  service?: AddOnLocalServiceDefinition;
  tools?: AddOnToolDefinition[];
  delegation?: AddOnDelegationContract;
  installHooks: {
    onInstall?: string;
    onEnable?: string;
    onUpgrade?: string;
  };
  workflowBoundaries?: AddOnWorkflowBoundary[];
  skills?: AddOnSkillDefinition[];
  connectors?: AddOnConnectorDefinition[];
  scripts?: AddOnScriptDefinition[];
  hooks?: AddOnHookDefinition[];
  engineerSetup?: AddOnEngineerSetupRunbook;
  augmentorSkills?: AddOnAugmentorSkill[];
  install?: AddOnInstallContract;
  audit?: AddOnAuditContract;
  embeddedWorkspace?: AddOnEmbeddedWorkspaceContract;
  agentRuntime?: AddOnAgentRuntimeContract;
  memoryAccess?: AddOnMemoryAccessContract;
  smokeTests?: AddOnDeterministicSmokeTest[];
  compatibility: {
    shellVersion: string;
    platforms: string[];
  };
  agents?: Array<{
    id: string;
    displayName: string;
    trustTier: Exclude<TrustTier, "core">;
    workspaceBehavior: WorkspaceBehavior;
  }>;
}

export interface AddOnArtifactReference {
  type: AddOnArtifactType;
  label: string;
  url?: string;
  path?: string;
  sha256?: string;
  signatureRef?: string;
}

export interface AddOnRegistryEntry {
  addonId: string;
  name: string;
  version: string;
  author: string;
  category: AddOnCategory;
  description: string;
  runtimeType: AddOnRuntimeType;
  registrySource: AddOnRegistrySource;
  provenanceTier: AddOnProvenanceTier;
  verificationState: ManifestVerificationState;
  reviewState: AddOnRegistryReviewState;
  manifestRef: AddOnArtifactReference;
  releaseArtifact?: AddOnArtifactReference;
  sourceRepositoryUrl?: string;
  compatibility: AddOnManifest["compatibility"];
  requestedCapabilities: CapabilityGrant[];
  recommendedGrantPresetIds: string[];
  installState: InstallationStatus;
  installed: boolean;
  enabled: boolean;
  notes: string[];
}

export interface ProviderProfile {
  id: string;
  label: string;
  providerType: ProviderType;
  authSource: AuthSource;
  authMethod: ProviderAuthMethod;
  authTier: AuthTier;
  apiBaseUrl?: string;
  allowedModels: string[];
  primaryModel: string;
  fallbackModel?: string;
  modelContext?: ProviderModelContextPolicy[];
  consumerScopes: string[];
  shared: boolean;
  status: ProviderStatus;
  credentialStatus: "configured" | "missing";
}

export interface ProviderModelContextPolicy {
  model: string;
  maxContextTokens: number;
  tokenEstimateMethod: "provider-metadata" | "local-tokenizer" | "heuristic";
  reservedOutputTokens?: number;
  reservedReasoningTokens?: number;
  reservedSystemTokens?: number;
  reservedRetrievalTokens?: number;
  source: "provider-default" | "runtime-node" | "user-config";
}

export interface ProviderRuntimeDiagnostic {
  runtimeNodeId: string;
  runtimeNodeLabel: string;
  runtimeKind: RuntimeNodeKind;
  locality: RuntimeNodeLocality;
  probeState: "healthy" | "attention" | "unavailable" | "unprobeable";
  detail: string;
}

export interface ProviderDiagnosticReport {
  providerId: string;
  providerLabel: string;
  providerType: ProviderType;
  authMethod: ProviderAuthMethod;
  authTier: AuthTier;
  executionAdapter: ProviderExecutionAdapterId | "unsupported";
  credentialConfigured: boolean;
  status: "healthy" | "attention" | "offline";
  summary: string;
  checkedAt: string;
  primaryModel: string;
  fallbackModel?: string;
  runtimeDiagnostics: ProviderRuntimeDiagnostic[];
}

export interface ProviderSmokeTestResult {
  providerId: string;
  model: string;
  ok: boolean;
  replyPreview: string;
  usage?: ProviderUsageTelemetry;
  checkedAt: string;
  summary: string;
}

export interface ProviderSetupProbeResult {
  providerId: string;
  ok: boolean;
  setupState: "routable-now" | "adapter-pending" | "unavailable";
  discoveredModels: string[];
  recommendedPrimaryModel?: string;
  recommendedFallbackModel?: string;
  endpoint: string;
  checkedAt: string;
  summary: string;
  detail: string;
  source: "native-template" | "openai-compatible-models" | "ollama-tags" | "http-probe" | "unsupported-adapter";
}

export interface TelegramServiceStatus {
  running: boolean;
  tokenConfigured: boolean;
  channelId: string;
  lastError?: string;
  lastUpdateId?: number;
  startedAt?: string;
}

export interface HermesAuditFinding {
  id: string;
  severity: "ready" | "info" | "warning" | "blocked";
  title: string;
  detail: string;
  suggestion: string;
}

export interface HermesGatewayStatus {
  present: boolean;
  running: boolean;
  pid?: number;
  state?: string;
  channels: string[];
  updatedAt?: string;
  detail: string;
}

export interface HermesInventory {
  skillsCount: number;
  memoriesCount: number;
  sessionsCount: number;
  kbPresent: boolean;
  kbIndexPresent: boolean;
  stateDbPresent: boolean;
  stateDbOk: boolean;
  identityPresent: boolean;
  envPresent: boolean;
  configPresent: boolean;
  channelDirectoryPresent: boolean;
}

export interface HermesInstallStatus {
  detected: boolean;
  home: string;
  command?: string;
  version?: string;
  agentSourcePath?: string;
  agentGitBranch?: string;
  agentGitCommit?: string;
  agentGitDirty: boolean;
  gateway: HermesGatewayStatus;
  inventory: HermesInventory;
  findings: HermesAuditFinding[];
  compatibility: "ready" | "degraded" | "blocked";
  currentModel?: string;
  availableModels: string[];
  checkedAt: string;
}

export interface HermesInstallResult {
  success: boolean;
  profileHome: string;
  command: string;
  log: string;
  status: HermesInstallStatus;
}

export interface HermesChatResult {
  reply: string;
  command: string;
  profileHome: string;
  model?: string;
}

export interface HermesDashboardStatus {
  running: boolean;
  url: string;
  dashboardProxyUrl?: string;
  host: string;
  port: number;
  detail: string;
  rawStatus: string;
}

export interface HermesProfileSummary {
  name: string;
  model: string;
  gateway: string;
  alias: string;
  current: boolean;
}

export interface HermesCuratorStatus {
  enabled: boolean;
  interval?: string;
  staleAfter?: string;
  archiveAfter?: string;
  rawStatus: string;
}

export interface HermesKanbanTask {
  id: string;
  title: string;
  status: string;
  assignee?: string;
}

export interface HermesKanbanSnapshot {
  counts: [string, number][];
  tasks: HermesKanbanTask[];
  assigneesRaw: string;
  rawStats: string;
}

export interface HermesWorkspaceSnapshot {
  install: HermesInstallStatus;
  dashboard: HermesDashboardStatus;
  profiles: HermesProfileSummary[];
  curator: HermesCuratorStatus;
  kanban: HermesKanbanSnapshot;
  slashgoalCommand: string;
  archivistRecommendation: string;
}

export interface ProviderRuntimeNode {
  id: string;
  label: string;
  providerProfileId: string;
  kind: RuntimeNodeKind;
  locality: RuntimeNodeLocality;
  endpoint?: string;
  supportedModels: string[];
  authTier: AuthTier;
  healthState: RuntimeNodeHealthState;
  deployableOnDemand: boolean;
  notes?: string[];
}

export interface ProviderRoutingPolicyInput {
  consumerId: string;
  allowedProviderProfileIds?: string[];
  preferredProviderProfileIds?: string[];
  preferredRuntimeNodeIds?: string[];
  preferredModels?: string[];
  allowedRuntimeKinds?: RuntimeNodeKind[];
  allowedAdapterIds?: ProviderExecutionAdapterId[];
  preferredLocalities?: RuntimeNodeLocality[];
  allowedAuthTiers?: AuthTier[];
  requiredCapabilities?: string[];
  allowExperimentalAuth?: boolean;
  allowResurrection?: boolean;
  fallbackPolicyId?: string;
}

export interface ProviderFallbackPolicy {
  id: string;
  label: string;
  orderedProviderProfileIds: string[];
  orderedRuntimeNodeIds?: string[];
  allowExperimentalAuth: boolean;
  allowResurrection: boolean;
  onFailure: "hard-stop" | "degrade";
}

export interface ProviderRecoveryAction {
  id: string;
  label: string;
  trigger: "panic-button" | "automatic";
  targetAgentIds: string[];
  runtimeNodeId: string;
  prepared: boolean;
  note: string;
}

export interface ProviderExecutionAdapterPolicy {
  id: ProviderExecutionAdapterId;
  label: string;
  supportedProviderTypes: ProviderType[];
  supportedRuntimeKinds: RuntimeNodeKind[];
  supportedAuthMethods: ProviderAuthMethod[];
  supportsReasoningEffort: boolean;
  supportsStreaming: boolean;
  supportsAbort: boolean;
  requiresCredential: boolean;
  experimental: boolean;
  notes: string[];
}

export interface ProviderRoutingDecision {
  providerProfileId?: string;
  runtimeNodeId?: string;
  executionAdapterId?: ProviderExecutionAdapterId;
  model?: string;
  authTier: AuthTier;
  usingFallback: boolean;
  resolutionReason: RoutingResolutionReason;
  fallbackPolicyId?: string;
  recoveryActionId?: string;
}

export interface ProviderRoutingState {
  policyEngineId: string;
  executionAdapters: ProviderExecutionAdapterPolicy[];
  fallbackPolicies: ProviderFallbackPolicy[];
  recoveryActions: ProviderRecoveryAction[];
  experimentalPolicy: {
    allowOptIn: boolean;
    note: string;
  };
}

export interface ComputeNodeProbeSummary {
  os?: string;
  arch?: string;
  cpuCores?: number;
  ramGb?: number;
  gpu?: string[];
  containerRuntimes?: string[];
  containerPlatforms?: string[];
  toolchains?: string[];
  modelEndpoints?: string[];
  checkedAt?: string;
}

export interface ComputeNode {
  id: string;
  label: string;
  kind: ComputeNodeKind;
  trustTier: ComputeNodeTrustTier;
  enrollmentState: ComputeNodeEnrollmentState;
  endpoint?: string;
  identityFingerprint?: string;
  supportedTransports: ComputeNodeTransport[];
  roles: ComputeNodeRole[];
  healthState: ComputeNodeHealthState;
  lastVerifiedAt?: string;
  probe?: ComputeNodeProbeSummary;
  notes?: string[];
}

export interface ComputeJobConstraints {
  os?: string[];
  arch?: string[];
  containerRuntime?: string[];
  containerPlatform?: string[];
  minRamGb?: number;
  minDiskGb?: number;
  gpu?: "required" | "optional" | "none";
  networkModes?: ComputeNetworkMode[];
  maxWallClockMinutes?: number;
}

export interface ComputeNetworkPolicy {
  mode: ComputeNetworkMode;
  allowlist?: string[];
  reason: string;
}

export interface ComputeWorkspacePolicy {
  mode: ComputeWorkspaceMode;
  rootPath?: string;
  projectId?: string;
  cleanup: "delete-on-success" | "delete-on-failure" | "retain-for-review" | "manual";
}

export interface ComputeFilesystemPolicy {
  readRoots: string[];
  writeRoots: string[];
  allowSymlinks: boolean;
  allowArchiveExtraction: boolean;
}

export interface ComputeSecretPolicy {
  allowRawSecrets: boolean;
  approvedSecretRefs: string[];
  exposure: "none" | "env" | "file" | "stdin" | "runtime-mediated";
  redactionRequired: boolean;
}

export interface ComputeArtifactPolicy {
  expectedTypes: DelegationArtifactType[];
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFileCount: number;
  retention: "ephemeral" | "review" | "project" | "manual";
  archiveIntakeAllowed: boolean;
}

export interface ComputeApprovalPolicy {
  humanApprovalRequired: boolean;
  approvalReasons: DelegationApprovalReason[];
  approvedBy?: string;
  approvedAt?: string;
}

export interface ComputeTimeoutPolicy {
  queueTimeoutSeconds: number;
  executionTimeoutSeconds: number;
  cancellationGraceSeconds: number;
}

export interface ComputeCommandSpec {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface ComputeContainerSpec {
  image: string;
  imageDigest?: string;
  command?: string[];
  env?: Record<string, string>;
  mounts?: Array<{
    source: string;
    target: string;
    mode: "ro" | "rw";
  }>;
}

export interface ComputeJob {
  id: string;
  createdAt: string;
  createdBy: string;
  consumerId: string;
  purpose: string;
  jobType: ComputeJobType;
  requiredNodeRoles: ComputeNodeRole[];
  constraints: ComputeJobConstraints;
  targetNodeId?: string;
  workspacePolicy: ComputeWorkspacePolicy;
  networkPolicy: ComputeNetworkPolicy;
  filesystemPolicy: ComputeFilesystemPolicy;
  secretPolicy: ComputeSecretPolicy;
  artifactPolicy: ComputeArtifactPolicy;
  approvalPolicy: ComputeApprovalPolicy;
  costPolicy: DelegationCostPolicy;
  timeoutPolicy: ComputeTimeoutPolicy;
  auditLogPath: string;
  command?: ComputeCommandSpec;
  container?: ComputeContainerSpec;
  status: ComputeJobStatus;
}

export interface ComputeArtifactRecord {
  id: string;
  jobId: string;
  nodeId: string;
  path: string;
  type: DelegationArtifactType;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  retention: ComputeArtifactPolicy["retention"];
  sensitivity: ComputeArtifactSensitivity;
}

export interface ComputePassiveDiagnosticsResult {
  nodeId: string;
  os: string;
  arch: string;
  family: string;
  executableSuffix: string;
  checkedAt: string;
  summary: string;
}

export interface ComputeSafeCommandRequest {
  nodeId: string;
  command: string[];
  jobId?: string;
}

export interface ComputeSafeCommandResult {
  nodeId: string;
  jobId?: string;
  command: string[];
  status: "succeeded" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  summary: string;
}

export interface ComputeRemoteProbeRequest {
  nodeId: "compute-gx10" | "compute-nas-backup";
}

export interface ComputeRemoteProbeResult {
  nodeId: string;
  status: "succeeded" | "failed";
  host: string;
  stdout: string;
  stderr: string;
  checkedAt: string;
  summary: string;
}

export interface Gx10LlamaStatusResult {
  nodeId: "compute-gx10";
  status: "succeeded" | "failed";
  stdout: string;
  stderr: string;
  checkedAt: string;
  models: Array<{
    id: string;
    port: number;
    health: "ok" | "failed" | "unknown";
    processRunning: boolean;
  }>;
  summary: string;
}

export interface Gx10LlamaSwitchRequest {
  modelId: "Qwen3.6-35B-A3B-Q4_K_M.gguf" | "Qwen3.6-27B-Q4_K_M.gguf";
}

export interface Gx10LlamaSwitchResult {
  nodeId: "compute-gx10";
  status: "succeeded" | "failed";
  modelId: string;
  port: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  summary: string;
}

export interface NasBackupStatusResult {
  nodeId: "compute-nas-backup";
  status: "succeeded" | "failed";
  stdout: string;
  stderr: string;
  checkedAt: string;
  backupRoot: string;
  summary: string;
}

export interface ComputeAuditRecord {
  id: string;
  jobId: string;
  nodeId?: string;
  createdAt: string;
  event:
    | "submitted"
    | "selected-node"
    | "enrolled"
    | "quarantined"
    | "revoked"
    | "approved"
    | "started"
    | "completed"
    | "failed"
    | "cancelled"
    | "artifact-recorded";
  detail: string;
  metadata: Record<string, unknown>;
}

export interface ComputeFabricState {
  policyEngineId: string;
  nodes: ComputeNode[];
  jobs: ComputeJob[];
  artifacts: ComputeArtifactRecord[];
  audit: ComputeAuditRecord[];
}

export interface StrategyRouteReference {
  providerProfileId: string;
  runtimeNodeId?: string;
  model: string;
  costPosture?: ProviderCostPosture;
  note?: string;
}

export interface StrategyFallbackChain {
  id: string;
  label: string;
  rule: string;
  orderedRoutes: StrategyRouteReference[];
  lastResortRoute?: StrategyRouteReference;
}

export interface WorkloadStrategy {
  id: string;
  label: string;
  workloadClass: WorkloadClass;
  ownerType: "agent" | "workload";
  ownerId: string;
  primaryRoute: StrategyRouteReference;
  fallbackChainId: string;
  hardStopWhenNoFallback: boolean;
  notes: string[];
}

export interface ModelStrategyState {
  profileId: string;
  label: string;
  summary: string;
  workloadStrategies: WorkloadStrategy[];
  fallbackChains: StrategyFallbackChain[];
  emergencyPolicy: {
    preferBestAvailable: boolean;
    orderedPromotionTargets: StrategyRouteReference[];
    hardFloorRoute: StrategyRouteReference;
    note: string;
  };
}

export interface LocalRuntimeStatus {
  available: boolean;
  targetModel: string;
  recoveryModelInstalled: boolean;
  recoveryModelRunning: boolean;
  installedModels: string[];
  runningModels: string[];
  ollamaListRaw: string;
  ollamaPsRaw: string;
}

export interface ArchiveIngestProbeResult {
  sourceLabel: string;
  summary: string;
  checkedAt: string;
}

export interface ArchivePathMapping {
  path: string;
  role: string;
  subtype?: string;
  absolutePath: string;
  exists: boolean;
  managedByAi: boolean;
  immutable: boolean;
  renameAllowed: boolean;
  moveAllowed: boolean;
}

export interface ArchiveSourceRoot {
  role: string;
  subtype?: string;
  path: string;
  exists: boolean;
}

export interface ArchiveIngestAgentStatus {
  enabled: boolean;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  configFile: string;
  promptFile: string;
  configExists: boolean;
  promptExists: boolean;
}

export interface ArchiveStats {
  pagesTotal: number;
  pagesByType: Record<string, number>;
  linksTotal: number;
  sourcesTotal: number;
  sourcesUnprocessed: number;
  activity7d: number;
}

export interface ArchiveActivityEntry {
  ts: string;
  action: string;
  pageId?: string;
  sourceId?: string;
  agentId?: string;
  details?: Record<string, unknown>;
  errors?: string;
}

export interface ArchiveRuntimeStatus {
  status: "ready" | "attention" | "missing";
  mode: string;
  portableUserState: {
    rootPath: string;
    manifestPath: string;
    memoryRoot: string;
    configRoot: string;
    secretsRoot: string;
    walletsRoot: string;
    logsRoot: string;
    backupsRoot: string;
    source: string;
    initialized: boolean;
  };
  configPath: string;
  vaultRoot: string;
  managedRoot: string;
  wikiRoot: string;
  dataRoot: string;
  logsRoot: string;
  configRoot: string;
  mappingFile: string;
  intakeRoot: string;
  reviewQueueRoot: string;
  mappings: ArchivePathMapping[];
  sourceRoots: ArchiveSourceRoot[];
  ingestAgent: ArchiveIngestAgentStatus;
  stats?: ArchiveStats;
  recentActivity: ArchiveActivityEntry[];
}

export interface ArchiveSearchPageHit {
  pageId: string;
  title: string;
  pageType: string;
  filePath: string;
  stage?: string;
  updated?: string;
  score: number;
  snippet: string;
}

export interface ArchiveSearchSourceHit {
  sourceId: string;
  title: string;
  sourceType: string;
  rawPath: string;
  processed: boolean;
}

export interface ArchiveSearchResult {
  query: string;
  pages: ArchiveSearchPageHit[];
  sources: ArchiveSearchSourceHit[];
}

export type ArchiveSourceWatchStatus = "new" | "changed" | "unchanged";

export interface ArchiveSourceWatchRecord {
  path: string;
  absolutePath: string;
  rootRole: string;
  rootSubtype?: string;
  sourceType: string;
  title: string;
  hash: string;
  previousHash?: string;
  sizeBytes: number;
  modifiedAt: string;
  status: ArchiveSourceWatchStatus;
  indexedInDb: boolean;
}

export interface ArchiveSourceFolderScanResult {
  scannedAt: string;
  rootsScanned: number;
  filesSeen: number;
  newFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  skippedFiles: number;
  records: ArchiveSourceWatchRecord[];
  indexPath: string;
}

export type ArchiveMemoryDomain = "mixed-library" | "human-knowledge" | "external-knowledge" | "ai-memory";
export type ArchiveLibraryImportMode = "copy" | "move" | "reference";

export interface ArchiveLibraryImportSourceRecord {
  sourceId: string;
  versionId: string;
  originalPath: string;
  canonicalPath: string;
  sourceType: string;
  title: string;
  hash: string;
  sizeBytes: number;
}

export interface ArchiveLibraryPreflightCount {
  label: string;
  count: number;
  sizeBytes: number;
}

export interface ArchiveLibraryPreflightSample {
  path: string;
  reason: string;
}

export interface ArchiveLibraryPreflightWarning {
  severity: "attention" | "warning" | "error" | string;
  title: string;
  detail: string;
}

export interface ArchiveLibraryRecommendedImportPlan {
  summary: string;
  recommendedAction: string;
  autoExcludedTopFolders: string[];
  ambiguousTopFolders: string[];
  includedTopFolders: string[];
  approvalNote: string;
}

export interface ArchiveLibraryPreflightResult {
  sourcePath: string;
  exists: boolean;
  isDirectory: boolean;
  obsidianVaultDetected: boolean;
  supportedFiles: number;
  skippedFiles: number;
  hiddenEntriesSkipped: number;
  generatedArchiveEntriesSkipped: number;
  estimatedImportBytes: number;
  estimatedManagedStorageBytes: number;
  supportedByExtension: ArchiveLibraryPreflightCount[];
  skippedByExtension: ArchiveLibraryPreflightCount[];
  supportedByTopFolder: ArchiveLibraryPreflightCount[];
  skippedByTopFolder: ArchiveLibraryPreflightCount[];
  warnings: ArchiveLibraryPreflightWarning[];
  samples: ArchiveLibraryPreflightSample[];
  recommendedPlan: ArchiveLibraryRecommendedImportPlan;
}

export type ArchiveClassificationTarget = "human-knowledge" | "external-knowledge" | "unclear";

export interface ArchiveClassificationProposal {
  sourceId: string;
  title: string;
  canonicalPath: string;
  proposedTarget: ArchiveClassificationTarget;
  confidence: "low" | "medium" | "high";
  reason: string;
  tags: string[];
  wikilinks: string[];
}

export interface ArchiveLibraryImportResult {
  importedAt: string;
  domain: ArchiveMemoryDomain;
  importMode: ArchiveLibraryImportMode;
  libraryId: string;
  libraryName: string;
  originalPath: string;
  canonicalRoot: string;
  filesSeen: number;
  filesImported: number;
  skippedFiles: number;
  manifestPath: string;
  versionLedgerPath: string;
  classificationManifestPath?: string;
  classificationStatus: string;
  metadataStandard: string;
  obsidianVaultDetected: boolean;
  recommendedAddon?: string;
  records: ArchiveLibraryImportSourceRecord[];
  classificationProposals: ArchiveClassificationProposal[];
}

export interface ArchiveImportedLibrarySummary {
  importedAt: string;
  domain: ArchiveMemoryDomain | string;
  importMode: ArchiveLibraryImportMode | string;
  libraryId: string;
  libraryName: string;
  originalPath: string;
  canonicalRoot: string;
  filesSeen: number;
  filesImported: number;
  skippedFiles: number;
  manifestPath: string;
  versionLedgerPath?: string;
  classificationManifestPath?: string;
  classificationStatus: string;
  metadataStandard: string;
  obsidianVaultDetected: boolean;
  recommendedAddon?: string;
  recordsCount: number;
}

export interface ArchiveQueueImportedLibraryResult {
  manifestPath: string;
  libraryName: string;
  recordsSeen: number;
  queued: number;
  skippedExistingQueue: number;
  skippedProcessed: number;
  skippedUnsupported: number;
  skippedMissing: number;
  requestFiles: string[];
}

export interface ArchiveLibraryClassificationReview {
  artifactType: string;
  createdAt: string;
  actorId: string;
  libraryId: string;
  libraryName: string;
  originalPath: string;
  canonicalRoot: string;
  classificationStatus: string;
  metadataStandard: string;
  structuralChangesAllowed: boolean;
  requiresHumanApprovalBeforeMove: boolean;
  recordsTotal: number;
  proposalsPreviewed: number;
  remainingForFullReview: number;
  proposals: ArchiveClassificationProposal[];
  manifestPath: string;
}

export interface ArchiveLibraryReorganisationMove {
  sourceId: string;
  title: string;
  proposedTarget: ArchiveClassificationTarget;
  sourcePath: string;
  destinationPath?: string;
  action: "propose-move-after-approval" | "tag-only-review" | string;
  confidence: "low" | "medium" | "high";
  reason: string;
}

export interface ArchiveLibraryReorganisationPlan {
  plannedAt: string;
  actorId: string;
  libraryId: string;
  libraryName: string;
  planPath: string;
  rollbackPlanPath: string;
  auditLogPath: string;
  requiresApproval: boolean;
  structuralChangesAllowed: boolean;
  movesPlanned: number;
  tagOnlyCount: number;
  blockedCount: number;
  entries: ArchiveLibraryReorganisationMove[];
}

export interface ArchiveSystemMemorySource {
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  required: boolean;
  hash?: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ArchiveSystemMemoryPage {
  pageId: string;
  title: string;
  filePath: string;
  sourceCount: number;
  hash: string;
}

export interface ArchiveSystemMemoryStatus {
  status: "missing" | "blocked" | "stale" | "ready" | string;
  generatedAt?: string;
  manifestPath: string;
  pagesRoot: string;
  sources: ArchiveSystemMemorySource[];
  pages: ArchiveSystemMemoryPage[];
  staleSources: string[];
  missingSources: string[];
}

export interface ArchiveSystemMemoryRefreshResult {
  refreshedAt: string;
  manifestPath: string;
  pagesRoot: string;
  pagesWritten: ArchiveSystemMemoryPage[];
  sourcesIndexed: number;
  missingSources: string[];
}

export interface ArchiveDocumentPayload {
  path: string;
  title?: string;
  docType?: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface ArchiveIntakeWriteResult {
  actorId: string;
  bucket: string;
  artifactPath: string;
  metadataPath?: string;
}

export interface ArchiveIngestRequestResult {
  requestFile: string;
  queuedAt: string;
}

export interface ArchiveQueuedIngestRequest {
  requestFile: string;
  queuedAt: string;
  actorId: string;
  sourcePath: string;
  sourceType: string;
  sourceRole?: string;
  intent: string;
  sourceExists: boolean;
}

export type ArchiveApprovalTier = "auto-approve" | "strategist-review" | "human-review";
export type ArchiveReviewDecisionStatus = "pending" | "approved" | "rejected" | "escalated";
export type ArchiveReviewDecisionAction = "approve" | "reject" | "escalate";
export type ArchiveReviewConfidence = "low" | "medium" | "high";
export type ArchiveDoctrineSensitivity = "low" | "medium" | "high";

export interface ArchiveReviewDecision {
  status: ArchiveReviewDecisionStatus;
  action?: ArchiveReviewDecisionAction;
  actorId?: string;
  decidedAt?: string;
  tierApplied?: ArchiveApprovalTier;
  notes?: string;
}

export interface ArchiveReviewPromotion {
  status: "promoted" | "no-op" | string;
  actorId?: string;
  promotedAt?: string;
  pagesWritten: number;
  pagesSkipped: number;
}

export interface ArchiveReviewArtifact {
  artifactFile: string;
  checkedAt: string;
  requestFile: string;
  sourcePath: string;
  sourceType: string;
  sourceRole?: string;
  intent: string;
  providerId: string;
  model: string;
  summary: string;
  confidence: ArchiveReviewConfidence;
  doctrineSensitivity: ArchiveDoctrineSensitivity;
  recommendedTier: ArchiveApprovalTier;
  recommendationReason: string;
  proposedPages: Array<Record<string, unknown>>;
  decision: ArchiveReviewDecision;
  promotion?: ArchiveReviewPromotion;
}

export interface ArchiveProcessIngestResult {
  requestFile: string;
  archivedRequestFile: string;
  reviewArtifactFile: string;
  summary: string;
  checkedAt: string;
  reviewArtifact: ArchiveReviewArtifact;
}

export interface ArchiveMaintenanceCycleResult {
  startedAt: string;
  finishedAt: string;
  processed: ArchiveProcessIngestResult[];
  repaired: ArchiveReviewDecisionResult[];
  promoted: ArchivePromoteReviewArtifactResult[];
  navigation: ArchiveWikiNavigationRefreshResult;
  lint: ArchiveLintResult;
  skipped: string[];
  errors: string[];
}

export interface ArchiveBackgroundCycleResult {
  startedAt: string;
  finishedAt: string;
  scan: ArchiveSourceFolderScanResult;
  queuedRequestFiles: string[];
  skippedQueueSources: string[];
  maintenance: ArchiveMaintenanceCycleResult;
}

export interface ArchiveAiMemoryBuildResult {
  jobId: string;
  jobFile: string;
  status: "running" | "needs-review" | "needs-human-review" | "ready-to-promote" | "attention" | "complete" | string;
  libraryName: string;
  manifestPath: string;
  recordsSeen: number;
  queuedThisRun: number;
  skippedExistingQueue: number;
  skippedProcessed: number;
  skippedUnsupported: number;
  skippedMissing: number;
  processedThisRun: number;
  promotedThisRun: number;
  queueRemaining: number;
  reviewPending: number;
  reviewApproved: number;
  reviewEscalated: number;
  reviewRejected: number;
  errors: string[];
  nextAction: string;
  maintenance: ArchiveMaintenanceCycleResult;
}

export interface ArchiveAiMemoryBuildJobSummary {
  jobId: string;
  jobFile: string;
  status: "running" | "needs-review" | "needs-human-review" | "ready-to-promote" | "attention" | "complete" | string;
  libraryName: string;
  manifestPath: string;
  startedAt: string;
  finishedAt?: string;
  recordsSeen: number;
  queuedThisRun: number;
  processedThisRun: number;
  promotedThisRun: number;
  queueRemaining: number;
  reviewPending: number;
  reviewApproved: number;
  reviewEscalated: number;
  reviewRejected: number;
  errors: string[];
  nextAction: string;
}

export interface ArchiveWikiNavigationRefreshResult {
  refreshedAt: string;
  indexPath: string;
  logPath: string;
  pagesIndexed: number;
  activityEntries: number;
}

export interface ArchiveLintFinding {
  severity: "info" | "warning" | "critical" | string;
  category:
    | "orphan-page"
    | "missing-wikilinks"
    | "stale-page"
    | "unprocessed-source"
    | "duplicate-title"
    | "contradiction-candidate"
    | "index-mismatch"
    | string;
  target: string;
  detail: string;
  recommendedAction: string;
}

export interface ArchiveLintResult {
  checkedAt: string;
  reportPath: string;
  pagesChecked: number;
  sourcesChecked: number;
  findings: ArchiveLintFinding[];
}

export interface ArchiveSemanticLintFinding {
  severity: "info" | "warning" | "critical" | string;
  targetPages: string[];
  claim: string;
  conflictingEvidence: string;
  confidence: ArchiveReviewConfidence | string;
  recommendedAction: string;
  requiresHumanReview: boolean;
}

export interface ArchiveSemanticLintResult {
  checkedAt: string;
  reportPath: string;
  providerId: string;
  model: string;
  sourceLintReportPath: string;
  candidatesReviewed: number;
  findings: ArchiveSemanticLintFinding[];
  summary: string;
  repairRequestFiles: string[];
}

export interface ArchiveReviewDecisionResult {
  artifactFile: string;
  status: ArchiveReviewDecisionStatus;
  action: ArchiveReviewDecisionAction;
  actorId: string;
  decidedAt: string;
  tierApplied: ArchiveApprovalTier;
  summary: string;
}

export interface ArchivePromotedPage {
  pageType: "summary" | "entity" | "concept" | "synthesis";
  pageId: string;
  title: string;
  filePath: string;
  action: "created" | "updated";
  backupPath?: string;
  sourceId: string;
  indexed: boolean;
  mergeMode: "create-page" | "append-provenance-section";
}

export interface ArchiveSkippedPage {
  title: string;
  reason: string;
}

export interface ArchivePromoteReviewArtifactResult {
  artifactFile: string;
  promotedAt: string;
  actorId: string;
  pagesWritten: ArchivePromotedPage[];
  skippedPages: ArchiveSkippedPage[];
}

export interface ArchiveTolBundleCandidate {
  sessionId: string;
  rawAudioPath?: string;
  transcriptPath?: string;
  analysisPath?: string;
  date?: string;
  time?: string;
  summary?: string;
  status: string;
  strategicActionsCount: number;
  explicitDirectivesCount: number;
}

export interface ArchiveTolBundleBuildResult {
  sessionId: string;
  intakeArtifactPath: string;
  requestFile: string;
  queuedAt: string;
  rawAudioPath?: string;
  transcriptPath: string;
  analysisPath: string;
}

export type EngineerToolEventStatus = "completed" | "failed";

export interface EngineerToolEvent {
  tool: string;
  summary: string;
  status: EngineerToolEventStatus;
}

export interface EngineerRecoveryTurnResult {
  reply: string;
  toolEvents: EngineerToolEvent[];
}

export interface RecoveryRouteCandidate {
  id: string;
  providerId: string;
  providerLabel: string;
  runtimeNodeId: string;
  runtimeNodeLabel: string;
  runtimeKind: RuntimeNodeKind;
  model: string;
  credentialConfigured: boolean;
  reachable: boolean;
  promotable: boolean;
  recommended: boolean;
  reason: string;
}

export interface AgentDefinition {
  id: string;
  displayName: string;
  trustTier: TrustTier;
  workspaceBehavior: WorkspaceBehavior;
  providerProfileId: string;
  fallbackProviderProfileId?: string;
  archiveReadScopes: string[];
  archiveIntakeWriteScopes: string[];
  canWriteKnowledgePages: boolean;
  channelIds: string[];
}

export interface ChannelDefinition {
  id: string;
  type: ChannelType;
  label: string;
  owningAgentId: string;
  strategistIdentityId: string;
  enabled: boolean;
  sessionMode: "shared-identity" | "isolated-session";
  workspaceId: string;
  metadata: Record<string, string>;
}

export interface WorkspaceDefinition {
  id: string;
  kind: WorkspaceKind;
  owningEntityId: string;
  title: string;
  visibility: WorkspaceVisibility;
  sharedArtifacts: boolean;
  surfaces: string[];
  channelIds: string[];
}

export interface DelegationTarget {
  id: string;
  label: string;
  runtime: DelegationTargetRuntime;
  addonId?: string;
  agentId?: string;
  acceptedTaskTypes: DelegationTaskType[];
  supportedArtifactTypes: DelegationArtifactType[];
  requiredCapabilities: Array<Capability | NativeToolCapability>;
  defaultRequiresHumanApproval: boolean;
}

export interface DelegationReturnProtocol {
  summaryRequired: boolean;
  artifactTypes: DelegationArtifactType[];
  mustReportFilesChanged: boolean;
  mustReportCommandsRun: boolean;
  mustReportResidualRisks: boolean;
  mustReportVerification: boolean;
}

export interface DelegationVerificationRequirement {
  id: string;
  label: string;
  method: "unit-test" | "build" | "lint" | "manual-review" | "source-citation" | "runtime-check" | "none";
  required: boolean;
}

export interface DelegationCostPolicy {
  sensitivity: "low" | "medium" | "high";
  preferredCostTier: "free-local" | "subscription" | "paid-api" | "best-available";
  allowPaidEscalation: boolean;
  rationale: string;
}

export interface DelegationProviderPolicy {
  preferredProviderProfileIds: string[];
  preferredRuntimeNodeIds: string[];
  preferredModels: string[];
  allowedRuntimeKinds: RuntimeNodeKind[];
  fallbackPolicyId?: string;
}

export interface DelegationPacket {
  id: string;
  createdAt: string;
  createdByAgentId: string;
  targetAgentId: string;
  targetRuntime: DelegationTargetRuntime;
  taskType: DelegationTaskType;
  mission: string;
  context: string;
  sourceMemoryRefs: string[];
  systemMemoryRefs: string[];
  workspaceId: string;
  filesInScope: string[];
  allowedTools: NativeToolCapability[];
  forbiddenActions: string[];
  capabilityGrants: CapabilityGrant[];
  providerPolicy: DelegationProviderPolicy;
  costPolicy: DelegationCostPolicy;
  humanApprovalRequired: boolean;
  approvalReasons: DelegationApprovalReason[];
  verificationRequirements: DelegationVerificationRequirement[];
  expectedArtifacts: DelegationArtifactType[];
  returnProtocol: DelegationReturnProtocol;
  auditLogPath: string;
}

export interface TaskWorkspace {
  id: string;
  packetId: string;
  rootPath: string;
  packetPath: string;
  taskMarkdownPath: string;
  artifactsPath: string;
  logsPath: string;
  resultPath: string;
  verificationPath: string;
}

export interface TaskWorkspacePayload {
  workspace: TaskWorkspace;
  packet: DelegationPacket;
  taskMarkdown: string;
  resultMarkdown: string;
  verification: Record<string, unknown>;
}

export interface FinishTaskWorkspaceResult {
  workspace: TaskWorkspace;
  resultPath: string;
  verificationPath: string;
  auditPath: string;
}

export interface ExecuteOpenCodeTaskResult extends FinishTaskWorkspaceResult {
  action: string;
  targetPath: string;
  verified: boolean;
  existedBefore: boolean;
  createdByThisRun: boolean;
}

export type GoalWorkspacePhase = "proposed" | "active" | "waiting" | "delegated" | "blocked" | "completed" | "archived";
export type GoalPhase = GoalWorkspacePhase;
export type GoalStepStatus = "planned" | "active" | "blocked" | "completed" | "cancelled";
export type GoalArtifactKind = DelegationArtifactType | "goal-note" | "browser-evidence" | "memory-intake" | "status-report";
export type GoalMemoryRefKind = "system-memory" | "living-archive" | "source" | "conversation" | "external";
export type GoalMemoryRefScope = "read-only" | "intake" | "artifact";

export interface GoalCostPolicy extends DelegationCostPolicy {
  maxEstimatedSpend?: number;
  currency?: string;
}

export interface GoalMemoryRef {
  id: string;
  ref: string;
  kind: GoalMemoryRefKind;
  label: string;
  scope: GoalMemoryRefScope;
  addedAt: string;
}

export interface GoalArtifact {
  id: string;
  type: GoalArtifactKind;
  label: string;
  createdAt: string;
  path?: string;
  summary?: string;
  source?: "human" | "augmentor" | "delegated-agent" | "host-tool";
}

export interface GoalBlocker {
  id: string;
  label: string;
  createdAt: string;
  severity?: "low" | "medium" | "high";
  resolutionHint?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface GoalDelegationRef {
  workspaceId: string;
  packetId: string;
  targetAgentId: string;
  createdAt: string;
  status?: "created" | "approved" | "dispatched" | "running" | "returned" | "verified" | "rejected" | "completed";
  summary?: string;
}

export interface GoalStep {
  id: string;
  label: string;
  status: GoalStepStatus;
  createdAt: string;
  updatedAt: string;
  ownerAgentId?: string;
  delegationWorkspaceId?: string;
  completedAt?: string;
  notes?: string;
}

export interface GoalWorkspace {
  id: string;
  title: string;
  mission: string;
  phase: GoalWorkspacePhase;
  createdAt: string;
  updatedAt: string;
  owningAgentId: string;
  threadId: string;
  successCriteria: string[];
  constraints: string[];
  deadline?: string;
  allowedAgents: string[];
  allowedTools: string[];
  memoryRefs: GoalMemoryRef[];
  costPolicy: GoalCostPolicy;
  steps?: GoalStep[];
  artifacts: GoalArtifact[];
  blockers: GoalBlocker[];
  delegationRefs: GoalDelegationRef[];
  completedAt?: string;
  archivedAt?: string;
  resumedAt?: string;
  statusSummary?: string;
}

export interface ArtifactReturn {
  packetId: string;
  targetAgentId: string;
  returnedAt: string;
  summary: string;
  artifacts: Array<{
    type: DelegationArtifactType;
    path?: string;
    content?: string;
  }>;
  filesChanged: string[];
  commandsRun: string[];
  verification: Array<{
    requirementId: string;
    status: "passed" | "failed" | "not-run";
    evidence: string;
  }>;
  residualRisks: string[];
}

export interface DelegationValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface DelegationValidationResult {
  valid: boolean;
  issues: DelegationValidationIssue[];
}

export interface CoreService {
  id: string;
  label: string;
  status: CoreServiceStatus;
  owner: string;
  description: string;
}

export interface ArchiveActorPolicy {
  actorId: string;
  actorType: ArchiveActorType;
  readScopes: string[];
  intakeWriteScopes: string[];
  canWriteKnowledgePages: boolean;
  canRequestIngest: boolean;
}

export interface ArchivePolicy {
  strategistIdentityId: string;
  ingestServiceId: string;
  intakeRoots: string[];
  knowledgeRoots: string[];
  reviewQueueRoot: string;
  approvalPolicy: {
    defaultTier: ArchiveApprovalTier;
    autoApproveIntents: string[];
    humanReviewSourceTypes: string[];
    humanReviewPageTypes: string[];
    notes: string[];
  };
  actorPolicies: ArchiveActorPolicy[];
  notes: string[];
}

export type ArchiveAiMemoryAutomationCostPolicy = "off" | "local-and-subscription" | "any-configured-route";

export interface ArchiveAutomationPolicy {
  autoSyncEnabled: boolean;
  aiMemoryBuilds: ArchiveAiMemoryAutomationCostPolicy;
  updatedAt?: string;
}

export interface AddOnInstallation {
  addonId: string;
  source: "bundled" | "sideload";
  provenanceTier: AddOnProvenanceTier;
  verificationState: ManifestVerificationState;
  installed: boolean;
  enabled: boolean;
  status: InstallationStatus;
  grantedCapabilities: CapabilityGrant[];
  recommendedGrantPresetIds: string[];
  grantRecommendationSource?: GrantRecommendationSource;
  privateProviderProfileIds: string[];
  config?: Record<string, unknown>;
  notes: string[];
  verificationArtifacts?: LogicianExecutionArtifact[];
}

export interface ObsidianVaultStatus {
  vaultPath: string;
  exists: boolean;
  isDirectory: boolean;
  obsidianConfigDetected: boolean;
  markdownFiles: number;
  warnings: string[];
}

export interface ObsidianNoteSummary {
  title: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface ObsidianNotePayload {
  title: string;
  relativePath: string;
  content: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface ObsidianOpenNoteResult {
  openedUrl: string;
  absolutePath: string;
  notePath: string;
}

export interface ObsidianWriteNoteResult {
  notePath: string;
  title: string;
  sizeBytes: number;
  previousModifiedAt?: string;
  modifiedAt?: string;
  versionPath: string;
  auditPath: string;
}

export interface ObsidianNoteOperationResult {
  operation: "create-note" | "create-folder" | "move-note" | "archive-note";
  notePath?: string;
  previousNotePath?: string;
  folderPath?: string;
  archivedPath?: string;
  title?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  versionPath?: string;
  auditPath: string;
}

export interface ObsidianBacklink {
  sourcePath: string;
  sourceTitle: string;
}

export interface ObsidianIndexedNote {
  title: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt?: string;
  tags: string[];
  wikilinks: string[];
  backlinks: ObsidianBacklink[];
  excerpt: string;
}

export interface ObsidianVaultIndex {
  vaultPath: string;
  noteCount: number;
  query?: string;
  notes: ObsidianIndexedNote[];
}

export interface BrowserAuditEvent {
  action: string;
  detail: string;
  timestamp: string;
}

export interface BrowserOpenUrlResult {
  sessionId: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  status: string;
  engine: string;
  screenshotDataUrl: string;
  audit: BrowserAuditEvent[];
}

export interface BrowserViewportInput {
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface BrowserEngineStatus {
  installed: boolean;
  enginePath?: string;
  installHint: string;
}

export interface BrowserEngineInstallResult {
  installed: boolean;
  enginePath?: string;
  log: string;
}

export interface BrowserPageLink {
  text: string;
  href: string;
}

export interface BrowserReadPageResult {
  sessionId: string;
  finalUrl: string;
  title: string;
  text: string;
  links: BrowserPageLink[];
  audit: BrowserAuditEvent[];
}

export interface BrowserInteractionResult {
  sessionId: string;
  finalUrl: string;
  title: string;
  screenshotDataUrl: string;
  audit: BrowserAuditEvent[];
}

export interface BrowserCloseSessionResult {
  sessionId: string;
  closed: boolean;
  audit: BrowserAuditEvent[];
}

export interface BrowserHostAuditEvent {
  at: string;
  event: string;
  sessionId: string | null;
  details: Record<string, unknown>;
}

export interface BrowserHostHealthResult {
  ready: boolean;
  sessionId: string | null;
  engine: "chromium";
  headless?: boolean;
  url: string | null;
  title?: string | null;
  menuLabels?: string[];
  extensionSupport?: "local-unpacked" | "none";
  audit: BrowserHostAuditEvent[];
}

export interface BrowserHostOpenUrlResult {
  sessionId: string;
  finalUrl: string;
  title: string;
  status: number | null;
  audit: BrowserHostAuditEvent[];
}

export interface BrowserHostReadPageResult {
  sessionId: string;
  finalUrl: string;
  title: string;
  text: string;
  links: BrowserPageLink[];
  audit: BrowserHostAuditEvent[];
}

export interface BrowserHostActionResult {
  sessionId: string;
  finalUrl: string;
  title: string;
  audit: BrowserHostAuditEvent[];
}

export interface BrowserHostEvidenceResult {
  sessionId: string;
  evidenceRef: string;
  audit: BrowserHostAuditEvent[];
}

export interface BrowserExtensionState {
  extensionId: string;
  name: string;
  version: string;
  installed: boolean;
  pinned: boolean;
  enabled: boolean;
  source: "chrome-web-store" | "local-unpacked" | "resonantos-registry";
  requestedCapabilities: string[];
  compatibilityState?: "supported" | "degraded" | "unsupported";
  compatibilityNotes?: string[];
}

export interface BrowserExtensionListResult {
  sessionId: string | null;
  extensions: BrowserExtensionState[];
  audit: BrowserHostAuditEvent[];
}

export interface BrowserToolCommand {
  type:
    | "start"
    | "open_url"
    | "read_page"
    | "click"
    | "type"
    | "capture_evidence"
    | "close"
    | "health"
    | "extensions_list"
    | "extensions_set_pinned"
    | "extensions_disable"
    | "wallet_host_health"
    | "wallet_host_start"
    | "wallet_host_open_url"
    | "wallet_host_read_page"
    | "wallet_host_inspect_dapp_gate"
    | "wallet_host_list_tabs";
  params?: Record<string, unknown>;
  humanApproved?: boolean;
}

export interface BrowserWorkspaceTabState {
  id: string;
  label: string;
  url: string;
  history: string[];
  historyIndex: number;
}

export interface BrowserControlledSessionState {
  sessionId: string | null;
  status: "idle" | "starting" | "ready" | "error";
  url: string | null;
  title: string | null;
  error: string | null;
  lastSyncedAt: string | null;
}

export interface BrowserWorkspaceState {
  activeTabId: string;
  tabs: BrowserWorkspaceTabState[];
  controlledSession: BrowserControlledSessionState;
}

export type OpenCodeLaunchMode = "web" | "serve";

export interface OpenCodeStatus {
  installed: boolean;
  version?: string | null;
  binaryPath?: string | null;
  installHint: string;
  installCommand?: string | null;
  alternativeInstallCommands?: string[];
  configureCommand?: string | null;
  searchedCommands?: string[];
  searchedPaths?: string[];
  searchedPathCount?: number;
  searchedPathOmitted?: number;
  overrideConfigured?: boolean;
  overridePath?: string | null;
  overrideFound?: boolean;
  supportsWebUi: boolean;
  supportsServerApi: boolean;
}

export interface OpenCodeServiceResult {
  sessionId: string;
  workspacePath: string;
  mode: OpenCodeLaunchMode;
  apiBaseUrl: string;
  webUrl: string;
  command: string;
  pid?: number | null;
  alreadyRunning: boolean;
  trustKernelRunDir?: string | null;
  trustKernelPacketPath?: string | null;
  trustKernelBriefPath?: string | null;
  trustKernelWarning?: string | null;
}

export interface OpenCodeInjectPromptResult {
  sessionId: string;
  opencodeSessionId?: string | null;
  workspacePath: string;
  apiBaseUrl: string;
  webUrl?: string | null;
  promptLength: number;
  cleared: boolean;
  submitted: boolean;
}

export interface TrustKernelAdvisory {
  runDir?: string | null;
  packetPath?: string | null;
  briefPath?: string | null;
  warning?: string | null;
}

export interface PaperclipStatus {
  installed: boolean;
  version?: string | null;
  binaryPath?: string | null;
  endpoint: string;
  endpointReachable: boolean;
  installHint: string;
  supportsWebUi: boolean;
  supportsServerApi: boolean;
  managedLaunchAvailable: boolean;
}

export interface PaperclipServiceResult {
  sessionId: string;
  endpoint: string;
  apiBaseUrl: string;
  webUrl: string;
  command: string;
  pid?: number | null;
  alreadyRunning: boolean;
}

export interface LivingArchiveMemoryServiceStatus {
  available: boolean;
  running: boolean;
  endpoint: string;
  memoryRoot: string;
  sessionId: string;
  readonly: boolean;
  pid?: number | null;
  command: string;
  statusDetail: string;
}

export interface LivingArchiveMemoryServiceResult {
  sessionId: string;
  endpoint: string;
  memoryRoot: string;
  readonly: boolean;
  command: string;
  pid?: number | null;
  alreadyRunning: boolean;
}

export interface PaperclipCompanySummary {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  budgetMonthlyCents?: number | null;
}

export interface PaperclipAgentSummary {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number | null;
}

export interface PaperclipIssueSummary {
  id: string;
  title: string;
  status?: string | null;
  priority?: string | null;
  assigneeAgentId?: string | null;
  projectId?: string | null;
}

export interface PaperclipDashboardSnapshot {
  endpoint: string;
  companyId?: string | null;
  companies: PaperclipCompanySummary[];
  agents: PaperclipAgentSummary[];
  issues: PaperclipIssueSummary[];
  fetchedAt: string;
}

export interface PaperclipCreateIssueResult {
  endpoint: string;
  companyId: string;
  issue: PaperclipIssueSummary;
  auditSummary: string;
}

export interface StrategistIdentity {
  id: string;
  defaultName: string;
  customName?: string;
  trustNote: string;
}

export interface ConversationMessage {
  id: string;
  threadId: string;
  channelId: string;
  role: ConversationRole;
  author: string;
  content: string;
  createdAt: string;
  status?: ConversationMessageStatus;
  archiveCitations?: Array<{
    title: string;
    path: string;
    pageType: string;
    snippet?: string;
  }>;
  providerUsage?: ProviderUsageTelemetry;
}

export interface ProviderUsageTelemetry {
  providerId: string;
  model: string;
  source: "provider" | "local-runtime";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  tokensPerSecond?: number;
}

export interface ProviderRequestAuditRecord {
  schemaVersion: number;
  recordedAt: string;
  requestId?: string;
  threadId?: string;
  agentId?: string;
  channelId?: string;
  providerId: string;
  providerType: ProviderType;
  runtimeNodeId?: string;
  runtimeNodeKind?: RuntimeNodeKind;
  endpointHost?: string;
  authTier?: AuthTier;
  model: string;
  status: "ok" | "error" | string;
  durationMs: number;
  usage?: ProviderUsageTelemetry;
  errorSummary?: string;
}

export interface ContextDecision {
  decisionId: string;
  title: string;
  decision: string;
  reason: string;
  scope: string;
  status: "proposed" | "accepted" | "superseded";
  sourceMessageIds: string[];
  relatedDocPaths: string[];
}

export interface ContextFact {
  factId: string;
  statement: string;
  scope: "user" | "project" | "system" | "external";
  confidence: "verified" | "unverified";
  observedAt: string;
  sourceMessageIds: string[];
}

export interface ContextPreference {
  preferenceId: string;
  statement: string;
  appliesTo: string;
  sourceMessageIds: string[];
}

export interface ContextTask {
  taskId: string;
  owner: string;
  status: "open" | "blocked" | "done";
  description: string;
  blockingReason?: string;
  verificationRequired: string[];
  sourceMessageIds: string[];
}

export interface ContextArtifactRef {
  artifactId: string;
  kind: "file" | "commit" | "archive-document" | "screenshot" | "addon-manifest" | "external-url" | "other";
  label: string;
  ref: string;
  sourceMessageIds: string[];
}

export interface ContextRisk {
  riskId: string;
  description: string;
  severity: "low" | "medium" | "high";
  mitigation?: string;
  sourceMessageIds: string[];
}

export interface ContextQuestion {
  questionId: string;
  question: string;
  owner: "user" | "agent" | "unknown";
  sourceMessageIds: string[];
}

export interface ContextMemoryState {
  threadId: string;
  compactedAt: string;
  sourceRange: {
    fromMessageId: string;
    toMessageId: string;
  };
  userIntent: {
    goal: string;
    why: string;
    successCriteria: string[];
    prioritySignals: string[];
    sourceMessageIds: string[];
  };
  workingSummary: string;
  decisions: ContextDecision[];
  facts: ContextFact[];
  preferences: ContextPreference[];
  openTasks: ContextTask[];
  artifacts: ContextArtifactRef[];
  risks: ContextRisk[];
  unresolvedQuestions: ContextQuestion[];
  preservedRecentMessageIds: string[];
  checksum: string;
}

export interface ContextBudget {
  providerId: string;
  modelId: string;
  maxContextTokens: number;
  usedInputTokens: number;
  reservedOutputTokens: number;
  reservedReasoningTokens: number;
  reservedSystemTokens: number;
  reservedRetrievalTokens: number;
  compactionThreshold: number;
  hardStopThreshold: number;
  estimateQuality: "provider" | "tokenizer" | "heuristic";
}

export interface CompactionRequest {
  threadId: string;
  agentId: string;
  providerRouteId: string;
  reason: "manual" | "threshold" | "provider_limit" | "branch" | "session_close";
  sourceMessageIds: string[];
  instructions?: string;
}

export interface ConversationTranscriptEvent {
  id: string;
  createdAt: string;
  action: ConversationTranscriptEventAction;
  threadId: string;
  channelId?: string;
  messageId?: string;
  role?: ConversationRole;
  agentId?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
  payload: Record<string, unknown>;
}

export interface ConversationThread {
  id: string;
  title: string;
  owningAgentId: string;
  workspaceId: string;
  channelId: string;
  summary: string;
  projectId?: string;
  messages: ConversationMessage[];
}

export interface ChatProject {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RecoveryChecklistStepStatus = "pending" | "active" | "complete";

export interface RecoveryChecklistStep {
  id: string;
  label: string;
  description: string;
  status: RecoveryChecklistStepStatus;
}

export interface RecoverySession {
  active: boolean;
  engineerAgentId: string;
  engineerThreadId: string;
  lastNormalThreadId: string;
  checklist: RecoveryChecklistStep[];
  changeLog: string[];
}

export interface UiPreferences {
  activeSection: ShellSectionId;
  activeChatThreadId: string;
  activeCostPosture: ProviderCostPosture;
  pinnedChatThreadIds: string[];
  pinnedChatProjectIds: string[];
  leftSidebarOpen: boolean;
  chatSidebarOpen: boolean;
  workspaceLayout: "main-chat" | "chat-main";
  chatHistoryOpen: boolean;
  chatSidebarWidth: number;
  recommendedAddOnsReviewed: boolean;
  windowZoom: number;
  pendingOpenCodeWorkspaceId: string | null;
  browserWorkspace: BrowserWorkspaceState;
  theme: "resonant-dark";
}

export interface DictationSettings {
  /** Engine selection mode. Default "auto". */
  engineSelection: "auto" | "whisper" | "parakeet";
  /** Whisper language code or "auto" for auto-detect. Default "auto". Ignored by Parakeet. */
  language: string;
  /** Whisper task. Default "transcribe". Ignored by Parakeet. */
  task: "transcribe" | "translate";
}

export interface TerminalRunCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface TerminalPtySessionResult {
  sessionId: string;
  cwd: string;
  shell: string;
  created: boolean;
}

export interface ResonantShellState {
  strategistIdentity: StrategistIdentity;
  coreServices: CoreService[];
  providers: ProviderProfile[];
  runtimeNodes: ProviderRuntimeNode[];
  providerRouting: ProviderRoutingState;
  computeFabric: ComputeFabricState;
  modelStrategy: ModelStrategyState;
  agents: AgentDefinition[];
  channels: ChannelDefinition[];
  workspaces: WorkspaceDefinition[];
  archivePolicy: ArchivePolicy;
  archiveAutomationPolicy: ArchiveAutomationPolicy;
  chatProjects: ChatProject[];
  conversationThreads: ConversationThread[];
  transcriptLedger: ConversationTranscriptEvent[];
  contextMemoryStates: ContextMemoryState[];
  goalWorkspaces: GoalWorkspace[];
  recoverySession: RecoverySession;
  installations: Record<string, AddOnInstallation>;
  uiPreferences: UiPreferences;
  distributionModel: "curated-plus-sideload";
  dictation: DictationSettings;
}
