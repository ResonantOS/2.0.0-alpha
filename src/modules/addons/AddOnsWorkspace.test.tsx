// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AddOnInstallation,
  AddOnManifest,
  CapabilityGrant,
  InstallationStatus,
  LogicianExecutionArtifact,
} from "../../core/contracts";
import { createHarnessClient, type HarnessProjection } from "../../core/harness-client";
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


describe("host harness management", () => {
  const runtime = (adapterId: string): AddOnManifest["agentRuntime"] => ({
    adapterVersion: 1, adapterId, authScheme: "none", supportedOperations: ["invoke", "history"],
    contextRoleFidelity: "text-only", toolCallbacks: false, invocationTool: "harness.invoke",
    chatAuthorLabel: "Harness", displayNameSource: "manifest", supportsStreaming: false,
    supportsCancellation: false, supportsModelSelection: false, outputFiltering: "assistant-reply-only",
    requiredCapabilities: ["agent-runtime"],
  });
  const dsh = { ...createMinimalManifest("addon.dsh", "DSH"), requestedCapabilities: [capability("agent-runtime")], agentRuntime: runtime("dsh-typert-v1") };
  const provider = { ...createMinimalManifest("addon.provider", "Provider Chat Demo"), agentRuntime: runtime("provider-fabric-v1") };
  const projection = (revision = 0): HarnessProjection => ({
    bootEpoch: "boot-a", revision, governanceActivated: false, candidates: [dsh, provider],
    installations: {}, slots: { "primary-agent": { addonId: null, generation: 0, available: false } },
  });
  const deferred = () => {
    let resolve!: (value: HarnessProjection) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<HarnessProjection>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const setup = () => {
    const read = deferred();
    const invoke = vi.fn().mockReturnValueOnce(read.promise);
    const client = createHarnessClient({ invoke });
    renderWorkspace({ harnessClient: client });
    return { read, invoke, client };
  };
  const card = (name: string) => within(screen.getByRole("region", { name }));
  const installed = (value: HarnessProjection, manifest: AddOnManifest) => {
    value.installations = { ...value.installations, [manifest.id]: {
      addonId: manifest.id, installed: true, enabled: true,
      grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: false })),
      disabledOperations: [], hiddenSurfaceIds: [],
    } };
    return value;
  };

  it("management follows host acknowledgements", async () => {
    const { read, invoke } = setup();
    expect(screen.queryByText("Harness management")).toBeNull();
    expect(screen.queryByRole("region", { name: "Import harness manifest" })).toBeNull();
    expect(screen.queryByRole("region", { name: "DSH" })).toBeNull();
    await act(async () => read.resolve(projection()));
    const install = deferred();
    invoke.mockReturnValueOnce(install.promise);
    fireEvent.click(card("DSH").getByRole("button", { name: "Install" }));
    expect(invoke).toHaveBeenLastCalledWith("harness_install", { manifest: dsh, enabled: true });
    expect(card("DSH").queryByRole("button", { name: "Grant" })).toBeNull();
    expect(screen.getByText("Pending: Install")).toBeTruthy();
    const first = installed(projection(1), dsh);
    await act(async () => install.resolve(first));
    expect(card("DSH").getByText("Not granted")).toBeTruthy();
    const grant = deferred();
    invoke.mockReturnValueOnce(grant.promise);
    fireEvent.click(card("DSH").getByRole("button", { name: "Grant" }));
    expect(invoke).toHaveBeenLastCalledWith("harness_grants", {
      addonId: dsh.id, grants: [{ ...capability("agent-runtime"), granted: true }], consent: true, expectedRevision: 1,
    });
    expect(card("DSH").getByText("Not granted")).toBeTruthy();
    expect(screen.getByText("Current owner: None · Unavailable")).toBeTruthy();
    const second = installed(projection(2), dsh);
    second.installations[dsh.id].grantedCapabilities[0].granted = true;
    await act(async () => grant.resolve(second));
    expect(card("DSH").getByText("Granted")).toBeTruthy();
    const assign = deferred();
    invoke.mockReturnValueOnce(assign.promise);
    fireEvent.click(card("DSH").getByRole("button", { name: "Make primary" }));
    expect(invoke).toHaveBeenLastCalledWith("harness_assign_slot", {
      slot: "primary-agent", addonId: dsh.id, expectedGeneration: 0, replace: false,
    });
    expect(screen.getByText("Current owner: None · Unavailable")).toBeTruthy();
    const third = { ...second, revision: 3, slots: { "primary-agent": { addonId: dsh.id, generation: 1, available: true } } };
    await act(async () => assign.resolve(third));
    expect(screen.getByText("Current owner: DSH · Available")).toBeTruthy();
    const addProvider = deferred();
    invoke.mockReturnValueOnce(addProvider.promise);
    fireEvent.click(card("Provider Chat Demo").getByRole("button", { name: "Install" }));
    const fourth = installed({ ...third, revision: 4 }, provider);
    await act(async () => addProvider.resolve(fourth));
    const replace = deferred();
    invoke.mockReturnValueOnce(replace.promise);
    fireEvent.click(card("Provider Chat Demo").getByRole("button", { name: "Replace" }));
    expect(invoke).toHaveBeenLastCalledWith("harness_assign_slot", {
      slot: "primary-agent", addonId: provider.id, expectedGeneration: 1, replace: true,
    });
    expect(screen.getByText("Current owner: DSH · Available")).toBeTruthy();
    const fifth = { ...fourth, revision: 5, slots: { "primary-agent": { addonId: provider.id, generation: 2, available: true } } };
    await act(async () => replace.resolve(fifth));
    const remove = deferred();
    invoke.mockReturnValueOnce(remove.promise);
    fireEvent.click(card("DSH").getByRole("button", { name: "Remove" }));
    expect(invoke).toHaveBeenLastCalledWith("harness_remove", { addonId: dsh.id });
    expect(card("DSH").getByText("Granted")).toBeTruthy();
    const sixth = { ...fifth, revision: 6, installations: { [provider.id]: fifth.installations[provider.id] } };
    await act(async () => remove.resolve(sixth));
    expect(card("DSH").getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("refetches ownership conflicts and displays the host refusal when removing the active owner", async () => {
    const { read, invoke } = setup();
    const value = installed(projection(1), dsh);
    value.slots = { "primary-agent": { addonId: dsh.id, generation: 7, available: true } };
    await act(async () => read.resolve(value));
    const refresh = deferred();
    invoke.mockRejectedValueOnce(Object.assign(new Error("Runtime ownership changed."), { code: "ownership-conflict" }))
      .mockReturnValueOnce(refresh.promise);
    fireEvent.click(card("DSH").getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Runtime ownership changed.")).toBeTruthy();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("harness_registry"));
    expect(screen.getByText(/Conflict: refreshing/)).toBeTruthy();
    expect(card("DSH").getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByText("Current owner: DSH · Available")).toBeTruthy();
    await act(async () => refresh.resolve({ ...value, revision: 2 }));
    expect(screen.queryByText(/Conflict:/)).toBeNull();
    expect(card("DSH").getByRole("button", { name: "Remove" })).toBeEnabled();
    expect(screen.getByLabelText("Import JSON manifest")).toBeEnabled();
    expect(screen.getByText("Runtime ownership changed.")).toBeTruthy();
    expect(screen.getByText("Current owner: DSH · Available")).toBeTruthy();
  });

  it("retains a conflict after failed refetches until a successful manual refresh", async () => {
    const { read, invoke } = setup();
    const value = installed(projection(1), dsh);
    await act(async () => read.resolve(value));
    invoke.mockRejectedValueOnce(Object.assign(new Error("conflict"), { code: "ownership-conflict" }))
      .mockRejectedValueOnce(new Error("refresh failed"));
    fireEvent.click(card("DSH").getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Conflict: review/)).toBeTruthy();
    expect(card("DSH").getByRole("button", { name: "Remove" })).toBeDisabled();
    const retry = deferred();
    invoke.mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh harnesses" }));
    expect(screen.getByText(/Conflict: refreshing/)).toBeTruthy();
    await act(async () => retry.reject(new Error("retry failed")));
    expect(screen.getByText(/Conflict: review/)).toBeTruthy();
    invoke.mockResolvedValueOnce({ ...value, revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh harnesses" }));
    await waitFor(() => expect(card("DSH").getByRole("button", { name: "Remove" })).toBeEnabled());
    expect(screen.queryByText(/Conflict:/)).toBeNull();
  });

  it("lists DSH display-only features within its projected owner card", async () => {
    const { read } = setup();
    const value = installed(projection(), dsh);
    value.slots = { "primary-agent": { addonId: dsh.id, generation: 1, available: true } };
    await act(async () => read.resolve(value));
    const unavailable = within(card("DSH").getByRole("list", { name: "Unavailable harness operations" }));
    expect(unavailable.getAllByRole("listitem")).toHaveLength(3);
    for (const label of ["Browser tools", "Approval waterfall", "Plugin-only augmentor actions"]) {
      expect(unavailable.getByText(`${label} — Unavailable`)).toBeTruthy();
    }
    expect(card("Provider Chat Demo").queryByRole("list", { name: "Unavailable harness operations" })).toBeNull();
  });

  it.each(["provider-fabric-v1", "unknown-adapter", "toString"])("shows no DSH labels for projected adapter %s", async adapterId => {
    const { read } = setup();
    const candidate = { ...provider, agentRuntime: runtime(adapterId) };
    const value = installed({ ...projection(), candidates: [candidate] }, candidate);
    value.slots = { "primary-agent": { addonId: candidate.id, generation: 1, available: true } };
    await act(async () => read.resolve(value));
    expect(screen.queryByRole("list", { name: "Unavailable harness operations" })).toBeNull();
    expect(screen.queryByText("Browser tools — Unavailable")).toBeNull();
  });

  it("shows no unavailable operations before the host projection loads", async () => {
    const { read } = setup();
    expect(screen.queryByRole("list", { name: "Unavailable harness operations" })).toBeNull();
    await act(async () => read.reject(new Error("offline")));
    expect(screen.queryByRole("list", { name: "Unavailable harness operations" })).toBeNull();
  });

  it.each([dsh, provider])("lists projected disabled contract operations under the same heading for $name", async manifest => {
    const { read } = setup();
    const value = installed({ ...projection(), candidates: [manifest] }, manifest);
    value.installations = { [manifest.id]: { ...value.installations[manifest.id], disabledOperations: ["history"] } };
    await act(async () => read.resolve(value));
    const unavailable = within(card(manifest.name).getByRole("list", { name: "Unavailable harness operations" }));
    expect(unavailable.getByText("history — Unavailable")).toBeTruthy();
    expect(unavailable.getAllByRole("listitem")).toHaveLength(manifest === dsh ? 4 : 1);
  });

  it.each(["invalid-manifest", "ownership-conflict"])("clears the selected import after host %s and requires a new file", async code => {
    const { read, invoke } = setup();
    await act(async () => read.resolve(projection()));
    const response = deferred();
    const refresh = deferred();
    invoke.mockReturnValueOnce(response.promise);
    if (code === "ownership-conflict") invoke.mockReturnValueOnce(refresh.promise);
    const input = screen.getByLabelText("Import JSON manifest") as HTMLInputElement;
    const install = card("Import harness manifest").getByRole("button", { name: "Install" });
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(dsh)], "manifest.json")] } });
    // jsdom's synthetic file selection does not populate the browser's fake path.
    Object.defineProperty(input, "value", { configurable: true, writable: true, value: "C:\\fakepath\\manifest.json" });
    fireEvent.click(install);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("harness_install", { manifest: dsh, enabled: true }));
    await act(async () => response.reject(Object.assign(new Error("private-host-detail"), { code })));
    expect(input.value).toBe("");
    expect(install).toBeDisabled();
    if (code === "ownership-conflict") await act(async () => refresh.resolve(projection(1)));
    expect(input).toBeEnabled();
    expect(install).toBeDisabled();
    const calls = invoke.mock.calls.length;
    fireEvent.click(install);
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(document.body.textContent).not.toContain("private-host-detail");
    invoke.mockResolvedValueOnce(projection(2));
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(provider)], "new.json")] } });
    expect(install).toBeEnabled();
    fireEvent.click(install);
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("harness_install", { manifest: provider, enabled: true }));
    await waitFor(() => expect(install).toBeDisabled());
  });

  it("imports bounded JSON once and lets only the host validate and project it", async () => {
    const { read, invoke } = setup();
    await act(async () => read.resolve({ ...projection(), candidates: [] }));
    const raw = JSON.stringify({ ...dsh, requestedCapabilities: [{ ...capability("agent-runtime"), granted: true }], token: "never-render-this-token" });
    const expectedManifest = JSON.parse(raw);
    const parse = vi.spyOn(JSON, "parse");
    const response = deferred();
    invoke.mockReturnValueOnce(response.promise);
    fireEvent.change(screen.getByLabelText("Import JSON manifest"), { target: { files: [new File([raw], "manifest.json")] } });
    fireEvent.click(card("Import harness manifest").getByRole("button", { name: "Install" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("harness_install", { manifest: expectedManifest, enabled: true }));
    expect(parse.mock.calls.filter(([input]) => input === raw).length).toBe(1);
    expect(screen.queryByText("DSH")).toBeNull();
    expect(document.body.textContent).not.toContain("never-render-this-token");
    const value = installed({ ...projection(1), candidates: [] }, dsh);
    await act(async () => response.resolve(value));
    expect(card(dsh.id).getByText("Not granted")).toBeTruthy();
  });

  it("rejects oversized and malformed imports without sending commands or echoing input", async () => {
    const { read, invoke } = setup();
    await act(async () => read.resolve(projection()));
    fireEvent.change(screen.getByLabelText("Import JSON manifest"), { target: { files: [new File(["x".repeat(262145)], "large.json")] } });
    fireEvent.click(card("Import harness manifest").getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Manifest must be at most 256 KiB.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Import JSON manifest"), { target: { files: [new File(["private-token-invalid-json"], "bad.json")] } });
    fireEvent.click(card("Import harness manifest").getByRole("button", { name: "Install" }));
    expect(await screen.findByText("Manifest must be valid JSON.")).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-token-invalid-json");
  });

  it("renders nothing while the harness projection is null, then displays the loaded registry", async () => {
    const { read, invoke } = setup();
    expect(screen.queryByText("Harness management")).toBeNull();
    expect(screen.queryByRole("region", { name: "Import harness manifest" })).toBeNull();
    expect(screen.queryByLabelText("Import JSON manifest")).toBeNull();
    await act(async () => read.resolve(projection()));
    expect(screen.getByRole("heading", { name: "Harness management" })).toBeTruthy();
    expect(screen.getByLabelText("Import JSON manifest")).toBeEnabled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refreshes only once under StrictMode and waits for refresh before showing a cached registry", async () => {
    const read = deferred();
    const client = createHarnessClient();
    client.applySnapshot(projection());
    const refresh = vi.spyOn(client, "refresh").mockReturnValue(read.promise);
    render(<StrictMode><AddOnsWorkspace {...renderWorkspaceProps({ harnessClient: client })} /></StrictMode>);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Harness management")).toBeNull();
    await act(async () => read.reject(Object.assign(new Error("Unsupported"), { code: "unsupported-operation" })));
    expect(screen.queryByText("Harness management")).toBeNull();
    await act(async () => { client.applySnapshot(projection(1)); });
    expect(screen.getByRole("heading", { name: "Harness management" })).toBeTruthy();
    expect(screen.getByLabelText("Import JSON manifest")).toBeEnabled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("renders nothing after an absent registry without retrying and accepts a later projection event", async () => {
    const read = deferred();
    const client = createHarnessClient();
    const refresh = vi.spyOn(client, "refresh").mockReturnValueOnce(read.promise);
    renderWorkspace({ harnessClient: client });
    await act(async () => read.resolve(null as unknown as HarnessProjection));
    expect(screen.queryByText("Harness management")).toBeNull();
    expect(screen.queryByRole("region", { name: "Import harness manifest" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh harnesses" })).toBeNull();
    expect(screen.queryByText("No host candidates.")).toBeNull();
    await act(async () => { client.applySnapshot({ ...projection(), candidates: [] }); });
    expect(screen.getByText("No host candidates.")).toBeTruthy();
    expect(screen.getByLabelText("Import JSON manifest")).toBeEnabled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retains keyboard focus on the import control while a host command is pending and after acknowledgement", async () => {
    const { read, invoke } = setup();
    await act(async () => read.resolve(projection()));
    const input = screen.getByLabelText("Import JSON manifest");
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(dsh)], "manifest.json")] } });
    input.focus();
    expect(input).toHaveFocus();
    const response = deferred();
    invoke.mockReturnValueOnce(response.promise);
    fireEvent.click(card("Import harness manifest").getByRole("button", { name: "Install" }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith("harness_install", { manifest: dsh, enabled: true }));
    expect(screen.getByText("Pending: Install")).toBeTruthy();
    expect(input).toHaveFocus();
    await act(async () => response.resolve(installed(projection(1), dsh)));
    expect(screen.queryByText("Pending: Install")).toBeNull();
    expect(input).toHaveFocus();
    expect(input).toBeEnabled();
  });

  it("shows unavailable operations as read-only and never renders raw transport errors", async () => {
    const { read, invoke } = setup();
    await act(async () => read.resolve(installed(projection(), dsh)));
    for (const text of ["Browser tools — Unavailable", "Approval waterfall — Unavailable", "Plugin-only augmentor actions — Unavailable"]) {
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: text })).toBeNull();
    }
    invoke.mockRejectedValueOnce(new Error("Authorization: secret-canary"));
    fireEvent.click(card("DSH").getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Runtime unavailable.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("secret-canary");
  });
});
