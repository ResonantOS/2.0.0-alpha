import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInitialShellState } from "../modules/shell/controller";
import { createHarnessClient } from "./harness-client";
import { HARNESS_PUBLIC_ERROR_MESSAGES, type HarnessEvent, type HarnessRegistryProjection } from "./contracts";

const snapshot = (revision: number): HarnessRegistryProjection => ({
  bootEpoch: "boot-1", revision, governanceActivated: true, candidates: [], installations: {},
  slots: { "primary-agent": { addonId: null, available: false, generation: revision } },
});
const session = { addonId: "addon.demo", sessionId: "session-1", bootEpoch: "boot-1", generation: 2 };
const event = (sequence: number): HarnessEvent => ({ ...session, sequence, turnId: "turn-1", type: "status", data: { status: "running" } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("harness projection client", () => {
  it("commands use scoped headers and monotonic projections: rejects older and equal acknowledgements", async () => {
    const client = createHarnessClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    expect(client.getSnapshot()).toBeNull();
    const latest = snapshot(5);
    expect(client.applySnapshot(latest)).toBe(true);
    const retained = client.getSnapshot();
    expect(client.applySnapshot(snapshot(4))).toBe(false);
    expect(client.applySnapshot({ ...snapshot(5), slots: {} })).toBe(false);
    expect(client.getSnapshot()).toBe(retained);
    expect(client.getSnapshot()).toEqual(latest);
    expect(client.getSnapshot()?.candidates).toEqual([]);
    expect(client.getSnapshot()?.installations).toEqual({});
    latest.slots["primary-agent"]!.available = true;
    expect(client.getSnapshot()?.slots["primary-agent"]?.available).toBe(false);
    expect(Object.isFrozen(client.getSnapshot()?.slots["primary-agent"])).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    client.applySnapshot(snapshot(6));
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([5, 0])("refresh establishes a new host epoch at persisted revision %i", async (revision) => {
    const next = { ...snapshot(revision), bootEpoch: "boot-2" };
    const client = createHarnessClient({ invoke: vi.fn().mockResolvedValue(next) });
    client.applySnapshot(snapshot(5));
    const listener = vi.fn();
    client.subscribe(listener);
    expect(await client.refresh()).toEqual(next);
    expect(listener).toHaveBeenCalledOnce();
    // Unsolicited snapshots cannot switch epochs, even with a larger counter.
    expect(client.applySnapshot(snapshot(99))).toBe(false);
    expect(client.getSnapshot()).toEqual(next);
  });

  it("ignores an old-epoch response arriving after an authoritative refresh", async () => {
    const late = deferred<HarnessRegistryProjection>();
    const next = { ...snapshot(5), bootEpoch: "boot-2" };
    const invoke = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(next);
    const client = createHarnessClient({ invoke });
    client.applySnapshot(snapshot(5));
    const oldRead = client.refresh();
    await client.refresh();
    late.resolve(snapshot(99));
    expect(await oldRead).toEqual(next);
    expect(client.getSnapshot()).toEqual(next);
  });

  it("does not adopt a delayed initial read from a different boot", async () => {
    const late = deferred<HarnessRegistryProjection>();
    const next = { ...snapshot(5), bootEpoch: "boot-2" };
    const client = createHarnessClient({ invoke: vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(next) });
    const oldRead = client.refresh();
    await client.refresh();
    late.resolve(snapshot(99));
    expect(await oldRead).toEqual(next);
  });

  it("keeps newer same-boot concurrent acknowledgements after the initial read", async () => {
    const late = deferred<HarnessRegistryProjection>();
    const client = createHarnessClient({ invoke: vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(snapshot(1)) });
    const write = client.remove(session.addonId);
    await client.refresh();
    late.resolve(snapshot(2));
    expect(await write).toEqual(snapshot(2));
  });

  it("successful concurrent mutations return the newest display state even when acknowledgements arrive out of order", async () => {
    const late = deferred<HarnessRegistryProjection>();
    const client = createHarnessClient({ invoke: vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(snapshot(3)) });
    client.applySnapshot(snapshot(1));
    const earlier = client.remove("addon.first");
    await client.remove("addon.second");
    late.resolve(snapshot(2));
    expect(await earlier).toEqual(snapshot(3));
  });

  it("keeps replay cursors only for the current owner generation", async () => {
    let cursors: Map<string, number> | undefined;
    const originalSet = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<string, number>, key, value) {
      if (typeof key === "string" && key.includes('"session-1"')) cursors = this;
      return originalSet.call(this, key, value);
    });
    try {
      const client = createHarnessClient({ events: async function* (ref) { yield { ...event(1), ...ref }; } });
      for (let generation = 2; generation < 12; generation++) {
        client.applySnapshot({ ...snapshot(generation), slots: {
          "primary-agent": { addonId: session.addonId, generation, available: true },
        } });
        for await (const frame of client.events({ ...session, generation })) expect(frame.sequence).toBe(1);
        expect(cursors?.size).toBe(1);
      }
      client.applySnapshot(snapshot(12));
      expect(cursors?.size).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it("never projects mutations before acknowledgement or rolls back on a delayed registry read", async () => {
    const read = deferred<HarnessRegistryProjection>();
    const write = deferred<HarnessRegistryProjection>();
    const invoke = vi.fn().mockImplementation((command) => command === "harness_registry" ? read.promise : write.promise);
    const client = createHarnessClient({ invoke });
    client.applySnapshot(snapshot(1));
    const refresh = client.refresh();
    const assignment = client.assignSlot({ slot: "primary-agent", addonId: session.addonId, expectedGeneration: 1, replace: true });
    expect(client.getSnapshot()).toEqual(snapshot(1));
    write.resolve(snapshot(3));
    await assignment;
    read.resolve(snapshot(2));
    await refresh;
    expect(client.getSnapshot()).toEqual(snapshot(3));
    expect(invoke.mock.calls).toEqual([
      ["harness_registry"],
      ["harness_assign_slot", { slot: "primary-agent", addonId: session.addonId, expectedGeneration: 1, replace: true }],
    ]);
  });

  it.each(Object.entries(HARNESS_PUBLIC_ERROR_MESSAGES))("surfaces the public %s error unchanged and retains acknowledged state", async (code, message) => {
    const failure = Object.assign(new Error(message), { code });
    const client = createHarnessClient({ invoke: vi.fn().mockRejectedValue(failure) });
    client.applySnapshot(snapshot(2));
    await expect(client.remove(session.addonId)).rejects.toBe(failure);
    expect(client.getSnapshot()).toEqual(snapshot(2));
  });

  it("out-of-order or foreign stream frames cannot roll state back or supply governance", async () => {
    const projected = { ...snapshot(2), slots: { "primary-agent": { addonId: session.addonId, generation: 2, available: true } } };
    const frames = async function* () {
      yield event(3);
      yield event(2);
      yield event(3);
      yield { ...event(4), bootEpoch: "old-boot" };
      yield { ...event(5), generation: 1 };
      yield { ...event(6), sessionId: "foreign" };
      yield { ...event(7), addonId: "addon.foreign" };
      yield event(8);
    };
    const client = createHarnessClient({ events: frames });
    client.applySnapshot(projected);
    const received = [];
    for await (const frame of client.events(session)) received.push(frame);
    expect(received).toEqual([event(3), event(8)]);
    expect(client.getSnapshot()).toEqual(projected);
    const replayed = [];
    for await (const frame of client.events(session)) replayed.push(frame);
    expect(replayed).toEqual([]);
  });

  it("rejects stream output after a newer projection withdraws ownership", async () => {
    const client = createHarnessClient({ events: async function* () {
      yield event(1);
      client.applySnapshot(snapshot(3));
      yield event(2);
    } });
    client.applySnapshot({ ...snapshot(2), slots: { "primary-agent": { addonId: session.addonId, generation: 2, available: true } } });
    const received = [];
    for await (const frame of client.events(session)) received.push(frame);
    expect(received).toEqual([event(1)]);
    expect(client.getSnapshot()).toEqual(snapshot(3));
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("boot uses the client acknowledgement instead of stored governance, including after an offline restart", async () => {
  vi.stubEnv("MODE", "development");
  const forged = { ...snapshot(2), candidates: [],
    slots: { "primary-agent": { addonId: "addon.saved", generation: 2, available: true } } };
  let saved = JSON.stringify({ activeSystemSlotProviderIds: { "primary-agent": "addon.saved" },
    installations: { "addon.saved": { installed: true, enabled: true, grantedCapabilities: [] } },
    harnessProjection: forged, candidates: [{ id: "addon.saved" }] });
  vi.stubGlobal("window", { localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } } });
  const fetchMock = vi.fn().mockImplementation(async () => new Response("[]"));
  vi.stubGlobal("fetch", fetchMock);
  const pending = deferred<HarnessRegistryProjection>();
  const invoke = vi.fn().mockReturnValue(pending.promise);
  const client = createHarnessClient({ invoke });
  const boot = loadInitialShellState(client);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("harness_registry"));
  expect(client.getSnapshot()).toBeNull();
  expect(JSON.parse(saved)).toHaveProperty("harnessProjection", forged);
  const acknowledged: HarnessRegistryProjection = { ...snapshot(3),
    installations: { "addon.host": { addonId: "addon.host", installed: true, enabled: true,
      grantedCapabilities: [], disabledOperations: [], hiddenSurfaceIds: [] } },
    slots: { "primary-agent": { addonId: "addon.host", generation: 3, available: true } } };
  pending.resolve(acknowledged);
  const { state } = await boot;
  expect(JSON.parse(saved)).not.toHaveProperty("harnessProjection");
  expect(JSON.parse(saved)).not.toHaveProperty("installations");
  expect(state.activeSystemSlotProviderIds).toEqual({ "primary-agent": "addon.host" });
  expect(state.installations).not.toHaveProperty("addon.saved");
  expect(state.installations["addon.host"]).toMatchObject({ installed: true, enabled: true });
  expect(state.distributionModel).toBe("curated-plus-sideload");
  expect(client.getSnapshot()).toEqual(acknowledged);
  const offline = createHarnessClient({ invoke: vi.fn().mockRejectedValue(new Error("offline")) });
  const restarted = await loadInitialShellState(offline);
  expect(offline.getSnapshot()).toBeNull();
  expect(restarted.state.activeSystemSlotProviderIds).toEqual({});
  expect(restarted.state.installations).toEqual({});
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/addons/dev-index.json", "/addons/dev-index.json"]);
});
