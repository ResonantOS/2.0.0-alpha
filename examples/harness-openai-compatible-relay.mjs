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

function normalizeFrame(frame, state) {
  const data = frame.split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return null;
  if (data === '[DONE]') {
    if (state.think.inside) throw new Error('unfinished think span');
    const trailing = state.think.pending;
    state.think.pending = '';
    state.sawDone = true;
    const finalText = trailing
      ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: trailing }, finish_reason: null }] })}\n\n`
      : '';
    return `${finalText}data: [DONE]\n\n`;
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
      state.sawFinish = true;
    }
  }
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function relayChat(upstream, res) {
  if (!/^text\/event-stream(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '') || !upstream.body) {
    reply(res, 502, 'upstream did not return an event stream');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
  const state = { sawDone: false, sawFinish: false, think: { inside: false, pending: '' } };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let wireBytes = 0;
  for await (const chunk of upstream.body) {
    wireBytes += chunk.byteLength;
    if (wireBytes > MAX_WIRE) throw new Error('upstream stream too large');
    pending += decoder.decode(chunk, { stream: true });
    pending = pending.replace(/\r\n/g, '\n');
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (Buffer.byteLength(frame) > MAX_FRAME) throw new Error('upstream frame too large');
      const normalized = normalizeFrame(frame, state);
      if (normalized) res.write(normalized);
      if (state.sawDone) { res.end(); return; }
    }
    if (Buffer.byteLength(pending) > MAX_FRAME) throw new Error('upstream frame too large');
  }
  pending += decoder.decode();
  if (pending.trim() || state.think.inside || state.think.pending ||
      (!state.sawDone && !state.sawFinish)) {
    throw new Error('incomplete upstream stream');
  }
  if (!state.sawDone) res.write('data: [DONE]\n\n');
  res.end();
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
      if (isChat) return await relayChat(upstream, res);
      const text = await boundedText(upstream);
      try { JSON.parse(text); } catch { return reply(res, 502, 'invalid upstream response'); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(text);
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
