// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import type {
  AddOnManifest,
  ConversationMessage,
  DelegationPacket,
  DelegationTarget,
  DelegationValidationIssue,
  DelegationValidationResult,
  ResonantShellState,
  TaskWorkspace,
  TaskWorkspacePayload,
  EngineerToolEvent,
} from "./contracts";

const VAGUE_MISSION_PATTERNS = [
  /\binvestigate\s+and\s+fix\b/i,
  /\bfix\s+everything\b/i,
  /\bmake\s+it\s+work\b/i,
  /\bdo\s+the\s+needful\b/i,
  /\bhandle\s+this\b/i,
];

const CODE_TASK_TYPES = new Set(["code-change", "bug-fix", "system-repair"]);
const RISKY_APPROVAL_REASONS = new Set(["destructive", "public-action", "financial", "identity-sensitive", "broad-filesystem"]);

const issue = (severity: DelegationValidationIssue["severity"], code: string, message: string): DelegationValidationIssue => ({
  severity,
  code,
  message,
});

const hasRequiredVerification = (packet: DelegationPacket): boolean =>
  packet.verificationRequirements.some((requirement) => requirement.required && requirement.method !== "none");

const hasGrantedCapability = (packet: DelegationPacket): boolean =>
  packet.capabilityGrants.some((grant) => grant.granted);

export const validateDelegationPacket = (packet: DelegationPacket): DelegationValidationResult => {
  const issues: DelegationValidationIssue[] = [];
  const mission = packet.mission.trim();
  const context = packet.context.trim();

  if (!packet.taskType) {
    issues.push(issue("error", "missing-task-type", "Delegation packet must declare a task type."));
  }
  if (!packet.targetAgentId.trim()) {
    issues.push(issue("error", "missing-target", "Delegation packet must declare a target agent or add-on."));
  }
  if (!mission) {
    issues.push(issue("error", "missing-mission", "Delegation packet must include a mission."));
  }
  if (mission.length < 24) {
    issues.push(issue("error", "mission-too-short", "Delegation mission is too short to preserve intent."));
  }
  if (VAGUE_MISSION_PATTERNS.some((pattern) => pattern.test(mission))) {
    issues.push(issue("error", "vague-mission", "Delegation mission is too vague. Replace it with concrete scope and expected outcome."));
  }
  if (!context) {
    issues.push(issue("warning", "missing-context", "Delegation packet has no context block."));
  }
  if (!packet.workspaceId.trim()) {
    issues.push(issue("error", "missing-workspace", "Delegation packet must bind the task to a workspace."));
  }
  if (!packet.returnProtocol.summaryRequired || !packet.returnProtocol.artifactTypes.length) {
    issues.push(issue("error", "missing-return-protocol", "Delegation packet must define a return protocol and artifact types."));
  }
  if (!packet.expectedArtifacts.length) {
    issues.push(issue("error", "missing-expected-artifacts", "Delegation packet must define expected artifacts."));
  }
  if (CODE_TASK_TYPES.has(packet.taskType) && !packet.filesInScope.length) {
    issues.push(issue("error", "code-task-without-files", "Code or system repair delegation requires files in scope."));
  }
  if (CODE_TASK_TYPES.has(packet.taskType) && !hasRequiredVerification(packet)) {
    issues.push(issue("error", "code-task-without-verification", "Code or system repair delegation requires deterministic verification."));
  }
  if (packet.filesInScope.length > 3 && CODE_TASK_TYPES.has(packet.taskType)) {
    issues.push(issue("warning", "broad-code-scope", "Coding delegation has more than three primary files in scope."));
  }
  if (packet.approvalReasons.some((reason) => RISKY_APPROVAL_REASONS.has(reason)) && !packet.humanApprovalRequired) {
    issues.push(issue("error", "risky-task-without-approval", "Risky delegation requires explicit human approval."));
  }
  if (!hasGrantedCapability(packet)) {
    issues.push(issue("warning", "no-capability-grants", "Delegation packet has no granted capabilities; target may run in degraded mode."));
  }
  if (!packet.systemMemoryRefs.length) {
    issues.push(issue("warning", "missing-system-memory", "Delegation packet does not cite System Architecture Memory."));
  }
  if (packet.costPolicy.sensitivity === "high" && packet.costPolicy.preferredCostTier === "paid-api") {
    issues.push(issue("warning", "high-cost-route", "High cost sensitivity conflicts with paid API preference."));
  }

  return {
    valid: issues.every((entry) => entry.severity !== "error"),
    issues,
  };
};

