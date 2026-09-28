// DSH 0.1.5 Typert shapes follow the checked-in Manolo client. This module
// receives an opened 1C transport: no credential access, auth retries or logs.
import { randomUUID } from 'node:crypto';
import { publicHarnessError, validateHarnessEvent } from '../harness-adapter-contract.mjs';
import { buildAugmentorChatRequestMessages } from '../augmentor-chat-contract.mjs';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });
const safe = error => fail(publicHarnessError(error).code);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = value => Number.isSafeInteger(value) && value >= -1;
// Validation-only identity; never published. The 1B boundary/event bus assigns
// real provenance and revalidates every frame before publishing it.
const validationIdentity = { addonId: 'addon.dsh', sessionId: 'validation', turnId: 'validation', bootEpoch: 'validation', generation: 0, sequence: 1 };
function frame(type, data) {
  if (!validateHarnessEvent({ ...validationIdentity, type, data })) throw fail('invalid-event');
  return { type, data };
}
function text(value) { frame('delta', { text: value }); return value; }
function content(parts) {
  if (!Array.isArray(parts) || parts.length > 256) throw fail('invalid-event');
  // Model-internal reasoning parts carry no reply text or authority; DSH
  // reasoning models emit them ahead of the text part. Other non-text types
  // remain hostile and reject the envelope.
  return text(parts.flatMap(part => {
    if (!record(part)) throw fail('invalid-event');
    if (part.type === 'reasoning') return [];
    if (part.type !== 'text' || typeof part.text !== 'string') throw fail('invalid-event');
    return [part.text];
  }).join(''));
}
function identifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw fail('invalid-event');
  return text(value);
}
function selection(value, allowUnknown = false) {
  if (!record(value) || (!allowUnknown && Object.keys(value).some(key => !['provider', 'model'].includes(key)))) throw fail('invalid-event');
  return { provider: identifier(value.provider), model: identifier(value.model) };
}

