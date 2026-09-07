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
  executeSideloadManifest,
  grantAddonCapabilities,
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

const uninstallDeps = (
  getState: () => ResonantShellState,
  updateRuntimeState: (updater: (current: ResonantShellState) => ResonantShellState) => void,
  stopRunningWork?: (input: { addonId: string }) => Promise<{ stopped: boolean; detail?: string }>,
) => ({
  getState,
  updateRuntimeState,
  stopRunningWork,
  now: () => new Date("2026-09-07T12:00:00.000Z"),
});

describe("toggleAddonInstallation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("installs a previously uninstalled addon", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = createMinimalInstallation("addon.test", false, false, "available");

    toggleAddonInstallation(manifest, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].installed).toBe(true);
    expect(state.installations["addon.test"].enabled).toBe(true);
    expect(state.installations["addon.test"].status).toBe("enabled");
  });

  it("reinstalling an uninstalled addon rebuilds fresh grants from the manifest", () => {
    const manifest = {
      ...createMinimalManifest("addon.test", "Test Addon"),
      requestedCapabilities: [capability("network"), capability("archive-read")],
    };
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = {
      ...createMinimalInstallation("addon.test", false, false, "uninstalled"),
      grantedCapabilities: [{ ...capability("network"), granted: true }],
      privateProviderProfileIds: ["profile-stale"],
      config: { vaultPath: "/tmp/stale-vault" },
    };

    toggleAddonInstallation(manifest, (updater) => {
      state = updater(state);
    });

    const installation = state.installations["addon.test"];
    expect(installation.installed).toBe(true);
    expect(installation.status).toBe("enabled");
    expect(installation.grantedCapabilities).toEqual([
      { ...capability("network"), granted: false },
      { ...capability("archive-read"), granted: false },
    ]);
    expect(installation.privateProviderProfileIds).toEqual([]);
    expect("config" in installation).toBe(false);
  });

  it("disables an enabled addon", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = createMinimalInstallation("addon.test", true, true, "enabled");

    toggleAddonInstallation(manifest, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].enabled).toBe(false);
    expect(state.installations["addon.test"].status).toBe("disabled");
  });

  it("re-enables a disabled addon", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = createMinimalInstallation("addon.test", true, false, "disabled");

    toggleAddonInstallation(manifest, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].enabled).toBe(true);
    expect(state.installations["addon.test"].status).toBe("enabled");
  });

  it("toggles the hermes channel when toggling hermes addon", () => {
    const manifest = createHermesManifest();
    let state = buildDefaultState([manifest]);
    state.channels.find((c) => c.id === "desktop-hermes")!.enabled = true;
    state.installations["addon.hermes"] = {
      ...state.installations["addon.hermes"],
      installed: true,
      enabled: true,
      status: "enabled",
    };

    toggleAddonInstallation(manifest, (updater) => {
      state = updater(state);
    });

    expect(state.channels.find((c) => c.id === "desktop-hermes")?.enabled).toBe(false);
  });

  it("silently returns when installation is missing from state", () => {
    const manifest = createMinimalManifest("addon.missing", "Missing");
    let state = buildDefaultState([]);

    toggleAddonInstallation(manifest, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.missing"]).toBeUndefined();
  });
});

describe("toggleAddonCapabilityGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles a capability grant from false to true", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = {
      ...createMinimalInstallation("addon.test", true, true, "enabled"),
      grantedCapabilities: [
        { capability: "network", granted: false, scope: "shared", revocationBehavior: "hard-stop" },
      ],
    };

    toggleAddonCapabilityGrant("addon.test", "network", (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].grantedCapabilities[0].granted).toBe(true);
  });

  it("toggles a capability grant from true to false", () => {
    const manifest = createMinimalManifest("addon.test", "Test Addon");
    let state = buildDefaultState([manifest]);
    state.installations["addon.test"] = {
      ...createMinimalInstallation("addon.test", true, true, "enabled"),
      grantedCapabilities: [
        { capability: "network", granted: true, scope: "shared", revocationBehavior: "hard-stop" },
      ],
    };

    toggleAddonCapabilityGrant("addon.test", "network", (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.test"].grantedCapabilities[0].granted).toBe(false);
  });

  it("silently returns when the addon installation is missing", () => {
    let state = buildDefaultState([]);

    toggleAddonCapabilityGrant("addon.nonexistent", "network", (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.nonexistent"]).toBeUndefined();
  });
});

describe("uninstallAddon", () => {
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

  it("ignores non-recommended and non-default-provider slots", async () => {
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

      expect(result.outcome).toBe("uninstalled");
    }
  });

  it("allows sideloaded system-slot providers", async () => {
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

    expect(result.outcome).toBe("uninstalled");
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

describe("grantAddonCapabilities", () => {
  it("only grants the requested Hermes workspace capabilities", () => {
    const hermesManifest = createHermesManifest();
    let state = buildDefaultState([hermesManifest]);

    grantAddonCapabilities("addon.hermes", ["shell", "ui-embedding"], hermesManifest.requestedCapabilities, (updater) => {
      state = updater(state);
    });

    const granted = new Set(
      state.installations["addon.hermes"].grantedCapabilities
        .filter((grant) => grant.granted)
        .map((grant) => grant.capability),
    );

    expect(granted).toEqual(new Set(["shell", "ui-embedding"]));
    expect(state.channels.find((channel) => channel.id === "desktop-hermes")?.enabled).toBe(true);
  });

  it("merges missing requested capabilities into existing grants", () => {
    const hermesManifest = createHermesManifest();
    let state = buildDefaultState([hermesManifest]);
    state.installations["addon.hermes"].grantedCapabilities = [];

    grantAddonCapabilities("addon.hermes", ["shell"], hermesManifest.requestedCapabilities, (updater) => {
      state = updater(state);
    });

    expect(state.installations["addon.hermes"].grantedCapabilities.length).toBeGreaterThanOrEqual(
      hermesManifest.requestedCapabilities.length,
    );
    expect(state.installations["addon.hermes"].grantedCapabilities.find((g) => g.capability === "shell")?.granted).toBe(true);
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
