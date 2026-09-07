// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AddOnInstallation,
  AddOnManifest,
  CapabilityGrant,
  InstallationStatus,
  LogicianExecutionArtifact,
} from "../../core/contracts";
import { buildDefaultState } from "../../core/defaults";
import { AddOnsWorkspace } from "./AddOnsWorkspace";
import type { UninstallAddonResult } from "./controller";

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

const createMinimalManifest = (id: string, name: string): AddOnManifest => ({
  id,
  name,
  version: "0.1.0",
  author: "test",
  category: "tool",
  description: `${name} manifest`,
  runtimeType: "ui-module",
  surfaces: [],
  requestedCapabilities: [],
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

type AddOnsWorkspaceRenderProps = ComponentProps<typeof AddOnsWorkspace>;

const renderWorkspaceProps = (overrides: Partial<AddOnsWorkspaceRenderProps> = {}): AddOnsWorkspaceRenderProps => {
  const fallbackManifest = createMinimalManifest("addon.test", "Test Addon");
  const manifests = overrides.filteredManifests ?? [overrides.selectedManifest ?? fallbackManifest];
  const state = buildDefaultState(manifests);
  const selectedManifest = overrides.selectedManifest ?? manifests[0] ?? null;
  const selectedInstallation =
    overrides.selectedInstallation ?? (selectedManifest ? state.installations[selectedManifest.id] : null);
  return {
    search: "",
    sideloadPath: "",
    filteredManifests: manifests,
    installations: state.installations,
    selectedManifest,
    selectedInstallation,
    uninstallBlock: null,
    onSearchChange: vi.fn(),
    onSideloadPathChange: vi.fn(),
    onSideload: vi.fn(),
    onSelectManifest: vi.fn(),
    onToggleAddonInstall: vi.fn(),
    onToggleGrant: vi.fn(),
    onGrantCapabilities: vi.fn(),
    onUpdateAddonConfig: vi.fn(),
    onUninstallAddon: vi.fn(async (): Promise<UninstallAddonResult> => ({ outcome: "blocked", blockReason: "not-installed" })),
    onRunLogicianScript: vi.fn(),
    onRunLogicianHook: vi.fn(),
    onAskAugmentor: vi.fn(async () => undefined),
    onOpenArchiveReview: vi.fn(),
    onOpenSurface: vi.fn(),
    ...overrides,
  };
};

const renderWorkspace = (overrides: Partial<AddOnsWorkspaceRenderProps> = {}) =>
  render(<AddOnsWorkspace {...renderWorkspaceProps(overrides)} />);

const setInstallationStatus = (installation: AddOnInstallation, status: InstallationStatus): AddOnInstallation => {
  installation.status = status;
  installation.installed = status !== "available" && status !== "uninstalled";
  installation.enabled = status === "enabled";
  return installation;
};

const confirmationCopy =
  "Uninstall clears this add-on's grants, private provider links, and settings. It keeps source files, Living Archive intake/review records, delegation packets, drafts, and result artifacts. Review those records separately before deleting them.";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
        uninstallBlock={null}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={vi.fn()}
        onUpdateAddonConfig={vi.fn()}
        onUninstallAddon={vi.fn()}
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
        uninstallBlock={null}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={onGrantCapabilities}
        onUpdateAddonConfig={vi.fn()}
        onUninstallAddon={vi.fn()}
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
        uninstallBlock={null}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={vi.fn()}
        onUpdateAddonConfig={vi.fn()}
        onUninstallAddon={vi.fn()}
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
        uninstallBlock={null}
        onSearchChange={vi.fn()}
        onSideloadPathChange={vi.fn()}
        onSideload={vi.fn()}
        onSelectManifest={vi.fn()}
        onToggleAddonInstall={vi.fn()}
        onToggleGrant={vi.fn()}
        onGrantCapabilities={vi.fn()}
        onUpdateAddonConfig={vi.fn()}
        onUninstallAddon={vi.fn()}
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

describe("AddOnsWorkspace uninstall lifecycle", () => {
  it.each(["installed", "enabled", "disabled", "degraded", "update-available", "incompatible"] as const)(
    "shows Uninstall for installed add-ons in %s status",
    (status) => {
      const manifest = createMinimalManifest(`addon.${status}`, `${status} Addon`);
      const state = buildDefaultState([manifest]);
      setInstallationStatus(state.installations[manifest.id], status);

      renderWorkspace({
        filteredManifests: [manifest],
        installations: state.installations,
        selectedManifest: manifest,
        selectedInstallation: state.installations[manifest.id],
      });

      const button = screen.getByRole("button", { name: `Uninstall ${manifest.name}` }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    },
  );

  it("hides Uninstall for available and uninstalled add-ons", () => {
    for (const status of ["available", "uninstalled"] as const) {
      const manifest = createMinimalManifest(`addon.${status}`, `${status} Addon`);
      const state = buildDefaultState([manifest]);
      setInstallationStatus(state.installations[manifest.id], status);
      const view = renderWorkspace({
        filteredManifests: [manifest],
        installations: state.installations,
        selectedManifest: manifest,
        selectedInstallation: state.installations[manifest.id],
      });

      expect(screen.queryByRole("button", { name: `Uninstall ${manifest.name}` })).toBeNull();
      view.unmount();
    }
  });

  it("disables Uninstall for a blocked active bundled default and shows the slot reason", () => {
    const manifest = createMinimalManifest("addon.default", "Default Agent");
    const state = buildDefaultState([manifest]);
    setInstallationStatus(state.installations[manifest.id], "enabled");

    renderWorkspace({
      filteredManifests: [manifest],
      installations: state.installations,
      selectedManifest: manifest,
      selectedInstallation: state.installations[manifest.id],
      uninstallBlock: { blockReason: "active-system-slot-provider", blockDetail: "primary-agent, chat-interface" },
    });

    const button = screen.getByRole("button", { name: "Uninstall Default Agent" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = screen.getByText(
      "Default Agent currently provides the primary-agent, chat-interface slot(s). Select another provider for those slots before uninstalling.",
    );
    expect(reason).toBeTruthy();
    // The disabled button must point screen readers at its reason.
    expect(reason.id).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("confirmation copy states config is deleted and user data retained", () => {
    const manifest = createMinimalManifest("addon.confirm", "Confirm Addon");
    const state = buildDefaultState([manifest]);
    setInstallationStatus(state.installations[manifest.id], "enabled");
    const onUninstallAddon = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    renderWorkspace({
      filteredManifests: [manifest],
      installations: state.installations,
      selectedManifest: manifest,
      selectedInstallation: state.installations[manifest.id],
      onUninstallAddon,
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Confirm Addon" }));

    expect(confirm).toHaveBeenCalledWith(confirmationCopy);
    expect(onUninstallAddon).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("calls the uninstall handler after confirmation and shows the counts-only result", async () => {
    const manifest = createMinimalManifest("addon.clean", "Clean Addon");
    const state = buildDefaultState([manifest]);
    setInstallationStatus(state.installations[manifest.id], "enabled");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onUninstallAddon = vi.fn(async (): Promise<UninstallAddonResult> => ({
      outcome: "uninstalled",
      audit: {
        at: "2026-09-07T12:00:00.000Z",
        event: "addonUninstalled",
        addonId: manifest.id,
        source: "bundled",
        previousStatus: "enabled",
        previousInstalled: true,
        previousEnabled: true,
        clearedCapabilities: ["network", "shell"],
        clearedPrivateProviderProfileIds: 3,
        configDeleted: true,
        userDataRetained: true,
        alsoDeleteUserDataOffered: false,
        actor: "human",
      },
    }));

    renderWorkspace({
      filteredManifests: [manifest],
      installations: state.installations,
      selectedManifest: manifest,
      selectedInstallation: state.installations[manifest.id],
      onUninstallAddon,
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Clean Addon" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("2 grant(s) cleared"));
    expect(screen.getByRole("status").textContent).toContain("settings deleted");
    expect(screen.getByRole("status").textContent).toContain("user data retained");
    expect(screen.queryByText(/private-profile|secret-config-value/i)).toBeNull();
    confirm.mockRestore();
  });

  it('shows "settings were not set" when configDeleted is false', async () => {
    const manifest = createMinimalManifest("addon.no-config", "No Config Addon");
    const state = buildDefaultState([manifest]);
    setInstallationStatus(state.installations[manifest.id], "enabled");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWorkspace({
      filteredManifests: [manifest],
      installations: state.installations,
      selectedManifest: manifest,
      selectedInstallation: state.installations[manifest.id],
      onUninstallAddon: vi.fn(async (): Promise<UninstallAddonResult> => ({
        outcome: "uninstalled",
        audit: {
          at: "2026-09-07T12:00:00.000Z",
          event: "addonUninstalled",
          addonId: manifest.id,
          source: "bundled",
          previousStatus: "enabled",
          previousInstalled: true,
          previousEnabled: true,
          clearedCapabilities: [],
          clearedPrivateProviderProfileIds: 0,
          configDeleted: false,
          userDataRetained: true,
          alsoDeleteUserDataOffered: false,
          actor: "human",
        },
      })),
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall No Config Addon" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("settings were not set"));
    confirm.mockRestore();
  });

  it("shows the block reason when the handler reports running work", async () => {
    const manifest = createMinimalManifest("addon.running", "Running Addon");
    const state = buildDefaultState([manifest]);
    setInstallationStatus(state.installations[manifest.id], "enabled");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWorkspace({
      filteredManifests: [manifest],
      installations: state.installations,
      selectedManifest: manifest,
      selectedInstallation: state.installations[manifest.id],
      onUninstallAddon: vi.fn(async (): Promise<UninstallAddonResult> => ({
        outcome: "blocked",
        blockReason: "running-work-not-stopped",
        blockDetail: "Work is still running.",
      })),
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Running Addon" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Work is still running."));
    confirm.mockRestore();
  });

  it("keeps the pending state on the add-on that was uninstalled when the selection changes", async () => {
    const first = createMinimalManifest("addon.first", "First Addon");
    const second = createMinimalManifest("addon.second", "Second Addon");
    const state = buildDefaultState([first, second]);
    setInstallationStatus(state.installations[first.id], "enabled");
    setInstallationStatus(state.installations[second.id], "enabled");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveUninstall: (result: UninstallAddonResult) => void = () => undefined;
    const uninstallPromise = new Promise<UninstallAddonResult>((resolve) => {
      resolveUninstall = resolve;
    });
    const onUninstallAddon = vi.fn(() => uninstallPromise);
    const props = {
      filteredManifests: [first, second],
      installations: state.installations,
      onUninstallAddon,
    };
    const view = renderWorkspace({
      ...props,
      selectedManifest: first,
      selectedInstallation: state.installations[first.id],
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall First Addon" }));
    expect((screen.getByRole("button", { name: "Uninstalling…" }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(
      <AddOnsWorkspace
        {...(renderWorkspaceProps({
          ...props,
          selectedManifest: second,
          selectedInstallation: state.installations[second.id],
        }))}
      />,
    );

    expect(screen.queryByRole("button", { name: "Uninstalling…" })).toBeNull();
    expect((screen.getByRole("button", { name: "Uninstall Second Addon" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      resolveUninstall({ outcome: "blocked", blockReason: "running-work-not-stopped", blockDetail: "still running" });
      await uninstallPromise;
    });
    confirm.mockRestore();
  });

  it("discards an uninstall result that arrives for a different add-on than the selection", async () => {
    const first = createMinimalManifest("addon.first", "First Addon");
    const second = createMinimalManifest("addon.second", "Second Addon");
    const state = buildDefaultState([first, second]);
    setInstallationStatus(state.installations[first.id], "enabled");
    setInstallationStatus(state.installations[second.id], "enabled");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let resolveUninstall: (result: UninstallAddonResult) => void = () => undefined;
    const uninstallPromise = new Promise<UninstallAddonResult>((resolve) => {
      resolveUninstall = resolve;
    });
    const props = {
      filteredManifests: [first, second],
      installations: state.installations,
      onUninstallAddon: vi.fn(() => uninstallPromise),
    };
    const view = renderWorkspace({
      ...props,
      selectedManifest: first,
      selectedInstallation: state.installations[first.id],
    });

    fireEvent.click(screen.getByRole("button", { name: "Uninstall First Addon" }));
    view.rerender(
      <AddOnsWorkspace
        {...(renderWorkspaceProps({
          ...props,
          selectedManifest: second,
          selectedInstallation: state.installations[second.id],
        }))}
      />,
    );

    await act(async () => {
      resolveUninstall({
        outcome: "blocked",
        blockReason: "running-work-not-stopped",
        blockDetail: "First add-on is still running.",
      });
      await uninstallPromise;
    });

    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(
      <AddOnsWorkspace
        {...(renderWorkspaceProps({
          ...props,
          selectedManifest: first,
          selectedInstallation: state.installations[first.id],
        }))}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    confirm.mockRestore();
  });
});
