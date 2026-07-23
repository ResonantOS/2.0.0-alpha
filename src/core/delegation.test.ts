import { describe, expect, it } from "vitest";
import type { AddOnManifest, DelegationPacket } from "./contracts";
import { buildDefaultState } from "./defaults";
import {
  createEngineerDelegationPacket,
  createHermesDelegationPacket,
  createOpenCodeDelegationPacket,
  delegationTargetsForState,
  delegationTargetsFromManifests,
  engineerTaskAuditEvent,
  engineerTaskMessagesFromWorkspace,
  engineerTaskVerificationPayload,
  formatTaskWorkspaceCreatedReply,
  formatEngineerTaskFinishedReply,
  formatOpenCodeTaskWorkspaceCreatedReply,
  hermesTaskAuditEvent,
  hermesTaskPromptFromWorkspace,
  hermesTaskVerificationPayload,
  nativeDelegationTargetsFromState,
  parseStartEngineerTaskWorkspaceId,
  renderEngineerTaskResultMarkdown,
  renderDelegationTaskMarkdown,
  shouldDelegateToEngineer,
  shouldDelegateToHermes,
  shouldDelegateToOpenCode,
  validateDelegationPacket,
} from "./delegation";

const basePacket = (overrides: Partial<DelegationPacket> = {}): DelegationPacket => ({
  id: "delegation-1",
  createdAt: "2026-04-25T12:00:00.000Z",
  createdByAgentId: "strategist.core",
  targetAgentId: "opencode.runtime",
  targetRuntime: "embedded-workspace",
  taskType: "code-change",
  mission: "Refactor the provider route card into a smaller component without changing behavior.",
  context: "The shell composition root is being kept small under ADR-002. Preserve existing UX.",
  sourceMemoryRefs: ["archive://concept/provider-fabric"],
  systemMemoryRefs: ["system://resonantos-architecture-contract"],
  workspaceId: "workspace-delegation-1",
  filesInScope: ["src/modules/settings/ProviderRouteCard.tsx"],
  allowedTools: ["filesystem.read", "filesystem.search", "filesystem.patch"],
  forbiddenActions: ["Do not change provider secrets.", "Do not alter routing policy."],
  capabilityGrants: [
    {
      capability: "filesystem",
      granted: true,
      scope: "workspace",
      revocationBehavior: "hard-stop",
    },
  ],
  providerPolicy: {
    preferredProviderProfileIds: ["shared-minimax"],
    preferredRuntimeNodeIds: ["node-minimax-cloud"],
    preferredModels: ["MiniMax-M3"],
    allowedRuntimeKinds: ["cloud", "local"],
    fallbackPolicyId: "core-default",
  },
  costPolicy: {
    sensitivity: "medium",
    preferredCostTier: "subscription",
    allowPaidEscalation: false,
    rationale: "Routine coding should prefer subscription or local routes.",
  },
  humanApprovalRequired: false,
  approvalReasons: [],
  verificationRequirements: [
    {
      id: "npm-test",
      label: "Run npm test",
      method: "unit-test",
      required: true,
    },
  ],
  expectedArtifacts: ["summary", "diff", "verification-report"],
  returnProtocol: {
    summaryRequired: true,
    artifactTypes: ["summary", "diff", "verification-report"],
    mustReportFilesChanged: true,
    mustReportCommandsRun: true,
    mustReportResidualRisks: true,
    mustReportVerification: true,
  },
  auditLogPath: "TaskWorkspace/logs/audit.jsonl",
  ...overrides,
});

