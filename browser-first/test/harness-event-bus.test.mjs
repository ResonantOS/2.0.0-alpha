import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarnessEventBus } from '../host/harness-event-bus.mjs';

const provenance = { addonId: 'addon.one', sessionId: 'session-1', bootEpoch: 'boot-1', generation: 1 };
const delta = text => ({ turnId: 'turn-1', type: 'delta', data: { text } });

test('slow readers close within configured bounds', async () => {
  const bus = createHarnessEventBus({ provenance, isCurrent: () => true, maxReaders: 1, maxQueueBytes: 512, maxQueueEvents: 2 });
  const reader = bus.subscribe();
  assert.throws(() => bus.subscribe(), { code: 'runtime-unavailable' }, 'reader limit must be enforced');
  for (let index = 0; index < 6; index++) bus.publish(delta('x'.repeat(100)));
  assert.equal((await reader.next()).value.type, 'error');
  assert.equal((await reader.next()).done, true);
  const replacement = bus.subscribe();
  bus.publish(delta('positive control'));
  assert.equal((await replacement.next()).value.data.text, 'positive control');
  await replacement.return();
});

test('byte and event count limits each independently close slow readers', async () => {
  for (const limits of [{ maxQueueBytes: 512, maxQueueEvents: 100 }, { maxQueueBytes: 100000, maxQueueEvents: 1 }]) {
    const bus = createHarnessEventBus({ provenance, isCurrent: () => true, ...limits });
    const reader = bus.subscribe();
    bus.publish(delta('a'.repeat(200)));
    bus.publish(delta('b'.repeat(200)));
    assert.equal((await reader.next()).value.type, 'error');
    assert.equal((await reader.next()).done, true);
  }
});

test('host provenance and sequence are immutable and superseded generations cannot publish or drain queued output', async () => {
  let current = true;
  const bus = createHarnessEventBus({ provenance, isCurrent: () => current });
  const reader = bus.subscribe();
  bus.publish(delta('first'));
  const event = (await reader.next()).value;
  assert.deepEqual(event, { ...provenance, ...delta('first'), sequence: 1 });
  event.data.text = 'reader mutation';
  bus.publish(delta('stale queued'));
  current = false;
  assert.throws(() => bus.publish(delta('late')), { code: 'ownership-conflict' });
  assert.equal((await reader.next()).value.type, 'error');
  assert.equal((await reader.next()).done, true);
});

test('malformed events and spoofed provenance never reach readers', async () => {
  const bus = createHarnessEventBus({ provenance, isCurrent: () => true });
  const reader = bus.subscribe();
  for (const event of [{ ...delta('text'), generation: 5 }, { ...delta('text'), data: { token: 'private-canary' } }, { ...delta('text'), type: 'browser_execute' }]) {
    assert.throws(() => bus.publish(event), { code: 'invalid-event' });
  }
  bus.publish(delta('valid'));
  assert.equal((await reader.next()).value.sequence, 1);
  bus.close('permission-denied');
  assert.equal((await reader.next()).value.data.code, 'permission-denied');
  assert.equal((await reader.next()).done, true);
});


test('reader alone detects a superseded generation and retains terminal provenance', async () => {
  let generation = provenance.generation;
  const bus = createHarnessEventBus({ provenance, isCurrent: () => generation === provenance.generation });
  const reader = bus.subscribe();
  bus.publish(delta('authorized'));
  assert.equal((await reader.next()).value.data.text, 'authorized');
  bus.publish(delta('stale queued'));
  generation++;
  const terminal = (await reader.next()).value;
  assert.equal(terminal.type, 'error');
  assert.equal(terminal.data.code, 'ownership-conflict');
  for (const key of Object.keys(provenance)) assert.equal(terminal[key], provenance[key]);
  assert.equal((await reader.next()).done, true);
});
