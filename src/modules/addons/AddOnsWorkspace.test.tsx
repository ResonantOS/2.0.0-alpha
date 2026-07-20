// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AddOnManifest, CapabilityGrant, LogicianExecutionArtifact } from "../../core/contracts";
import { buildDefaultState } from "../../core/defaults";
import { AddOnsWorkspace } from "./AddOnsWorkspace";

vi.mock("../../core/runtime", () => ({
  requestBrowserEngineStatus: vi.fn(async () => ({
    installed: false,
    version: null,
    executablePath: null,
    profileDir: null,
    sessionsDir: null,
    activeSessions: [],
    findings: [],
  })),
  requestBrowserInstallEngine: vi.fn(),
}));

const capability = (name: CapabilityGrant["capability"]): CapabilityGrant => ({
  capability: name,
  granted: false,
  scope: name === "archive-intake-write" ? "intake-only" : "shared",
  revocationBehavior: "hard-stop",
});

const createHermesManifest = (): AddOnManifest => ({
  id: "addon.hermes",
  name: "Hermes",
  version: "0.1.0",
  author: "test",
  category: "agent",
  description: "Hermes manifest",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [
    capability("network"),
    capability("shell"),
    capability("ui-embedding"),
    capability("providers"),
    capability("archive-read"),
    capability("archive-intake-write"),
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
});

describe("AddOnsWorkspace Hermes grants", () => {
  it("opens installed add-ons that declare shell navigation", () => {
    const toolManifest: AddOnManifest = {
      id: "addon.custom-tool",
      name: "Custom Tool",
      version: "0.1.0",
      author: "test",
      category: "tool",
      description: "Custom tool manifest",
      runtimeType: "local-service",
      surfaces: [
        {
          id: "custom-tool-page",
          type: "page",
          label: "Custom Tool Console",
          description: "Control the custom tool.",
          shellNavigation: {
            sectionId: "custom-tool",
            dockIcon: "browser",
            eyebrow: "tool",
            order: 70,
          },
        },
      ],
      requestedCapabilities: [capability("filesystem")],
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
    };
    const state = buildDefaultState([toolManifest]);
    state.installations[toolManifest.id].installed = true;
    state.installations[toolManifest.id].enabled = true;
    state.installations[toolManifest.id].status = "enabled";
    const onOpenSurface = vi.fn();

    render(
      <AddOnsWorkspace
        search=""
        sideloadPath=""
        filteredManifests={[toolManifest]}
        installations={state.installations}
        selectedManifest={null}
        selectedInstallation={null}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={vi.fn()}
        onUpdateAddonConfig={vi.fn()}
        onRunLogicianScript={vi.fn()}
        onRunLogicianHook={vi.fn()}
        onAskAugmentor={vi.fn(async () => undefined)}
        onOpenArchiveReview={vi.fn()}
        onOpenSurface={onOpenSurface}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Custom Tool" }));

    expect(onOpenSurface).toHaveBeenCalledWith("custom-tool");
  });

  it("keeps the Hermes quick action scoped to workspace launch capabilities", () => {
    const hermesManifest = createHermesManifest();
    const state = buildDefaultState([hermesManifest]);
    const onGrantCapabilities = vi.fn();

    render(
      <AddOnsWorkspace
        search=""
        sideloadPath=""
        filteredManifests={[hermesManifest]}
        installations={state.installations}
        selectedManifest={null}
        selectedInstallation={null}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={onGrantCapabilities}
        onUpdateAddonConfig={vi.fn()}
        onRunLogicianScript={vi.fn()}
        onRunLogicianHook={vi.fn()}
        onAskAugmentor={vi.fn(async () => undefined)}
        onOpenArchiveReview={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install and grant Hermes workspace access" }));

    expect(onGrantCapabilities).toHaveBeenCalledWith(
      "addon.hermes",
      ["shell", "ui-embedding"],
      hermesManifest.requestedCapabilities,
    );
  });

  it("shows scaffold metadata for packaged workflow add-ons", () => {
    const hermesManifest: AddOnManifest = {
      ...createHermesManifest(),
      workflowBoundaries: [
        {
          id: "delegated-communication",
          label: "Delegated communication",
          jobToBeDone: "Route communication work to Hermes.",
          userValue: "The human can delegate routine messaging safely.",
          repeatability: "workflow-package",
          owner: "addon-agent",
          nonGoals: ["Do not send externally without approval."],
        },
      ],
      skills: [
        {
          id: "communication-skill",
          name: "Communication skill",
          description: "Prepare reviewable communication drafts.",
          documentPath: "docs/skills/hermes.md",
          invocation: "agent-suggested",
          requiredCapabilities: ["shell"],
          requiredTools: [],
        },
      ],
      connectors: [
        {
          id: "hermes-profile",
          name: "Hermes profile",
          type: "local-runtime",
          description: "Connects to local Hermes.",
          requiredCapabilities: ["shell"],
          configScope: "user-config",
        },
      ],
      scripts: [
        {
          id: "hermes-preflight",
          name: "Hermes preflight",
          description: "Checks Hermes before use.",
          commandRef: "hermes.audit",
          runPolicy: "preflight",
          deterministic: true,
          requiredCapabilities: ["shell"],
          producesArtifacts: ["diagnostic-report"],
          requiresHumanApproval: false,
        },
      ],
      hooks: [
        {
          id: "hermes-health",
          event: "health-check",
          handlerRef: "hermes-preflight",
          requiredCapabilities: ["shell"],
          failurePolicy: "degrade",
        },
      ],
    };
    const state = buildDefaultState([hermesManifest]);

    render(
      <AddOnsWorkspace
        search=""
        sideloadPath=""
        filteredManifests={[hermesManifest]}
        installations={state.installations}
        selectedManifest={hermesManifest}
        selectedInstallation={state.installations[hermesManifest.id]}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={vi.fn()}
        onUpdateAddonConfig={vi.fn()}
        onRunLogicianScript={vi.fn(async (): Promise<LogicianExecutionArtifact> => ({
          id: "test-artifact",
          addonId: hermesManifest.id,
          kind: "script" as const,
          targetId: "hermes-preflight",
          label: "Hermes preflight",
          commandRef: "hermes.audit",
          status: "passed" as const,
          summary: "ok",
          detail: "ok",
          requiredCapabilities: [],
          missingCapabilities: [],
          producedArtifacts: [],
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(0).toISOString(),
          durationMs: 0,
          evidence: {},
          verifyAgentReport: {
            schemaVersion: "verify-agent-report/vnext-1",
            status: "warn",
            nextAction: "Review warnings before promoting the result.",
            evidenceTrustCounts: {
              observed: 3,
              "host-reported": 1,
              "self-reported": 1,
              "transcript-claim": 0,
              unknown: 0,
            },
            evidence: [],
            findings: [
              {
                code: "verification-report-not-declared",
                severity: "medium",
                message: "Script does not declare a verification-report artifact.",
                evidenceRefs: ["script:hermes-preflight"],
              },
            ],
          },
        }))}
        onRunLogicianHook={vi.fn()}
        onAskAugmentor={vi.fn(async () => undefined)}
        onOpenArchiveReview={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(screen.getByText("Packaged workflow")).toBeTruthy();
    expect(screen.getByText("Delegated communication")).toBeTruthy();
    expect(screen.getByText("Communication skill")).toBeTruthy();
    expect(screen.getByText("Hermes profile")).toBeTruthy();
    expect(screen.getByText("Hermes preflight")).toBeTruthy();
  });

  it("renders Verify Agent evidence and findings for latest Logician artifacts", () => {
    const hermesManifest: AddOnManifest = {
      ...createHermesManifest(),
      scripts: [
        {
          id: "hermes-preflight",
          name: "Hermes preflight",
          description: "Checks Hermes before use.",
          commandRef: "hermes.audit",
          runPolicy: "preflight",
          deterministic: true,
          requiredCapabilities: ["shell"],
          producesArtifacts: ["diagnostic-report", "verification-report"],
          requiresHumanApproval: false,
        },
      ],
    };
    const state = buildDefaultState([hermesManifest]);
    const artifact: LogicianExecutionArtifact = {
      id: "test-artifact",
      addonId: hermesManifest.id,
      kind: "script",
      targetId: "hermes-preflight",
      label: "Hermes preflight",
      commandRef: "hermes.audit",
      status: "degraded",
      summary: "Hermes compatibility is degraded.",
      detail: "profile needs review",
      requiredCapabilities: ["shell"],
      missingCapabilities: [],
      producedArtifacts: ["diagnostic-report", "verification-report"],
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      durationMs: 0,
      evidence: {},
      verifyAgentReport: {
        schemaVersion: "verify-agent-report/vnext-1",
        status: "warn",
        nextAction: "Hermes profile requires review.",
        evidenceTrustCounts: {
          observed: 3,
          "host-reported": 1,
          "self-reported": 0,
          "transcript-claim": 0,
          unknown: 0,
        },
        evidence: [],
        findings: [
          {
            code: "command-degraded",
            severity: "medium",
            message: "Hermes compatibility is degraded.",
            evidenceRefs: ["command:evidence"],
          },
        ],
      },
    };
    state.installations[hermesManifest.id].verificationArtifacts = [artifact];

    render(
      <AddOnsWorkspace
        search=""
        sideloadPath=""
        filteredManifests={[hermesManifest]}
        installations={state.installations}
        selectedManifest={hermesManifest}
        selectedInstallation={state.installations[hermesManifest.id]}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={vi.fn()}
        onUpdateAddonConfig={vi.fn()}
        onRunLogicianScript={vi.fn()}
        onRunLogicianHook={vi.fn()}
        onAskAugmentor={vi.fn(async () => undefined)}
        onOpenArchiveReview={vi.fn()}
        onOpenSurface={vi.fn()}
      />,
    );

    expect(screen.getByText("Verify Agent: warn")).toBeTruthy();
    expect(screen.getByText(/Hermes profile requires review/i)).toBeTruthy();
    expect(screen.getByText(/host-reported: 1/i)).toBeTruthy();
    expect(screen.getByText(/command-degraded/i)).toBeTruthy();
  });
});
