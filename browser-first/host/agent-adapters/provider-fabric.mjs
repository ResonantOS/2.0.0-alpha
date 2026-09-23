import { publicHarnessError } from '../harness-adapter-contract.mjs';

const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });

// In-process only: credentials and route policy remain in the provider service.
// The harness boundary supplies authority and validates every published frame.
export function createProviderFabricAdapter({ executeRawProviderChat } = {}) {
  if (typeof executeRawProviderChat !== 'function') throw new TypeError('Raw provider execution required.');
  const sessions = new WeakMap();
  function active(session) {
    const state = sessions.get(session);
    if (!state) throw fail('session-not-found');
    return state;
  }
  return {
    async probe() { return { available: true }; },
    async createSession({ signal } = {}) {
      if (signal?.aborted) throw fail('cancelled');
      const session = {};
      sessions.set(session, { turn: null });
      return session;
    },
    async *invoke({ session, input, signal }) {
      const state = active(session);
      if (state.turn) throw fail('ownership-conflict');
      const controller = new AbortController();
      const turnSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      state.turn = controller;
      try {
        turnSignal.throwIfAborted();
        const result = await executeRawProviderChat(input, { signal: turnSignal });
        turnSignal.throwIfAborted();
        yield { type: 'final', data: { text: result.reply } };
      } catch (error) {
        yield turnSignal.aborted ? { type: 'cancelled', data: {} }
          : { type: 'error', data: publicHarnessError(error) };
      } finally { if (state.turn === controller) state.turn = null; }
    },
    async cancel({ session }) { active(session).turn?.abort(); },
    async dispose({ session }) {
      const state = sessions.get(session);
      state?.turn?.abort();
      sessions.delete(session);
    },
  };
}
