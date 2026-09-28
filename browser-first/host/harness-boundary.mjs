import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertHarnessOperation, publicHarnessError } from './harness-adapter-contract.mjs';
import { createHarnessEventBus } from './harness-event-bus.mjs';
const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });

// resolveAdapter is a host-supplied, reviewed factory. Concrete adapters,
// credentials, network transports and routes are intentionally separate owners.
export function createHarnessBoundary({ registry, resolveAdapter, maxSessions = 64, cleanupTimeoutMs = 1000, operationTimeoutMs = 30000, eventLimits = {} } = {}) {
  if (!registry || typeof resolveAdapter !== 'function' || !Number.isSafeInteger(maxSessions) || maxSessions < 1 ||
      ![cleanupTimeoutMs, operationTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647)) throw new TypeError('Host boundary dependencies required.');
  const sessions = new Map(), pending = new Set(), sessionKey = randomBytes(32);
  // Authenticate issued references so disposal retries need no unbounded
  // tombstones. A signed reference alone never authorizes adapter execution.
  function signedSessionId(authorization, nonce = randomUUID()) {
    const identity = [authorization.slot, authorization.addonId, authorization.bootEpoch, authorization.generation, nonce];
    return `${nonce}.${createHmac('sha256', sessionKey).update(JSON.stringify(identity)).digest('hex')}`;
  }
  function issuedReference(ref) {
    const authorization = { ...ref, slot: 'primary-agent' };
    if (!exactReference(ref) || typeof ref.sessionId !== 'string' || !/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(ref.sessionId)) return false;
    const expected = Buffer.from(signedSessionId(authorization, ref.sessionId.split('.')[0]));
    const actual = Buffer.from(ref.sessionId);
    return actual.length === expected.length && timingSafeEqual(actual, expected) && registry.isCurrent(authorization);
  }
  let closed = false;
  const current = ctx => !closed && !ctx.controller.signal.aborted && registry.isCurrent(ctx.authorization);
  function check(ctx) { if (!current(ctx)) throw fail('ownership-conflict'); }
  async function bounded(operation, { timeoutMs = cleanupTimeoutMs, signal, onTimeout } = {}) {
    let timer, onAbort;
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (signal?.aborted) throw fail('ownership-conflict');
        return operation();
      }), new Promise((_, reject) => {
        onAbort = () => reject(fail('ownership-conflict'));
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          reject(fail('deadline-exceeded'));
          onTimeout?.();
        }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  async function dispose(ctx) {
    if (!ctx.adapter || ctx.creating || ctx.disposed) return;
    ctx.disposed = true;
    await bounded(() => ctx.adapter.dispose({ session: ctx.upstream }));
  }
  function retire(ctx) {
    ctx.controller.abort(); ctx.turn?.controller.abort(); ctx.bus?.close('ownership-conflict');
    sessions.delete(ctx.sessionId);
    // Cleanup is best-effort only after local authority and output are fenced.
    // Adapter failures must not strand an otherwise durable governance change.
    return dispose(ctx).catch(() => {});
  }
  const unsubscribe = registry.onFence(({ slot, addonId, policy }) => {
    if (policy) {
      const cleanup = [];
      for (const ctx of [...pending, ...sessions.values()].filter(ctx => ctx.authorization.addonId === addonId)) {
        if (policy.hardStop || policy.disabledOperations.includes('createSession')) {
          cleanup.push(retire(ctx)); continue;
        }
        for (const work of ctx.operations) if (policy.disabledOperations.includes(work.operation)) work.controller.abort();
        if (ctx.turn && policy.disabledOperations.includes('invoke') && !ctx.turn.controller.signal.aborted) {
          const turn = ctx.turn;
          turn.controller.abort();
          ctx.bus.publish({ turnId: turn.turnId, type: 'cancelled', data: {} });
          cleanup.push(bounded(() => ctx.adapter.cancel?.({ session: ctx.upstream, turnId: turn.turnId, signal: ctx.controller.signal })).catch(() => {}));
        }
      }
      return Promise.all(cleanup);
    }
    // No await before aborting *all* affected pending and registered sessions.
    return Promise.all([...pending, ...sessions.values()].filter(ctx => ctx.authorization.slot === slot).map(retire));
  });
  const referenceKeys = ['addonId', 'bootEpoch', 'generation', 'sessionId'];
  function exactReference(ref) {
    return ref && typeof ref === 'object' && Reflect.ownKeys(ref).length === referenceKeys.length &&
      referenceKeys.every(key => Object.hasOwn(ref, key));
  }
  function matches(ref, ctx) {
    return ctx && exactReference(ref) && referenceKeys.every(key => ref[key] === ctx.ref[key]);
  }
  function registered(ref) {
    const ctx = sessions.get(ref?.sessionId);
    if (!matches(ref, ctx) || !current(ctx)) throw fail('session-not-found');
    return ctx;
  }
  async function call(ref, operation, input) {
    const ctx = registered(ref);
    assertHarnessOperation(ctx.authorization.runtime, operation);
    registry.assertOperation(ctx.authorization, operation);
    if (typeof ctx.adapter[operation] !== 'function') throw fail('unsupported-operation');
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.controller.signal, controller.signal]);
    const work = { operation, controller };
    ctx.operations.add(work);
    try {
      const result = await bounded(() => ctx.adapter[operation]({ session: ctx.upstream, input, signal }), {
        timeoutMs: operationTimeoutMs, signal, onTimeout: () => controller.abort(),
      });
      check(ctx);
      registry.assertOperation(ctx.authorization, operation);
      if (signal.aborted) throw fail('permission-denied');
      return result;
    } catch (error) { check(ctx); registry.assertOperation(ctx.authorization, operation); throw fail(publicHarnessError(error).code); }
    finally { ctx.operations.delete(work); }
  }
  return {
    async createSession({ addonId, slot = 'primary-agent' } = {}) {
      if (slot !== 'primary-agent') throw fail('permission-denied');
      if (closed || sessions.size + pending.size >= maxSessions) throw fail('runtime-unavailable');
      const authorization = registry.authorize(slot, addonId);
      assertHarnessOperation(authorization.runtime, 'createSession');
      registry.assertOperation(authorization, 'createSession');
      const ctx = { authorization, controller: new AbortController(), sessionId: signedSessionId(authorization), adapter: null, upstream: null, turn: null, operations: new Set(), disposed: false };
      pending.add(ctx);
      try {
        ctx.adapter = await resolveAdapter(structuredClone(authorization));
        check(ctx);
        ctx.creating = true;
        try { ctx.upstream = await ctx.adapter.createSession({ signal: ctx.controller.signal }); }
        finally { ctx.creating = false; }
        check(ctx);
        registry.assertOperation(authorization, 'createSession');
        if (!ctx.upstream) throw fail('runtime-unavailable');
        ctx.ref = { addonId, sessionId: ctx.sessionId, bootEpoch: authorization.bootEpoch, generation: authorization.generation };
        ctx.bus = createHarnessEventBus({ ...eventLimits, provenance: ctx.ref, isCurrent: () => current(ctx) });
        sessions.set(ctx.sessionId, ctx);
        return structuredClone(ctx.ref);
      } catch (error) {
        try { await dispose(ctx); } catch { /* Authority is already fenced. */ }
        if (!current(ctx)) throw fail('ownership-conflict');
        throw fail(publicHarnessError(error).code);
      } finally { pending.delete(ctx); }
    },
    events(ref) { return registered(ref).bus.subscribe(); },
    invoke(ref, input) {
      const ctx = registered(ref);
      assertHarnessOperation(ctx.authorization.runtime, 'invoke');
      registry.assertOperation(ctx.authorization, 'invoke');
      if (ctx.turn) throw fail('ownership-conflict');
      const turn = { turnId: randomUUID(), controller: new AbortController() };
      ctx.turn = turn;
      const signal = AbortSignal.any([ctx.controller.signal, turn.controller.signal]);
      const turnCurrent = () => {
        if (!current(ctx) || ctx.turn !== turn || signal.aborted) return false;
        try { registry.assertOperation(ctx.authorization, 'invoke'); return true; } catch { return false; }
      };
      // Invoke only on the next microtask, after publishing the registered turn.
      const completion = Promise.resolve().then(async () => {
        try {
          if (!turnCurrent()) return;
          const stream = await ctx.adapter.invoke({ session: ctx.upstream, input, signal });
          if (!turnCurrent()) return;
          for await (const frame of stream) {
            if (!turnCurrent()) return;
            if (!frame || Object.keys(frame).some(key => !['type', 'data'].includes(key))) throw fail('invalid-event');
            ctx.bus.publish({ turnId: turn.turnId, type: frame.type, data: frame.type === 'error' ? publicHarnessError(frame.data) : frame.data });
            if (['final', 'cancelled', 'error'].includes(frame.type)) return;
          }
        } catch (error) {
          if (turnCurrent()) ctx.bus.publish({ turnId: turn.turnId, type: 'error', data: publicHarnessError(error) });
        } finally { if (ctx.turn === turn) ctx.turn = null; }
      });
      return { turnId: turn.turnId, completion };
    },
    async cancel(ref, turnId) {
      const ctx = registered(ref);
      assertHarnessOperation(ctx.authorization.runtime, 'cancel');
      registry.assertOperation(ctx.authorization, 'cancel');
      if (!ctx.turn || ctx.turn.turnId !== turnId) throw fail('session-not-found');
      const turn = ctx.turn;
      turn.controller.abort();
      ctx.bus.publish({ turnId, type: 'cancelled', data: {} });
      try { await bounded(() => ctx.adapter.cancel({ session: ctx.upstream, turnId, signal: ctx.controller.signal })); check(ctx); }
      catch (error) { check(ctx); throw fail(publicHarnessError(error).code); }
      // Keep the turn reserved until its iterator unwinds; an adapter ignoring
      // abort cannot overlap a replacement turn on the same upstream session.
    },
    async dispose(ref) {
      if (!sessions.has(ref?.sessionId)) {
        if (closed || !issuedReference(ref)) throw fail('session-not-found');
        return;
      }
      const ctx = registered(ref);
      await retire(ctx);
    },
    history: ref => call(ref, 'history'),
    status: ref => call(ref, 'status'),
    modelCatalog: ref => call(ref, 'modelCatalog'),
    selectModel: (ref, input) => call(ref, 'selectModel', input),
    async close() {
      closed = true; unsubscribe();
      await Promise.allSettled([...pending, ...sessions.values()].map(retire));
    },
  };
}