export function createDshTypertAdapter({ transport, followTimeoutMs = 15000, turnTimeoutMs = 120000, maxQueueBytes = 262144 } = {}) {
  if (!transport || !['request', 'openStream', 'dispose'].every(key => typeof transport[key] === 'function') ||
      ![followTimeoutMs, turnTimeoutMs, maxQueueBytes].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647)) throw fail('runtime-unavailable');
  let rpcSequence = 0, closed = false;
  const sessions = new Map();
  const capabilities = Object.freeze({ contextRoleFidelity: 'text-only', toolCallbacks: false,
    browserTools: 'unavailable', approvals: 'unavailable', augmentorSave: 'unavailable', augmentorUnsave: 'unavailable', augmentorState: 'unavailable' });
  function stateFor(session) {
    const state = sessions.get(session);
    if (closed || !state) throw fail('session-not-found');
    return state;
  }
  async function rpc(method, args = {}, signal) {
    try {
      if (closed || signal?.aborted) throw fail('runtime-unavailable');
      const rpcId = `augmentor-${++rpcSequence}`;
      const { body } = await transport.request(`/api/${method}`, { method: 'POST', signal,
        body: { type: 'client-request', rpcId, method, payload: { args } } });
      if (closed || signal?.aborted || body?.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true) throw fail('runtime-unavailable');
      return body.result.value;
    } catch (error) { throw safe(error); }
  }
  function disconnect(state, error = fail('runtime-unavailable')) {
    state.status = 'unknown';
    // A failed turn invalidates its subscription, not the session's ownership.
    if (['permission-denied', 'ownership-conflict'].includes(error.code)) state.fenced = true;
    const follow = state.follow;
    state.follow = null;
    if (follow) { clearTimeout(follow.timer); follow.reject(error); follow.controller.abort(); follow.stream?.close(); }
    state.turn?.finish(frame('error', publicHarnessError(error)));
  }
  function eventReceived(state, event) {
    if (!record(event) || !counter(event.seq) || event.seq < 0 || typeof event.type !== 'string') throw fail('invalid-event');
    if (event.seq <= state.cursor) return;
    state.cursor = event.seq;
    const turn = state.turn;
    if (!turn || !turn.dispatched || turn.done) return;
    if (event.type === 'turn/start') {
      turn.started = true;
      state.status = 'running';
      turn.push(frame('status', { status: state.status }));
    }
    // A fresh subscription can still carry the old turn's trailing live output.
    // Only a post-dispatch, post-cursor turn/start admits output to this turn.
    if (!turn.started) return;
    if (event.type === 'assistant/message') {
      turn.confirmed = text([turn.confirmed, content(event.data?.message?.content)].filter(Boolean).join('\n\n'));
      turn.partial = '';
    } else if (event.type === 'turn/end') {
      if (event.data?.reason?.kind === 'error') disconnect(state);
      else {
        state.status = 'idle';
        turn.push(frame('status', { status: state.status }));
        turn.finish(frame('final', { text: text([turn.confirmed, turn.partial].filter(Boolean).join('\n\n')) }));
      }
    } else if (event.type === 'error') disconnect(state);
    // Browser/tool/approval/plugin events carry no executable authority here.
  }
  async function follow(state, signal) {
    if (signal?.aborted || state.fenced || closed) throw fail('runtime-unavailable');
    if (!state.follow) {
      const pending = { controller: new AbortController() };
      pending.ready = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
      // A close/error can precede the awaiting caller's continuation.
      pending.ready.catch(() => {});
      state.follow = pending;
      pending.timer = setTimeout(() => disconnect(state, fail('deadline-exceeded')), followTimeoutMs);
      void transport.openStream({ signal: pending.controller.signal,
        onMessage(envelope) {
          if (state.follow !== pending || closed) return;
          try {
            if (envelope?.streamId !== 'augmentor') return;
            if (envelope.type === 'error' || envelope.type === 'end') throw fail('runtime-unavailable');
            if (envelope.type !== 'item' || !record(envelope.value)) throw fail('invalid-event');
            const value = envelope.value;
            if (value.type === 'snapshot') {
              if (pending.opened || !counter(value.cursor) || !Array.isArray(value.records) || value.records.length > 200 || typeof value.hasMore !== 'boolean') throw fail('invalid-event');
              // Initial history is not new turn output. History is separately
              // fetched via page and projected through the same text validator.
              state.cursor = value.cursor; pending.opened = true;
              clearTimeout(pending.timer); pending.resolve();
            } else if (!pending.opened) throw fail('invalid-event');
            else if (value.type === 'event') eventReceived(state, value.event);
            else if (value.type === 'assistant-stream' && value.frame?.type === 'chunk' && value.frame.chunk?.type === 'text-delta') {
              const delta = text(value.frame.chunk.text), turn = state.turn;
              if (turn?.dispatched && turn.started && !turn.done) {
                turn.partial = text(turn.partial + delta);
                text(turn.confirmed + turn.partial);
                turn.push(frame('delta', { text: delta }));
              }
            }
          } catch (error) { disconnect(state, safe(error)); }
        },
        onError: error => { if (state.follow === pending) disconnect(state, safe(error)); },
        onClose: () => { if (state.follow === pending) disconnect(state); },
      }).then(stream => {
        if (state.follow !== pending || closed) { stream.close(); return; }
        pending.stream = stream;
        stream.send({ type: 'open', streamId: 'augmentor', endpoint: 'session/follow', payload: { args: { request: {
          address: { kind: 'session', sessionId: state.id }, maxMessages: 200, assistantStream: true,
        } } } });
      }).catch(error => { if (state.follow === pending) disconnect(state, safe(error)); });
    }
    const pending = state.follow;
    let abort;
    try {
      await Promise.race([pending.ready, new Promise((_, reject) => {
        abort = () => reject(fail('runtime-unavailable'));
        signal?.addEventListener('abort', abort, { once: true });
      })]);
      if (signal?.aborted || state.follow !== pending || closed) throw fail('runtime-unavailable');
    } finally { signal?.removeEventListener('abort', abort); }
  }
  function cancelState(state, signal) {
    // Idempotent across the 1B abort signal and its explicit cancel callback.
    const turn = state.turn;
    if (turn?.cancellation) return turn.cancellation;
    if (!turn && state.cancellation) return state.cancellation;
    turn?.finish(frame('cancelled', {}));
    disconnect(state);
    state.cancellation = turn?.dispatched ? rpc('session/cancel', { request: { sessionId: state.id } }, signal).catch(error => {
      disconnect(state, error); throw error;
    }) : (state.cancellation ?? Promise.resolve());
    if (turn) turn.cancellation = state.cancellation;
    return state.cancellation;
  }
  const adapter = {
    capabilities,
    async probe({ signal } = {}) { await rpc('session/modelCatalog', {}, signal); return { available: true, ...capabilities }; },
    async createSession({ signal } = {}) {
      if (closed || sessions.size >= 64) throw fail('runtime-unavailable');
      const session = Object.freeze({ sessionId: `resonantos-${randomUUID()}` });
      await rpc('session/create', { request: { sessionId: session.sessionId } }, signal);
      sessions.set(session, { id: session.sessionId, cursor: -1, status: 'unknown', follow: null, turn: null, fenced: false });
      return session;
    },
    async *invoke({ session, input, signal } = {}) {
      if (closed) throw fail('runtime-unavailable');
      const state = stateFor(session);
      if (state.turn || state.fenced) throw fail('runtime-unavailable');
      const queue = []; let bytes = 0, wake;
      const turn = { done: false, dispatched: false, started: false, confirmed: '', partial: '',
        push(value) {
          if (turn.done) return;
          const size = Buffer.byteLength(JSON.stringify(value));
          if (bytes + size > maxQueueBytes) { disconnect(state, fail('invalid-event')); return; }
          queue.push(value); bytes += size; wake?.();
        },
        finish(value) {
          if (turn.done) return;
          // Terminal results replace queued output on failure/cancel, so slow
          // readers cannot receive buffered text after the turn is fenced.
          if (value.type !== 'final') { queue.length = 0; bytes = 0; }
          queue.push(value); turn.done = true; wake?.();
        },
      };
      state.turn = turn;
      const abort = () => { void cancelState(state).catch(() => {}); };
      const timer = setTimeout(() => { disconnect(state, fail('deadline-exceeded')); void cancelState(state).catch(() => {}); }, turnTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted) { abort(); }
        else {
          let prompt;
          try {
            prompt = text(buildAugmentorChatRequestMessages(input).map(item => `${item.role}:\n${item.content}`).join('\n\n'));
            // Settle the preceding cancel before dispatching another prompt:
            // session/cancel must never race against the new turn upstream.
            const cancellation = state.cancellation;
            if (cancellation) {
              await cancellation.catch(() => {});
              if (state.cancellation === cancellation) state.cancellation = null;
            }
            if (!turn.done && !signal?.aborted) await follow(state, signal);
            if (!turn.done && !signal?.aborted) {
              turn.dispatched = true;
              const accepted = await rpc('session/prompt', { request: { sessionId: state.id, mode: 'queue',
                content: [{ type: 'text', text: prompt }], requestId: randomUUID() } }, signal);
              if (accepted?.accepted !== true) throw fail('runtime-unavailable');
            }
          } catch (error) {
            // No output is yielded before RPC acceptance. A concurrent final
            // cannot turn an explicitly rejected/uncertain request into success.
            if (!turn.done || queue.at(-1)?.type === 'final') {
              turn.done = false; disconnect(state, safe(error));
            }
          }
        }
        while (queue.length || !turn.done) {
          if (!queue.length) { await new Promise(resolve => { wake = resolve; }); wake = null; continue; }
          const value = queue.shift(); bytes -= Buffer.byteLength(JSON.stringify(value)); yield value;
        }
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (!turn.done) await cancelState(state).catch(() => {});
        if (state.turn === turn) state.turn = null;
      }
    },
    async cancel({ session, signal } = {}) { await cancelState(stateFor(session), signal); },
    async status({ session } = {}) { return { status: stateFor(session).status }; },
    async history({ session, input = {}, signal } = {}) {
      const state = stateFor(session);
      await follow(state, signal);
      const maxMessages = input.maxMessages ?? 200;
      if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw fail('invalid-event');
      const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: state.id }, throughSeq: state.cursor, maxMessages: Math.min(maxMessages, 200) } }, signal);
      if (!Array.isArray(page?.records) || page.records.length > 200 || typeof page.hasMore !== 'boolean') throw fail('invalid-event');
      const messages = []; let total = 0;
      for (const row of page.records) {
        const event = row?.event;
        if (!['user/message', 'assistant/message'].includes(event?.type)) continue;
        const value = content(event.type === 'user/message' ? event.data?.content : event.data?.message?.content);
        total += Buffer.byteLength(value); if (total > 65536) throw fail('invalid-event');
        messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', content: value });
      }
      return { messages, hasMore: page.hasMore };
    },
    async modelCatalog({ session, signal } = {}) {
      stateFor(session);
      const catalog = await rpc('session/modelCatalog', {}, signal);
      if (!Array.isArray(catalog?.groups) || catalog.groups.length > 100) throw fail('invalid-event');
      let total = 0;
      const groups = catalog.groups.map(group => {
        if (!Array.isArray(group?.models) || group.models.length > 200) throw fail('invalid-event');
        const provider = identifier(group.provider);
        const models = group.models.map(model => {
          if (!record(model)) throw fail('invalid-event');
          const value = { model: identifier(model.model), ...(model.name === undefined ? {} : { name: text(model.name) }) };
          total += Buffer.byteLength(JSON.stringify(value));
          if (total > 65536) throw fail('invalid-event');
          return value;
        });
        total += Buffer.byteLength(provider); if (total > 65536) throw fail('invalid-event');
        return { provider, models };
      });
      return { groups, ...(catalog.default === undefined ? {} : { default: selection(catalog.default, true) }) };
    },
    async selectModel({ session, input, signal } = {}) {
      const state = stateFor(session);
      await rpc('session/selectModel', { request: { sessionId: state.id, ...selection(input) } }, signal);
      return { selected: true };
    },
    async dispose() {
      if (closed) return;
      for (const state of sessions.values()) state.fenced = true;
      try { await Promise.allSettled([...sessions.values()].map(state => cancelState(state))); }
      finally { closed = true; sessions.clear(); transport.dispose(); }
    },
  };
  return Object.freeze(adapter);
}
