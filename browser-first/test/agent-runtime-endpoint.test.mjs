import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const endpointModule = await import('../host/agent-runtime-endpoint.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
function guard(options) {
  assert.equal(typeof endpointModule.createAgentRuntimeEndpoint, 'function',
    'one shared endpoint guard must protect HTTP and WebSocket connections');
  return endpointModule.createAgentRuntimeEndpoint(options);
}
async function server(t, handler = (_req, res) => res.end('ok')) {
  const instance = createServer(handler), sockets = new Set();
  let connections = 0;
  instance.on('connection', socket => {
    connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => instance.close(resolve));
  });
  instance.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  return { instance, endpoint: `http://127.0.0.1:${instance.address().port}`, connections: () => connections };
}
async function connect(client, kind, path = '/') {
  const signal = AbortSignal.timeout(3000);
  if (kind === 'HTTP') {
    const response = await client.connectHttp(path, { signal, headers: { connection: 'close' } });
    assert.equal(await response.text(), 'ok');
    return;
  }
  return client.connectWebSocket(path, { signal }, socket => new Promise((resolve, reject) => {
    socket.addEventListener('open', () => { socket.close(); resolve(); }, { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket handshake rejected')), { once: true });
  }));
}

test('shared guard accepts only approved loopback endpoint hostnames', () => {
  for (const endpoint of ['http://localhost:3080', 'http://127.0.0.1:3080', 'http://[::1]:3080']) {
    assert.doesNotThrow(() => guard({ endpoint }));
  }
  for (const endpoint of ['http://127.0.0.2:3080', 'http://example.com:3080', 'http://203.0.113.1:3080',
    'http://localhost', 'http://localhost:0', 'ftp://localhost:3080', 'http://user@localhost:3080',
    'http://localhost:3080/path', 'http://localhost:3080/?token=x', 'http://localhost:3080/#fragment']) {
    assert.throws(() => guard({ endpoint }), { code: 'permission-denied' });
  }
});

for (const kind of ['HTTP', 'WebSocket']) {
  test(`DNS rebinding cannot redirect either transport: ${kind}`, async t => {
    // Assert the missing shared boundary before attempting sockets in a sandbox.
    guard({ endpoint: 'http://localhost:3080' });
    const approved = await server(t);
    let answers = [{ address: '127.0.0.1', family: 4 }], resolutions = 0, connections = 0;
    const recordDestination = url => {
      connections++;
      assert.equal(new URL(url).hostname, '127.0.0.1', 'connect to the validated address, never resolve the hostname again');
    };
    const client = guard({ endpoint: approved.endpoint.replace('127.0.0.1', 'localhost'),
      lookup: async (host, options) => {
        assert.equal(host, 'localhost'); assert.deepEqual(options, { all: true, verbatim: true });
        resolutions++; return answers;
      },
      fetchImpl: (url, options) => { recordDestination(url); return fetch(url, options); },
      WebSocketImpl: class extends WebSocket {
        constructor(url, options) { recordDestination(url); super(url, options); }
      },
    });
    await connect(client, kind);
    assert.equal(approved.connections(), 1, 'positive control establishes a real socket');
    assert.equal(resolutions, 1);
    for (const bad of [
      [{ address: '203.0.113.1', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }, { address: '203.0.113.1', family: 4 }],
      [{ address: '::2', family: 6 }, { address: '127.0.0.1', family: 4 }], [],
    ]) {
      answers = bad;
      await assert.rejects(connect(client, kind), { code: 'permission-denied' });
      assert.equal(approved.connections(), 1, 'denied DNS establishes zero additional sockets');
      assert.equal(connections, 1, 'denied DNS never reaches a network connector');
    }
    assert.equal(resolutions, 5, 'resolve on every attempted connection, without cached answers');
    answers = [{ address: '127.0.0.1', family: 4 }];
    await connect(client, kind);
    assert.equal(approved.connections(), 2, 'recovery still establishes an authorized socket');
    assert.equal(resolutions, 6);
  });

  test(`${kind} wrong ports and redirects establish zero prohibited sockets`, async t => {
    guard({ endpoint: 'http://localhost:3080' });
    const prohibited = await server(t), approved = await server(t);
    const client = guard({ endpoint: approved.endpoint });
    await connect(client, kind);
    assert.equal(approved.connections(), 1);
    for (const path of [prohibited.endpoint, `//127.0.0.1:${new URL(prohibited.endpoint).port}/`,
      prohibited.endpoint.replace('http:', 'ws:')]) {
      await assert.rejects(connect(client, kind, path), { code: 'permission-denied' });
      assert.equal(prohibited.connections(), 0, 'wrong port must be rejected before socket establishment');
    }
    for (const status of [301, 302, 303, 307, 308]) {
      const redirector = await server(t, (_req, res) => {
        res.writeHead(status, { location: prohibited.endpoint, connection: 'close' }).end();
      });
      redirector.instance.removeAllListeners('upgrade');
      redirector.instance.on('upgrade', (_req, socket) => socket.end(
        `HTTP/1.1 ${status} Redirect\r\nLocation: ${prohibited.endpoint.replace('http:', 'ws:')}\r\nContent-Length: 0\r\n\r\n`));
      await assert.rejects(connect(guard({ endpoint: redirector.endpoint }), kind));
      assert.equal(redirector.connections(), 1, 'the redirect response came from a real socket');
      assert.equal(prohibited.connections(), 0, `${status} redirect must never establish a destination socket`);
    }
  });
}

test('aborted DNS cannot establish a late connection on either transport', async () => {
  for (const kind of ['HTTP', 'WebSocket']) {
    let release, connections = 0;
    const controller = new AbortController();
    const client = guard({ endpoint: 'http://localhost:3080',
      lookup: () => new Promise(resolve => { release = resolve; }),
      fetchImpl: () => { connections++; },
      WebSocketImpl: class { constructor() { connections++; } },
    });
    const pending = kind === 'HTTP' ? client.connectHttp('/', { signal: controller.signal }) :
      client.connectWebSocket('/', { signal: controller.signal }, () => {});
    controller.abort(); release([{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(pending);
    assert.equal(connections, 0);
  }
});

test('shared connectors pin addresses, ports and redirect policy with trusted host dependencies', async () => {
  const calls = [];
  let answers = [{ address: '127.0.0.1', family: 4 }], lookups = 0;
  const client = guard({ endpoint: 'http://localhost:3080',
    lookup: async () => { lookups++; return answers; },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options }); return new Response('ok');
    },
    WebSocketImpl: class { constructor(url, options) { calls.push({ url: String(url), options }); } },
  });
  await client.connectHttp('/api/test');
  await client.connectWebSocket('/api/test', {}, () => {});
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:3080/api/test', 'ws://127.0.0.1:3080/api/test']);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[1].options.followRedirects, false);
  assert.equal(lookups, 2);
  for (const bad of [[{ address: '203.0.113.1', family: 4 }],
    [{ address: '127.0.0.1', family: 4 }, { address: '::2', family: 6 }], [], [null]]) {
    answers = bad;
    await assert.rejects(client.connectHttp('/api/test'), { code: 'permission-denied' });
    await assert.rejects(client.connectWebSocket('/api/test', {}, () => {}), { code: 'permission-denied' });
  }
  assert.equal(lookups, 10);
  answers = [{ address: '127.0.0.1', family: 4 }];
  for (const path of ['http://localhost:3081/api/test', '//localhost:3081/api/test', '/\\localhost:3081/api/test']) {
    await assert.rejects(client.connectHttp(path), { code: 'permission-denied' });
    await assert.rejects(client.connectWebSocket(path, {}, () => {}), { code: 'permission-denied' });
  }
  assert.equal(calls.length, 2, 'proposals cannot replace the host-approved port');
});
