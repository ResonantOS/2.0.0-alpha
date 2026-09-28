import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AddOnHookDefinition,
  AddOnInstallation,
  AddOnManifest,
  AddOnScriptDefinition,
  CapabilityGrant,
  InstallationStatus,
  LogicianExecutionArtifact,
  ResonantShellState,
} from "../../core/contracts";
import { createHarnessClient, type HarnessProjection } from "../../core/harness-client";
import { buildDefaultState } from "../../core/defaults";

const runtimeMocks = vi.hoisted(() => ({
  applyProviderCredentialStatuses: vi.fn((s: unknown) => s),
  hydrateState: vi.fn(),
  loadProviderCredentialStatuses: vi.fn(),
  sideloadManifest: vi.fn(),
}));

vi.mock("../../core/runtime", () => runtimeMocks);

const logicianMocks = vi.hoisted(() => ({
  executeLogicianHook: vi.fn(),
  executeLogicianScript: vi.fn(),
}));

vi.mock("../../core/logician", () => logicianMocks);
import {
  describeUninstallBlock,
  executeSideloadManifest,
  grantAddonCapabilities,
  grantWorkspaceAccess,
  runAddonLogicianHook,
  runAddonLogicianScript,
  toggleAddonCapabilityGrant,
  toggleAddonInstallation,
  uninstallAddon,
  updateAddonConfig,
} from "./controller";

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
  providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
  archiveIntegration: { readScopes: [], intakeWriteScopes: [], canRequestIngest: false, canWriteKnowledgePages: false },
  health: { strategy: "none" },
  installHooks: {},
  compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
});

const createMinimalInstallation = (addonId: string, installed: boolean, enabled: boolean, status: InstallationStatus): AddOnInstallation => ({
  addonId,
  source: "bundled",
  provenanceTier: "curated-signed",
  verificationState: "verified",
  installed,
  enabled,
  status,
  grantedCapabilities: [],
  recommendedGrantPresetIds: [],
  privateProviderProfileIds: [],
  notes: [],
});

const createSystemSlotManifest = (
  id: string,
  role: NonNullable<AddOnManifest["systemSlots"]>[number]["role"] = "default-provider",
  recommended = true,
): AddOnManifest => ({
  ...createMinimalManifest(id, id),
  requestedCapabilities: [capability("agent-delegation"), capability("chat-interface")],
  systemSlots: [
    { id: "primary-agent", role, replaceable: true, recommended },
    { id: "chat-interface", role: "default-provider", replaceable: true, recommended: true },
  ],
});

const ownerProjection = (owners: ResonantShellState["activeSystemSlotProviderIds"]): HarnessProjection => ({
  bootEpoch: "test", revision: 0, governanceActivated: true, candidates: [], installations: {},
  slots: Object.fromEntries(Object.entries(owners).map(([slot, addonId]) =>
    [slot, { addonId, generation: 1, available: true }])),
});

const uninstallDeps = (
  getState: () => ResonantShellState,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
  stopRunningWork?: (input: { addonId: string }) => Promise<{ stopped: boolean; detail?: string }>,
) => {
  const client = createHarnessClient({ invoke: vi.fn(async () => ({ bootEpoch: "test", revision: 1, governanceActivated: false, candidates: [], installations: {}, slots: {} })) as never });
  // Explicit host acknowledgement for these uninstall fixtures. The local
  // selection alone is never authority (covered separately below).
  client.applySnapshot(ownerProjection(getState().activeSystemSlotProviderIds));
  return { client, getState, updateRuntimeState, stopRunningWork,
    now: () => new Date("2026-09-07T12:00:00.000Z") };
};