describe("Hermes delegation packet factory", () => {
  it("creates a valid approval-gated Hermes communication packet", () => {
    const state = buildDefaultState([]);
    const packet = createHermesDelegationPacket(state, {
      mission: "Draft a follow-up message to the research collaborator summarizing next actions.",
      createdAt: "2026-05-06T10:00:00.000Z",
    });

    expect(packet.targetAgentId).toBe("hermes.agent");
    expect(packet.targetRuntime).toBe("addon-agent");
    expect(packet.humanApprovalRequired).toBe(true);
    expect(packet.approvalReasons).toContain("public-action");
    expect(packet.forbiddenActions.join("\n")).toContain("Do not write trusted Living Archive knowledge pages");
    expect(validateDelegationPacket(packet).valid).toBe(true);
  });

  it("builds a Hermes task prompt and completion artifacts with approval boundaries", () => {
    const state = buildDefaultState([]);
    const packet = createHermesDelegationPacket(state, {
      mission: "Prepare a coordination summary for the collaborator before any outbound send.",
      createdAt: "2026-05-06T10:00:00.000Z",
    });
    const payload = {
      workspace: {
        id: "workspace-hermes-test",
        packetId: packet.id,
        rootPath: "/tmp/workspace-hermes-test",
        packetPath: "/tmp/workspace-hermes-test/delegation.packet.json",
        taskMarkdownPath: "/tmp/workspace-hermes-test/TASK.md",
        artifactsPath: "/tmp/workspace-hermes-test/artifacts",
        logsPath: "/tmp/workspace-hermes-test/logs",
        resultPath: "/tmp/workspace-hermes-test/result.md",
        verificationPath: "/tmp/workspace-hermes-test/verification.json",
      },
      packet,
      taskMarkdown: renderDelegationTaskMarkdown(packet),
      resultMarkdown: "# Delegation Result\n\nPending.",
      verification: {},
    };

    const prompt = hermesTaskPromptFromWorkspace(payload);
    expect(prompt).toContain("Use the existing Hermes profile identity");
    expect(prompt).toContain("Living Archive material as read-only context");
    expect(prompt).toContain("Do not send public, external, or identity-sensitive messages");

    const verification = hermesTaskVerificationPayload({ packetId: packet.id, profileHome: "/Users/augmentor/.hermes" });
    expect(verification.approval.outboundSendApproved).toBe(false);

    const audit = hermesTaskAuditEvent({
      packetId: packet.id,
      workspaceId: payload.workspace.id,
      profileHome: "/Users/augmentor/.hermes",
    });
    expect(audit.approvalBoundary).toBe("no-outbound-send-approved");
  });

  it("detects explicit Hermes delegation requests", () => {
    expect(shouldDelegateToHermes("Delegate this email follow-up to Hermes")).toBe(true);
    expect(shouldDelegateToHermes("What is ResonantOS?")).toBe(false);
  });
});

describe("OpenCode delegation packet factory", () => {
  it("creates a valid approval-gated OpenCode workspace packet", () => {
    const state = buildDefaultState([]);
    const packet = createOpenCodeDelegationPacket(state, {
      mission: "Delegate a scoped coding workspace diagnosis to OpenCode before making changes.",
      createdAt: "2026-05-17T10:00:00.000Z",
    });

    expect(packet.targetAgentId).toBe("opencode.runtime");
    expect(packet.targetRuntime).toBe("local-service");
    expect(packet.taskType).toBe("system-diagnosis");
    expect(packet.allowedTools).toContain("filesystem.search");
    expect(packet.capabilityGrants.map((grant) => grant.capability)).toEqual(["filesystem", "shell", "providers"]);
    expect(packet.capabilityGrants.every((grant) => !grant.granted)).toBe(true);
    expect(packet.humanApprovalRequired).toBe(true);
    expect(packet.forbiddenActions.join("\n")).toContain("Do not run destructive commands");
    const validation = validateDelegationPacket(packet);
    expect(validation.valid).toBe(true);
    expect(validation.issues.some((entry) => entry.code === "no-capability-grants")).toBe(true);
  });

  it("detects explicit OpenCode delegation requests and formats the workspace reply", () => {
    expect(shouldDelegateToOpenCode("Delegate this simple task to OpenCode")).toBe(true);
    expect(shouldDelegateToOpenCode("Use OpenCode to create folder ~/Desktop/OpenCodeTest")).toBe(true);
    expect(shouldDelegateToOpenCode("Create a file with OpenCode in the scoped workspace")).toBe(true);
    expect(shouldDelegateToOpenCode("Can Hermes draft this?")).toBe(false);

    const reply = formatOpenCodeTaskWorkspaceCreatedReply({
      id: "workspace-opencode-test",
      packetId: "delegation-opencode-test",
      rootPath: "/tmp/workspace-opencode-test",
      packetPath: "/tmp/workspace-opencode-test/delegation.packet.json",
      taskMarkdownPath: "/tmp/workspace-opencode-test/TASK.md",
      artifactsPath: "/tmp/workspace-opencode-test/artifacts",
      logsPath: "/tmp/workspace-opencode-test/logs",
      resultPath: "/tmp/workspace-opencode-test/result.md",
      verificationPath: "/tmp/workspace-opencode-test/verification.json",
    });

    expect(reply).toContain("OpenCode delegation workspace");
    expect(reply).toContain("changed files, commands run, verification evidence, and residual risks");
  });
});

