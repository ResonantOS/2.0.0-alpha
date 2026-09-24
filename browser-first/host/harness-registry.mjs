import { randomUUID } from 'node:crypto';
import { assertValidHarnessManifest, publicHarnessError } from './harness-adapter-contract.mjs';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });
const slots = { 'primary-agent': 'agent-runtime', 'chat-interface': 'chat-interface', 'memory-system': 'memory-provider', 'communication-channel': 'notifications' };
const empty = () => ({ revision: 0, governanceActivated: false, installations: {}, slots: {} });
const counter = n => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER;
const grantShape = grant => ({ capability: grant.capability, scope: grant.scope, revocationBehavior: grant.revocationBehavior, granted: grant.granted });
const sameRequest = (a, b) => a.capability === b.capability && a.scope === b.scope && a.revocationBehavior === b.revocationBehavior;

// Host-only API. Routes supply explicit consent later; no browser or adapter may
// write this state. Binding metadata authorizes use, never resolves credentials.
export async function createHarnessRegistry({ store, reviewedAdapterIds = [], bindings = [] } = {}) {
  if (!store?.read || !store?.write) throw new TypeError('Durable registry store required.');
  const reviewed = new Set(reviewedAdapterIds), approvedBindings = structuredClone(bindings);
  const bootEpoch = randomUUID(), listeners = new Set(), fenced = new Set();
  let state = empty(), disabled = false, queue = Promise.resolve();

  function bindingAllowed(manifest) {
    const runtime = manifest.agentRuntime;
    if (!runtime || runtime.adapterVersion !== 1 || !reviewed.has(runtime.adapterId)) return false;
    if (runtime.authScheme === 'none' && !runtime.endpoint) return true;
    return approvedBindings.some(binding => binding.addonId === manifest.id && binding.adapterId === runtime.adapterId &&
      binding.name === runtime.credentialBinding && binding.authScheme === runtime.authScheme &&
      binding.endpoint === runtime.endpoint);
  }
  function validateGrants(entry, grants) {
    if (!Array.isArray(grants) || new Set(grants.map(g => g?.capability)).size !== grants.length || grants.some(grant =>
      !grant || Object.keys(grant).some(key => !['capability', 'scope', 'revocationBehavior', 'granted'].includes(key)) ||
      typeof grant.granted !== 'boolean' || !entry.manifest.requestedCapabilities.some(request => sameRequest(request, grant)))) throw fail('permission-denied');
  }
  try {
    const document = await store.read();
    if (document !== null) {
      if (document?.version !== 1 || !['pending', 'committed'].includes(document.phase)) throw fail('runtime-unavailable');
      const loaded = structuredClone(document.state);
      if (!loaded || !counter(loaded.revision) || typeof loaded.governanceActivated !== 'boolean' ||
          !loaded.installations || Array.isArray(loaded.installations) || !loaded.slots || Array.isArray(loaded.slots) ||
          Object.keys(loaded.installations).length > 256) throw fail('runtime-unavailable');
      for (const [id, entry] of Object.entries(loaded.installations)) {
        // Validate saved consent against its original requests before adding a
        // runtime request. Legacy delegation authority must never be relabelled.
        validateGrants(entry, entry.grants);
        if (entry.manifest.systemSlots?.some(slot => slot.id === 'primary-agent')) {
          let request = entry.manifest.requestedCapabilities.find(grant => grant.capability === 'agent-runtime');
          if (!request && entry.manifest.requestedCapabilities.some(grant => grant.capability === 'agent-delegation')) {
            request = { capability: 'agent-runtime', scope: 'system', revocationBehavior: 'hard-stop', granted: false };
            entry.manifest.requestedCapabilities.push(request);
          }
          if (request && !entry.grants.some(grant => grant.capability === 'agent-runtime')) {
            entry.grants.push({ ...grantShape(request), granted: false });
          }
        }
        assertValidHarnessManifest(entry.manifest);
        if (id !== entry.manifest.id || typeof entry.enabled !== 'boolean') throw fail('runtime-unavailable');
      }
      for (const [slot, owner] of Object.entries(loaded.slots)) {
        if (!Object.hasOwn(slots, slot) || !counter(owner.generation) ||
            (owner.addonId !== null && !Object.hasOwn(loaded.installations, owner.addonId))) throw fail('runtime-unavailable');
      }
      state = structuredClone(loaded);
      disabled = document.phase !== 'committed';
    }
  } catch {
    disabled = true;
    // Unknown persisted authority must never look like an unmanaged legacy slot.
    state = { ...empty(), governanceActivated: true, slots: { 'primary-agent': { addonId: null, generation: 0 } } };
  }

  const entryFor = addonId => {
    if (!Object.hasOwn(state.installations, addonId)) throw fail('permission-denied');
    return state.installations[addonId];
  };
  function eligible(entry, slot) {
    if (!entry?.enabled || !entry.manifest.systemSlots?.some(item => item.id === slot)) return false;
    // Only primary execution needs a reviewed runtime and approved binding.
    // Other slots authorize their own capability on an installed registry entry.
    if (slot === 'primary-agent' && !bindingAllowed(entry.manifest)) return false;
    const required = [slots[slot], ...(slot === 'primary-agent' ? entry.manifest.agentRuntime.requiredCapabilities : [])];
    return required.every(capability => entry.grants.some(grant => grant.capability === capability && grant.granted));
  }
  function authorize(slot, addonId) {
    if (disabled) throw fail('runtime-unavailable');
    const owner = state.slots[slot];
    if (!Object.hasOwn(slots, slot) || !owner?.addonId || owner.addonId !== addonId || fenced.has(slot) || !eligible(state.installations[addonId], slot)) throw fail('permission-denied');
    return { slot, addonId, bootEpoch, generation: owner.generation, runtime: structuredClone(state.installations[addonId].manifest.agentRuntime) };
  }
  function isCurrent(authorization) {
    try {
      const current = authorize(authorization.slot, authorization.addonId);
      return authorization.bootEpoch === current.bootEpoch && authorization.generation === current.generation;
    } catch { return false; }
  }
  /** @returns {import('../../src/core/contracts.ts').HarnessRegistryProjection} */
  function snapshot() {
    const installations = Object.fromEntries(Object.entries(state.installations).map(([addonId, entry]) => [addonId, {
      addonId, installed: true, enabled: entry.enabled, grantedCapabilities: structuredClone(entry.grants),
      disabledOperations: disabled || !entry.enabled ? [...(entry.manifest.agentRuntime?.supportedOperations ?? [])] : [], hiddenSurfaceIds: [],
    }]));
    const projection = Object.fromEntries(Object.entries(state.slots).map(([slot, owner]) => [slot, { ...owner,
      available: !disabled && !fenced.has(slot) && !!owner.addonId && eligible(state.installations[owner.addonId], slot),
    }]));
    return { bootEpoch, revision: state.revision, governanceActivated: state.governanceActivated, candidates: [], installations, slots: projection };
  }
  function notify(slot) {
    fenced.add(slot); // Fence synchronously, before listeners or durable I/O.
    return [...listeners].map(listener => {
      try { return Promise.resolve(listener({ slot })); } catch (error) { return Promise.reject(error); }
    });
  }
  function transact(prepare) {
    const operation = queue.then(async () => {
      if (disabled) throw fail('runtime-unavailable');
      const next = structuredClone(state), changedSlots = prepare(next);
      if (!counter(next.revision + 1)) throw fail('runtime-unavailable');
      next.revision++;
      const cleanup = Promise.allSettled(changedSlots.flatMap(notify));
      try {
        await store.write({ version: 1, phase: 'pending', state: next });
        const results = await cleanup;
        if (results.some(result => result.status === 'rejected')) throw fail('runtime-unavailable');
        await store.write({ version: 1, phase: 'committed', state: next });
        state = next;
        for (const slot of changedSlots) fenced.delete(slot);
        return snapshot();
      } catch {
        disabled = true;
        await Promise.allSettled(Object.keys(state.slots).flatMap(notify));
        throw fail('runtime-unavailable');
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function ownedSlots(next, addonId) {
    return Object.keys(next.slots).filter(slot => next.slots[slot].addonId === addonId);
  }
  function advance(next, changed) {
    for (const slot of changed) {
      if (!counter(next.slots[slot].generation + 1)) throw fail('runtime-unavailable');
      next.slots[slot].generation++;
    }
    return changed;
  }
  return {
    snapshot, authorize, isCurrent,
    onFence(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    install(manifest, { enabled } = {}) {
      // Capture input before entering the serialized queue to prevent TOCTOU edits.
      const captured = structuredClone(manifest);
      return transact(next => {
        assertValidHarnessManifest(captured);
        if (typeof enabled !== 'boolean' || (captured.agentRuntime?.adapterVersion !== undefined && !bindingAllowed(captured))) throw fail('permission-denied');
        if (Buffer.byteLength(JSON.stringify(captured)) > 262144) throw fail('invalid-manifest');
        if (!Object.hasOwn(next.installations, captured.id) && Object.keys(next.installations).length >= 256) throw fail('runtime-unavailable');
        const changed = ownedSlots(next, captured.id);
        // Replacement of an installed manifest cannot silently mutate an owner.
        if (changed.length) throw fail('ownership-conflict');
        captured.requestedCapabilities = captured.requestedCapabilities.map(grant => ({ ...grantShape(grant), granted: false }));
        next.installations[captured.id] = { manifest: captured, enabled, grants: structuredClone(captured.requestedCapabilities) };
        return [];
      });
    },
    importLegacy(records) {
      const captured = structuredClone(records);
      return transact(next => {
        if (!Array.isArray(captured) || captured.length > 256) throw fail('invalid-manifest');
        for (const record of captured) {
          const manifest = record?.manifest;
          assertValidHarnessManifest(manifest);
          if (Buffer.byteLength(JSON.stringify(manifest)) > 262144) throw fail('invalid-manifest');
          // Imported booleans and local selections are proposals, never consent.
          // Existing host records always win over a migration candidate.
          if (Object.hasOwn(next.installations, manifest.id)) continue;
          if (Object.keys(next.installations).length >= 256) throw fail('runtime-unavailable');
          manifest.requestedCapabilities = manifest.requestedCapabilities.map(grant => ({ ...grantShape(grant), granted: false }));
          next.installations[manifest.id] = { manifest, enabled: false, grants: structuredClone(manifest.requestedCapabilities) };
        }
        return [];
      });
    },
    setGrants(addonId, grants, { consent, expectedRevision } = {}) {
      const captured = structuredClone(grants);
      return transact(next => {
        if (expectedRevision !== state.revision) throw fail('ownership-conflict');
        if (consent !== true) throw fail('permission-denied');
        const entry = entryFor(addonId); validateGrants(entry, captured);
        const revoked = captured.some(grant => !grant.granted && entry.grants.some(old => old.capability === grant.capability && old.granted));
        next.installations[addonId].grants = entry.grants.map(old => grantShape(captured.find(grant => sameRequest(old, grant)) ?? old));
        // Phase 1 conservatively fences any revoked grant; per-operation degrade
        // and hide-surface behavior belongs to the later policy increment.
        return advance(next, revoked ? ownedSlots(next, addonId) : []);
      });
    },
    setEnabled(addonId, enabled, { expectedRevision } = {}) {
      return transact(next => {
        entryFor(addonId);
        if (expectedRevision !== state.revision) throw fail('ownership-conflict');
        if (typeof enabled !== 'boolean') throw fail('permission-denied');
        next.installations[addonId].enabled = enabled;
        return advance(next, ownedSlots(next, addonId));
      });
    },
    assignSlot(slot, addonId, { expectedGeneration, replace = false } = {}) {
      return transact(next => {
        if (!Object.hasOwn(slots, slot)) throw fail('permission-denied');
        const incumbent = state.slots[slot] ?? { addonId: null, generation: 0 };
        if (expectedGeneration !== incumbent.generation) throw fail('ownership-conflict');
        if (incumbent.addonId && !replace) throw fail('ownership-conflict');
        if (addonId !== null && !eligible(entryFor(addonId), slot)) throw fail('permission-denied');
        if (!counter(incumbent.generation + 1)) throw fail('runtime-unavailable');
        next.slots[slot] = { addonId, generation: incumbent.generation + 1 };
        if (slot === 'primary-agent') next.governanceActivated = true;
        return [slot];
      });
    },
    remove(addonId) {
      return transact(next => {
        entryFor(addonId);
        if (ownedSlots(next, addonId).length) throw fail('ownership-conflict');
        delete next.installations[addonId];
        return [];
      });
    },
  };
}
