// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import { describe, expect, it } from "vitest";
import type { AddOnManifest } from "../../core/contracts";
import { validateAddOnManifest } from "./validation";

const validManifest = (overrides: Partial<AddOnManifest> = {}): AddOnManifest => ({
  id: "addon.browser",
  name: "Resonant Browser",
  version: "0.1.0",
  author: "Resonant Alpha",
  category: "tool",
  description: "Controlled browser add-on.",
  runtimeType: "local-service",
  surfaces: [
    {
      id: "browser-workspace",
      type: "embedded-pane",
      label: "Browser",
      description: "User-visible controlled Chromium workspace.",
    },
  ],
  requestedCapabilities: [
    { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
    { capability: "ui-embedding", granted: false, scope: "system", revocationBehavior: "hide-surface" },
    { capability: "browser-control", granted: false, scope: "system", revocationBehavior: "hard-stop" },
    { capability: "archive-intake-write", granted: false, scope: "intake-only", revocationBehavior: "degrade" },
  ],
  provenance: {
    tier: "curated-signed",
    verificationState: "verified",
    signed: true,
    signer: "ResonantOS test catalog",
  },
  runtimeIsolation: {
    boundary: "host-mediated-service",
    supportsDegradedMode: true,
    requiresReviewedGrant: true,
  },
  grantPresets: [
    {
      id: "browser-control-visible",
      label: "Visible browser control",
      description: "Allow controlled browsing with audit logs.",
      grants: [
        { capability: "network", granted: true, scope: "shared", revocationBehavior: "hard-stop" },
        { capability: "ui-embedding", granted: true, scope: "system", revocationBehavior: "hide-surface" },
        { capability: "browser-control", granted: true, scope: "system", revocationBehavior: "hard-stop" },
      ],
    },
  ],
  providerRequirements: {
    sharedProfiles: [],
    supportsPrivateCredentials: false,
  },
  archiveIntegration: {
    readScopes: [],
    intakeWriteScopes: ["LivingArchive/INTAKE/browser"],
    canRequestIngest: true,
    canWriteKnowledgePages: false,
  },
  health: {
    strategy: "browser-engine-ready",
  },
  service: {
    protocol: "stdio-json-rpc",
    entrypoint: "browser-engine",
    healthCommand: "health",
    shutdownCommand: "shutdown",
  },
  tools: [
    {
      name: "browser.open_url",
      description: "Open a URL in a controlled visible browser session.",
      requiredCapabilities: ["network", "browser-control"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      audit: {
        logRequest: true,
        logResult: true,
        artifactTypes: ["log", "citation-bundle"],
      },
    },
  ],
  installHooks: {
    onInstall: "install-browser-engine",
  },
  compatibility: {
    shellVersion: "^0.1.0",
    platforms: ["macOS", "windows", "linux"],
  },
  ...overrides,
});

describe("add-on SDK manifest validation", () => {
  it("accepts a Browser-style local-service manifest with audited tools", () => {
    const result = validateAddOnManifest(validManifest());

    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts explicit workflow scaffolding contracts for packaged add-on work", () => {
    const result = validateAddOnManifest(
      validManifest({
        workflowBoundaries: [
          {
            id: "visible-browser-research",
            label: "Visible browser research",
            jobToBeDone: "Open, inspect, and capture web pages through a host-mediated browser.",
            userValue: "The human avoids copy/paste browser work while keeping the session visible and auditable.",
            repeatability: "workflow-package",
            owner: "augmentor",
            nonGoals: ["Bypass user approval for sensitive websites"],
          },
        ],
        skills: [
          {
            id: "research-session",
            name: "Research session",
            description: "Guide Augmentor through a repeatable browser-backed research flow.",
            documentPath: "skills/research-session.md",
            invocation: "agent-suggested",
            requiredCapabilities: ["network", "browser-control"],
            requiredTools: ["browser.open_url"],
          },
        ],
        connectors: [
          {
            id: "chromium-host",
            name: "Chromium host",
            type: "local-runtime",
            description: "Connects ResonantOS to the local controlled Chromium runtime.",
            requiredCapabilities: ["network", "browser-control"],
            configScope: "user-config",
          },
        ],
        scripts: [
          {
            id: "browser-smoke-check",
            name: "Browser smoke check",
            description: "Verify the controlled browser can open a URL and return a page title.",
            commandRef: "browser.open_url",
            runPolicy: "preflight",
            deterministic: true,
            requiredCapabilities: ["network", "browser-control"],
            producesArtifacts: ["verification-report"],
            requiresHumanApproval: false,
          },
        ],
        hooks: [
          {
            id: "before-browser-task-complete",
            event: "before-task-complete",
            handlerRef: "browser-smoke-check",
            requiredCapabilities: ["network", "browser-control"],
            failurePolicy: "block",
          },
        ],
      }),
    );

    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects workflow scaffolding contracts that bypass declared capabilities or declared tools", () => {
    const result = validateAddOnManifest(
      validManifest({
        skills: [
          {
            id: "bad-skill",
            name: "Bad skill",
            description: "References undeclared authority.",
            documentPath: "skills/bad.md",
            invocation: "automatic",
            requiredCapabilities: ["shell"],
            requiredTools: ["browser.shell_escape"],
          },
        ],
        connectors: [
          {
            id: "bad-connector",
            name: "Bad connector",
            type: "mcp-server",
            description: "References undeclared shell access.",
            requiredCapabilities: ["shell"],
            configScope: "host-vault",
          },
        ],
        scripts: [
          {
            id: "bad-script",
            name: "Bad script",
            description: "References undeclared shell access.",
            commandRef: "npm run anything",
            runPolicy: "preflight",
            deterministic: true,
            requiredCapabilities: ["shell"],
            producesArtifacts: ["verification-report"],
            requiresHumanApproval: false,
          },
        ],
        hooks: [
          {
            id: "bad-hook",
            event: "before-task-complete",
            handlerRef: "bad-script",
            requiredCapabilities: ["shell"],
            failurePolicy: "block",
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "skill-unrequested-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "skill-unknown-tool")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "connector-unrequested-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "script-unrequested-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "hook-unrequested-capability")).toBe(true);
  });

  it("rejects hooks that do not explicitly activate their handler script contract", () => {
    const result = validateAddOnManifest(
      validManifest({
        requestedCapabilities: [
          { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
          { capability: "browser-control", granted: false, scope: "system", revocationBehavior: "hard-stop" },
        ],
        scripts: [
          {
            id: "browser-smoke-check",
            name: "Browser smoke check",
            description: "Verify controlled browser readiness.",
            commandRef: "browser.health",
            runPolicy: "preflight",
            deterministic: true,
            requiredCapabilities: ["network", "browser-control"],
            producesArtifacts: ["verification-report"],
            requiresHumanApproval: true,
          },
        ],
        hooks: [
          {
            id: "before-browser-task-complete",
            event: "before-task-complete",
            handlerRef: "browser-smoke-check",
            requiredCapabilities: ["browser-control"],
            failurePolicy: "block",
          },
          {
            id: "unknown-handler",
            event: "health-check",
            handlerRef: "missing-script",
            requiredCapabilities: ["browser-control"],
            failurePolicy: "warn",
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "hook-omits-handler-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "hook-handler-requires-human-approval")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "hook-unknown-handler")).toBe(true);
  });

  it("rejects add-ons that claim Living Archive knowledge-page write authority", () => {
    const result = validateAddOnManifest(
      validManifest({
        archiveIntegration: {
          readScopes: [],
          intakeWriteScopes: [],
          canRequestIngest: true,
          canWriteKnowledgePages: true,
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "addon-knowledge-write-forbidden")).toBe(true);
  });

  it("rejects archive scopes that are not backed by requested capabilities", () => {
    const result = validateAddOnManifest(
      validManifest({
        requestedCapabilities: [
          { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
          { capability: "ui-embedding", granted: false, scope: "system", revocationBehavior: "hide-surface" },
          { capability: "browser-control", granted: false, scope: "system", revocationBehavior: "hard-stop" },
        ],
        archiveIntegration: {
          readScopes: ["living-archive/context"],
          intakeWriteScopes: ["LivingArchive/INTAKE/browser"],
          canRequestIngest: true,
          canWriteKnowledgePages: false,
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "archive-read-scope-requires-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "archive-intake-scope-requires-capability")).toBe(true);
  });

  it("rejects shared provider profiles that are not backed by the providers capability", () => {
    const result = validateAddOnManifest(
      validManifest({
        requestedCapabilities: [
          { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
          { capability: "ui-embedding", granted: false, scope: "system", revocationBehavior: "hide-surface" },
          { capability: "browser-control", granted: false, scope: "system", revocationBehavior: "hard-stop" },
          { capability: "archive-intake-write", granted: false, scope: "intake-only", revocationBehavior: "degrade" },
        ],
        providerRequirements: {
          sharedProfiles: ["shared-openai"],
          supportsPrivateCredentials: false,
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "provider-profile-requires-capability")).toBe(true);
  });

  it("rejects embedded surfaces that do not request UI embedding", () => {
    const result = validateAddOnManifest(
      validManifest({
        requestedCapabilities: [
          { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
          { capability: "browser-control", granted: false, scope: "system", revocationBehavior: "hard-stop" },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "embedded-surface-requires-ui-embedding")).toBe(true);
  });

  it("warns when a shell UI module asks for embedding without exposing an embedded surface", () => {
    const result = validateAddOnManifest(
      validManifest({
        runtimeType: "ui-module",
        surfaces: [
          {
            id: "settings-panel",
            type: "panel",
            label: "Settings",
            description: "Shell-owned settings panel.",
          },
        ],
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.issues.some((issue) => issue.code === "ui-module-ui-embedding-unnecessary")).toBe(true);
  });

  it("validates manifest-declared shell navigation for add-on surfaces", () => {
    const valid = validateAddOnManifest(
      validManifest({
        surfaces: [
          {
            id: "custom-tool-page",
            type: "page",
            label: "Custom Tool",
            description: "Custom tool workspace.",
            shellNavigation: {
              sectionId: "custom-tool",
              dockIcon: "custom-tool",
              eyebrow: "Tool",
              order: 70,
              requiredCapabilities: ["network"],
            },
          },
        ],
      }),
    );

    expect(valid.valid).toBe(true);
    expect(valid.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);

    const invalidSurfaceNavigation = {
        surfaces: [
          {
            id: "bad-page",
            type: "page",
            label: "Bad",
            description: "Invalid dock route.",
            shellNavigation: {
              sectionId: "not-a-section",
              dockIcon: "not-an-icon",
              eyebrow: "bad",
              requiredCapabilities: ["shell"],
            },
          },
        ],
      } as unknown as Partial<AddOnManifest>;
    const invalid = validateAddOnManifest(validManifest(invalidSurfaceNavigation));

    expect(invalid.valid).toBe(false);
    // sectionId and dockIcon are open strings — add-ons may register any section name.
    // "not-a-section" and "not-an-icon" are valid dynamic section/icon IDs; no errors on those paths.
    expect(invalid.issues.some((issue) => issue.path === "surfaces[0].shellNavigation.sectionId")).toBe(false);
    expect(invalid.issues.some((issue) => issue.path === "surfaces[0].shellNavigation.dockIcon")).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "surface-navigation-unrequested-capability")).toBe(true);
  });

  it("rejects preset grants and tool requirements that were not requested by the manifest", () => {
    const result = validateAddOnManifest(
      validManifest({
        grantPresets: [
          {
            id: "bad-preset",
            label: "Bad preset",
            description: "Tries to grant shell without request.",
            grants: [{ capability: "shell", granted: true, scope: "system", revocationBehavior: "hard-stop" }],
          },
        ],
        tools: [
          {
            name: "browser.shell_escape",
            description: "Invalid tool.",
            requiredCapabilities: ["shell"],
            inputSchema: {},
            outputSchema: {},
            audit: { logRequest: true, logResult: true, artifactTypes: ["log"] },
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "preset-grants-unrequested-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "tool-uses-unrequested-capability")).toBe(true);
  });

  it("accepts Engineer setup runbooks only when they stay inside requested capabilities", () => {
    const baseManifest = validManifest();
    const valid = validateAddOnManifest(
      validManifest({
        requestedCapabilities: [
          ...baseManifest.requestedCapabilities,
          { capability: "shell", granted: false, scope: "system", revocationBehavior: "hard-stop" },
        ],
        engineerSetup: {
          documentPath: "addons/browser/ENGINEER_SETUP.md",
          objective: "Install and verify the Browser engine through host-reviewed commands.",
          requiredCapabilities: ["shell", "network"],
          allowedHostCommands: ["browser_engine_status", "browser_engine_install"],
          expectedInputs: ["target platform", "approved install root"],
          expectedOutputs: ["install log", "engine status"],
          requiresHumanApprovalBeforeExecution: true,
          auditLogRequired: true,
        },
      }),
    );

    expect(valid.valid).toBe(true);
    expect(valid.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);

    const invalid = validateAddOnManifest(
      validManifest({
        engineerSetup: {
          documentPath: "addons/browser/ENGINEER_SETUP.md",
          objective: "Invalid setup request.",
          requiredCapabilities: ["shell"],
          allowedHostCommands: ["arbitrary_shell"],
          expectedInputs: ["anything"],
          expectedOutputs: ["anything"],
          requiresHumanApprovalBeforeExecution: true,
          auditLogRequired: true,
        },
      }),
    );

    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "engineer-setup-unrequested-capability")).toBe(true);
  });

  it("accepts orchestration as a first-class add-on category", () => {
    const result = validateAddOnManifest(
      validManifest({
        id: "addon.paperclip",
        name: "Paperclip",
        category: "orchestration",
        description: "Organizational runtime add-on.",
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("accepts Augmentor skills only when they stay inside declared tools and capabilities", () => {
    const baseManifest = validManifest();
    const valid = validateAddOnManifest(
      validManifest({
        requestedCapabilities: [
          ...baseManifest.requestedCapabilities,
          { capability: "agent-delegation", granted: false, scope: "workspace", revocationBehavior: "degrade" },
        ],
        tools: [
          ...(baseManifest.tools ?? []),
          {
            name: "paperclip.create_company_plan",
            description: "Prepare a Paperclip company architecture plan for human approval.",
            requiredCapabilities: ["agent-delegation"],
            inputSchema: {},
            outputSchema: {},
            audit: { logRequest: true, logResult: true, artifactTypes: ["markdown"] },
          },
        ],
        augmentorSkills: [
          {
            documentPath: "addons/paperclip/AUGMENTOR_SKILL.md",
            objective: "Design and approve a Paperclip organization before implementation.",
            requiredCapabilities: ["agent-delegation", "network"],
            requiredTools: ["paperclip.create_company_plan"],
            workflowPhases: ["vision intake", "research", "architecture approval", "implementation"],
            approvalGates: ["approve business architecture", "approve company creation"],
            expectedInputs: ["human intent", "provider policy", "budget constraints"],
            expectedOutputs: ["company architecture", "agent role specs", "delegation packets"],
            producesDelegationPackets: true,
            auditLogRequired: true,
          },
        ],
      }),
    );

    expect(valid.valid).toBe(true);
    expect(valid.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);

    const invalid = validateAddOnManifest(
      validManifest({
        augmentorSkills: [
          {
            documentPath: "addons/paperclip/AUGMENTOR_SKILL.md",
            objective: "Invalid skill.",
            requiredCapabilities: ["providers"],
            requiredTools: ["paperclip.create_company_plan"],
            workflowPhases: ["implementation"],
            approvalGates: ["approval"],
            expectedInputs: ["intent"],
            expectedOutputs: ["company"],
            producesDelegationPackets: true,
            auditLogRequired: true,
          },
        ],
      }),
    );

    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.code === "augmentor-skill-unrequested-capability")).toBe(true);
    expect(invalid.issues.some((issue) => issue.code === "augmentor-skill-unknown-tool")).toBe(true);
  });

  it("warns but does not fail older local-service manifests that have not declared an executable service yet", () => {
    const { service: _service, ...manifest } = validManifest();
    const result = validateAddOnManifest(manifest);

    expect(result.valid).toBe(true);
    expect(result.issues.some((issue) => issue.code === "local-service-entrypoint-missing")).toBe(true);
  });

  it("accepts agent add-on operating contracts learned from Hermes", () => {
    const baseManifest = validManifest();
    const result = validateAddOnManifest(
      validManifest({
        id: "addon.hermes",
        name: "Hermes",
        category: "agent",
        runtimeType: "agent-addon",
        requestedCapabilities: [
          ...baseManifest.requestedCapabilities,
          { capability: "shell", granted: false, scope: "self", revocationBehavior: "degrade" },
          { capability: "providers", granted: false, scope: "shared", revocationBehavior: "degrade" },
          { capability: "archive-read", granted: false, scope: "shared", revocationBehavior: "degrade" },
          { capability: "agent-delegation", granted: false, scope: "workspace", revocationBehavior: "degrade" },
        ],
        tools: [
          ...(baseManifest.tools ?? []),
          {
            name: "hermes.audit",
            description: "Audit Hermes.",
            requiredCapabilities: ["shell"],
            inputSchema: {},
            outputSchema: {},
            audit: { logRequest: true, logResult: true, artifactTypes: ["diagnostic-report"] },
          },
          {
            name: "hermes.install",
            description: "Install Hermes.",
            requiredCapabilities: ["network", "shell"],
            inputSchema: {},
            outputSchema: {},
            audit: { logRequest: true, logResult: true, artifactTypes: ["diagnostic-report", "log"] },
          },
          {
            name: "hermes.chat",
            description: "Chat with Hermes.",
            requiredCapabilities: ["shell", "providers"],
            inputSchema: {},
            outputSchema: {},
            audit: { logRequest: true, logResult: true, artifactTypes: ["summary", "log"] },
          },
          {
            name: "hermes.dashboard",
            description: "Control the Hermes dashboard.",
            requiredCapabilities: ["shell", "ui-embedding"],
            inputSchema: {},
            outputSchema: {},
            audit: { logRequest: true, logResult: true, artifactTypes: ["diagnostic-report", "log"] },
          },
        ],
        install: {
          mode: "detect-existing-or-install",
          detectionTool: "hermes.audit",
          installTool: "hermes.install",
          requiredCapabilities: ["network", "shell"],
          requiresHumanApprovalBeforeInstall: true,
          preservesExistingUserConfig: true,
          credentialSetup: "user-guided",
          auditLogRequired: true,
          expectedArtifacts: ["diagnostic-report", "log"],
        },
        audit: {
          tool: "hermes.audit",
          checks: ["version", "identity", "skills", "memory", "model"],
          requiredCapabilities: ["shell"],
          remediationPolicy: "approval-gated",
          auditLogRequired: true,
        },
        embeddedWorkspace: {
          surfaceId: "browser-workspace",
          mode: "hosted-dashboard",
          autoStart: true,
          settingsVisibility: "hidden-collapsible",
          healthTool: "hermes.dashboard",
          requiredCapabilities: ["shell", "ui-embedding"],
        },
        memoryAccess: {
          archiveReadMode: "retrieval-with-citations",
          archiveWriteMode: "intake-only",
          citationRequired: true,
          directKnowledgeWriteAllowed: false,
        },
        agentRuntime: {
          invocationTool: "hermes.chat",
          chatAuthorLabel: "Hermes",
          displayNameSource: "runtime-profile",
          supportsStreaming: false,
          supportsCancellation: true,
          supportsModelSelection: true,
          outputFiltering: "assistant-reply-only",
          requiredCapabilities: ["shell", "providers"],
          modelSelection: {
            source: "runtime-audit",
            currentModelField: "currentModel",
            selectable: true,
            changeTool: "hermes.chat",
            requiredCapabilities: ["providers"],
          },
        },
        smokeTests: [
          {
            id: "direct-chat",
            tool: "hermes.chat",
            input: { prompt: "Say exactly: HERMES_ONBOARDING_CHECK" },
            expectedOutputPattern: "^HERMES_ONBOARDING_CHECK$",
            timeoutMs: 120000,
            requiredCapabilities: ["shell", "providers"],
          },
        ],
      }),
    );

    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects unsafe agent add-on contracts that would erase existing config or bypass archive boundaries", () => {
    const result = validateAddOnManifest(
      validManifest({
        install: {
          mode: "detect-existing-or-install",
          detectionTool: "browser.open_url",
          installTool: "browser.open_url",
          requiredCapabilities: ["shell"],
          requiresHumanApprovalBeforeInstall: false,
          preservesExistingUserConfig: false,
          credentialSetup: "user-guided",
          auditLogRequired: true,
          expectedArtifacts: ["log"],
        },
        memoryAccess: {
          archiveReadMode: "retrieval-with-citations",
          archiveWriteMode: "intake-only",
          citationRequired: true,
          directKnowledgeWriteAllowed: true as never,
        },
        smokeTests: [
          {
            id: "bad",
            tool: "browser.open_url",
            input: {},
            expectedOutputPattern: "ok",
            timeoutMs: 1000,
            requiredCapabilities: ["shell"],
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "install-must-preserve-existing-config")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "install-requires-human-approval")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "install-unrequested-capability")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "memory-access-knowledge-write-forbidden")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "smoke-test-unrequested-capability")).toBe(true);
  });

  it("rejects a systemSlot claim whose backing capability is not declared (P1-b ungated slot bypass)", () => {
    const result = validateAddOnManifest(
      validManifest({
        // Claims the primary-agent slot but does NOT declare agent-delegation,
        // so the runtime grant gate (activeSystemSlotProvider) can never apply.
        systemSlots: [
          { id: "primary-agent", role: "default-provider", replaceable: true },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.code === "system-slot-undeclared-capability" && issue.path === "systemSlots[0].id",
      ),
    ).toBe(true);
  });

  it("rejects a systemSlot claim with an unknown slot id", () => {
    const result = validateAddOnManifest(
      validManifest({
        systemSlots: [
          { id: "root-controller" as never, role: "default-provider", replaceable: true },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "system-slot-unknown")).toBe(true);
  });

  it("accepts a properly capability-gated systemSlot claim", () => {
    const base = validManifest();
    const result = validateAddOnManifest(
      validManifest({
        // primary-agent's backing capability (agent-delegation) is declared, so
        // the runtime grant gate can apply -> covered.
        requestedCapabilities: [
          ...base.requestedCapabilities,
          { capability: "agent-delegation", granted: false, scope: "system", revocationBehavior: "hard-stop" },
        ],
        systemSlots: [
          { id: "primary-agent", role: "default-provider", replaceable: true },
        ],
      }),
    );

    expect(result.issues.filter((issue) => issue.code.startsWith("system-slot"))).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
