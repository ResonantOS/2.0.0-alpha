import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTypertAdapter } from '../host/agent-adapters/dsh-typert.mjs';
import { HARNESS_OPERATIONS } from '../../packages/addon-sdk/src/contracts.ts';
import { validateHarnessEvent } from '../host/harness-adapter-contract.mjs';
import { wire, until, snapshot, event, chunk, message } from './harness-wire-fixtures.mjs';
const input = { messages: [{ role: 'user', content: 'hello' }] };
async function setup(t, options = {}, limits = {}) {
  const w = await wire(options), adapter = createDshTypertAdapter({ transport: w.transport, ...limits });
  t.after(() => adapter.dispose());
  return { w, adapter, session: await adapter.createSession() };
}
test('follow readiness precedes prompt and final text reconciles', async t => {
  const { w, adapter, session } = await setup(t, { autoSnapshot: false });
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.opens.length);
  assert.equal(w.rpc('session/prompt').length, 0, 'prompt must wait for snapshot readiness');
  w.emit(snapshot); await until(() => w.rpc('session/prompt').length);
  w.emit(event('turn/start', 2)); w.emit(chunk('hel')); w.emit(chunk('lo'));
  w.emit(message('hello!')); w.emit(message('duplicate', 3)); w.emit(event('turn/end', 4));
  const frames = await result;
  assert.equal(frames.filter(frame => frame.type === 'delta').map(frame => frame.data.text).join(''), 'hello');
  assert.deepEqual(frames.filter(frame => frame.type === 'final'), [{ type: 'final', data: { text: 'hello!' } }], 'authoritative text replaces chunks, never appends them');
  assert.deepEqual(await adapter.status({ session }), { status: 'idle' });
  for (const [index, frame] of frames.entries()) assert.ok(validateHarnessEvent({ addonId: 'addon.dsh', sessionId: 's', turnId: 't', bootEpoch: 'b', generation: 1, sequence: index + 1, ...frame }));
});
test('unsupported DSH operations remain unavailable', async t => {
  const { w, adapter, session } = await setup(t);
  assert.equal(adapter.capabilities.contextRoleFidelity, 'text-only');
  assert.equal(adapter.capabilities.toolCallbacks, false);
  for (const key of ['browserTools', 'approvals', 'augmentorSave', 'augmentorUnsave', 'augmentorState']) assert.equal(adapter.capabilities[key], 'unavailable');
  const unsupported = ['browser_click', 'browser_type', 'browser_navigate', 'waterfall', 'augmentor/save', 'augmentor/unsave', 'augmentor/state'];
  for (const kind of unsupported) {
    assert.ok(!HARNESS_OPERATIONS.includes(kind));
    assert.ok(!(adapter.supportedOperations ?? []).includes(kind));
    assert.equal(adapter[kind], undefined);
  }
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length);
  let seq = 2;
  const emitUnsupported = async status => {
    for (const type of unsupported) {
      w.emit(event(type, seq++, { text: `FORBIDDEN ${type}`, prompt: 'FORBIDDEN approval prompt', request: { action: 'execute' } }));
      assert.deepEqual(await adapter.status({ session }), { status });
    }
  };
  await emitUnsupported('unknown');
  w.emit(event('turn/start', seq++));
  w.emit(chunk('assistant '));
  await emitUnsupported('running');
  w.emit(chunk('text'));
  w.emit(message('assistant text', seq++));
  await emitUnsupported('running');
  w.emit(event('turn/end', seq++));
  const frames = await result;
  await emitUnsupported('idle');
  assert.deepEqual(frames, [
    { type: 'status', data: { status: 'running' } },
    { type: 'delta', data: { text: 'assistant ' } },
    { type: 'delta', data: { text: 'text' } },
    { type: 'status', data: { status: 'idle' } },
    { type: 'final', data: { text: 'assistant text' } },
  ]);
  assert.ok(!JSON.stringify(frames).includes('FORBIDDEN'));
  assert.deepEqual(w.requests.filter(row => row.body?.type === 'client-request' && row.headers.cookie === w.cookie).map(row => row.body.method), ['session/create', 'session/prompt']);
  assert.deepEqual(w.opens.map(row => row.endpoint), ['session/follow']);
});
test('a disconnected running stream reports unknown status', async t => {
  const { w, adapter, session } = await setup(t);
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length);
  w.emit(event('turn/start', 2)); assert.deepEqual(await adapter.status({ session }), { status: 'running' });
  w.sockets[0].close();
  assert.deepEqual(await adapter.status({ session }), { status: 'unknown' });
  assert.equal((await result).at(-1).type, 'error');
});
test('reasoning content parts are dropped, never surfaced or fatal', async t => {
  const { w, adapter, session } = await setup(t);
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length);
  w.emit(event('turn/start', 2)); w.emit(chunk('Seven is prime.'));
  w.emit(event('assistant/message', 3, { message: { content: [
    { type: 'reasoning', text: 'PRIVATE chain-of-thought' }, { type: 'text', text: 'Seven is prime.' },
  ] } }));
  w.emit(event('turn/end', 4));
  const frames = await result;
  assert.equal(frames.at(-1).type, 'final');
  assert.deepEqual(frames.at(-1).data, { text: 'Seven is prime.' });
  assert.ok(!JSON.stringify(frames).includes('PRIVATE'));
});
test('cancellation closes the turn and suppresses late chunks', async t => {
  const { w, adapter, session } = await setup(t);
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length);
  w.emit(chunk('partial')); await adapter.cancel({ session });
  w.emit(chunk('late')); w.emit(message('late'));
  const frames = await result;
  assert.equal(frames.at(-1).type, 'cancelled');
  assert.ok(!JSON.stringify(frames).includes('late'));
  assert.equal(w.rpc('session/cancel').length, 1);
  assert.ok(w.sockets[0].closed);
});
for (const problem of ['oversized', 'malformed', 'upstream-error', 'queue-overflow']) {
  test(`${problem} stream fails with a fixed public error`, async t => {
    const { w, adapter, session } = await setup(t, {}, { maxQueueBytes: 128 });
    const iterator = adapter.invoke({ session, input });
    const first = iterator.next();
    await until(() => w.rpc('session/prompt').length);
    w.emit(event('turn/start', 2)); await first;
    if (problem === 'oversized') w.emit(chunk('x'.repeat(65537)));
    if (problem === 'malformed') w.emit({ type: 'event', event: { type: 'assistant/message', seq: 3, data: { message: { content: 'PRIVATE' } } } });
    if (problem === 'upstream-error') w.emit(event('turn/end', 3, { reason: { kind: 'error', error: { message: 'PRIVATE' } } }));
    if (problem === 'queue-overflow') for (let i = 0; i < 20; i++) w.emit(chunk('text'));
    const frames = await Array.fromAsync(iterator);
    assert.equal(frames.at(-1).type, 'error'); assert.ok(!JSON.stringify(frames).includes('PRIVATE'));
  });
}
test('follow timeout and abort before readiness never dispatch a prompt', async t => {
  for (const abort of [false, true]) {
    const { w, adapter, session } = await setup(t, { autoSnapshot: false }, { followTimeoutMs: 20 });
    const controller = new AbortController();
    const result = Array.fromAsync(adapter.invoke({ session, input, signal: controller.signal }));
    await until(() => w.opens.length); if (abort) controller.abort();
    const frames = await result;
    assert.equal(w.rpc('session/prompt').length, 0);
    assert.equal(frames.at(-1).type, abort ? 'cancelled' : 'error');
    assert.ok(w.sockets[0].closed);
  }
});

