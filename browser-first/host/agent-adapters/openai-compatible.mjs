import { createAgentRuntimeEndpoint } from '../agent-runtime-endpoint.mjs';
import { publicHarnessError } from '../harness-adapter-contract.mjs';
import { buildAugmentorChatRequestMessages } from '../augmentor-chat-contract.mjs';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });
const MAX_TEXT = 65536, MAX_FRAME = 65536, MAX_WIRE = 1048576, MAX_HISTORY = 262144;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 256;
function check(signal) {
  if (signal.aborted) throw fail(signal.reason?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'cancelled');
}

// Credential custody is confined to this transport closure. The wire reader
// below receives only an authorized request function and a sanitizer.
async function openTransport({ credentials, addonId, runtime, completionsPath, fetchImpl, lookup }) {
  if (runtime?.adapterId !== 'openai-compatible-v1' || runtime.authScheme !== 'bearer') throw fail('permission-denied');
  if (typeof completionsPath !== 'string' || completionsPath.length > 2048 ||
      !/^\/(?!\/)/.test(completionsPath) || /[\\?#\s]/.test(completionsPath)) throw fail('permission-denied');
  const lease = await credentials.acquire({ addonId, runtime });
  try {
    const endpoint = await lease.use(({ endpoint }) => endpoint);
    const guard = createAgentRuntimeEndpoint({ endpoint, lookup, fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init);
      // The shared guard rechecks abort after fetch. Release the response before
      // that check can discard it during a headers/abort race.
      if (init.signal.aborted) await response.body?.cancel();
      return response;
    } });
    return Object.freeze({
      request: (body, signal) => lease.use(({ actionToken }) => guard.connectHttp(completionsPath, {
        method: 'POST', headers: { Authorization: `Bearer ${actionToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body), signal,
      })),
      sanitize: value => lease.sanitize(value),
      dispose: () => lease.dispose(),
    });
  } catch (error) { lease.dispose(); throw fail(publicHarnessError(error).code); }
}

// Stateless wire decoder: no session IDs, transcript authority or credentials.
// A network chunk is neither an SSE event nor necessarily a complete UTF-8 code
// point. Bound total bytes, each event, and final text independently.
async function readCompletion(transport, body, signal) {
  let reader, response, text = '', pending = '', data = [], eventBytes = 0, wireBytes = 0;
  let complete = false, pendingCR = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(fail(signal.reason?.code === 'deadline-exceeded' ? 'deadline-exceeded' : 'cancelled'));
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  // Handle pre-abort without producing an unobserved rejected promise.
  const wait = async promise => { check(signal); return Promise.race([promise, aborted]); };
  function line(value) {
    if (value === '') {
      if (data.length) {
        const payload = data.join('\n'); data = [];
        if (payload === '[DONE]') { complete = true; return; }
        let event;
        try { event = JSON.parse(payload); } catch { throw fail('invalid-event'); }
        if (!record(event) || event.error || !Array.isArray(event.choices) || event.choices.length > 1) throw fail('invalid-event');
        // The optional streaming usage frame contains an empty choices array.
        if (!event.choices.length) { if (!record(event.usage)) throw fail('invalid-event'); }
        else {
          const choice = event.choices[0];
          if (!record(choice) || (choice.index !== undefined && choice.index !== 0) || !record(choice.delta) ||
              (choice.delta.content != null && typeof choice.delta.content !== 'string') ||
              choice.delta.tool_calls || choice.delta.function_call ||
              (choice.finish_reason != null && !['stop', 'length', 'content_filter'].includes(choice.finish_reason))) throw fail('invalid-event');
          text += choice.delta.content ?? '';
          if (Buffer.byteLength(text) > MAX_TEXT) throw fail('invalid-event');
        }
      }
      eventBytes = 0;
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    check(signal);
    const request = transport.request(body, signal);
    // If a connector resolves after cancellation, release its body too.
    void request.then(value => { if (signal.aborted) void value.body?.cancel().catch(() => {}); }, () => {});
    response = await wait(request);
    check(signal);
    if (!response.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw fail('runtime-unavailable');
    reader = response.body.getReader();
    while (!complete) {
      const chunk = await wait(reader.read());
      check(signal);
      if (chunk.done) { decoder.decode(); throw fail('invalid-event'); }
      wireBytes += chunk.value.byteLength;
      if (wireBytes > MAX_WIRE) throw fail('invalid-event');
      let decoded;
      try { decoded = decoder.decode(chunk.value, { stream: true }); } catch { throw fail('invalid-event'); }
      for (const char of decoded) {
        if (pendingCR && char === '\n') { pendingCR = false; continue; }
        pendingCR = char === '\r';
        eventBytes += Buffer.byteLength(char);
        if (eventBytes > MAX_FRAME) throw fail('invalid-event');
        if (char === '\r' || char === '\n') { line(pending); pending = ''; }
        else pending += char;
        if (complete) break;
      }
    }
    check(signal);
    // Sanitize the assembled response, never independent fragments: a service
    // echoing a credential across frames cannot leak its component deltas.
    const safe = transport.sanitize({ text }).text;
    if (typeof safe !== 'string' || Buffer.byteLength(safe) > MAX_TEXT) throw fail('invalid-event');
    return safe;
  } catch (error) {
    check(signal);
    // A refused or unreachable endpoint (undici: TypeError 'fetch failed') is the runtime being
    // unavailable; every other TypeError comes from decoding a malformed stream (review round 1).
    const connectionFailure = error instanceof TypeError && error.message === 'fetch failed';
    throw fail(connectionFailure ? 'runtime-unavailable' : error instanceof TypeError ? 'invalid-event' : publicHarnessError(error).code);
  } finally {
    signal.removeEventListener('abort', abort);
    signal.removeEventListener('abort', rejectAbort);
    if (reader) { try { await reader.cancel(); } catch { /* Request already aborted. */ } finally { reader.releaseLock(); } }
    else { try { await response?.body?.cancel(); } catch { /* Request already aborted. */ } }
  }
}

// Host session wrapper owns model selection and bounded, ephemeral history.
// The wire decoder cannot read or mutate it. Failed/cancelled turns never enter
// history; subsequent turns use committed host history, not caller replacements.
export async function createOpenAICompatibleAdapter({ credentials, addonId, runtime,
  completionsPath = '/v1/chat/completions', turnTimeoutMs = 120000, fetchImpl = globalThis.fetch, lookup } = {}) {
  if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1 || turnTimeoutMs > 2147483647) throw fail('runtime-unavailable');
  let transport;
  try { transport = await openTransport({ credentials, addonId, runtime, completionsPath, fetchImpl, lookup }); }
  catch (error) { throw fail(publicHarnessError(error).code); }
  const sessions = new Map();
  let closed = false;
  function stateFor(session) {
    const state = sessions.get(session);
    if (closed || !state) throw fail('session-not-found');
    return state;
  }
  function messagesFor(state, input) {
    if (!Array.isArray(input?.messages) || !input.messages.length || input.messages.length > 256 ||
        input.messages.some(m => !record(m) || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || Buffer.byteLength(m.content) > MAX_TEXT) ||
        input.messages.at(-1).role !== 'user') throw fail('invalid-event');
    const messages = state.messages.length ? [...state.messages, input.messages.at(-1)] : input.messages;
    const copy = messages.map(({ role, content }) => ({ role, content }));
    if (Buffer.byteLength(JSON.stringify(copy)) > MAX_HISTORY) throw fail('invalid-event');
    return copy;
  }
  return {
    async probe() { return { available: !closed }; },
    async createSession({ signal } = {}) {
      if (closed) throw fail('runtime-unavailable');
      if (signal?.aborted) throw fail('cancelled');
      if (sessions.size >= 64) throw fail('runtime-unavailable');
      const session = {};
      sessions.set(session, { messages: [], selection: null, turn: null });
      return session;
    },
    async *invoke({ session, input, signal }) {
      const state = stateFor(session);
      if (state.turn) throw fail('ownership-conflict');
      const controller = new AbortController();
      const turnSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      state.turn = controller;
      const timer = setTimeout(() => controller.abort(fail('deadline-exceeded')), turnTimeoutMs);
      let result;
      try {
        check(turnSignal);
        const messages = messagesFor(state, input);
        const model = input.model ?? state.selection?.model;
        if (!identifier(model)) throw fail('invalid-event');
        const request = { model, stream: true, messages: buildAugmentorChatRequestMessages({ ...input, messages }) };
        if (Buffer.byteLength(JSON.stringify(request)) > MAX_WIRE) throw fail('invalid-event');
        const text = await readCompletion(transport, request, turnSignal);
        check(turnSignal);
        const committed = transport.sanitize([...messages, { role: 'assistant', content: text }]);
        while (committed.length > 256 || Buffer.byteLength(JSON.stringify(committed)) > MAX_HISTORY) committed.splice(0, 2);
        state.messages = committed;
        result = { type: 'final', data: { text } };
      } catch (error) {
        result = turnSignal.aborted && turnSignal.reason?.code !== 'deadline-exceeded'
          ? { type: 'cancelled', data: {} } : { type: 'error', data: publicHarnessError(turnSignal.aborted ? turnSignal.reason : error) };
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (state.turn === controller) state.turn = null;
      }
      yield result;
    },
    async cancel({ session }) { stateFor(session).turn?.abort(); },
    async history({ session }) { return { messages: structuredClone(stateFor(session).messages), hasMore: false }; },
    async status({ session }) { return { status: stateFor(session).turn ? 'running' : 'idle' }; },
    async selectModel({ session, input }) {
      const state = stateFor(session);
      if (state.turn) throw fail('ownership-conflict');
      if (!record(input) || !identifier(input.provider) || !identifier(input.model)) throw fail('invalid-event');
      state.selection = { provider: input.provider, model: input.model };
      return { ...state.selection };
    },
    async dispose({ session } = {}) {
      if (session) { sessions.get(session)?.turn?.abort(); sessions.delete(session); }
      else { for (const state of sessions.values()) state.turn?.abort(); sessions.clear(); }
      // Host composition creates one adapter per boundary session. Dispose also
      // closes the credential lease on failed creation and host shutdown.
      if (!sessions.size) { closed = true; transport.dispose(); }
    },
  };
}