const renderList = (items: string[], fallback = "None specified."): string =>
  items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;

export const renderDelegationTaskMarkdown = (packet: DelegationPacket): string =>
  [
    `# TASK.md — ${packet.taskType}`,
    "",
    "## Mission",
    packet.mission.trim(),
    "",
    "## Context",
    packet.context.trim() || "No context provided.",
    "",
    "## Target",
    `- Target agent/add-on: ${packet.targetAgentId}`,
    `- Runtime: ${packet.targetRuntime}`,
    `- Workspace: ${packet.workspaceId}`,
    `- Created by: ${packet.createdByAgentId}`,
    "",
    "## Files In Scope",
    renderList(packet.filesInScope),
    "",
    "## System Memory References",
    renderList(packet.systemMemoryRefs),
    "",
    "## Source Memory References",
    renderList(packet.sourceMemoryRefs),
    "",
    "## Allowed Tools",
    renderList(packet.allowedTools),
    "",
    "## Forbidden Actions",
    renderList(packet.forbiddenActions),
    "",
    "## Verification Requirements",
    packet.verificationRequirements.length
      ? packet.verificationRequirements
          .map((requirement) => `- [${requirement.required ? "required" : "optional"}] ${requirement.label} (${requirement.method})`)
          .join("\n")
      : "- None specified.",
    "",
    "## Expected Artifacts",
    renderList(packet.expectedArtifacts),
    "",
    "## Return Protocol",
    `- Summary required: ${packet.returnProtocol.summaryRequired ? "yes" : "no"}`,
    `- Artifact types: ${packet.returnProtocol.artifactTypes.join(", ") || "none"}`,
    `- Report files changed: ${packet.returnProtocol.mustReportFilesChanged ? "yes" : "no"}`,
    `- Report commands run: ${packet.returnProtocol.mustReportCommandsRun ? "yes" : "no"}`,
    `- Report residual risks: ${packet.returnProtocol.mustReportResidualRisks ? "yes" : "no"}`,
    `- Report verification: ${packet.returnProtocol.mustReportVerification ? "yes" : "no"}`,
    "",
    "## Approval And Audit",
    `- Human approval required: ${packet.humanApprovalRequired ? "yes" : "no"}`,
    `- Approval reasons: ${packet.approvalReasons.join(", ") || "none"}`,
    `- Audit log: ${packet.auditLogPath}`,
    "",
    "## Cost And Provider Policy",
    `- Cost sensitivity: ${packet.costPolicy.sensitivity}`,
    `- Preferred cost tier: ${packet.costPolicy.preferredCostTier}`,
    `- Paid escalation allowed: ${packet.costPolicy.allowPaidEscalation ? "yes" : "no"}`,
    `- Cost rationale: ${packet.costPolicy.rationale}`,
    `- Preferred providers: ${packet.providerPolicy.preferredProviderProfileIds.join(", ") || "none"}`,
    `- Preferred models: ${packet.providerPolicy.preferredModels.join(", ") || "none"}`,
    "",
    "## Packet",
    `- Packet id: ${packet.id}`,
    `- Created at: ${packet.createdAt}`,
    "",
  ].join("\n");

export const delegationTargetFromManifest = (manifest: AddOnManifest): DelegationTarget | null => {
  if (!manifest.delegation?.acceptsTasks) {
    return null;
  }

  return {
    id: manifest.agents?.[0]?.id ?? manifest.id,
    label: manifest.name,
    runtime: manifest.delegation.defaultTargetRuntime,
    addonId: manifest.id,
    agentId: manifest.agents?.[0]?.id,
    acceptedTaskTypes: manifest.delegation.taskTypes,
    supportedArtifactTypes: manifest.delegation.artifactReturnTypes,
    requiredCapabilities: manifest.requestedCapabilities.map((grant) => grant.capability),
    defaultRequiresHumanApproval: manifest.delegation.requiresHumanApprovalBeforeExecution,
  };
};