for (const ending of ['cancel', 'abort', 'transport-error', 'upstream-error', 'malformed', 'rejected-prompt']) {
  test(`${ending} closes only the turn; the same session re-follows without old output`, async t => {
    const { w, adapter, session } = await setup(t, { autoSnapshot: false });
    const controller = new AbortController();
    if (ending === 'rejected-prompt') w.outcome('rejected');
    const first = Array.fromAsync(adapter.invoke({ session, input, signal: controller.signal }));
    await until(() => w.opens.length === 1);
    w.emit(snapshot);
    await until(() => w.rpc('session/prompt').length === 1);
    w.emit(event('turn/start', 2)); w.emit(chunk('old partial'));
    if (ending === 'abort') { controller.abort(); await adapter.cancel({ session }); }
    if (ending === 'cancel') { await adapter.cancel({ session }); await adapter.cancel({ session }); }
    if (ending === 'transport-error') w.sockets[0].dispatchEvent(new Event('error'));
    if (ending === 'upstream-error') w.emit(event('turn/end', 3, { reason: { kind: 'error' } }));
    if (ending === 'malformed') w.emit(event('assistant/message', 3, { message: { content: 'PRIVATE' } }));
    const oldFrames = await first;
    assert.equal(oldFrames.at(-1).type, ['cancel', 'abort'].includes(ending) ? 'cancelled' : 'error');
    assert.deepEqual(await adapter.status({ session }), { status: 'unknown' });
    assert.ok(w.sockets[0].closed, 'per-turn failures must close the follow stream');
    w.outcome('accepted');
    const second = Array.fromAsync(adapter.invoke({ session, input }));
    // Handle the existing permanent-fence rejection immediately, before polling.
    let settled = false;
    const outcome = second.then(frames => ({ frames }), error => ({ error })).finally(() => { settled = true; });
    await until(() => w.opens.length === 2 || settled);
    assert.equal(w.opens.length, 2, 'same session must open a fresh follow after turn closure');
    assert.equal(w.rpc('session/prompt').length, 1, 'new prompt waits for the fresh snapshot');
    w.emit({ ...snapshot, cursor: 20, records: [message('old snapshot', 20)] });
    await until(() => w.rpc('session/prompt').length === 2);
    // Closed subscription callbacks, replayed seqs, and the previous turn's
    // trailing output before the new turn/start must all be ignored.
    w.emit(chunk('old socket chunk'), 0); w.emit(message('old socket message', 999), 0);
    w.emit(event('turn/start', 19)); w.emit(message('old replay', 20));
    w.emit(chunk('old trailing chunk')); w.emit(message('old trailing message', 21)); w.emit(event('turn/end', 22));
    w.emit(event('turn/start', 23)); w.emit(chunk('new text')); w.emit(message('new text', 24)); w.emit(event('turn/end', 25));
    const recovered = await outcome;
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.frames.at(-1).type, 'final');
    assert.equal(recovered.frames.at(-1).data.text, 'new text');
    assert.deepEqual(recovered.frames.filter(frame => frame.type === 'delta'), [{ type: 'delta', data: { text: 'new text' } }]);
    assert.ok(!JSON.stringify(recovered.frames).includes('old'));
    assert.equal(w.rpc('session/create').length, 1);
    assert.equal(w.rpc('session/cancel').length, ['cancel', 'abort'].includes(ending) ? 1 : 0);
    if (ending === 'cancel') {
      const third = Array.fromAsync(adapter.invoke({ session, input }));
      await until(() => w.rpc('session/prompt').length === 3);
      await adapter.cancel({ session });
      assert.equal((await third).at(-1).type, 'cancelled');
      assert.equal(w.rpc('session/cancel').length, 2, 'each cancelled turn gets its own single cancel');
    }
  });
}
test('dispose still fences subsequent invoke', async t => {
  const { adapter, session } = await setup(t);
  await adapter.dispose();
  await assert.rejects(Array.fromAsync(adapter.invoke({ session, input })), { code: 'runtime-unavailable' });
});
test('normal completed sessions support another real turn without replaying old output', async t => {
  const { w, adapter, session } = await setup(t);
  for (let n = 0; n < 2; n++) {
    const result = Array.fromAsync(adapter.invoke({ session, input }));
    await until(() => w.rpc('session/prompt').length === n + 1);
    w.emit(event('turn/start', 2 + n * 3));
    w.emit(message(`answer ${n}`, 3 + n * 3));
    w.emit(event('turn/end', 4 + n * 3));
    assert.equal((await result).at(-1).data.text, `answer ${n}`);
  }
  assert.equal(w.opens.length, 1);
  await adapter.dispose();
  assert.ok(w.sockets[0].closed);
  await assert.rejects(adapter.status({ session }), { code: 'session-not-found' });
});