describe("uninstallAddon", () => {
  it("ignores a forged local owner when the host slot is vacant", () => {
    const manifest = createSystemSlotManifest("addon.forged");
    const state = buildDefaultState([manifest]);
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");
    state.activeSystemSlotProviderIds = { "primary-agent": manifest.id };
    expect(describeUninstallBlock(state, manifest, ownerProjection({}))).toBeNull();
    expect(describeUninstallBlock(state, manifest)).toBeNull();
  });

  it("describeUninstallBlock mirrors decideUninstall for allowed, not-installed, uninstalled and active-slot cases", () => {
    const allowedManifest = createMinimalManifest("addon.allowed", "Allowed");
    const missingManifest = createMinimalManifest("addon.missing", "Missing");
    const uninstalledManifest = createMinimalManifest("addon.removed", "Removed");
    const activeSlotManifest = createSystemSlotManifest("addon.default");
    const state = buildDefaultState([allowedManifest, missingManifest, uninstalledManifest, activeSlotManifest]);
    state.installations[allowedManifest.id] = createMinimalInstallation(allowedManifest.id, true, true, "enabled");
    state.installations[uninstalledManifest.id] = createMinimalInstallation(
      uninstalledManifest.id,
      false,
      false,
      "uninstalled",
    );
    state.installations[activeSlotManifest.id] = createMinimalInstallation(activeSlotManifest.id, true, true, "enabled");
    state.activeSystemSlotProviderIds = { "primary-agent": activeSlotManifest.id };

    expect(describeUninstallBlock(state, allowedManifest)).toBeNull();
    expect(describeUninstallBlock(state, missingManifest)).toEqual({ blockReason: "not-installed" });
    expect(describeUninstallBlock(state, uninstalledManifest)).toEqual({ blockReason: "already-uninstalled" });
    expect(describeUninstallBlock(state, activeSlotManifest, ownerProjection({ "primary-agent": activeSlotManifest.id }))).toEqual({
      blockReason: "active-system-slot-provider",
      blockDetail: "primary-agent",
    });

    // Two selected slots are both named in the detail, comma-separated.
    const twoSlotManifest = {
      ...createSystemSlotManifest("addon.two-slots"),
      systemSlots: [
        { id: "primary-agent" as const, role: "default-provider" as const, replaceable: true, recommended: true },
        { id: "chat-interface" as const, role: "default-provider" as const, replaceable: true, recommended: true },
      ],
    };
    const twoSlotState = buildDefaultState([twoSlotManifest]);
    twoSlotState.installations[twoSlotManifest.id] = createMinimalInstallation(twoSlotManifest.id, true, true, "enabled");
    twoSlotState.activeSystemSlotProviderIds = { "primary-agent": twoSlotManifest.id, "chat-interface": twoSlotManifest.id };
    expect(describeUninstallBlock(twoSlotState, twoSlotManifest, ownerProjection({ "primary-agent": twoSlotManifest.id, "chat-interface": twoSlotManifest.id }))).toEqual({
      blockReason: "active-system-slot-provider",
      blockDetail: "primary-agent, chat-interface",
    });
  });

  it("describeUninstallBlock blocks sideloaded active owners", () => {
    const manifest = createSystemSlotManifest("addon.sideloaded");
    const state = buildDefaultState([manifest]);
    state.activeSystemSlotProviderIds = { "primary-agent": manifest.id };
    state.installations[manifest.id] = {
      ...createMinimalInstallation(manifest.id, true, true, "enabled"),
      source: "sideload",
    };

    expect(describeUninstallBlock(state, manifest, ownerProjection({ "primary-agent": manifest.id }))).toEqual({ blockReason: "active-system-slot-provider", blockDetail: "primary-agent" });
  });

  it("clears grants provider profiles and config", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id] = {
      ...createMinimalInstallation(manifest.id, true, true, "enabled"),
      grantedCapabilities: [
        { ...capability("network"), granted: true },
        { ...capability("archive-read"), granted: false },
      ],
      privateProviderProfileIds: ["profile-a", "profile-b"],
      config: { secret: "do-not-log" },
    };

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(result.outcome).toBe("uninstalled");
    expect(state.installations[manifest.id].grantedCapabilities).toEqual([]);
    expect(state.installations[manifest.id].privateProviderProfileIds).toEqual([]);
    expect("config" in state.installations[manifest.id]).toBe(false);
    expect(result.audit?.clearedCapabilities).toEqual(["network"]);
    expect(result.audit?.clearedPrivateProviderProfileIds).toBe(2);
    expect(result.audit?.configDeleted).toBe(true);
  });

  it("disables enabled add-ons and records an uninstall note", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");

    await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(state.installations[manifest.id]).toMatchObject({
      installed: false,
      enabled: false,
      status: "uninstalled",
      notes: ["Uninstalled; capability grants and add-on config were cleared. User data was retained."],
    });
  });

  it("disables the Hermes channel in the same mutation", async () => {
    const manifest = createHermesManifest();
    let state = buildDefaultState([manifest]);
    state.channels.find((channel) => channel.id === "desktop-hermes")!.enabled = true;
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");

    await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(state.channels.find((channel) => channel.id === "desktop-hermes")?.enabled).toBe(false);
  });

  it("is a no-op for available add-ons and missing records", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let availableState = buildDefaultState([manifest]);
    const missingState = buildDefaultState([]);
    const availableBefore = structuredClone(availableState);
    const missingBefore = structuredClone(missingState);

    const available = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => availableState,
        (updater) => {
          availableState = updater(availableState);
        },
      ),
    );
    const missing = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => missingState,
        () => {
          throw new Error("missing records should not mutate");
        },
      ),
    );

    expect(available).toEqual({ outcome: "blocked", blockReason: "not-installed" });
    expect(missing).toEqual({ outcome: "blocked", blockReason: "not-installed" });
    expect(availableState).toEqual(availableBefore);
    expect(missingState).toEqual(missingBefore);
  });

  it("is idempotent for already-uninstalled add-ons", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, false, false, "uninstalled");
    const before = structuredClone(state);

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(result).toEqual({ outcome: "blocked", blockReason: "already-uninstalled" });
    expect(result.audit).toBeUndefined();
    expect(state).toEqual(before);
  });

  it("is allowed from disabled, degraded, update-available and incompatible", async () => {
    for (const status of ["disabled", "degraded", "update-available", "incompatible"] as const) {
      const manifest = createMinimalManifest(`addon.${status}`, status);
      let state = buildDefaultState([manifest]);
      state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, false, status);

      const result = await uninstallAddon(
        manifest,
        uninstallDeps(
          () => state,
          (updater) => {
            state = updater(state);
          },
        ),
      );

      expect(result.outcome).toBe("uninstalled");
      expect(result.audit?.previousStatus).toBe(status);
      expect(state.installations[manifest.id].status).toBe("uninstalled");
    }
  });

  it("blocks a bundled default that is the selected provider for one of its slots", async () => {
    const manifest = createSystemSlotManifest("addon.default");
    let state = buildDefaultState([manifest]);
    state.activeSystemSlotProviderIds = { "primary-agent": manifest.id };
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");
    const before = structuredClone(state);

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(result).toEqual({
      outcome: "blocked",
      blockReason: "active-system-slot-provider",
      blockDetail: "primary-agent",
    });
    expect(state).toEqual(before);
  });

  it("blocks non-recommended and non-default active owners", async () => {
    const notRecommended = createSystemSlotManifest("addon.not-recommended", "default-provider", false);
    const alternative = createSystemSlotManifest("addon.alternative", "alternative-provider", true);

    for (const manifest of [notRecommended, alternative]) {
      let state = buildDefaultState([manifest]);
      state.activeSystemSlotProviderIds = { "primary-agent": manifest.id };
      state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");

      const result = await uninstallAddon(
        manifest,
        uninstallDeps(
          () => state,
          (updater) => {
            state = updater(state);
          },
        ),
      );

      expect(result).toMatchObject({ outcome: "blocked", blockReason: "active-system-slot-provider" });
    }
  });

  it("blocks sideloaded active system-slot providers", async () => {
    const manifest = createSystemSlotManifest("addon.sideloaded");
    let state = buildDefaultState([manifest]);
    state.activeSystemSlotProviderIds = { "primary-agent": manifest.id };
    state.installations[manifest.id] = {
      ...createMinimalInstallation(manifest.id, true, true, "enabled"),
      source: "sideload",
    };

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(result).toMatchObject({ outcome: "blocked", blockReason: "active-system-slot-provider" });
  });

  it("allows a bundled default once another provider is selected for all its slots", async () => {
    const manifest = createSystemSlotManifest("addon.default");
    let state = buildDefaultState([manifest]);
    state.activeSystemSlotProviderIds = {
      "primary-agent": "addon.replacement",
      "chat-interface": "addon.replacement",
    };
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(result.outcome).toBe("uninstalled");
  });

  it("blocks when running work cannot be stopped", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    for (const stopRunningWork of [
      vi.fn(async () => ({ stopped: false, detail: "still running" })),
      vi.fn(async () => {
        throw new Error("runtime unavailable");
      }),
    ]) {
      let state = buildDefaultState([manifest]);
      state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");
      const before = structuredClone(state);

      const result = await uninstallAddon(
        manifest,
        uninstallDeps(
          () => state,
          (updater) => {
            state = updater(state);
          },
          stopRunningWork,
        ),
      );

      expect(result.outcome).toBe("blocked");
      expect(result.blockReason).toBe("running-work-not-stopped");
      expect(result.audit).toBeUndefined();
      expect(state).toEqual(before);
    }
  });

  it("proceeds when no stop hook is provided", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );

    expect(result.outcome).toBe("uninstalled");
  });

  it("awaits the stop hook before mutating", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");
    const observedStatuses: InstallationStatus[] = [];

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
        async () => {
          observedStatuses.push(state.installations[manifest.id].status);
          return { stopped: true };
        },
      ),
    );

    expect(result.outcome).toBe("uninstalled");
    expect(observedStatuses).toEqual(["enabled"]);
  });

  it("does not call the stop hook when already blocked", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    const state = buildDefaultState([manifest]);
    const stopRunningWork = vi.fn(async () => ({ stopped: true }));

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        () => {
          throw new Error("blocked uninstall should not mutate");
        },
        stopRunningWork,
      ),
    );

    expect(result.blockReason).toBe("not-installed");
    expect(stopRunningWork).not.toHaveBeenCalled();
  });

  it("decides inside the updater", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    const getStateSnapshot = buildDefaultState([manifest]);
    getStateSnapshot.installations[manifest.id] = createMinimalInstallation(manifest.id, true, true, "enabled");
    let draft = buildDefaultState([manifest]);
    draft.installations[manifest.id] = createMinimalInstallation(manifest.id, false, false, "uninstalled");
    const before = structuredClone(draft);

    const result = await uninstallAddon(manifest, {
      ...uninstallDeps(
        () => getStateSnapshot,
        (updater) => {
          draft = updater(draft);
        },
      ),
    });

    expect(result).toEqual({ outcome: "blocked", blockReason: "already-uninstalled" });
    expect(draft).toEqual(before);
  });

  it("returns a counts-only audit record", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id] = {
      ...createMinimalInstallation(manifest.id, true, true, "enabled"),
      grantedCapabilities: [{ ...capability("network"), granted: true }],
      privateProviderProfileIds: ["private-profile-123"],
      config: { apiKey: "secret-config-value" },
    };

    const result = await uninstallAddon(
      manifest,
      uninstallDeps(
        () => state,
        (updater) => {
          state = updater(state);
        },
      ),
    );
    const auditJson = JSON.stringify(result.audit);

    expect(result.audit?.clearedCapabilities).toEqual(["network"]);
    expect(result.audit?.clearedPrivateProviderProfileIds).toBe(1);
    expect(auditJson).not.toContain("private-profile-123");
    expect(auditJson).not.toContain("secret-config-value");
  });
});

