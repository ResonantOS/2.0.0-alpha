#!/usr/bin/env node
// Operator example for the harness swap demo. This normalizes provider wire
// quirks; it does not redact prompts before they leave the machine.
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_WIRE = 1_048_576;
const MAX_FRAME = 65_536;
const DEADLINE_MS = 115_000;
const DROPPED_DELTA_FIELDS = ['name', 'audio_content', 'audio', 'reasoning', 'reasoning_content'];
const REDACTED = '[redacted]';

function scrubString(value, secret) {
  return value.split(secret).join(REDACTED);
}

function scrubValue(value, secret) {
  if (typeof value === 'string') return scrubString(value, secret);
  if (Array.isArray(value)) return value.map(item => scrubValue(item, secret));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    scrubString(key, secret), scrubValue(item, secret),
  ]));
}

function scrubContent(content, state, index, secret, flush = false) {
  const combined = `${state.contentPending.get(index) ?? ''}${content}`;
  if (flush) {
    state.contentPending.delete(index);
    return scrubString(combined, secret);
  }
  const held = markerPrefix(combined, secret);
  state.contentPending.set(index, combined.slice(combined.length - held));
  return scrubString(combined.slice(0, combined.length - held), secret);
}

function endpoint(raw, label) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`invalid ${label} endpoint`); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error(`invalid ${label} endpoint`);
  }
  return url;
}

function authorized(header, bearer) {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${bearer}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function reply(res, status, message) {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { message } }));
}

async function chatBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw Object.assign(new Error('invalid content type'), { status: 415 });
  }
  if (Number(req.headers['content-length']) > MAX_WIRE) {
    throw Object.assign(new Error('request too large'), { status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WIRE) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.stream !== true || !Array.isArray(body.messages)) {
    throw Object.assign(new Error('invalid chat request'), { status: 400 });
  }
  delete body.store;
  if (body.max_completion_tokens !== undefined && body.max_tokens === undefined) {
    body.max_tokens = body.max_completion_tokens;
  }
  delete body.max_completion_tokens;
  return JSON.stringify(body);
}

function markerPrefix(text, marker) {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length--) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function withoutThink(content, state) {
  state.pending += content;
  let visible = '';
  while (state.pending) {
    const marker = state.inside ? '</think>' : '<think>';
    const index = state.pending.indexOf(marker);
    if (index !== -1) {
      if (!state.inside) visible += state.pending.slice(0, index);
      state.pending = state.pending.slice(index + marker.length);
      state.inside = !state.inside;
      continue;
    }
    const held = markerPrefix(state.pending, marker);
    if (!state.inside) visible += state.pending.slice(0, state.pending.length - held);
    state.pending = state.pending.slice(state.pending.length - held);
    break;
  }
  return visible;
}