export const delegationTargetsFromManifests = (manifests: AddOnManifest[]): DelegationTarget[] =>
  manifests
    .map((manifest) => delegationTargetFromManifest(manifest))
    .filter((target): target is DelegationTarget => target !== null);

export const nativeDelegationTargetsFromState = (state: ResonantShellState): DelegationTarget[] => {
  const engineer = state.agents.find((agent) => agent.id === state.recoverySession.engineerAgentId);
  if (!engineer) {
    return [];
  }

  return [
    {
      id: engineer.id,
      label: engineer.displayName,
      runtime: "native-agent",
      agentId: engineer.id,
      acceptedTaskTypes: ["system-diagnosis", "system-repair", "bug-fix", "code-change"],
      supportedArtifactTypes: ["summary", "diagnostic-report", "verification-report", "log", "diff", "file-list"],
      requiredCapabilities: [
        "filesystem.read",
        "filesystem.search",
        "filesystem.patch",
        "process.safe_command",
        "provider.probe",
        "delegation.collect_artifacts",
        "delegation.verify_result",
      ],
      defaultRequiresHumanApproval: true,
    },
  ];
};

export const delegationTargetsForState = (state: ResonantShellState, manifests: AddOnManifest[]): DelegationTarget[] => [
  ...nativeDelegationTargetsFromState(state),
  ...delegationTargetsFromManifests(manifests),
];

export const shouldDelegateToEngineer = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    /\bdelegate\b.*\b(engineer|diagnos|repair|system|runtime|provider|recovery)\b/.test(normalized) ||
    /\bask\b.*\b(engineer)\b/.test(normalized) ||
    /\b(engineer)\b.*\b(check|diagnos|repair|investigate)\b/.test(normalized)
  );
};

const compactIdFragment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "engineer-task";