describe("updateAddonConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges config into an existing installation", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);

    updateAddonConfig("addon.test", { apiKey: "sk-123" }, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].config).toEqual({ apiKey: "sk-123" });
  });

  it("merges additional keys into existing config", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"].config = { existingKey: "value" };

    updateAddonConfig("addon.test", { newKey: "newValue" }, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].config).toEqual({
      existingKey: "value",
      newKey: "newValue",
    });
  });

  it("silently returns when installation is missing", () => {
    let state = buildDefaultState([]);

    updateAddonConfig("addon.missing", { key: "val" }, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.missing"]).toBeUndefined();
  });
});

describe("runAddonLogicianScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes a logician script and appends the verification artifact", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    const installation = createMinimalInstallation("addon.test", true, true, "enabled");
    const script: AddOnScriptDefinition = {
      id: "script-test",
      name: "Test Script",
      description: "A test script",
      commandRef: "scripts/test.sh",
      runPolicy: "on-demand",
      deterministic: true,
      requiredCapabilities: [],
      producesArtifacts: [],
      requiresHumanApproval: false,
    };
    const artifact: LogicianExecutionArtifact = {
      id: "artifact-1",
      addonId: "addon.test",
      kind: "script",
      targetId: "script-test",
      label: "Test Script",
      commandRef: "scripts/test.sh",
      status: "passed",
      summary: "Script passed",
      detail: "",
      requiredCapabilities: [],
      missingCapabilities: [],
      producedArtifacts: [],
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:01.000Z",
      durationMs: 1000,
      evidence: {},
    };
    logicianMocks.executeLogicianScript.mockResolvedValue(artifact);
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = {
      ...state.installations["addon.test"],
      installed: true,
      enabled: true,
      status: "enabled",
    };

    const result = await runAddonLogicianScript(manifest, installation, script, (updater) => {
      state = updater(state);
    });

    expect(logicianMocks.executeLogicianScript).toHaveBeenCalledWith(
      expect.objectContaining({ manifest, installation, script, humanInitiated: true }),
    );
    expect(result).toEqual(artifact);
    expect(state.installations["addon.test"].status).toBe("enabled");
  });

  it("sets installation status to degraded when script fails", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    const installation = createMinimalInstallation("addon.test", true, true, "enabled");
    const script: AddOnScriptDefinition = {
      id: "script-fail",
      name: "Fail Script",
      description: "A failing script",
      commandRef: "scripts/fail.sh",
      runPolicy: "on-demand",
      deterministic: true,
      requiredCapabilities: [],
      producesArtifacts: [],
      requiresHumanApproval: false,
    };
    const artifact: LogicianExecutionArtifact = {
      id: "artifact-fail",
      addonId: "addon.test",
      kind: "script",
      targetId: "script-fail",
      label: "Fail Script",
      commandRef: "scripts/fail.sh",
      status: "failed",
      summary: "Script failed",
      detail: "exit code 1",
      requiredCapabilities: [],
      missingCapabilities: [],
      producedArtifacts: [],
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:01.000Z",
      durationMs: 500,
      evidence: {},
    };
    logicianMocks.executeLogicianScript.mockResolvedValue(artifact);
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = {
      ...state.installations["addon.test"],
      installed: true,
      enabled: true,
      status: "enabled",
    };

    await runAddonLogicianScript(manifest, installation, script, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].status).toBe("degraded");
  });
});

