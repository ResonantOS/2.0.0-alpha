import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import { createOpenAICompatibleAdapter } from '../browser-first/host/agent-adapters/openai-compatible.mjs';
import { createHarnessCredentials } from '../browser-first/host/harness-credentials.mjs';
import { createRelayServer } from './harness-openai-compatible-relay.mjs';

const RELAY_BEARER = 'example-relay-bearer-123456789';
const UPSTREAM_KEY = 'example-upstream-key';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function relayFor(t, upstream, options = {}) {
  return listen(t, createRelayServer({
    chatUrl: `${upstream}/v1/chat/completions`,
    upstreamKey: UPSTREAM_KEY,
    relayBearer: RELAY_BEARER,
    ...options,
  }));
}

function chatRequest(endpoint, body, bearer = RELAY_BEARER) {
  return fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('the relay accepts only authenticated fixed routes and valid streaming chat requests', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer(() => { upstreamCalls++; }));
  const relay = await relayFor(t, upstream);
  const valid = { model: 'example-model', stream: true, messages: [{ role: 'user', content: 'hello' }] };

  assert.equal((await chatRequest(relay, valid, 'wrong-bearer')).status, 401);
  assert.equal((await fetch(`${relay}/unlisted`, { headers: { authorization: `Bearer ${RELAY_BEARER}` } })).status, 404);
  assert.equal((await fetch(`${relay}/v1/chat/completions`, { headers: { authorization: `Bearer ${RELAY_BEARER}` } })).status, 405);
  assert.equal((await chatRequest(relay, '{invalid')).status, 400);
  assert.equal((await chatRequest(relay, { ...valid, stream: false })).status, 400);
  assert.equal(upstreamCalls, 0);
});

test('normalizes the observed provider request and SSE quirks', async t => {
  const seen = [];
  const upstream = await listen(t, createServer(async (req, res) => {
    const body = await new Promise(resolve => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    seen.push({ path: req.url, authorization: req.headers.authorization, body });
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'example-model' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
    res.write(frame({ choices: [{ index: 0, delta: { content: 'Hello <thi', reasoning_content: 'hidden', name: 'provider' } }] }));
    res.write(frame({ choices: [{ index: 0, delta: { content: 'nk>private reasoning</think> world', audio_content: 'hidden' } }] }));
    res.end(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, {
    model: 'example-model', stream: true, store: true, max_completion_tokens: 123,
    messages: [{ role: 'user', content: 'public test prompt' }],
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.equal(wire.match(/data: \[DONE\]/g)?.length, 1);
  assert.doesNotMatch(wire, /private reasoning|reasoning_content|audio_content|provider|<think>/);
  const events = wire.trim().split('\n\n').filter(frame => frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice('data: '.length)));
  assert.equal(events.map(event => event.choices[0].delta.content ?? '').join(''), 'Hello  world');
  assert.equal(seen[0].path, '/v1/chat/completions');
  assert.equal(seen[0].authorization, `Bearer ${UPSTREAM_KEY}`);
  assert.deepEqual(JSON.parse(seen[0].body), {
    model: 'example-model', stream: true, max_tokens: 123,
    messages: [{ role: 'user', content: 'public test prompt' }],
  });

  const models = await fetch(`${relay}/v1/models`, { headers: { authorization: `Bearer ${RELAY_BEARER}` } });
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { data: [{ id: 'example-model' }] });
  assert.equal(seen[1].authorization, `Bearer ${UPSTREAM_KEY}`);
});

test('the real host adapter accepts a normalized relay completion', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"hello <think>hidden</think>safe","reasoning_content":"hidden"}}]}\n\n');
    res.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
  }));
  const relay = await relayFor(t, upstream);
  const runtime = { adapterId: 'openai-compatible-v1', authScheme: 'bearer',
    credentialBinding: 'relay.integration', endpoint: relay };
  const credentials = createHarnessCredentials({
    bindings: [{ ...runtime, name: runtime.credentialBinding, addonId: 'addon.relay-integration',
      source: { env: 'TEST_RELAY_BEARER' } }],
    env: { TEST_RELAY_BEARER: RELAY_BEARER },
  });
  const adapter = await createOpenAICompatibleAdapter({ credentials, addonId: 'addon.relay-integration',
    runtime, lookup: async () => [{ address: '127.0.0.1' }] });
  t.after(() => adapter.dispose());
  const session = await adapter.createSession();
  const events = [];
  for await (const event of adapter.invoke({ session, input: {
    model: 'example-model', messages: [{ role: 'user', content: 'test' }],
  } })) events.push(event);
  assert.deepEqual(events.at(-1), { type: 'final', data: { text: 'hello safe' } });
});

