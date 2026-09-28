import { publicHarnessError, validateHarnessEvent } from './harness-adapter-contract.mjs';
const fail = code => Object.assign(new Error(publicHarnessError({ code }).message), { code });

// In-memory, session-local fanout. Readers never choose provenance or sequence.
export function createHarnessEventBus({ provenance, isCurrent, maxReaders = 8, maxQueueBytes = 262144, maxQueueEvents = 256 } = {}) {
  for (const value of [maxReaders, maxQueueBytes, maxQueueEvents]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Positive event limits required.');
  }
  const identity = structuredClone(provenance), readers = new Set();
  let sequence = 0, closed = false, lastTurn = 'session';
  function terminal(code) {
    return { ...identity, turnId: lastTurn, sequence: ++sequence, type: 'error', data: publicHarnessError({ code }) };
  }
  function finish(reader, event) {
    reader.queue = []; reader.bytes = 0; reader.closed = true; readers.delete(reader);
    if (reader.waiting) { reader.waiting({ value: structuredClone(event), done: !event }); reader.waiting = null; }
    else if (event) reader.queue.push({ event, bytes: 0 });
  }
  function close(code = 'runtime-unavailable') {
    if (closed) return;
    closed = true;
    const event = terminal(code);
    for (const reader of readers) finish(reader, event);
  }
  function check() {
    if (!isCurrent()) { close('ownership-conflict'); throw fail('ownership-conflict'); }
    if (closed) throw fail('runtime-unavailable');
  }
  return {
    close,
    publish(payload) {
      check();
      if (!payload || Object.keys(payload).length !== 3 || !['turnId', 'type', 'data'].every(key => Object.hasOwn(payload, key))) throw fail('invalid-event');
      /** @type {import('../../src/core/contracts.ts').HarnessEvent} */
      const event = { ...identity, ...structuredClone(payload), sequence: sequence + 1 };
      if (!validateHarnessEvent(event)) throw fail('invalid-event');
      sequence++; lastTurn = event.turnId;
      const bytes = Buffer.byteLength(JSON.stringify(event));
      for (const reader of readers) {
        if (reader.waiting) { reader.waiting({ value: structuredClone(event), done: false }); reader.waiting = null; }
        else if (reader.bytes + bytes > maxQueueBytes || reader.queue.length >= maxQueueEvents) finish(reader, terminal('runtime-unavailable'));
        else { reader.queue.push({ event, bytes }); reader.bytes += bytes; }
      }
      return structuredClone(event);
    },
    subscribe() {
      check();
      if (readers.size >= maxReaders) throw fail('runtime-unavailable');
      const reader = { queue: [], bytes: 0, closed: false, waiting: null };
      readers.add(reader);
      return {
        [Symbol.asyncIterator]() { return this; },
        next() {
          if (!reader.closed && !isCurrent()) close('ownership-conflict');
          if (reader.queue.length) {
            const item = reader.queue.shift(); reader.bytes -= item.bytes;
            return Promise.resolve({ value: structuredClone(item.event), done: false });
          }
          if (reader.closed) return Promise.resolve({ value: undefined, done: true });
          if (reader.waiting) return Promise.reject(fail('runtime-unavailable'));
          return new Promise(resolve => { reader.waiting = resolve; });
        },
        async return() { finish(reader); return { value: undefined, done: true }; },
      };
    },
  };
}