describe("runAddonLogicianHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes a logician hook and appends the verification artifact", async () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    const installation = createMinimalInstallation("addon.test", true, true, "enabled");
    const hook: AddOnHookDefinition = {
      id: "hook-test",
      event: "after-install",
      handlerRef: "hooks/after-install.sh",
      requiredCapabilities: [],
      failurePolicy: "warn",
    };
    const artifact: LogicianExecutionArtifact = {
      id: "artifact-hook",
      addonId: "addon.test",
      kind: "hook",
      targetId: "hook-test",
      label: "Test Hook",
      commandRef: "hooks/post-install.sh",
      status: "passed",
      summary: "Hook passed",
      detail: "",
      requiredCapabilities: [],
      missingCapabilities: [],
      producedArtifacts: [],
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:01.000Z",
      durationMs: 200,
      evidence: {},
    };
    logicianMocks.executeLogicianHook.mockResolvedValue(artifact);
    let state = buildDefaultState([manifest]);

    const result = await runAddonLogicianHook(manifest, installation, hook, (updater) => {
      state = updater(state);
    });

    expect(logicianMocks.executeLogicianHook).toHaveBeenCalledWith(
      expect.objectContaining({ manifest, installation, hook, humanInitiated: true }),
    );
    expect(result).toEqual(artifact);
  });
});