export const createEngineerDelegationPacket = (
  state: ResonantShellState,
  input: {
    mission: string;
    context?: string;
    taskType?: "system-diagnosis" | "system-repair";
    createdAt?: string;
  },
): DelegationPacket => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const engineerId = state.recoverySession.engineerAgentId;
  const mission = input.mission.trim();
  const workspaceId = `workspace-engineer-${compactIdFragment(mission)}-${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const taskType = input.taskType ?? "system-diagnosis";

  return {
    id: `delegation-${workspaceId}`,
    createdAt,
    createdByAgentId: "strategist.core",
    targetAgentId: engineerId,
    targetRuntime: "native-agent",
    taskType,
    mission,
    context:
      input.context?.trim() ||
      "Augmentor is delegating a system-level diagnostic task. Create the task workspace only; do not execute repair actions until explicitly started.",
    sourceMemoryRefs: [],
    systemMemoryRefs: [
      "system://resonantos-system-index",
      "system://resonantos-architecture-contract",
      "system://resonantos-archive-recovery-contract",
    ],
    workspaceId,
    filesInScope: taskType === "system-repair" ? ["ResonantOS runtime/config/code files selected during diagnosis"] : [],
    allowedTools: [
      "filesystem.read",
      "filesystem.search",
      "provider.probe",
      "archive.search",
      "archive.read",
      "delegation.collect_artifacts",
      "delegation.verify_result",
    ],
    forbiddenActions: [
      "Do not execute repair commands in this workspace creation step.",
      "Do not modify files until the human explicitly starts the Engineer task.",
      "Do not access raw secrets.",
      "Do not write trusted Living Archive knowledge pages.",
    ],
    capabilityGrants: [
      {
        capability: "filesystem",
        granted: true,
        scope: "workspace",
        revocationBehavior: "hard-stop",
      },
      {
        capability: "archive-read",
        granted: true,
        scope: "shared",
        revocationBehavior: "degrade",
      },
      {
        capability: "providers",
        granted: true,
        scope: "shared",
        revocationBehavior: "degrade",
      },
    ],
    providerPolicy: {
      preferredProviderProfileIds: ["shared-local", "shared-minimax", "shared-openai"],
      preferredRuntimeNodeIds: ["node-local-resurrect", "node-minimax-cloud", "node-openai-cloud"],
      preferredModels: ["batiai/gemma4-e2b:q4", "MiniMax-M3", "gpt-5.5"],
      allowedRuntimeKinds: ["local", "cloud", "remote-user-owned"],
      fallbackPolicyId: "recovery-default",
    },
    costPolicy: {
      sensitivity: "high",
      preferredCostTier: "free-local",
      allowPaidEscalation: true,
      rationale: "System diagnosis should start local where possible, then escalate only when a stronger model is needed.",
    },
    humanApprovalRequired: taskType === "system-repair",
    approvalReasons: taskType === "system-repair" ? ["broad-filesystem"] : [],
    verificationRequirements: [
      {
        id: "diagnostic-report",
        label: "Return a diagnostic report with facts, suspected cause, and proposed next step.",
        method: "manual-review",
        required: true,
      },
    ],
    expectedArtifacts: ["summary", "diagnostic-report", "verification-report", "log"],
    returnProtocol: {
      summaryRequired: true,
      artifactTypes: ["summary", "diagnostic-report", "verification-report", "log"],
      mustReportFilesChanged: true,
      mustReportCommandsRun: true,
      mustReportResidualRisks: true,
      mustReportVerification: true,
    },
    auditLogPath: `${workspaceId}/logs/audit.jsonl`,
  };
};

export const createHermesDelegationPacket = (
  state: ResonantShellState,
  input: {
    mission: string;
    context?: string;
    taskType?: "communication" | "routine-work" | "research";
    createdAt?: string;
  },
): DelegationPacket => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const mission = input.mission.trim();
  const workspaceId = `workspace-hermes-${compactIdFragment(mission)}-${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const taskType = input.taskType ?? "communication";
  const hermesInstallation = state.installations["addon.hermes"];
  const grantedCapabilities = hermesInstallation?.grantedCapabilities.filter((grant) => grant.granted) ?? [];

  return {
    id: `delegation-${workspaceId}`,
    createdAt,
    createdByAgentId: "strategist.core",
    targetAgentId: "hermes.agent",
    targetRuntime: "addon-agent",
    taskType,
    mission,
    context:
      input.context?.trim() ||
      "Augmentor is delegating a Hermes-compatible communication or coordination task. Prepare the answer, plan, draft, or research result. Do not send public or external messages without explicit human approval.",
    sourceMemoryRefs: [],
    systemMemoryRefs: [
      "system://resonantos-addon-sdk",
      "system://resonantos-delegation-contract",
      "system://living-archive/context-read-only",
    ],
    workspaceId,
    filesInScope: [],
    allowedTools: [
      "archive.search",
      "archive.read",
      "archive.intake_write",
      "delegation.collect_artifacts",
      "delegation.verify_result",
    ],
    forbiddenActions: [
      "Do not send public, external, or identity-sensitive messages without explicit human approval.",
      "Do not write trusted Living Archive knowledge pages.",
      "Do not read raw secrets or expose provider/channel credentials.",
      "Do not alter Hermes identity, skills, memory, or config unless the user explicitly approves a remediation step.",
    ],
    capabilityGrants: grantedCapabilities.length
      ? grantedCapabilities
      : [
          {
            capability: "archive-read",
            granted: true,
            scope: "shared",
            revocationBehavior: "degrade",
          },
          {
            capability: "providers",
            granted: true,
            scope: "shared",
            revocationBehavior: "degrade",
          },
        ],
    providerPolicy: {
      preferredProviderProfileIds: ["shared-minimax", "shared-local", "shared-openai"],
      preferredRuntimeNodeIds: ["node-minimax-cloud", "node-local-resurrect", "node-openai-cloud"],
      preferredModels: ["MiniMax-M3", "batiai/gemma4-e2b:q4", "gpt-5.5"],
      allowedRuntimeKinds: ["local", "cloud", "remote-user-owned"],
      fallbackPolicyId: "routine-default",
    },
    costPolicy: {
      sensitivity: "medium",
      preferredCostTier: "subscription",
      allowPaidEscalation: false,
      rationale: "Hermes delegation should use the existing Hermes profile first and avoid unexpected paid escalation.",
    },
    humanApprovalRequired: true,
    approvalReasons: ["public-action", "identity-sensitive"],
    verificationRequirements: [
      {
        id: "hermes-result-review",
        label: "Return a reviewable Hermes result with summary, actions taken, approval needs, and residual risks.",
        method: "manual-review",
        required: true,
      },
    ],
    expectedArtifacts: ["summary", "markdown", "log"],
    returnProtocol: {
      summaryRequired: true,
      artifactTypes: ["summary", "markdown", "log"],
      mustReportFilesChanged: false,
      mustReportCommandsRun: false,
      mustReportResidualRisks: true,
      mustReportVerification: true,
    },
    auditLogPath: `${workspaceId}/logs/audit.jsonl`,
  };
};