test('the real host adapter rejects content that follows a terminal choice', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    res.write(frame({ choices: [{ index: 0, delta: { content: 'First.' } }] }));
    res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    res.end(frame({ choices: [{ index: 0, delta: { content: 'Second partial' } }] }));
  }));
  const relay = await relayFor(t, upstream);
  const runtime = { adapterId: 'openai-compatible-v1', authScheme: 'bearer',
    credentialBinding: 'relay.integration', endpoint: relay };
  const credentials = createHarnessCredentials({
    bindings: [{ ...runtime, name: runtime.credentialBinding, addonId: 'addon.relay-integration',
      source: { env: 'TEST_RELAY_BEARER' } }],
    env: { TEST_RELAY_BEARER: RELAY_BEARER },
  });
  const adapter = await createOpenAICompatibleAdapter({ credentials, addonId: 'addon.relay-integration',
    runtime, lookup: async () => [{ address: '127.0.0.1' }] });
  t.after(() => adapter.dispose());
  const session = await adapter.createSession();
  const events = [];
  for await (const event of adapter.invoke({ session, input: {
    model: 'example-model', messages: [{ role: 'user', content: 'test' }],
  } })) events.push(event);
  assert.equal(events.at(-1).type, 'error');
  assert.notEqual(events.at(-1).data?.text, 'First.Second partial');
});

test('preserves valid content in the same event as its terminal finish', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"final content"},"finish_reason":"stop"}]}\n\n');
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /final content/);
  assert.match(wire, /data: \[DONE\]/);
});

test('does not synthesize DONE for an unfinished second choice', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    res.write(frame({ choices: [{ index: 0, delta: { content: 'first' }, finish_reason: 'stop' }] }));
    res.end(frame({ choices: [{ index: 1, delta: { content: 'second partial' } }] }));
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});

test('scrubs upstream credentials from chat content across SSE frames', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    res.write(frame({ id: UPSTREAM_KEY, choices: [{ index: 0, delta: { content: `before ${UPSTREAM_KEY.slice(0, 8)}` } }] }));
    res.write(frame({ choices: [{ index: 0, delta: { content: `${UPSTREAM_KEY.slice(8)} after` } }] }));
    res.end(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.doesNotMatch(wire, new RegExp(UPSTREAM_KEY));
  const events = wire.trim().split('\n\n').filter(frame => frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice('data: '.length)));
  const assembled = events.map(event => event.choices[0].delta.content ?? '').join('');
  assert.doesNotMatch(assembled, new RegExp(UPSTREAM_KEY));
});