describe("executeSideloadManifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early when sideload path is empty", async () => {
    const setReadyState = vi.fn();
    const setSelectedAddonId = vi.fn();
    const setSideloadPath = vi.fn();
    const setErrorState = vi.fn();

    await executeSideloadManifest({
      sideloadPath: "",
      bundled: [],
      sideloaded: [],
      setReadyState,
      setSelectedAddonId,
      setSideloadPath,
      setErrorState,
      errorMessageOf: (_e, fallback) => fallback,
    });

    expect(runtimeMocks.sideloadManifest).not.toHaveBeenCalled();
    expect(setReadyState).not.toHaveBeenCalled();
    expect(setSideloadPath).not.toHaveBeenCalled();
  });

  it("sideloads a manifest, hydrates state, and calls setters", async () => {
    const manifest = createMinimalManifest("addon.sideloaded", "Sideloaded");
    runtimeMocks.sideloadManifest.mockResolvedValue(manifest);
    runtimeMocks.hydrateState.mockResolvedValue(buildDefaultState([manifest]));
    runtimeMocks.loadProviderCredentialStatuses.mockResolvedValue([]);

    const setReadyState = vi.fn();
    const setSelectedAddonId = vi.fn();
    const setSideloadPath = vi.fn();
    const setErrorState = vi.fn();

    await executeSideloadManifest({
      sideloadPath: "/path/to/addon.json",
      bundled: [],
      sideloaded: [],
      setReadyState,
      setSelectedAddonId,
      setSideloadPath,
      setErrorState,
      errorMessageOf: (_e, fallback) => fallback,
    });

    expect(runtimeMocks.sideloadManifest).toHaveBeenCalledWith("/path/to/addon.json");
    expect(runtimeMocks.hydrateState).toHaveBeenCalled();
    expect(runtimeMocks.loadProviderCredentialStatuses).toHaveBeenCalled();
    expect(runtimeMocks.applyProviderCredentialStatuses).toHaveBeenCalled();
    expect(setReadyState).toHaveBeenCalled();
    expect(setSelectedAddonId).toHaveBeenCalledWith("addon.sideloaded");
    expect(setSideloadPath).toHaveBeenCalledWith("");
    expect(setErrorState).not.toHaveBeenCalled();
  });

  it("calls setErrorState on failure", async () => {
    runtimeMocks.sideloadManifest.mockRejectedValue(new Error("invalid manifest"));

    const setErrorState = vi.fn();

    await executeSideloadManifest({
      sideloadPath: "/path/to/bad.json",
      bundled: [],
      sideloaded: [],
      setReadyState: vi.fn(),
      setSelectedAddonId: vi.fn(),
      setSideloadPath: vi.fn(),
      setErrorState,
      errorMessageOf: (_e, fallback) => fallback,
    });

    expect(setErrorState).toHaveBeenCalledWith("Failed to sideload manifest.");
  });
});