export const createOpenCodeDelegationPacket = (
  state: ResonantShellState,
  input: {
    mission: string;
    context?: string;
    taskType?: "system-diagnosis" | "code-change" | "bug-fix";
    filesInScope?: string[];
    createdAt?: string;
  },
): DelegationPacket => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const mission = input.mission.trim();
  const workspaceId = `workspace-opencode-${compactIdFragment(mission)}-${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const taskType = input.taskType ?? "system-diagnosis";
  const openCodeInstallation = state.installations["addon.opencode"];
  const grantedCapabilities = openCodeInstallation?.grantedCapabilities.filter((grant) => grant.granted) ?? [];

  return {
    id: `delegation-${workspaceId}`,
    createdAt,
    createdByAgentId: "strategist.core",
    targetAgentId: "opencode.runtime",
    targetRuntime: "local-service",
    taskType,
    mission,
    context:
      input.context?.trim() ||
      "Augmentor is delegating a coding workspace task to OpenCode. Create the task workspace, preserve scope, and require reviewable artifacts before completion.",
    sourceMemoryRefs: [],
    systemMemoryRefs: [
      "system://resonantos-addon-sdk",
      "system://resonantos-delegation-contract",
      "system://opencode-hosted-service-contract",
    ],
    workspaceId,
    filesInScope: input.filesInScope ?? (taskType === "system-diagnosis" ? [] : ["Files selected by the human or OpenCode workspace scope"]),
    allowedTools: [
      "filesystem.read",
      "filesystem.search",
      "filesystem.patch",
      "process.safe_command",
      "provider.route_select",
      "delegation.collect_artifacts",
      "delegation.verify_result",
    ],
    forbiddenActions: [
      "Do not access files outside the approved OpenCode workspace scope.",
      "Do not expose provider credentials, tokens, or raw secrets.",
      "Do not run destructive commands without explicit human approval.",
      "Do not write trusted Living Archive knowledge pages.",
      "Do not mark the task complete without changed files, command log, verification evidence, and residual risks.",
    ],
    capabilityGrants: grantedCapabilities.length
      ? grantedCapabilities
      : [
          {
            capability: "filesystem",
            granted: true,
            scope: "workspace",
            revocationBehavior: "hard-stop",
          },
          {
            capability: "shell",
            granted: true,
            scope: "workspace",
            revocationBehavior: "hard-stop",
          },
          {
            capability: "providers",
            granted: true,
            scope: "shared",
            revocationBehavior: "hard-stop",
          },
        ],
    providerPolicy: {
      preferredProviderProfileIds: ["shared-local", "shared-minimax", "gx10-local-llama"],
      preferredRuntimeNodeIds: ["node-local-resurrect", "node-minimax-cloud", "node-gx10-local"],
      preferredModels: ["Qwen 3.6 27B", "MiniMax-M3", "batiai/gemma4-e2b:q4"],
      allowedRuntimeKinds: ["local", "remote-user-owned", "cloud"],
      fallbackPolicyId: "coding-default",
    },
    costPolicy: {
      sensitivity: "medium",
      preferredCostTier: "free-local",
      allowPaidEscalation: true,
      rationale: "OpenCode should prefer local or subscription routes for routine coding and escalate only when the human approves.",
    },
    humanApprovalRequired: true,
    approvalReasons: ["broad-filesystem"],
    verificationRequirements: [
      {
        id: "opencode-verification",
        label: "Return changed files, commands run, deterministic verification, and residual risks.",
        method: "unit-test",
        required: true,
      },
    ],
    expectedArtifacts: ["summary", "diff", "file-list", "log", "verification-report"],
    returnProtocol: {
      summaryRequired: true,
      artifactTypes: ["summary", "diff", "file-list", "log", "verification-report"],
      mustReportFilesChanged: true,
      mustReportCommandsRun: true,
      mustReportResidualRisks: true,
      mustReportVerification: true,
    },
    auditLogPath: `${workspaceId}/logs/audit.jsonl`,
  };
};

export const shouldDelegateToOpenCode = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    /\bdelegate\b.*\b(opencode|open code|coding workspace|code agent)\b/.test(normalized) ||
    /\bask\b.*\b(opencode|open code)\b/.test(normalized) ||
    /\b(use|with|via|through)\b.*\b(opencode|open code)\b/.test(normalized) ||
    /\b(opencode|open code)\b.*\b(code|fix|debug|implement|refactor|diagnos|check|work|task|create|make|add|write|edit|folder|file|mkdir)\b/.test(
      normalized,
    ) ||
    /\b(create|make|add|write|edit|mkdir)\b.*\b(opencode|open code)\b/.test(normalized)
  );
};

export const formatOpenCodeTaskWorkspaceCreatedReply = (workspace: TaskWorkspace): string =>
  [
    "I created an OpenCode delegation workspace and moved you to the OpenCode surface. The browser-first host can submit it to a governed local OpenCode session after explicit consent and preflight.",
    "",
    `- Workspace: \`${workspace.rootPath}\``,
    `- Delegation packet: \`${workspace.packetPath}\``,
    `- TASK.md: \`${workspace.taskMarkdownPath}\``,
    `- Verification: \`${workspace.verificationPath}\``,
    "",
    "OpenCode must return changed files, commands run, verification evidence, and residual risks before the task is considered complete.",
  ].join("\n");