const manifest = (overrides: Partial<AddOnManifest>): AddOnManifest => ({
  id: "addon.opencode",
  name: "OpenCode",
  version: "0.1.0",
  author: "test",
  category: "tool",
  description: "test",
  runtimeType: "embedded-module",
  surfaces: [],
  requestedCapabilities: [
    {
      capability: "filesystem",
      granted: false,
      scope: "workspace",
      revocationBehavior: "hard-stop",
    },
  ],
  providerRequirements: {
    sharedProfiles: [],
    supportsPrivateCredentials: false,
  },
  archiveIntegration: {
    readScopes: [],
    intakeWriteScopes: [],
    canRequestIngest: false,
    canWriteKnowledgePages: false,
  },
  health: {
    strategy: "none",
  },
  installHooks: {},
  compatibility: {
    shellVersion: "^0.1.0",
    platforms: ["macOS"],
  },
  ...overrides,
});

describe("delegation packet validation", () => {
  it("accepts a concrete code delegation with scope and verification", () => {
    const result = validateDelegationPacket(basePacket());
    expect(result.valid).toBe(true);
    expect(result.issues.filter((entry) => entry.severity === "error")).toHaveLength(0);
  });

  it("rejects vague missions", () => {
    const result = validateDelegationPacket(basePacket({ mission: "Investigate and fix." }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "vague-mission")).toBe(true);
  });

  it("rejects code delegations without verification", () => {
    const result = validateDelegationPacket(basePacket({ verificationRequirements: [] }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "code-task-without-verification")).toBe(true);
  });

  it("rejects risky delegations without human approval", () => {
    const result = validateDelegationPacket(
      basePacket({
        taskType: "communication",
        filesInScope: [],
        approvalReasons: ["public-action"],
        humanApprovalRequired: false,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "risky-task-without-approval")).toBe(true);
  });
});

describe("TASK.md renderer", () => {
  it("renders the packet into an interoperable worker brief", () => {
    const rendered = renderDelegationTaskMarkdown(basePacket());
    expect(rendered).toContain("# TASK.md");
    expect(rendered).toContain("## Mission");
    expect(rendered).toContain("ProviderRouteCard.tsx");
    expect(rendered).toContain("Run npm test");
    expect(rendered).toContain("## Return Protocol");
    expect(rendered).toContain("Packet id: delegation-1");
  });
});

describe("delegation targets", () => {
  it("derives delegation targets from add-on manifests", () => {
    const targets = delegationTargetsFromManifests([
      manifest({
        agents: [
          {
            id: "opencode.runtime",
            displayName: "OpenCode",
            trustTier: "addon",
            workspaceBehavior: "delegated",
          },
        ],
        delegation: {
          acceptsTasks: true,
          taskTypes: ["code-change", "bug-fix"],
          artifactReturnTypes: ["summary", "diff", "verification-report"],
          defaultTargetRuntime: "embedded-workspace",
          requiresHumanApprovalBeforeExecution: true,
        },
      }),
      manifest({
        id: "addon.obsidian",
        name: "Obsidian",
      }),
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe("opencode.runtime");
    expect(targets[0]?.acceptedTaskTypes).toContain("code-change");
  });

  it("exposes the Resonant Engineer Agent as a native delegation target", () => {
    const state = buildDefaultState([]);
    const targets = nativeDelegationTargetsFromState(state);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe(state.recoverySession.engineerAgentId);
    expect(targets[0]?.runtime).toBe("native-agent");
    expect(targets[0]?.acceptedTaskTypes).toContain("system-diagnosis");
  });

  it("combines native and add-on delegation targets", () => {
    const state = buildDefaultState([]);
    const targets = delegationTargetsForState(state, [
      manifest({
        agents: [
          {
            id: "opencode.runtime",
            displayName: "OpenCode",
            trustTier: "addon",
            workspaceBehavior: "delegated",
          },
        ],
        delegation: {
          acceptsTasks: true,
          taskTypes: ["code-change"],
          artifactReturnTypes: ["summary", "diff", "verification-report"],
          defaultTargetRuntime: "embedded-workspace",
          requiresHumanApprovalBeforeExecution: true,
        },
      }),
    ]);

    expect(targets.map((target) => target.id)).toContain(state.recoverySession.engineerAgentId);
    expect(targets.map((target) => target.id)).toContain("opencode.runtime");
  });
});

describe("Engineer delegation packet factory", () => {
  it("creates a valid Augmentor to Engineer diagnostic packet", () => {
    const state = buildDefaultState([]);
    const packet = createEngineerDelegationPacket(state, {
      mission: "Check why the provider runtime diagnostics are degraded before any repair work starts.",
      createdAt: "2026-04-25T12:00:00.000Z",
    });

    expect(packet.createdByAgentId).toBe("strategist.core");
    expect(packet.targetAgentId).toBe(state.recoverySession.engineerAgentId);
    expect(packet.targetRuntime).toBe("native-agent");
    expect(packet.systemMemoryRefs).toContain("system://resonantos-architecture-contract");
    expect(validateDelegationPacket(packet).valid).toBe(true);
  });

  it("requires human approval for Engineer repair packets", () => {
    const state = buildDefaultState([]);
    const packet = createEngineerDelegationPacket(state, {
      mission: "Prepare a bounded repair plan for the provider runtime configuration issue.",
      taskType: "system-repair",
      createdAt: "2026-04-25T12:00:00.000Z",
    });

    expect(packet.humanApprovalRequired).toBe(true);
    expect(packet.approvalReasons).toContain("broad-filesystem");
    expect(validateDelegationPacket(packet).valid).toBe(true);
  });

  it("detects explicit Engineer delegation requests", () => {
    expect(shouldDelegateToEngineer("Delegate this provider diagnostic to the Engineer")).toBe(true);
    expect(shouldDelegateToEngineer("What is ResonantOS?")).toBe(false);
  });

  it("formats task workspace creation replies", () => {
    const reply = formatTaskWorkspaceCreatedReply({
      id: "workspace-engineer-test",
      packetId: "delegation-test",
      rootPath: "/tmp/workspace-engineer-test",
      packetPath: "/tmp/workspace-engineer-test/delegation.packet.json",
      taskMarkdownPath: "/tmp/workspace-engineer-test/TASK.md",
      artifactsPath: "/tmp/workspace-engineer-test/artifacts",
      logsPath: "/tmp/workspace-engineer-test/logs",
      resultPath: "/tmp/workspace-engineer-test/result.md",
      verificationPath: "/tmp/workspace-engineer-test/verification.json",
    });

    expect(reply).toContain("No agent execution has started yet");
    expect(reply).toContain("TASK.md");
  });

  it("parses explicit start Engineer task requests", () => {
    expect(parseStartEngineerTaskWorkspaceId("start engineer task workspace-engineer-test")).toBe("workspace-engineer-test");
    expect(parseStartEngineerTaskWorkspaceId("start the engineer task workspace_123")).toBe("workspace_123");
    expect(parseStartEngineerTaskWorkspaceId("please run something")).toBeNull();
  });

  it("builds Engineer task messages and completion artifacts", () => {
    const payload = {
      workspace: {
        id: "workspace-engineer-test",
        packetId: "delegation-test",
        rootPath: "/tmp/workspace-engineer-test",
        packetPath: "/tmp/workspace-engineer-test/delegation.packet.json",
        taskMarkdownPath: "/tmp/workspace-engineer-test/TASK.md",
        artifactsPath: "/tmp/workspace-engineer-test/artifacts",
        logsPath: "/tmp/workspace-engineer-test/logs",
        resultPath: "/tmp/workspace-engineer-test/result.md",
        verificationPath: "/tmp/workspace-engineer-test/verification.json",
      },
      packet: createEngineerDelegationPacket(buildDefaultState([]), {
        mission: "Check why provider diagnostics are degraded before repair.",
        createdAt: "2026-04-25T12:00:00.000Z",
      }),
      taskMarkdown: "# TASK.md\n\nCheck diagnostics.",
      resultMarkdown: "# Delegation Result\n\nPending.",
      verification: {},
    };
    const messages = engineerTaskMessagesFromWorkspace(payload);
    expect(messages[0]?.content).toContain("TASK.md");
    expect(messages[0]?.content).toContain("Delegation packet");

    const result = renderEngineerTaskResultMarkdown({
      workspace: payload.workspace,
      reply: "Diagnostics complete.",
      toolEvents: [{ tool: "provider_probe", status: "completed", summary: "Provider is healthy." }],
    });
    expect(result).toContain("Diagnostics complete.");
    expect(result).toContain("provider_probe");

    const verification = engineerTaskVerificationPayload({
      packetId: "delegation-test",
      toolEvents: [{ tool: "provider_probe", status: "completed", summary: "Provider is healthy." }],
    });
    expect(verification.status).toBe("completed");

    const audit = engineerTaskAuditEvent({
      packetId: "delegation-test",
      workspaceId: "workspace-engineer-test",
      toolEvents: [{ tool: "provider_probe", status: "completed", summary: "Provider is healthy." }],
    });
    expect(audit.event).toBe("engineer-task-finished");

    const reply = formatEngineerTaskFinishedReply({
      workspace: payload.workspace,
      resultPath: payload.workspace.resultPath,
      verificationPath: payload.workspace.verificationPath,
      auditPath: `${payload.workspace.logsPath}/audit.jsonl`,
    });
    expect(reply).toContain("Engineer task ran");
  });
});