describe("all add-on and quick-grant actions use host transactions", () => {
  it.each(["install", "disable", "enable", "grant", "batch", "remove"])("%s waits for acknowledgement and denial changes no consent", async action => {
    const manifest = createHermesManifest();
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id].installed = action !== "install";
    state.installations[manifest.id].enabled = action !== "enable";
    state.installations[manifest.id].status = action === "install" ? "available" : "enabled";
    const snapshot: HarnessProjection = { bootEpoch: "boot", revision: 4, governanceActivated: false, candidates: [], slots: {}, installations:
      action === "install" ? {} : { [manifest.id]: { ...state.installations[manifest.id], disabledOperations: [], hiddenSurfaceIds: [] } } };
    let reject!: (error: Error) => void;
    const invoke = vi.fn((_command: string, _args?: Record<string, unknown>) => new Promise<HarnessProjection>((_, fail) => { reject = fail; }));
    const client = createHarnessClient({ invoke: invoke as never });
    client.applySnapshot(snapshot);
    const deps = { client, getState: () => state, updateRuntimeState: (updater: (s: ResonantShellState) => ResonantShellState) => { state = updater(state); } };
    const before = structuredClone(state);
    const pending = action === "remove" ? uninstallAddon(manifest, deps)
      : action === "grant" ? toggleAddonCapabilityGrant(manifest.id, "shell", deps)
      : action === "batch" ? grantAddonCapabilities(manifest, ["shell", "ui-embedding"], deps)
      : toggleAddonInstallation(manifest, deps);
    const rejected = expect(pending).rejects.toThrow("denied");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(state).toEqual(before);
    expect(invoke.mock.calls[0][0]).toBe(action === "install" ? "harness_install" : action === "remove" ? "harness_remove" : ["grant", "batch"].includes(action) ? "harness_grants" : "harness_enabled");
    reject(new Error("denied"));
    await rejected;
    expect(state).toEqual(before);
  });
});