export const formatTaskWorkspaceCreatedReply = (workspace: TaskWorkspace): string =>
  [
    "I created an Engineer delegation workspace. No agent execution has started yet.",
    "",
    `- Workspace: \`${workspace.rootPath}\``,
    `- Delegation packet: \`${workspace.packetPath}\``,
    `- TASK.md: \`${workspace.taskMarkdownPath}\``,
    `- Verification: \`${workspace.verificationPath}\``,
    "",
    "Next step, when approved: start the Engineer task from this workspace and collect its diagnostic artifacts.",
  ].join("\n");

export const formatHermesTaskWorkspaceCreatedReply = (workspace: TaskWorkspace): string =>
  [
    "I created a Hermes delegation workspace. No Hermes execution has started yet.",
    "",
    `- Workspace: \`${workspace.rootPath}\``,
    `- Delegation packet: \`${workspace.packetPath}\``,
    `- TASK.md: \`${workspace.taskMarkdownPath}\``,
    `- Verification: \`${workspace.verificationPath}\``,
    "",
    "Next step, when approved: start the Hermes task from the Delegation monitor and review the returned artifact before any outbound send.",
  ].join("\n");

export const shouldDelegateToHermes = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return (
    /\bdelegate\b.*\b(hermes|message|communication|email|telegram|follow[- ]?up|coordination)\b/.test(normalized) ||
    /\bask\b.*\bhermes\b/.test(normalized) ||
    /\bhermes\b.*\b(draft|research|coordinate|message|follow[- ]?up|handle)\b/.test(normalized)
  );
};

export const hermesTaskPromptFromWorkspace = (payload: TaskWorkspacePayload): string =>
  [
    "Start this delegated Hermes task from the ResonantOS task workspace.",
    "",
    "Rules:",
    "- Use the existing Hermes profile identity, skills, and memory.",
    "- Treat Living Archive material as read-only context unless ResonantOS provides intake approval.",
    "- Do not send public, external, or identity-sensitive messages. Return drafts and approval requests instead.",
    "- Report summary, actions taken, approval needs, residual risks, and verification.",
    "",
    "Delegation packet:",
    JSON.stringify(payload.packet, null, 2),
    "",
    "TASK.md:",
    payload.taskMarkdown,
  ].join("\n");

