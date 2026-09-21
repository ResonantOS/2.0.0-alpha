import { randomUUID } from 'node:crypto';
import { assertHarnessOperation, publicHarnessError } from './harness-adapter-contract.mjs';
import { createHarnessEventBus } from './harness-event-bus.mjs';
const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });

// resolveAdapter is a host-supplied, reviewed factory. Concrete adapters,
// credentials, network transports and routes are intentionally separate owners.
export function createHarnessBoundary({ registry, resolveAdapter, maxSessions = 64, cleanupTimeoutMs = 1000, operationTimeoutMs = 30000, eventLimits = {} } = {}) {
  if (!registry || typeof resolveAdapter !== 'function' || !Number.isSafeInteger(maxSessions) || maxSessions < 1 ||
      ![cleanupTimeoutMs, operationTimeoutMs].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 2147483647)) throw new TypeError('Host boundary dependencies required.');
  const sessions = new Map(), pending = new Set();
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
  const unsubscribe = registry.onFence(({ slot }) => {
    // No await before aborting *all* affected pending and registered sessions.
    return Promise.all([...pending, ...sessions.values()].filter(ctx => ctx.authorization.slot === slot).map(retire));
  });
  function registered(ref) {
    const ctx = sessions.get(ref?.sessionId);
    const keys = ['addonId', 'bootEpoch', 'generation', 'sessionId'];
    if (!ctx || typeof ref !== 'object' || Reflect.ownKeys(ref).length !== keys.length ||
        keys.some(key => !Object.hasOwn(ref, key) || ref[key] !== ctx.ref[key]) || !current(ctx)) throw fail('session-not-found');
    return ctx;
  }
  async function call(ref, operation, input) {
    const ctx = registered(ref);
    assertHarnessOperation(ctx.authorization.runtime, operation);
    if (typeof ctx.adapter[operation] !== 'function') throw fail('unsupported-operation');
    const controller = new AbortController();
    const signal = AbortSignal.any([ctx.controller.signal, controller.signal]);
    try {
      const result = await bounded(() => ctx.adapter[operation]({ session: ctx.upstream, input, signal }), {
        timeoutMs: operationTimeoutMs, signal: ctx.controller.signal, onTimeout: () => controller.abort(),
      });
      check(ctx);
      return result;
    } catch (error) { check(ctx); throw fail(publicHarnessError(error).code); }
  }
  return {
    async createSession({ addonId, slot = 'primary-agent' } = {}) {
      if (slot !== 'primary-agent') throw fail('permission-denied');
      if (closed || sessions.size + pending.size >= maxSessions) throw fail('runtime-unavailable');
      const authorization = registry.authorize(slot, addonId);
      assertHarnessOperation(authorization.runtime, 'createSession');
      const ctx = { authorization, controller: new AbortController(), sessionId: randomUUID(), adapter: null, upstream: null, turn: null, disposed: false };
      pending.add(ctx);
      try {
        ctx.adapter = await resolveAdapter(structuredClone(authorization));
        check(ctx);
        ctx.creating = true;
        try { ctx.upstream = await ctx.adapter.createSession({ signal: ctx.controller.signal }); }
        finally { ctx.creating = false; }
        check(ctx);
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
      if (ctx.turn) throw fail('ownership-conflict');
      const turn = { turnId: randomUUID(), controller: new AbortController() };
      ctx.turn = turn;
      const signal = AbortSignal.any([ctx.controller.signal, turn.controller.signal]);
      const turnCurrent = () => current(ctx) && ctx.turn === turn && !signal.aborted;
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
      if (!ctx.turn || ctx.turn.turnId !== turnId) throw fail('session-not-found');
      const turn = ctx.turn;
      turn.controller.abort();
      ctx.bus.publish({ turnId, type: 'cancelled', data: {} });
      try { await bounded(() => ctx.adapter.cancel({ session: ctx.upstream, turnId, signal: ctx.controller.signal })); check(ctx); }
      catch (error) { check(ctx); throw fail(publicHarnessError(error).code); }
      // Keep the turn reserved until its iterator unwinds; an adapter ignoring
      // abort cannot overlap a replacement turn on the same upstream session.
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