describe("acknowledged add-on mutations", () => {
  it.each(["install", "disable", "enable", "grant", "revoke", "batch"])("%s applies only the host result", async action => {
    const manifest = createHermesManifest();
    let state = buildDefaultState([manifest]);
    state.installations[manifest.id].status = "uninstalled";
    state.installations[manifest.id].config = { stale: true };
    state.installations[manifest.id].privateProviderProfileIds = ["stale"];
    const initial: HarnessProjection = { bootEpoch: "boot", revision: 2, governanceActivated: false, candidates: [], slots: {}, installations: {} };
    const entry = { addonId: manifest.id, installed: true, enabled: action !== "enable", grantedCapabilities: manifest.requestedCapabilities.map(g => ({ ...g, granted: action === "revoke" })), disabledOperations: [], hiddenSurfaceIds: [] };
    if (action !== "install") initial.installations = { [manifest.id]: entry };
    const acknowledged = structuredClone(initial);
    acknowledged.revision++;
    acknowledged.installations = { [manifest.id]: { ...entry, enabled: action !== "disable", grantedCapabilities: entry.grantedCapabilities.map(g => ({ ...g, granted: action === "batch" ? ["shell", "ui-embedding"].includes(g.capability) : action === "grant" && g.capability === "shell" })) } };
    let resolve!: (p: HarnessProjection) => void;
    const invoke = vi.fn((_command: string, _args?: Record<string, unknown>) => new Promise<HarnessProjection>(done => { resolve = done; }));
    const client = createHarnessClient({ invoke: invoke as never }); client.applySnapshot(initial);
    const deps = { client, getState: () => state, updateRuntimeState: (updater: (s: ResonantShellState) => ResonantShellState) => { state = updater(state); } };
    const before = structuredClone(state);
    const pending = action === "batch" ? grantAddonCapabilities(manifest, ["shell", "ui-embedding"], deps)
      : ["grant", "revoke"].includes(action) ? toggleAddonCapabilityGrant(manifest.id, "shell", deps)
      : toggleAddonInstallation(manifest, deps);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(state).toEqual(before);
    if (action === "batch") expect(invoke).toHaveBeenCalledWith("harness_grants", { addonId: manifest.id, consent: true, expectedRevision: 2, grants: manifest.requestedCapabilities.filter(g => ["shell", "ui-embedding"].includes(g.capability)).map(g => ({ ...g, granted: true })) });
    resolve(acknowledged); await pending;
    expect(state.installations[manifest.id].grantedCapabilities).toEqual(acknowledged.installations[manifest.id].grantedCapabilities);
    expect(state.installations[manifest.id].enabled).toBe(action !== "disable");
    expect(state.channels.find(c => c.id === "desktop-hermes")?.enabled).toBe(action !== "disable");
    expect(state.installations[manifest.id].config).toBeUndefined();
    expect(state.installations[manifest.id].privateProviderProfileIds).toEqual([]);
  });
});

