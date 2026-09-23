import type { AddOnManifest, CapabilityGrant, HarnessEvent, HarnessRegistryProjection, SystemSlotId } from "./contracts";
import { webHarnessEvents, webInvoke, type HarnessSession, type HarnessStreamOptions } from "./web-transport";

// supportedOperations is added by harness-host-service to registry installations.
export type HarnessProjection = HarnessRegistryProjection & {
  installations: Readonly<Record<string, HarnessRegistryProjection["installations"][string] & {
    supportedOperations?: readonly import("./contracts").HarnessOperation[];
  }>>;
};

type Transport = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  events: (session: HarnessSession, options?: HarnessStreamOptions) => AsyncIterable<HarnessEvent>;
};

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// An in-memory external store for React's useSyncExternalStore. No local state,
// catalog defaults, or command intent can establish host governance here.
export function createHarnessClient(transport: Partial<Transport> = {}) {
  const invoke = transport.invoke ?? webInvoke;
  const readEvents = transport.events ?? webHarnessEvents;
  const listeners = new Set<() => void>();
  const sequences = new Map<string, number>();
  let projection: HarnessProjection | null = null;
  let epochVersion = 0;
  const ownerKey = (value: HarnessProjection | null) => {
    const owner = value?.slots["primary-agent"];
    return JSON.stringify([value?.bootEpoch, owner?.addonId, owner?.generation, owner?.available]);
  };
  function publish(next: HarnessProjection) {
    if (!projection || next.bootEpoch !== projection.bootEpoch) epochVersion++;
    if (ownerKey(next) !== ownerKey(projection)) sequences.clear();
    projection = freeze(structuredClone(next));
    for (const listener of listeners) listener();
  }

  function applySnapshot(next: HarnessProjection): boolean {
    if (!Number.isSafeInteger(next.revision) || next.revision < 0 ||
        (projection && (next.bootEpoch !== projection.bootEpoch || next.revision <= projection.revision))) return false;
    publish(next);
    return true;
  }
  async function command(name: string, args?: Record<string, unknown>) {
    const requestEpochVersion = epochVersion;
    const next = args === undefined ? await invoke<HarnessProjection>(name) : await invoke<HarnessProjection>(name, args);
    // Only an authenticated registry refresh can establish a different boot.
    // Pending responses from before that transition cannot restore the old boot.
    if (requestEpochVersion === epochVersion || next.bootEpoch === projection?.bootEpoch) {
      if (name === "harness_registry" && projection && next.bootEpoch !== projection.bootEpoch &&
          typeof next.bootEpoch === "string" && next.bootEpoch.length > 0 &&
          Number.isSafeInteger(next.revision) && next.revision >= 0) {
        publish(next);
      } else applySnapshot(next);
    }
    // A successful host command may arrive after a newer acknowledgement.
    // Return current display state; a discarded snapshot is not a failed mutation.
    return projection!;
  }
  return {
    getSnapshot: () => projection,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    applySnapshot,
    refresh: () => command("harness_registry"),
    install: (manifest: AddOnManifest, enabled: boolean) => command("harness_install", { manifest, enabled }),
    setGrants: (args: { addonId: string; grants: readonly CapabilityGrant[]; consent: boolean; expectedRevision: number }) =>
      command("harness_grants", args),
    remove: (addonId: string) => command("harness_remove", { addonId }),
    assignSlot: (args: { slot: SystemSlotId; addonId: string | null; expectedGeneration: number; replace?: boolean }) =>
      command("harness_assign_slot", args),
    createSession: (addonId: string) => invoke<{ session: HarnessSession }>("harness_session", { addonId }),
    turn: (session: HarnessSession, input: Record<string, unknown>) => invoke<{ turnId: string }>("harness_turn", { session, input }),
    cancel: (session: HarnessSession, turnId: string) => invoke("harness_cancel", { session, turnId }),
    history: (session: HarnessSession) => invoke<{ history: unknown }>("harness_history", { session }),
    status: (session: HarnessSession) => invoke<{ status: unknown }>("harness_status", { session }),
    selectModel: (session: HarnessSession, model: { provider: string; model: string }) =>
      invoke<{ selection: unknown }>("harness_select_model", { session, model }),
    async *events(session: HarnessSession, options?: HarnessStreamOptions): AsyncGenerator<HarnessEvent> {
      const key = JSON.stringify([session.bootEpoch, session.addonId, session.sessionId, session.generation]);
      for await (const frame of readEvents(session, options)) {
        const owner = projection?.slots["primary-agent"];
        if (!owner?.available || projection?.bootEpoch !== session.bootEpoch || owner.addonId !== session.addonId ||
            owner.generation !== session.generation) return;
        if (frame.addonId !== session.addonId || frame.sessionId !== session.sessionId || frame.bootEpoch !== session.bootEpoch ||
            frame.generation !== session.generation || !Number.isSafeInteger(frame.sequence) || frame.sequence <= (sequences.get(key) ?? 0)) continue;
        sequences.set(key, frame.sequence);
        yield frame;
      }
    },
  };
}
