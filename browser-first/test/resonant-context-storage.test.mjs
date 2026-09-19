import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { performance } from 'node:perf_hooks';

const lib = new URL('../resonantos-side-panel-extension/src/lib/', import.meta.url);
const corePath = new URL('trace-redaction-core.js', lib);
const warning = 'Resonant Context: session history will not survive navigation because redaction is unavailable.';

function harness(t, { core = 'actual', stored, persistSession = true, config = {}, url = 'https://example.test/token=path-fixture?view=wide', navigationType = 'navigate' } = {}) {
  const dom = new JSDOM('<!doctype html><title>Account token=title-fixture</title><button id="token=selector-fixture">Continue password=click-fixture</button>', {
    runScripts: 'outside-only', url,
    referrer: 'https://example.test/start?token=referrer-fixture&view=wide'
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.performance.getEntriesByType = type => type === 'navigation' ? [{ type: navigationType }] : [];
  let now = 1000;
  w.Date.now = () => now;
  if (stored) w.sessionStorage.setItem('rc_session', JSON.stringify(stored));
  const writes = [], warnings = [];
  const original = w.Storage.prototype.setItem;
  w.Storage.prototype.setItem = function (key, value) {
    writes.push({ key, value: JSON.parse(value) });
    return original.call(this, key, value);
  };
  w.console.warn = (...args) => warnings.push(args);
  // Baseline without the new file must reach payload assertions, not fail at file IO.
  if (core === 'actual' && existsSync(corePath)) w.eval(readFileSync(corePath, 'utf8'));
  else if (core !== 'missing' && core !== 'actual') w.eval(core);
  w.eval(readFileSync(new URL('resonant-context.js', lib), 'utf8'));
  const tracker = new w._ResonantContext.SessionTracker({ ...config, persistSession });
  return { w, tracker, writes, warnings, setNow: value => { now = value; } };
}

function latest(writes, count) {
  assert.equal(writes.length, count, 'expected actual rc_session storage writes');
  assert.ok(writes.every(write => write.key === 'rc_session'));
  return writes.at(-1).value;
}

test('initialization redacts title, path and referrer in a detached nonempty payload', t => {
  const { tracker, writes } = harness(t);
  assert.deepEqual(latest(writes, 1), {
    history: [{ path: '/token=REDACTED', title: 'Account token=REDACTED', enteredAt: 1000, dwellMs: 0 }],
    clickTrail: [], entryPoint: 'https://example.test/start?token=REDACTED&view=wide'
  });
  assert.equal(tracker._history[0].path, '/token=path-fixture');
  assert.equal(tracker._history[0].title, 'Account token=title-fixture');
  assert.equal(tracker._entryPoint, 'https://example.test/start?token=referrer-fixture&view=wide');
});

test('click and unload writes redact selectors/text and retain dwell and timing metadata', t => {
  const { w, tracker, writes, setNow } = harness(t);
  latest(writes, 1);
  setNow(1250);
  w.document.querySelector('button').click();
  assert.deepEqual(latest(writes, 2).clickTrail, [{ selector: '#token=REDACTED', text: 'Continue password=REDACTED', ts: 1250 }]);
  assert.equal(tracker._clickTrail[0].selector, '#token=selector-fixture');
  assert.equal(tracker._clickTrail[0].text, 'Continue password=click-fixture');
  setNow(1800);
  w.dispatchEvent(new w.Event('beforeunload'));
  assert.equal(latest(writes, 3).history[0].dwellMs, 800);
  assert.equal(writes[2].value.history[0].enteredAt, 1000);
  assert.equal(writes[2].value.clickTrail[0].ts, 1250);
});

test('restored nested historical content is redacted on the next write without mutating live state', t => {
  const stored = {
    history: [{ path: '/old?token=old-fixture', title: 'Benign title', enteredAt: 10, dwellMs: 20,
      extra: { nested: [{ password: 'nested-fixture', note: 'Bearer bearer-fixture' }] } }],
    clickTrail: [{ selector: '#safe', text: 'Benign text', ts: 30, extra: { pin: 1234 } }],
    entryPoint: 'https://example.test/?secret=entry-fixture'
  };
  const { tracker, writes } = harness(t, { stored });
  const output = latest(writes, 1);
  assert.equal(output.history.length, 2);
  assert.deepEqual(output.history[0], { path: '/old?token=REDACTED', title: 'Benign title', enteredAt: 10, dwellMs: 20,
    extra: { nested: [{ password: 'REDACTED', note: 'REDACTED' }] } });
  assert.deepEqual(output.clickTrail, [{ selector: '#safe', text: 'Benign text', ts: 30, extra: { pin: 'REDACTED' } }]);
  assert.equal(output.entryPoint, 'https://example.test/?secret=REDACTED');
  assert.equal(tracker._history[0].extra.nested[0].password, 'nested-fixture');
  assert.equal(tracker._clickTrail[0].extra.pin, 1234);
});

test('disabled persistence never writes or warns even without the core', t => {
  const { w, tracker, writes, warnings } = harness(t, { persistSession: false, core: 'missing' });
  w.document.querySelector('button').click();
  w.dispatchEvent(new w.Event('beforeunload'));
  tracker._persist();
  assert.equal(writes.length, 0);
  assert.deepEqual(warnings, []);
});

for (const [name, core] of [
  ['missing', 'missing'],
  ['wrong version', 'globalThis.__RESONANTOS_TRACE_REDACTION__ = Object.freeze({version: 2, redactTraceText() {}, redactTraceValue(v) { return v; }});'],
  ['invalid methods', 'globalThis.__RESONANTOS_TRACE_REDACTION__ = Object.freeze({version: 1, redactTraceValue: 42});'],
  ['throwing', 'globalThis.__RESONANTOS_TRACE_REDACTION__ = Object.freeze({version: 1, redactTraceText() {}, redactTraceValue() { throw new Error("payload-fixture"); }});'],
  ['throwing lookup', 'Object.defineProperty(globalThis, "__RESONANTOS_TRACE_REDACTION__", {get() {throw new Error("payload-fixture");}});']
]) test(`${name} core writes nothing and emits one fixed value-free warning per tracker`, t => {
  const { w, tracker, writes, warnings } = harness(t, { core });
  w.document.querySelector('button').click();
  w.dispatchEvent(new w.Event('beforeunload'));
  tracker._persist();
  assert.equal(writes.length, 0, 'unavailable redaction must prevent every write');
  assert.deepEqual(warnings, [[warning]]);
  new w._ResonantContext.SessionTracker({});
  assert.equal(writes.length, 0);
  assert.deepEqual(warnings, [[warning], [warning]]);
});

test('default history and click retention and same-page reload behavior remain intact', t => {
  const stored = { history: Array.from({length: 20}, (_, i) => ({path: `/old/${i}`, title: 'Benign', enteredAt: i + 1, dwellMs: 4})),
    clickTrail: Array.from({length: 30}, (_, i) => ({selector: '#safe', text: 'Benign', ts: i})), entryPoint: '(direct)' };
  const { w, writes } = harness(t, { stored });
  assert.equal(latest(writes, 1).history.length, 20);
  assert.equal(writes[0].value.history[0].path, '/old/1');
  w.document.querySelector('button').click();
  assert.equal(latest(writes, 2).clickTrail.length, 30);
  assert.equal(writes[1].value.clickTrail[0].ts, 1);
  // Live raw path matches on a normal reload with benign location.
  w.history.replaceState({}, '', '/benign');
  new w._ResonantContext.SessionTracker({});
  latest(writes, 3);
  new w._ResonantContext.SessionTracker({});
  latest(writes, 3);
});

for (const path of ['/token=path-fixture', '/0123456789abcdef0123456789abcdef', '/' + 'Z'.repeat(44)]) {
  test(`redacted path reload retains history and timing for ${path}`, t => {
    const stored = { history: Array.from({ length: 19 }, (_, i) => ({ path: `/old/${i}`, title: 'Benign', enteredAt: i + 1, dwellMs: 4 })), clickTrail: [], entryPoint: '(direct)' };
    const first = harness(t, { stored, url: `https://example.test${path}` });
    let persisted = latest(first.writes, 1);
    for (let reload = 0; reload < 3; reload++) {
      const next = harness(t, { stored: persisted, url: `https://example.test${path}`, navigationType: 'reload' });
      assert.equal(next.tracker._history.length, 20);
      assert.equal(next.tracker._history[0].path, '/old/0', 'reload must not evict real navigation');
      assert.equal(next.writes.length, 0, 'same-page reload must not append or write a duplicate');
      next.setNow(1800);
      next.w.dispatchEvent(new next.w.Event('beforeunload'));
      persisted = latest(next.writes, 1);
      assert.equal(persisted.history.at(-1).enteredAt, 1000);
      assert.equal(persisted.history.at(-1).dwellMs, 800);
    }
  });
}

test('distinct navigations with identical redacted paths remain separate history entries', t => {
  const first = harness(t, { url: 'https://example.test/token=first-fixture' });
  const second = harness(t, { stored: latest(first.writes, 1), url: 'https://example.test/token=second-fixture' });
  assert.equal(latest(second.writes, 1).history.length, 2);
  assert.equal(second.tracker._history[1].path, '/token=second-fixture');
});

test('reload with unavailable redaction still installs tracking and warns once without writes', t => {
  const { w, writes, warnings } = harness(t, { navigationType: 'reload', core: 'missing', stored: {
    history: [{ path: '/token=REDACTED', title: 'Account', enteredAt: 500, dwellMs: 0 }], clickTrail: []
  } });
  w.document.querySelector('button').click();
  assert.equal(writes.length, 0);
  assert.deepEqual(warnings, [[warning]]);
});

for (const [name, historyCount, clickCount, textLength, iterations] of [
  ['default maximum', 20, 30, 80, 50],
  ['long restored record', 100, 200, 8192, 10]
]) test(`profile context persistence: ${name}`, t => {
  const text = 'Benign content '.repeat(Math.ceil(textLength / 15)).slice(0, textLength);
  const stored = {
    history: Array.from({ length: historyCount }, (_, i) => ({ path: `/old/${i}`, title: `${text} token=title-fixture`, enteredAt: i + 1, dwellMs: 4 })),
    clickTrail: Array.from({ length: clickCount }, (_, i) => ({ selector: '#safe', text: `${text} password=click-fixture`, ts: i,
      extra: { nested: [{ secret: 'nested-fixture' }] } })),
    entryPoint: '(direct)'
  };
  const { tracker, writes } = harness(t, { stored, config: { maxHistory: historyCount } });
  latest(writes, 1);
  const durations = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    tracker._persist();
    durations.push(performance.now() - start);
  }
  const output = latest(writes, iterations + 1);
  assert.equal(output.history.length, historyCount);
  assert.equal(output.clickTrail.length, clickCount);
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /title-fixture|click-fixture|nested-fixture/);
  assert.match(tracker._history[0].title, /title-fixture/);
  durations.sort((a, b) => a - b);
  t.diagnostic(`${name}: ${historyCount} history / ${clickCount} clicks; input ${Buffer.byteLength(JSON.stringify(stored))} bytes; output ${Buffer.byteLength(serialized)} bytes; ${iterations} writes; median ${durations[Math.floor(iterations / 2)].toFixed(3)} ms; p95 ${durations[Math.ceil(iterations * 0.95) - 1].toFixed(3)} ms (includes serialization and captured storage; no machine-dependent timing threshold)`);
});
