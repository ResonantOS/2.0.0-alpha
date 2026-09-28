import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import * as esm from '../resonantos-side-panel-extension/src/lib/trace-redaction.js';

const source = () => readFileSync(new URL('../resonantos-side-panel-extension/src/lib/trace-redaction-core.js', import.meta.url), 'utf8');
const key = '__RESONANTOS_TRACE_REDACTION__';

test('classic registration is frozen, nonenumerable, versioned and repeatable', () => {
  const realm = createContext({});
  runInContext(source(), realm);
  const api = realm[key];
  assert.equal(api.version, 1);
  assert.equal(Object.isFrozen(api), true);
  const descriptor = Object.getOwnPropertyDescriptor(realm, key);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  runInContext(source(), realm);
  assert.equal(realm[key], api);
});

test('ESM adapter exports the registered functions without its own implementation', () => {
  assert.equal(esm.redactTraceText, globalThis[key]?.redactTraceText);
  assert.equal(esm.redactTraceValue, globalThis[key]?.redactTraceValue);
});

test('classic registration rejects incompatible versions or malformed APIs without replacing them', () => {
  for (const initial of [null, {}, { version: 2 }, { version: 1, redactTraceText() {} }]) {
    const realm = createContext({ [key]: initial });
    assert.throws(() => runInContext(source(), realm), /Incompatible ResonantOS trace redaction API/);
    assert.equal(realm[key], initial);
  }
});

test('ESM adapter rejects an invalid cached core API', () => {
  const core = new URL('../resonantos-side-panel-extension/src/lib/trace-redaction-core.js', import.meta.url).href;
  const adapter = new URL('../resonantos-side-panel-extension/src/lib/trace-redaction.js', import.meta.url).href;
  // Pre-cache the core with a valid-looking registration, then corrupt that
  // pre-existing writable slot: the adapter must independently validate it.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.${key} = Object.freeze({ version: 1, redactTraceText() {}, redactTraceValue() {} });
    await import(${JSON.stringify(core)});
    globalThis.${key} = { version: 1, redactTraceValue() {} };
    try { await import(${JSON.stringify(adapter)}); process.exitCode = 1; }
    catch (e) { if (e.message !== 'Incompatible ResonantOS trace redaction API') throw e; }
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

for (const tag of ['div', 'iframe']) test(`classic registration ignores a named ${tag} DOM property`, t => {
  const dom = new JSDOM(`<${tag} id="${key}"></${tag}>`, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  assert.equal(dom.window.eval(`${JSON.stringify(key)} in globalThis`), true);
  assert.doesNotThrow(() => dom.window.eval(source()), 'named DOM properties must not block core registration');
  assert.equal(dom.window[key].redactTraceText('token=fixture'), 'token=REDACTED');
  assert.equal(Object.isFrozen(dom.window[key]), true);
});

test('classic registration never reads inherited API getters', () => {
  const realm = createContext({});
  runInContext(`Object.defineProperty(Object.getPrototypeOf(globalThis), ${JSON.stringify(key)}, {
    get() { throw new Error('unexpected inherited lookup'); }, configurable: true
  });`, realm);
  assert.doesNotThrow(() => runInContext(source(), realm));
  assert.equal(realm[key].version, 1);
});
