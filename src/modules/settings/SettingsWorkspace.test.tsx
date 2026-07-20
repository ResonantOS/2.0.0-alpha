// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddOnManifest, CapabilityGrant } from "../../core/contracts";
import { buildDefaultState } from "../../core/defaults";
import { SettingsWorkspace } from "./SettingsWorkspace";

const capability = (name: CapabilityGrant["capability"]): CapabilityGrant => ({
  capability: name,
  granted: false,
  scope: name === "archive-intake-write" ? "intake-only" : "shared",
  revocationBehavior: "hard-stop",
});

const logicianManifest = (): AddOnManifest => ({
  id: "addon.logician",
  name: "Logician",
  version: "0.1.0",
  author: "test",
  category: "knowledge",
  description: "Policy and reasoning rules engine.",
  runtimeType: "local-service",
  surfaces: [],
  requestedCapabilities: [capability("filesystem"), capability("archive-read")],
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  archiveIntegration: {
    readScopes: ["constitution", "protocols"],
    intakeWriteScopes: [],
    canRequestIngest: false,
    canWriteKnowledgePages: false,
  },
  health: { strategy: "policy-engine" },
  installHooks: {},
  workflowBoundaries: [],
  scripts: [
    {
      id: "logician-policy-check",
      name: "Logician policy check",
      description: "Run deterministic policy check.",
      commandRef: "logician.policy_check",
      runPolicy: "on-demand",
      deterministic: true,
      requiredCapabilities: ["filesystem", "archive-read"],
      producesArtifacts: ["verification-report"],
      requiresHumanApproval: false,
    },
  ],
  hooks: [
    {
      id: "before-task-complete-policy-check",
      event: "before-task-complete",
      handlerRef: "logician-policy-check",
      requiredCapabilities: ["filesystem", "archive-read"],
      failurePolicy: "block",
    },
  ],
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
});

afterEach(() => {
  cleanup();
});