it.each(["batch", "toggle"])("a denied %s after installation refreshes installed state without inventing grants", async action => {
  const manifest = createHermesManifest();
  let state = buildDefaultState([manifest]);
  const initial: HarnessProjection = { bootEpoch: "boot", revision: 0, governanceActivated: false, candidates: [], slots: {}, installations: {} };
  const installed: HarnessProjection = { ...initial, revision: 1, installations: { [manifest.id]: {
    addonId: manifest.id, installed: true, enabled: true, grantedCapabilities: manifest.requestedCapabilities,
    disabledOperations: [], hiddenSurfaceIds: [],
  } } };
  const refreshed: HarnessProjection = { ...installed, revision: 2, installations: { [manifest.id]: {
    ...installed.installations[manifest.id], enabled: false,
  } } };
  const invoke = vi.fn().mockResolvedValueOnce(installed).mockRejectedValueOnce(new Error("grant denied"))
    .mockResolvedValueOnce(refreshed);
  const client = createHarnessClient({ invoke }); client.applySnapshot(initial);
  const deps = { client, getManifest: () => manifest, getState: () => state,
    updateRuntimeState: (updater: (s: ResonantShellState) => ResonantShellState) => { state = updater(state); } };
  await expect(action === "batch"
    ? grantAddonCapabilities(manifest, ["shell", "ui-embedding"], deps)
    : toggleAddonCapabilityGrant(manifest.id, "shell", deps)).rejects.toThrow("grant denied");
  const expected = refreshed.installations[manifest.id];
  expect.soft(state.installations[manifest.id]).toMatchObject({ installed: expected.installed, enabled: expected.enabled,
    status: "disabled", grantedCapabilities: expected.grantedCapabilities });
  expect.soft(state.channels.find(channel => channel.id === "desktop-hermes")?.enabled).toBe(expected.enabled);
  expect.soft(client.getSnapshot()).toEqual(refreshed);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["harness_install", "harness_grants", "harness_registry"]);
  expect(expected.grantedCapabilities.every(g => !g.granted)).toBe(true);
});

it.each(["install", "grant"])("a denied workspace %s never opens the vault picker", async denial => {
  const manifest = { ...createMinimalManifest("addon.obsidian", "Obsidian"),
    requestedCapabilities: [capability("filesystem"), capability("ui-embedding")] };
  let state = buildDefaultState([manifest]);
  const initial: HarnessProjection = { bootEpoch: "boot", revision: 0, governanceActivated: false, candidates: [], slots: {},
    installations: denial === "install" ? {} : { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
      grantedCapabilities: manifest.requestedCapabilities, disabledOperations: [], hiddenSurfaceIds: [] } } };
  const invoke = vi.fn().mockRejectedValue(new Error("host denied"));
  const client = createHarnessClient({ invoke }); client.applySnapshot(initial);
  const selectVault = vi.fn().mockResolvedValue("/vault");
  await expect(grantWorkspaceAccess(manifest, {
    client, getState: () => state, updateRuntimeState: updater => { state = updater(state); },
  }, selectVault)).rejects.toThrow("host denied");
  expect(selectVault).not.toHaveBeenCalled();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([denial === "install" ? "harness_install" : "harness_grants"]);
});

it("an acknowledgement bootstraps an installation missing from the display draft", async () => {
  const manifest = createHermesManifest();
  let state = buildDefaultState([]);
  const initial: HarnessProjection = { bootEpoch: "boot", revision: 0, governanceActivated: false, candidates: [], slots: {}, installations: {} };
  const entry = { addonId: manifest.id, installed: true, enabled: false,
    grantedCapabilities: [{ ...capability("shell"), granted: true }], disabledOperations: [], hiddenSurfaceIds: [] };
  const invoke = vi.fn().mockResolvedValue({ ...initial, revision: 1, installations: { [manifest.id]: entry } });
  const client = createHarnessClient({ invoke }); client.applySnapshot(initial);
  await toggleAddonInstallation(manifest, {
    client, getState: () => state, updateRuntimeState: updater => { state = updater(state); },
  });
  expect(state.installations[manifest.id]).toMatchObject({ addonId: manifest.id, installed: true, enabled: false,
    status: "disabled", grantedCapabilities: entry.grantedCapabilities,
    privateProviderProfileIds: [], recommendedGrantPresetIds: [] });
  expect(state.installations[manifest.id].grantedCapabilities).not.toBe(client.getSnapshot()?.installations[manifest.id].grantedCapabilities);
});
