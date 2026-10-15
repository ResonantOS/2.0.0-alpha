import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createBridgeShutdown, installBridgeSignals } from '../host/bridge-shutdown.mjs';
import { ensureOpencodeServer, resetOpencodeServerSingletonForTests } from '../host/opencode-client.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('repeated signals start native stop immediately and cannot exit before both owners settle', async () => {
  const native = deferred();
  const openCode = deferred();
  const calls = [];
  const processImpl = new EventEmitter();
  processImpl.exit = (code) => calls.push(`exit:${code}`);
  const shutdown = createBridgeShutdown({
    closeHarness: () => { calls.push('native'); return native.promise; },
    closeOpenCode: () => { calls.push('opencode'); return openCode.promise; },
    flushPrefs: async () => { calls.push('prefs'); },
    unsubscribe: () => calls.push('unsubscribe'),
    closeServer: async () => { calls.push('server'); },
  });
  const remove = installBridgeSignals({ processImpl, shutdown });
  processImpl.emit('SIGTERM');
  processImpl.emit('SIGINT');
  assert.equal(calls.filter((x) => x === 'native').length, 1);
  assert.equal(calls.filter((x) => x === 'opencode').length, 1);
  assert.equal(calls.some((x) => x.startsWith('exit:')), false);
  native.resolve();
  await Promise.resolve();
  assert.equal(calls.includes('server'), false);
  openCode.resolve();
  await shutdown();
  await Promise.resolve();
  assert.deepEqual(calls.filter((x) => x.startsWith('exit:')), ['exit:0']);
  assert.equal(calls.filter((x) => x === 'server').length, 1);
  remove();
});

test('failed cleanup still drains other owners and closes listener once', async () => {
  const wait = deferred();
  let drained = false;
  let closed = 0;
  const shutdown = createBridgeShutdown({
    closeHarness: async () => { throw new Error('fixed test'); },
    closeOpenCode: async () => { await wait.promise; drained = true; },
    flushPrefs: async () => {},
    unsubscribe() {},
    closeServer: async () => { closed++; },
  });
  const a = shutdown();
  const b = shutdown();
  assert.equal(a, b);
  assert.equal(closed, 0);
  wait.resolve();
  await a;
  assert.equal(drained, true);
  assert.equal(closed, 1);
});

for (const installSignalHandlers of [false, true, undefined]) {
  test(`OpenCode signal ownership ${installSignalHandlers}`, async () => {
    resetOpencodeServerSingletonForTests();
    const processImpl = new EventEmitter();
    processImpl.pid = process.pid;
    processImpl.exit = () => {};
    let killed = 0;
    const child = new EventEmitter();
    child.pid = 42001;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed++; child.emit('exit', 0); };
    const info = await ensureOpencodeServer({
      command: '/synthetic/opencode',
      cwd: '/synthetic',
      env: {},
      processImpl,
      installSignalHandlers,
      pickEphemeralPort: async () => 45219,
      spawnImpl: () => {
        setImmediate(() => child.stdout.write('opencode server listening on http://127.0.0.1:45219\n'));
        return child;
      },
      fetchImpl: async (_url, options) => ({
        status: options?.headers?.Authorization ? 200 : 401,
        ok: Boolean(options?.headers?.Authorization),
        text: async () => '{}',
      }),
      pidRecord: { read: async () => null, write: async () => {}, clear() {}, isAlive: () => false, commandOf: () => '', kill() {} },
    });
    assert.ok(info);
    assert.equal(processImpl.listenerCount('exit'), 1);
    assert.equal(processImpl.listenerCount('SIGTERM'), Number(installSignalHandlers !== false));
    assert.equal(processImpl.listenerCount('SIGINT'), Number(installSignalHandlers !== false));
    processImpl.emit('exit');
    assert.equal(killed, 1);
    resetOpencodeServerSingletonForTests();
  });
}
