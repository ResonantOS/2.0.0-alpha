// Intent citation: docs/architecture/ADR-002-modular-codebase.md

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddOnManifest, HarnessRegistryProjection } from "../../core/contracts";
import { createHarnessClient } from "../../core/harness-client";
import augmentor from "../../../public/addons/augmentor-chat.json";
import archive from "../../../public/addons/living-archive.json";
import { activeSystemSlotProvider, systemSlotAvailable } from "./system-slots";
import { buildDefaultState } from "../../core/defaults";

const runtimeMocks = vi.hoisted(() => ({
  applyProviderCredentialStatuses: vi.fn((state) => state),
  hydrateState: vi.fn(),
  loadBundledManifests: vi.fn(),
  loadProviderCredentialStatuses: vi.fn(),
  loadSideloadedManifests: vi.fn(),
  requestLocalRuntimeStatus: vi.fn(),
  requestRecoveryRouteCandidates: vi.fn(),
}));

vi.mock("../../core/runtime", () => runtimeMocks);

describe("shell boot controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.loadBundledManifests.mockResolvedValue([]);
    runtimeMocks.loadSideloadedManifests.mockResolvedValue([]);
    runtimeMocks.loadProviderCredentialStatuses.mockResolvedValue([]);
  });

  it("preserves the persisted active workspace instead of forcing Home on boot", async () => {
    const state = buildDefaultState([]);
    state.uiPreferences.activeSection = "archive";
    runtimeMocks.hydrateState.mockResolvedValue(state);

    const { loadInitialShellState } = await import("./controller");
    const booted = await loadInitialShellState();

    expect(booted.state.uiPreferences.activeSection).toBe("archive");
  });

  it("receives the host projection at boot and passes it to hydration and slot lookups", async () => {
    const manifest = augmentor as AddOnManifest;
    const state = buildDefaultState([manifest]);
    const projection: HarnessRegistryProjection = {
      bootEpoch: "boot", revision: 1, governanceActivated: true, candidates: [manifest],
      installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
        grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })),
        disabledOperations: [], hiddenSurfaceIds: [] } },
      slots: { "chat-interface": { addonId: manifest.id, generation: 1, available: true } },
    };
    const invoke = vi.fn().mockResolvedValue(projection);
    const client = createHarnessClient({ invoke });
    runtimeMocks.loadBundledManifests.mockResolvedValue([manifest]);
    runtimeMocks.hydrateState.mockResolvedValue(state);
    const { loadInitialShellState } = await import("./controller");
    const booted = await loadInitialShellState(client);
    expect(invoke).toHaveBeenCalledWith("harness_registry");
    expect(runtimeMocks.hydrateState).toHaveBeenCalledWith([manifest], [], projection);
    expect(systemSlotAvailable(booted.state, booted.bundled, "chat-interface", client.getSnapshot())).toBe(true);
    expect(state.activeSystemSlotProviderIds).toEqual({});
  });

  it("loads recovery runtime snapshot with status and candidates", async () => {
    const state = buildDefaultState([]);
    const status = { recoveryModelRunning: true, modelVersion: "0.1.0" };
    const candidates = [{ providerId: "shared-local", providerLabel: "Local", runtimeNodeLabel: "Local Runtime", model: "gemma-4-26b" }];
    runtimeMocks.requestLocalRuntimeStatus.mockResolvedValue(status);
    runtimeMocks.requestRecoveryRouteCandidates.mockResolvedValue(candidates);

    const { loadRecoveryRuntimeSnapshot } = await import("./controller");
    const result = await loadRecoveryRuntimeSnapshot(state);

    expect(result.status).toEqual(status);
    expect(result.candidates).toEqual(candidates);
    expect(runtimeMocks.requestLocalRuntimeStatus).toHaveBeenCalledWith(
      state.providers.find((p) => p.id === "shared-local")?.primaryModel ?? "batiai/gemma4-e2b:q4",
    );
    expect(runtimeMocks.requestRecoveryRouteCandidates).toHaveBeenCalledTimes(1);
  });

  it("first-run consent becomes effective only after host acknowledgement", async () => {
    const manifests = [augmentor, archive] as AddOnManifest[];
    const state = buildDefaultState(manifests);
    const before = structuredClone(state);
    let snapshot: HarnessRegistryProjection = { bootEpoch: "first-run", revision: 0, governanceActivated: false, candidates: [], installations: {}, slots: {} };
    const pending: Array<{ command: string; args: any; resolve: (value: HarnessRegistryProjection) => void }> = [];
    const invoke = vi.fn((command: string, args?: Record<string, unknown>) => command === "harness_registry"
      ? Promise.resolve(snapshot)
      : new Promise<HarnessRegistryProjection>(resolve => pending.push({ command, args, resolve })));
    const client = createHarnessClient({ invoke: invoke as never });
    await client.refresh();
    const { applyFirstRunRecommendedAddOns } = await import("./controller");
    const operation = applyFirstRunRecommendedAddOns(state, manifests, manifests.map(m => m.id), client);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].command).toBe("harness_install");
    for (let index = 0; index < 7; index++) {
      await vi.waitFor(() => expect(pending).toHaveLength(index + 1));
      const { command, args, resolve } = pending[index];
      const next = { ...structuredClone(snapshot), installations: { ...snapshot.installations }, slots: { ...snapshot.slots } };
      next.revision++;
      if (command === "harness_install") next.installations[args.manifest.id] = {
        addonId: args.manifest.id, installed: true, enabled: true,
        grantedCapabilities: args.manifest.requestedCapabilities.map((g: any) => ({ ...g, granted: false })), disabledOperations: [], hiddenSurfaceIds: [],
      };
      if (command === "harness_grants") {
        expect(args).toMatchObject({ consent: true, expectedRevision: snapshot.revision });
        expect(client.getSnapshot()!.installations[args.addonId].grantedCapabilities.some(g => g.granted)).toBe(false);
        next.installations[args.addonId] = { ...next.installations[args.addonId], grantedCapabilities: next.installations[args.addonId].grantedCapabilities.map(g => args.grants.find((item: any) => item.capability === g.capability) ?? g) };
      }
      if (command === "harness_assign_slot") {
        expect(args.expectedGeneration).toBe(0);
        expect(activeSystemSlotProvider(state, manifests, args.slot, client.getSnapshot())).toBeNull();
        next.slots[args.slot as "primary-agent"] = { addonId: args.addonId, generation: 1, available: true };
      }
      expect(state).toEqual(before);
      snapshot = next;
      resolve(next);
      await Promise.resolve();
    }
    const result = await operation;
    expect(result.installations).toEqual(before.installations);
    expect(result.activeSystemSlotProviderIds).toEqual(before.activeSystemSlotProviderIds);
    expect(result.uiPreferences.recommendedAddOnsReviewed).toBe(true);
    for (const slot of ["primary-agent", "chat-interface", "memory-system"] as const) {
      expect(systemSlotAvailable(result, manifests, slot)).toBe(false);
      expect(systemSlotAvailable(result, manifests, slot, client.getSnapshot())).toBe(true);
    }
  });

  it.each([true, false])("first run preserves another add-on's owner (available: %s)", async available => {
    const manifest = archive as AddOnManifest;
    const state = buildDefaultState([manifest]);
    const before = structuredClone(state);
    const owner = { addonId: "addon.other-memory", generation: 7, available };
    let snapshot: HarnessRegistryProjection = { bootEpoch: "first-run", revision: 1, governanceActivated: true,
      candidates: [manifest], installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: true,
        grantedCapabilities: [], disabledOperations: [], hiddenSurfaceIds: [] } }, slots: { "memory-system": owner } };
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "harness_registry") return snapshot;
      if (command === "harness_grants") {
        snapshot = { ...snapshot, revision: snapshot.revision + 1 };
        return snapshot;
      }
      if (command === "harness_assign_slot") {
        expect(args?.expectedGeneration, "first run must never authorize replacing an incumbent generation").toBe(0);
        throw new Error("Slot already owned");
      }
      throw new Error("Unexpected first-run command");
    });
    const client = createHarnessClient({ invoke: invoke as never });
    const { applyFirstRunRecommendedAddOns } = await import("./controller");
    const result = await applyFirstRunRecommendedAddOns(state, [manifest], [manifest.id], client);
    expect(result.uiPreferences.recommendedAddOnsReviewed).toBe(true);
    expect(client.getSnapshot()?.slots["memory-system"]).toEqual(owner);
    expect(invoke.mock.calls.filter(([command]) => command === "harness_assign_slot")).toHaveLength(0);
    expect(state).toEqual(before);
  });

  it("enables an installed disabled default only after host acknowledgement", async () => {
    const manifest = archive as AddOnManifest;
    const state = buildDefaultState([manifest]);
    const before = structuredClone(state);
    let snapshot: HarnessRegistryProjection = { bootEpoch: "first-run", revision: 1, governanceActivated: true,
      candidates: [manifest], installations: { [manifest.id]: { addonId: manifest.id, installed: true, enabled: false,
        grantedCapabilities: manifest.requestedCapabilities.map(grant => ({ ...grant, granted: true })),
        disabledOperations: [], hiddenSurfaceIds: [] } },
      slots: { "memory-system": { addonId: manifest.id, generation: 1, available: false } } };
    let acknowledge!: (value: HarnessRegistryProjection) => void;
    const enabled = new Promise<HarnessRegistryProjection>(resolve => { acknowledge = resolve; });
    const invoke = vi.fn(async (command: string) => {
      if (command === "harness_registry") return snapshot;
      if (command === "harness_enabled") return enabled;
      if (command === "harness_grants") return { ...snapshot, revision: snapshot.revision + 1 };
      throw new Error("Unexpected first-run command");
    });
    const client = createHarnessClient({ invoke: invoke as never });
    await client.refresh();
    const { applyFirstRunRecommendedAddOns } = await import("./controller");
    const operation = applyFirstRunRecommendedAddOns(state, [manifest], [manifest.id], client);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("harness_enabled", {
      addonId: manifest.id, enabled: true, expectedRevision: 1,
    }));
    expect(client.getSnapshot()?.installations[manifest.id].enabled).toBe(false);
    expect(systemSlotAvailable(state, [manifest], "memory-system", client.getSnapshot())).toBe(false);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["harness_registry", "harness_enabled"]);
    expect(state).toEqual(before);
    snapshot = { ...snapshot, revision: 2,
      installations: { [manifest.id]: { ...snapshot.installations[manifest.id], enabled: true } },
      slots: { "memory-system": { addonId: manifest.id, generation: 1, available: true } } };
    acknowledge(snapshot);
    const result = await operation;
    expect(client.getSnapshot()?.installations[manifest.id].enabled).toBe(true);
    expect(systemSlotAvailable(result, [manifest], "memory-system", client.getSnapshot())).toBe(true);
    expect(invoke).toHaveBeenCalledWith("harness_grants", expect.objectContaining({ expectedRevision: 2 }));
    expect(result.installations).toEqual(before.installations);
    expect(result.activeSystemSlotProviderIds).toEqual(before.activeSystemSlotProviderIds);
    expect(result.uiPreferences.recommendedAddOnsReviewed).toBe(true);
    expect(state).toEqual(before);
  });

  it("ignores selected IDs outside the bundled defaults and keeps empty selection local", async () => {
    const custom = { ...augmentor, id: "addon.custom" } as AddOnManifest;
    const manifests = [augmentor, archive, custom] as AddOnManifest[];
    const state = buildDefaultState(manifests);
    const invoke = vi.fn();
    const client = createHarnessClient({ invoke });
    const { applyFirstRunRecommendedAddOns } = await import("./controller");
    const result = await applyFirstRunRecommendedAddOns(state, manifests, [custom.id], client);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.installations).toEqual(state.installations);
    expect(result.uiPreferences).toMatchObject({ recommendedAddOnsReviewed: true, chatSidebarOpen: false });
  });

  it("host denial leaves first-run consent and preferences untouched", async () => {
    const manifests = [augmentor] as AddOnManifest[];
    const state = buildDefaultState(manifests), before = structuredClone(state);
    const snapshot = { bootEpoch: "first-run", revision: 0, governanceActivated: false, candidates: [], installations: {}, slots: {} };
    const invoke = vi.fn(async (command: string) => {
      if (command === "harness_registry") return snapshot;
      throw new Error("Host denied consent");
    });
    const client = createHarnessClient({ invoke: invoke as never });
    const { applyFirstRunRecommendedAddOns } = await import("./controller");
    await expect(applyFirstRunRecommendedAddOns(state, manifests, [augmentor.id], client)).rejects.toThrow("Host denied consent");
    expect(state).toEqual(before);
    expect(client.getSnapshot()?.installations).toEqual({});
  });

  it("marks recommended addons as reviewed", async () => {
    const state = buildDefaultState([]);
    const { markFirstRunRecommendedAddOnsReviewed } = await import("./controller");
    const result = markFirstRunRecommendedAddOnsReviewed(state);

    expect(result.uiPreferences.recommendedAddOnsReviewed).toBe(true);
    expect(result).not.toBe(state);
  });
});