export const renderHermesTaskResultMarkdown = (input: {
  workspace: TaskWorkspace;
  reply: string;
  profileHome?: string;
}): string =>
  [
    "# Hermes Delegation Result",
    "",
    `Workspace: \`${input.workspace.id}\``,
    input.profileHome ? `Hermes profile: \`${input.profileHome}\`` : null,
    "",
    "## Result",
    input.reply.trim(),
    "",
    "## ResonantOS Boundary",
    "- External sends remain unapproved unless the result explicitly states a later human approval was granted.",
    "- Living Archive writes remain intake-only and review-gated.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

export const hermesTaskVerificationPayload = (input: { packetId: string; profileHome?: string }) => ({
  packetId: input.packetId,
  status: "completed",
  checks: [
    {
      id: "hermes-result-review",
      status: "passed",
      evidence: "Hermes returned a reviewable result through the local profile bridge.",
    },
  ],
  profileHome: input.profileHome,
  approval: {
    outboundSendApproved: false,
    note: "Delegation execution does not approve public or external sends.",
  },
});

export const hermesTaskAuditEvent = (input: { packetId: string; workspaceId: string; profileHome?: string }) => ({
  event: "hermes-task-finished",
  packetId: input.packetId,
  workspaceId: input.workspaceId,
  profileHome: input.profileHome,
  approvalBoundary: "no-outbound-send-approved",
});

export const parseStartEngineerTaskWorkspaceId = (message: string): string | null => {
  const match = message.match(/\bstart\s+(?:the\s+)?engineer\s+task\s+([a-zA-Z0-9_-]+)/i);
  return match?.[1] ?? null;
};

export const engineerTaskMessagesFromWorkspace = (payload: TaskWorkspacePayload): ConversationMessage[] => [
  {
    id: `${payload.workspace.id}:engineer-task`,
    threadId: payload.workspace.id,
    channelId: "delegation-task-workspace",
    role: "user",
    author: "Augmentor",
    createdAt: new Date().toISOString(),
    content: [
      "Start this delegated Engineer task from the task workspace.",
      "",
      "Rules:",
      "- Work only within the task scope.",
      "- Use tools only through the recovery tool loop.",
      "- Report facts, actions, verification, residual risks, and next steps.",
      "- If repair action requires approval, stop and request approval.",
      "",
      "Delegation packet:",
      JSON.stringify(payload.packet, null, 2),
      "",
      "TASK.md:",
      payload.taskMarkdown,
    ].join("\n"),
  },
];

export const renderEngineerTaskResultMarkdown = (input: {
  workspace: TaskWorkspace;
  reply: string;
  toolEvents: EngineerToolEvent[];
}): string =>
  [
    "# Delegation Result",
    "",
    `Workspace: ${input.workspace.id}`,
    `Completed at: ${new Date().toISOString()}`,
    "",
    "## Engineer Reply",
    input.reply.trim() || "No reply returned.",
    "",
    "## Tool Events",
    input.toolEvents.length
      ? input.toolEvents.map((event) => `- [${event.status}] ${event.tool}: ${event.summary}`).join("\n")
      : "- No tool events were returned.",
    "",
  ].join("\n");

export const engineerTaskVerificationPayload = (input: {
  packetId: string;
  toolEvents: EngineerToolEvent[];
}): Record<string, unknown> => ({
  packetId: input.packetId,
  status: input.toolEvents.some((event) => event.status === "failed") ? "needs-review" : "completed",
  checks: [
    {
      id: "engineer-task-run",
      status: input.toolEvents.some((event) => event.status === "failed") ? "failed" : "passed",
      evidence: input.toolEvents.length
        ? input.toolEvents.map((event) => `[${event.status}] ${event.tool}: ${event.summary}`).join("\n")
        : "Engineer returned a reply without tool events.",
    },
  ],
});

export const engineerTaskAuditEvent = (input: {
  packetId: string;
  workspaceId: string;
  toolEvents: EngineerToolEvent[];
}): Record<string, unknown> => ({
  event: "engineer-task-finished",
  packetId: input.packetId,
  workspaceId: input.workspaceId,
  toolEvents: input.toolEvents.map((event) => ({
    tool: event.tool,
    status: event.status,
    summary: event.summary,
  })),
});

export const formatEngineerTaskFinishedReply = (input: {
  workspace: TaskWorkspace;
  resultPath: string;
  verificationPath: string;
  auditPath: string;
}): string =>
  [
    "The Engineer task ran and the workspace was updated.",
    "",
    `- Workspace: \`${input.workspace.rootPath}\``,
    `- Result: \`${input.resultPath}\``,
    `- Verification: \`${input.verificationPath}\``,
    `- Audit log: \`${input.auditPath}\``,
    "",
    "Review the result before promoting any changes or memory updates.",
  ].join("\n");