test('events before prompt dispatch cannot masquerade as the new answer', async t => {
  const { w, adapter, session } = await setup(t, { autoSnapshot: false });
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.opens.length);
  w.emit(snapshot);
  w.emit(event('turn/start', 2)); w.emit(message('old answer', 3)); w.emit(event('turn/end', 4));
  await until(() => w.rpc('session/prompt').length);
  w.emit(event('turn/start', 5)); w.emit(message('new answer', 6)); w.emit(event('turn/end', 7));
  const frames = await result;
  assert.equal(frames.at(-1).data.text, 'new answer');
  assert.ok(!JSON.stringify(frames).includes('old answer'));
});
test('a rejected prompt cannot publish a successful final from concurrent stream events', async t => {
  const { w, adapter, session } = await setup(t);
  w.outcome('rejected');
  w.onPrompt(() => { w.emit(event('turn/start', 2)); w.emit(message('unaccepted answer')); w.emit(event('turn/end', 4)); });
  const frames = await Array.fromAsync(adapter.invoke({ session, input }));
  assert.equal(frames.at(-1).type, 'error', 'an explicit prompt rejection must override queued success');
  assert.ok(!JSON.stringify(frames).includes('unaccepted answer'));
});

test('non-object streamed content parts fail the turn instead of being dropped', async t => {
  const { w, adapter, session } = await setup(t);
  const result = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length);
  w.emit(event('turn/start', 2));
  w.emit(event('assistant/message', 3, { message: { content: [null] } }));
  w.emit(event('turn/end', 4));
  assert.deepEqual((await result).at(-1), { type: 'error', data: { code: 'invalid-event', message: 'Invalid runtime event.' } });
});