test('scrubs parsed escaped credentials from models JSON', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[{"id":"\\u0065xample-upstream-key"}]}');
  }));
  const relay = await relayFor(t, upstream);
  const response = await fetch(`${relay}/v1/models`, { headers: { authorization: `Bearer ${RELAY_BEARER}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.notEqual(body.data[0].id, UPSTREAM_KEY);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(UPSTREAM_KEY));
});

test('refuses redirects and keeps upstream error bodies out of local responses', async t => {
  let redirected = 0;
  const destination = await listen(t, createServer(() => { redirected++; }));
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(302, { location: `${destination}/capture`, 'content-type': 'text/plain' });
    res.end('provider private diagnostic');
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /provider private diagnostic|capture/);
  assert.equal(redirected, 0);
});

test('does not turn a truncated upstream stream into a successful completion', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});

test('passes an explicit DONE and preserves a split marker at completion', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"literal <thi"}}]}\n\n' +
      'data: [DONE]\n\n');
  }));
  const relay = await relayFor(t, upstream);
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 200);
  const wire = await response.text();
  const text = wire.trim().split('\n\n').filter(frame => frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice('data: '.length)).choices[0].delta.content ?? '').join('');
  assert.equal(text, 'literal <thi');
  assert.equal(wire.match(/data: \[DONE\]/g)?.length, 1);
});

test('aborts an upstream stream when the local client disconnects', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstream = await listen(t, createServer((req, res) => {
    res.once('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n');
  }));
  const relay = await relayFor(t, upstream);
  const controller = new AbortController();
  const response = await fetch(`${relay}/v1/chat/completions`, {
    method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${RELAY_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', stream: true, messages: [] }),
  });
  await response.body.getReader().read();
  controller.abort();
  await within(closed, 2000, 'upstream stayed open');
});

test('bounds a slow authenticated request before it reaches the provider', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer(() => { upstreamCalls++; }));
  const relay = await relayFor(t, upstream, { deadlineMs: 80 });
  const request = httpRequest(`${relay}/v1/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${RELAY_BEARER}`, 'content-type': 'application/json' },
  });
  request.on('error', () => {});
  t.after(() => request.destroy());
  const closed = new Promise(resolve => request.once('close', resolve));
  request.write('{"model":');
  await within(closed, 2000, 'slow request stayed open');
  assert.equal(upstreamCalls, 0);
});

test('bounds forwarded requests and models responses', async t => {
  let upstreamCalls = 0;
  const upstream = await listen(t, createServer((req, res) => {
    upstreamCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: 'x'.repeat(1_048_576) }));
  }));
  const relay = await relayFor(t, upstream);
  const large = await chatRequest(relay, {
    model: 'x', stream: true, messages: [{ role: 'user', content: 'x'.repeat(1_048_576) }],
  });
  assert.equal(large.status, 413);
  assert.equal(upstreamCalls, 0);

  const models = await fetch(`${relay}/v1/models`, { headers: { authorization: `Bearer ${RELAY_BEARER}` } });
  assert.equal(models.status, 502);
  assert.equal(upstreamCalls, 1);
});

test('rejects unsafe upstream configuration before listening', () => {
  const config = { chatUrl: 'http://example.com/v1/chat/completions', upstreamKey: UPSTREAM_KEY, relayBearer: RELAY_BEARER };
  assert.throws(() => createRelayServer(config), /invalid chat endpoint/);
  assert.throws(() => createRelayServer({ ...config, chatUrl: 'https://example.com/v1/chat/completions', modelsUrl: 'https://other.example/v1/models' }), /models endpoint must share/);
  assert.throws(() => createRelayServer({ ...config, chatUrl: 'https://example.com/v1/chat/completions', relayBearer: 'short' }), /invalid relay credentials/);
  assert.throws(() => createRelayServer({ ...config, chatUrl: 'https://example.com/v1/chat/completions', deadlineMs: 0 }), /invalid relay deadline/);
  assert.throws(() => createRelayServer({ ...config, chatUrl: 'https://example.com/v1/chat/completions', relayBearer: UPSTREAM_KEY }), /must differ/);
});

test('cancels a successful non-event-stream upstream body immediately', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const upstream = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"never":"ending');
    req.once('close', () => { upstreamClosed(); res.destroy(); });
  }));
  const relay = await relayFor(t, upstream, { deadlineMs: 2000 });
  const response = await chatRequest(relay, { model: 'x', stream: true, messages: [] });
  assert.equal(response.status, 502);
  await response.text();
  await within(closed, 1000, 'non-event-stream upstream body was not cancelled');
});

test('the CLI binds its actual listener to loopback only', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['examples/harness-openai-compatible-relay.mjs', String(port)], {
    cwd: process.cwd(),
    env: {
      UPSTREAM_CHAT: 'http://127.0.0.1:9/v1/chat/completions',
      UPSTREAM_KEY: 'cli-upstream-key',
      RELAY_BEARER: 'cli-relay-bearer-123456789',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (!child.killed) child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
  });
  await within(new Promise((resolve, reject) => {
    const onData = () => {
      if (/relay listening on 127\.0\.0\.1:\d+/.test(stdout)) { child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`relay CLI exited ${code}: ${stderr}`)));
  }), 2000, 'relay CLI did not start');

  const local = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: 'Bearer cli-relay-bearer-123456789' },
  });
  assert.equal(local.status, 502);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(fetch(`http://127.0.0.2:${port}/v1/models`, {
      signal: controller.signal,
      headers: { authorization: 'Bearer cli-relay-bearer-123456789' },
    }));
  } finally { clearTimeout(timer); }
});
