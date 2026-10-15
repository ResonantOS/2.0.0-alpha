import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshTypertAdapter } from '../host/agent-adapters/dsh-typert.mjs';

function adapter(value, result) {
  return createDshTypertAdapter({ transport: {
    request: async (_path, options) => ({ status: 200, body: {
      type: 'server-response', rpcId: options.body.rpcId, result: result ?? { ok: true, value },
    } }),
    openStream: async () => { throw new Error('probe must not open a follow stream'); },
    dispose() {},
  } });
}

test('empty validated catalog is protocol ready without a model', async () => {
  const a = adapter({ groups: [] });
  try {
    const result = await a.probe({ native: true });
    assert.equal(result.protocolReady, true);
    assert.equal(result.providerAvailable, false);
  } finally { await a.dispose(); }
});

test('native validates catalog while plugin probe keeps its existing behavior', async () => {
  for (const value of [{}, { groups: null }, { groups: [{ id: '', models: [] }] },
    { groups: [{ id: 'deepseek', models: [{ id: '' }] }] }]) {
    const a = adapter(value);
    try {
      await assert.rejects(a.probe({ native: true }), { code: 'invalid-event' });
      assert.equal((await a.probe()).available, true);
    } finally { await a.dispose(); }
  }
});

test('unknown or auth-shaped error is never manufactured into provider readiness', async () => {
  for (const error of [{ code: 'unauthorized' }, { code: 'unknown' }, { message: 'provider key missing' }]) {
    const a = adapter(null, { ok: false, error });
    try { await assert.rejects(a.probe({ native: true }), { code: 'runtime-unavailable' }); }
    finally { await a.dispose(); }
  }
});

test('error envelope carrying valid catalog cannot establish native readiness', async () => {
  for (const error of [{ code: 'unauthorized' }, { code: 'unknown' }, { message: 'provider key missing' }]) {
    const a = adapter(null, { ok: false, error, value: { groups: [] } });
    try { await assert.rejects(a.probe({ native: true }), { code: 'runtime-unavailable' }); }
    finally { await a.dispose(); }
  }
});

test('valid model catalog establishes availability', async () => {
  const a = adapter({ groups: [{ id: 'deepseek', models: [{ id: 'model', name: 'Model' }] }] });
  try {
    const result = await a.probe({ native: true });
    assert.equal(result.protocolReady, true);
    assert.equal(result.providerAvailable, true);
  } finally { await a.dispose(); }
});