function normalizeFrame(frame, state, upstreamKey) {
  const data = frame.split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return null;
  if (data === '[DONE]') {
    if (state.think.inside) throw new Error('unfinished think span');
    const trailing = state.think.pending;
    state.think.pending = '';
    const flushed = [];
    if (trailing) {
      const content = scrubContent(trailing, state, 0, upstreamKey, true);
      if (content) flushed.push({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
    }
    for (const index of state.contentPending.keys()) {
      const content = scrubContent('', state, index, upstreamKey, true);
      if (content) flushed.push({ choices: [{ index, delta: { content }, finish_reason: null }] });
    }
    state.sawDone = true;
    return flushed;
  }
  let event;
  try { event = JSON.parse(data); } catch { throw new Error('invalid upstream event'); }
  if (!event || event.error || !Array.isArray(event.choices) || event.choices.length > 1) {
    throw new Error('invalid upstream event');
  }
  for (const choice of event.choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('invalid choice');
    if (choice.delta == null && choice.finish_reason != null) choice.delta = {};
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object' || Array.isArray(delta) ||
        'tool_calls' in delta || 'function_call' in delta) throw new Error('invalid delta');
    const index = choice.index ?? 0;
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('invalid choice');
    const terminal = state.choices.get(index);
    if (terminal?.finished) throw new Error('content after finish');
    if (delta.content != null && typeof delta.content !== 'string') throw new Error('invalid content');
    for (const field of DROPPED_DELTA_FIELDS) delete delta[field];
    if (typeof delta.content === 'string') delta.content = withoutThink(delta.content, state.think);
    if (choice.finish_reason != null) {
      if (!['stop', 'length', 'content_filter'].includes(choice.finish_reason)) throw new Error('invalid finish');
      if (state.think.inside) throw new Error('unfinished think span');
      if (state.think.pending) {
        delta.content = (delta.content ?? '') + state.think.pending;
        state.think.pending = '';
      }
      delta.content = scrubContent(delta.content ?? '', state, index, upstreamKey, true);
      state.choices.set(index, { finished: true });
    } else {
      delta.content = scrubContent(delta.content ?? '', state, index, upstreamKey);
      if (!terminal) state.choices.set(index, { finished: false });
    }
  }
  return [scrubValue(event, upstreamKey)];
}

function createSseParser(onFrame) {
  let line = '';
  let lineBytes = 0;
  let frameBytes = 0;
  let lines = [];
  let pendingCR = false;
  let stopped = false;

  function endLine() {
    frameBytes += lineBytes + 1;
    if (frameBytes > MAX_FRAME) throw new Error('upstream frame too large');
    if (!line) {
      const frame = lines.join('\n');
      line = '';
      lineBytes = 0;
      lines = [];
      frameBytes = 0;
      if (onFrame(frame) === false) stopped = true;
      return;
    }
    lines.push(line);
    line = '';
    lineBytes = 0;
  }

  function feed(text) {
    if (stopped) return;
    for (const char of text) {
      if (pendingCR) {
        pendingCR = false;
        endLine();
        if (stopped) return;
        if (char === '\n') continue;
      }
      if (char === '\r') {
        pendingCR = true;
      } else if (char === '\n') {
        endLine();
        if (stopped) return;
      } else {
        line += char;
        lineBytes += Buffer.byteLength(char);
        if (frameBytes + lineBytes > MAX_FRAME) throw new Error('upstream frame too large');
      }
    }
  }

  function finish() {
    if (stopped) return;
    if (pendingCR) {
      pendingCR = false;
      endLine();
    }
    if (line || lines.length) throw new Error('incomplete upstream stream');
  }

  return { feed, finish };
}

async function relayChat(upstream, res, upstreamKey) {
  if (!/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '') || !upstream.body) {
    await upstream.body?.cancel().catch(() => {});
    reply(res, 502, 'upstream did not return an event stream');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
  res.flushHeaders();
  const state = { sawDone: false, choices: new Map(), contentPending: new Map(), think: { inside: false, pending: '' } };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0;
  const parser = createSseParser(frame => {
    const normalized = normalizeFrame(frame, state, upstreamKey) ?? [];
    for (const event of normalized) res.write(`data: ${JSON.stringify(event)}\n\n`);
    return !state.sawDone;
  });
  try {
    for await (const chunk of upstream.body) {
      wireBytes += chunk.byteLength;
      if (wireBytes > MAX_WIRE) throw new Error('upstream stream too large');
      parser.feed(decoder.decode(chunk, { stream: true }));
      if (state.sawDone) break;
    }
    if (!state.sawDone) {
      parser.feed(decoder.decode());
      parser.finish();
      const allChoicesFinished = state.choices.size > 0 && [...state.choices.values()].every(choice => choice.finished);
      if (state.think.inside || state.think.pending || !allChoicesFinished) throw new Error('incomplete upstream stream');
    }
    if (!state.sawDone) {
      for (const index of state.contentPending.keys()) {
        const content = scrubContent('', state, index, upstreamKey, true);
        if (content) res.write(`data: ${JSON.stringify({ choices: [{ index, delta: { content }, finish_reason: null }] })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } finally {
    await upstream.body.cancel().catch(() => {});
  }
}

async function boundedText(upstream) {
  if (!upstream.body) throw new Error('missing upstream body');
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream.body) {
    size += chunk.byteLength;
    if (size > MAX_WIRE) throw new Error('upstream response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRelayServer({ chatUrl, modelsUrl, upstreamKey, relayBearer,
  deadlineMs = DEADLINE_MS }) {
  if (typeof upstreamKey !== 'string' || !upstreamKey || /[\r\n]/.test(upstreamKey) ||
      typeof relayBearer !== 'string' || relayBearer.length < 16 || /\s/.test(relayBearer)) {
    throw new Error('invalid relay credentials');
  }
  if (upstreamKey === relayBearer) throw new Error('upstream and relay credentials must differ');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > DEADLINE_MS) {
    throw new Error('invalid relay deadline');
  }
  const chat = endpoint(chatUrl, 'chat');
  if (!chat.pathname.endsWith('/chat/completions')) throw new Error('invalid chat endpoint');
  const derived = new URL(chat);
  derived.pathname = derived.pathname.replace(/chat\/completions$/, 'models');
  const models = modelsUrl ? endpoint(modelsUrl, 'models') : derived;
  if (models.origin !== chat.origin) throw new Error('models endpoint must share the chat origin');

  return createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, relayBearer)) return reply(res, 401, 'unauthorized');
    const isChat = ['/v1/chat/completions', '/chat/completions'].includes(req.url);
    const isModels = ['/v1/models', '/models'].includes(req.url);
    if (!isChat && !isModels) return reply(res, 404, 'not found');
    if ((isChat && req.method !== 'POST') || (isModels && req.method !== 'GET')) {
      return reply(res, 405, 'method not allowed');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => { abort(); req.destroy(); }, deadlineMs);
    timer.unref();
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      let body;
      if (isChat) {
        try { body = await chatBody(req); }
        catch (error) { return reply(res, error.status ?? 400, 'invalid chat request'); }
      }
      const upstream = await fetch(isChat ? chat : models, {
        method: req.method,
        headers: {
          authorization: `Bearer ${upstreamKey}`,
          accept: isChat ? 'text/event-stream' : 'application/json',
          ...(isChat ? { 'content-type': 'application/json' } : {}),
        },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return reply(res, 502, 'upstream request failed');
      }
      if (isChat) return await relayChat(upstream, res, upstreamKey);
      const text = await boundedText(upstream);
      let modelsBody;
      try { modelsBody = JSON.parse(text); } catch { return reply(res, 502, 'invalid upstream response'); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(scrubValue(modelsBody, upstreamKey)));
    } catch {
      if (res.headersSent) res.destroy();
      else reply(res, 502, 'relay upstream failure');
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', abort);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    console.error('usage: node examples/harness-openai-compatible-relay.mjs <port>');
    process.exitCode = 2;
  } else {
    try {
      const server = createRelayServer({
        chatUrl: process.env.UPSTREAM_CHAT,
        modelsUrl: process.env.UPSTREAM_MODELS,
        upstreamKey: process.env.UPSTREAM_KEY,
        relayBearer: process.env.RELAY_BEARER,
      });
      server.once('error', () => { console.error('relay failed to listen'); process.exitCode = 1; });
      server.listen(port, '127.0.0.1', () => console.log(`relay listening on 127.0.0.1:${port}`));
    } catch {
      console.error('invalid relay configuration; set UPSTREAM_CHAT, UPSTREAM_KEY and RELAY_BEARER');
      process.exitCode = 2;
    }
  }
}