test('an abort while the previous cancel RPC settles still cancels the new turn', async t => {
  const { w, adapter, session } = await setup(t);
  let releaseCancel;
  w.onCancel(() => new Promise(resolve => { releaseCancel = resolve; }));
  const first = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length === 1);
  const cancelling = adapter.cancel({ session });
  t.after(() => releaseCancel?.());
  assert.equal((await first).at(-1).type, 'cancelled');
  await until(() => releaseCancel);
  const controller = new AbortController();
  const iterator = adapter.invoke({ session, input, signal: controller.signal });
  const next = iterator.next();
  controller.abort();
  releaseCancel(); await cancelling;
  // Timeout is only a deadlock guard. The assertion concerns the terminal
  // frame, not how fast a local event loop happens to run.
  let timer;
  const value = await Promise.race([next, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); })]);
  clearTimeout(timer);
  if (!value) { await adapter.dispose(); await next; }
  await iterator.return();
  assert.equal(value?.value?.type, 'cancelled', 'new turn abort must not reuse the old turn cancellation');
  assert.equal(w.rpc('session/prompt').length, 1, 'pending old cancel prevents new dispatch');
  assert.equal(w.rpc('session/cancel').length, 1, 'an undispatched turn needs no upstream cancel');
});

for (const code of ['permission-denied', 'ownership-conflict']) {
  test(`${code} failure fences the session permanently`, async t => {
    const w = await wire();
    let deny = false;
    const adapter = createDshTypertAdapter({ transport: { ...w.transport, request(...args) {
      if (deny) throw Object.assign(new Error('PRIVATE authentication failure'), { code });
      return w.transport.request(...args);
    } } });
    t.after(() => adapter.dispose());
    const session = await adapter.createSession();
    deny = true;
    const frames = await Array.fromAsync(adapter.invoke({ session, input }));
    assert.equal(frames.at(-1).data.code, code);
    deny = false;
    w.onPrompt(() => { w.emit(event('turn/start', 2)); w.emit(message('must not run')); w.emit(event('turn/end', 4)); });
    await assert.rejects(Array.fromAsync(adapter.invoke({ session, input })), { code: 'runtime-unavailable' });
    assert.ok(!JSON.stringify(frames).includes('PRIVATE'));
  });
}


test('a pre-aborted turn preserves the preceding pending cancel barrier', async t => {
  const { w, adapter, session } = await setup(t);
  let releaseCancel;
  w.onCancel(() => new Promise(resolve => { releaseCancel = resolve; }));
  const first = Array.fromAsync(adapter.invoke({ session, input }));
  await until(() => w.rpc('session/prompt').length === 1);
  const cancelling = adapter.cancel({ session });
  assert.equal((await first).at(-1).type, 'cancelled');
  await until(() => releaseCancel);
  const controller = new AbortController(); controller.abort();
  assert.equal((await Array.fromAsync(adapter.invoke({ session, input, signal: controller.signal }))).at(-1).type, 'cancelled');
  w.onPrompt(() => { w.emit(event('turn/start', 2)); w.emit(message('new answer')); w.emit(event('turn/end', 4)); });
  const third = Array.fromAsync(adapter.invoke({ session, input }));
  await new Promise(resolve => setImmediate(resolve));
  const promptsBeforeCancelSettled = w.rpc('session/prompt').length;
  releaseCancel(); await cancelling;
  assert.equal((await third).at(-1).data.text, 'new answer');
  assert.equal(promptsBeforeCancelSettled, 1, 'no prompt may overtake the preceding cancel RPC');
});