describe("SettingsWorkspace strategy planner", () => {
  it("keeps user-facing sections at the top level and internals behind Advanced", () => {
    const state = buildDefaultState([]);

    render(
      <SettingsWorkspace
        state={state}
        manifests={[]}
        settingsSection="profile"
        settingsNotice={null}
        providerDiagnostics={[]}
        providerDiagnosticsBusy={false}
        activeProviderProbeId={null}
        providerSmokeResults={{}}
        providerSmokeBusyId={null}
        providerDrafts={{}}
        memoryServiceStatus={null}
        memoryServiceBusy={false}
        memoryServiceLastResult={null}
        onSettingsSectionChange={vi.fn()}
        onUpdateProvider={vi.fn()}
        onCreateProvider={vi.fn()}
        onUpdateWorkloadStrategy={vi.fn()}
        onUpdateWorkloadStrategyRoute={vi.fn()}
        onProviderDraftChange={vi.fn()}
        onSaveProviderSecret={vi.fn()}
        onProbeProvider={vi.fn()}
        onProbeAllProviders={vi.fn()}
        onSetupProvider={vi.fn()}
        onSmokeTestProvider={vi.fn()}
        onRefreshMemoryServiceStatus={vi.fn()}
        onStartMemoryService={vi.fn()}
        onStopMemoryService={vi.fn()}
        onOpenLogicianAddOn={vi.fn()}
      />,
    );

    const primaryNav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(primaryNav).getByRole("button", { name: /Profile/i })).toBeTruthy();
    expect(within(primaryNav).getByRole("button", { name: /Providers/i })).toBeTruthy();
    expect(within(primaryNav).getByRole("button", { name: /Memory/i })).toBeTruthy();
    expect(within(primaryNav).getByRole("button", { name: /Browser Control/i })).toBeTruthy();
    expect(within(primaryNav).getByRole("button", { name: /Add-ons/i })).toBeTruthy();
    expect(within(primaryNav).getByRole("button", { name: /Privacy/i })).toBeTruthy();
    expect(within(primaryNav).getByRole("button", { name: /Advanced/i })).toBeTruthy();
    expect(within(primaryNav).queryByRole("button", { name: /Strategy/i })).toBeNull();
    expect(within(primaryNav).queryByRole("button", { name: /Logician/i })).toBeNull();
    expect(within(primaryNav).queryByRole("button", { name: /Defaults/i })).toBeNull();
    expect(within(primaryNav).queryByRole("button", { name: /Shell/i })).toBeNull();
  });

  it("lets the user change the workload primary route and failure behavior", () => {
    const onUpdateWorkloadStrategy = vi.fn();
    const onUpdateWorkloadStrategyRoute = vi.fn();
    const state = buildDefaultState([]);

    render(
      <SettingsWorkspace
        state={state}
        manifests={[]}
        settingsSection="advanced"
        settingsNotice={null}
        providerDiagnostics={[]}
        providerDiagnosticsBusy={false}
        activeProviderProbeId={null}
        providerSmokeResults={{}}
        providerSmokeBusyId={null}
        providerDrafts={{}}
        memoryServiceStatus={null}
        memoryServiceBusy={false}
        memoryServiceLastResult={null}
        onSettingsSectionChange={vi.fn()}
        onUpdateProvider={vi.fn()}
        onCreateProvider={vi.fn()}
        onUpdateWorkloadStrategy={onUpdateWorkloadStrategy}
        onUpdateWorkloadStrategyRoute={onUpdateWorkloadStrategyRoute}
        onProviderDraftChange={vi.fn()}
        onSaveProviderSecret={vi.fn()}
        onProbeProvider={vi.fn()}
        onProbeAllProviders={vi.fn()}
        onSetupProvider={vi.fn()}
        onSmokeTestProvider={vi.fn()}
        onRefreshMemoryServiceStatus={vi.fn()}
        onStartMemoryService={vi.fn()}
        onStopMemoryService={vi.fn()}
        onOpenLogicianAddOn={vi.fn()}
      />,
    );

    const advancedNav = screen.getByRole("navigation", { name: "Advanced settings sections" });
    fireEvent.click(within(advancedNav).getByRole("button", { name: /Routing/i }));

    const routineCard = screen.getByText("Routine Background Work").closest("article");
    expect(routineCard).toBeTruthy();
    const controls = routineCard!.querySelectorAll("select");

    fireEvent.change(controls[0], { target: { value: "gx10-local-llama::node-gx10-qwen::Qwen3.6-35B-A3B-Q4_K_M.gguf" } });
    fireEvent.change(controls[2], { target: { value: "hard-stop" } });

    expect(onUpdateWorkloadStrategyRoute).toHaveBeenCalledWith(
      "strategy-routine-background",
      "gx10-local-llama::node-gx10-qwen::Qwen3.6-35B-A3B-Q4_K_M.gguf",
    );
    expect(onUpdateWorkloadStrategy).toHaveBeenCalledWith("strategy-routine-background", {
      hardStopWhenNoFallback: true,
    });
  });

  it("shows Logician protocol, gate, and evidence settings", () => {
    const manifest = logicianManifest();
    const state = buildDefaultState([manifest]);

    render(
      <SettingsWorkspace
        state={state}
        manifests={[manifest]}
        settingsSection="advanced"
        settingsNotice={null}
        providerDiagnostics={[]}
        providerDiagnosticsBusy={false}
        activeProviderProbeId={null}
        providerSmokeResults={{}}
        providerSmokeBusyId={null}
        providerDrafts={{}}
        memoryServiceStatus={null}
        memoryServiceBusy={false}
        memoryServiceLastResult={null}
        onSettingsSectionChange={vi.fn()}
        onUpdateProvider={vi.fn()}
        onCreateProvider={vi.fn()}
        onUpdateWorkloadStrategy={vi.fn()}
        onUpdateWorkloadStrategyRoute={vi.fn()}
        onProviderDraftChange={vi.fn()}
        onSaveProviderSecret={vi.fn()}
        onProbeProvider={vi.fn()}
        onProbeAllProviders={vi.fn()}
        onSetupProvider={vi.fn()}
        onSmokeTestProvider={vi.fn()}
        onRefreshMemoryServiceStatus={vi.fn()}
        onStartMemoryService={vi.fn()}
        onStopMemoryService={vi.fn()}
        onOpenLogicianAddOn={vi.fn()}
      />,
    );

    const advancedNav = screen.getByRole("navigation", { name: "Advanced settings sections" });
    fireEvent.click(within(advancedNav).getByRole("button", { name: /Logician/i }));

    expect(screen.getByText("Logician Trust Kernel")).toBeTruthy();
    expect(screen.getByText("Protocol flow explorer")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Protocol Flows" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Policy Rules" })).toBeTruthy();
    expect(screen.getByLabelText("Search Logician flows")).toBeTruthy();
    expect(screen.getAllByText("Protocol Selection Before Work").length).toBeGreaterThan(0);
    expect(screen.getByText("Protocol Library")).toBeTruthy();
    expect(screen.getByText("Protocol Selector")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Selection Gate/i }));
    expect(screen.getByText("Mandatory checkpoint")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Policy Rules" }));
    expect(screen.getAllByText("Evidence Trust Rule").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Search Logician flows"), { target: { value: "capability" } });
    expect(screen.getAllByText("Capability Gate Rule").length).toBeGreaterThan(0);
    expect(screen.getByText("Selection and library policy")).toBeTruthy();
    expect(screen.getByText("Hook enforcement")).toBeTruthy();
    expect(screen.getByText("Evidence trust policy")).toBeTruthy();
    expect(screen.getByText("before-task-complete")).toBeTruthy();
  });
});
