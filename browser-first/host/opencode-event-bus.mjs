// Host-only parsing, session fan-out and provenance. No upstream byte is forwarded.
const FRAME_LIMIT = 262144;
const QUEUE_LIMIT = 1048576 - 4096;
const PROVENANCE_LIMIT = 10000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = v => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 256;
function failure(code = 'OPENCODE_PROTOCOL_ERROR') {
  const e = new Error('OpenCode boundary request failed.'); e.code = code;
  e.status = code === 'OPENCODE_LIMIT' ? 429 : code === 'OPENCODE_SESSION_UNKNOWN' ? 404 : code === 'OPENCODE_TIMEOUT' ? 504 : code === 'OPENCODE_STREAM_DISCONNECTED' ? 503 : 502;
  return e;
}
function unique(values) {
  const present = values.filter(v => v !== undefined && v !== null);
  if (present.some(v => !validId(v)) || new Set(present).size > 1) throw failure();
  return present[0] ?? null;
}
export function eventSessionId(raw) {
  const p = raw?.properties ?? {};
  return unique([raw?.sessionID, raw?.sessionId, p.sessionID, p.sessionId, p.session?.id,
    p.info?.sessionID, p.info?.sessionId, p.part?.sessionID, p.part?.sessionId,
    /^session[.-]/.test(raw?.type ?? '') ? p.info?.id : undefined]);
}
const knownTypes = new Set(['server.connected','server.heartbeat','installation.updated','server.instance.disposed','global.disposed',
  'session.created','session.updated','session.deleted','session.status','session.idle','session.error','session.compacted','session.diff','session-diff','session-meta',
  'message.updated','message-updated','message.removed','message.part.updated','message.part.delta','message.part.removed',
  'file.edited','file-edited','file.watcher.updated','permission.asked','permission.ask','permission.replied','permission.reply','permission.updated',
  'todo.updated','todo','text.delta','text-delta','reasoning.delta','reasoning-delta','tool.called','tool-called','tool.input.ended','tool.success','tool.completed','tool-completed','tool.failed','tool.error',
  'command.executed','vcs.branch.updated','lsp.updated','lsp.client.diagnostics','pty.created','pty.updated','pty.exited','pty.deleted']);
function validateEvent(event) {
  if (!object(event) || !knownTypes.has(event.type) || !object(event.properties)) throw failure();
  eventSessionId(event);
  return event;
}
export function createOpenCodeSSEParser({ onEvent, onError, maxFrameBytes = FRAME_LIMIT } = {}) {
  if (typeof onEvent !== 'function' || typeof onError !== 'function') throw new TypeError('OpenCode parser dependencies required.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', failed = false;
  const fail = () => { if (!failed) { failed = true; buffer = ''; onError(failure()); } };
  function parse() {
    let match;
    while (!failed && (match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      if (Buffer.byteLength(frame) > maxFrameBytes) { fail(); return; }
      const lines = frame.split(/\r?\n/), data = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (!/^(event|id|retry):/.test(line)) { fail(); return; }
      }
      if (data.length) { try { onEvent(validateEvent(JSON.parse(data.join('\n')))); } catch { fail(); } }
    }
    if (Buffer.byteLength(buffer) > maxFrameBytes) fail();
  }
  return {
    feed(bytes) { if (failed) return; try { buffer += typeof bytes === 'string' ? bytes : decoder.decode(bytes, { stream: true }); parse(); } catch { fail(); } },
    end() { if (failed) return; try { buffer += decoder.decode(); parse(); if (buffer.length) fail(); } catch { fail(); } }
  };
}
function subscription(sessionId, isCurrent, remove) {
  let queue = [], bytes = 0, terminalCode = null, wake, transport = null, settle;
  const closed = new Promise(r => { settle = r; });
  const sub = {
    sessionId, closed,
    get terminalCode() { return terminalCode; }, get queuedBytes() { return bytes; },
    attachTransport(value) {
      if (transport) throw failure();
      transport = value;
      if (terminalCode) void value.terminate(terminalCode);
      return () => { if (transport === value) transport = null; };
    },
    close(code = 'OPENCODE_STREAM_DISCONNECTED') {
      if (terminalCode) return closed;
      terminalCode = code; queue = []; bytes = 0; remove(sub); wake?.(); wake = null;
      const captured = transport;
      if (!captured) settle();
      else (async () => { try { await captured.terminate(code); await captured.closed; } finally { settle(); } })().catch(() => {});
      return closed;
    },
    push(envelope) {
      if (terminalCode || !isCurrent()) return;
      const size = Buffer.byteLength(`data: ${JSON.stringify(envelope)}\n\n`);
      if (bytes + size + (transport?.bufferedBytes() ?? 0) > QUEUE_LIMIT) { void sub.close('OPENCODE_SLOW_CONSUMER'); return; }
      queue.push({ envelope, size }); bytes += size; wake?.(); wake = null;
    },
    events: {
      [Symbol.asyncIterator]() { return {
        async next() {
          // Wake with a notification, not a captured frame: revocation can discard it.
          await Promise.resolve();
          while (!terminalCode && isCurrent() && !queue.length) await new Promise(r => { wake = r; });
          if (terminalCode || !isCurrent()) return { done: true };
          const item = queue.shift(); bytes -= item.size; return { done: false, value: item.envelope };
        },
        async return() { await sub.close(); return { done: true }; }
      }; }
    }
  };
  return sub;
}
export function createOpenCodeEventBus({ connect, sessionRegistry, generation, isCurrent, sanitize, onFatal } = {}) {
  if (typeof connect !== 'function' || !(sessionRegistry instanceof Map) || typeof isCurrent !== 'function' || typeof sanitize !== 'function' || typeof onFatal !== 'function' || generation === undefined) throw new TypeError('OpenCode bus dependencies required.');
  const subscribers = new Set(), states = new Map(), provenance = new Map(), controller = new AbortController();
  let startPromise, reader, terminalCode = null, idleTimer, connectTimer, closePromise;
  const current = () => !terminalCode && isCurrent(generation);
  function entry(id) {
    const e = sessionRegistry.get(id);
    if (!e || e.generation !== generation) throw failure('OPENCODE_SESSION_UNKNOWN');
    return e;
  }
  function state(id) {
    entry(id);
    if (!states.has(id)) states.set(id, { messages: new Map(), roots: new Map(), parts: new Map(), permissions: new Map(), pending: [], pendingBytes: 0, supported: false });
    return states.get(id);
  }
  function remember(id, kind, key, value) {
    const s = state(id), index = `${id}\0${kind}\0${key}`;
    s[kind].set(key, value); provenance.delete(index); provenance.set(index, [id, kind, key]);
    while (provenance.size > PROVENANCE_LIMIT) {
      const first = provenance.keys().next().value, [sid, k, item] = provenance.get(first); provenance.delete(first);
      states.get(sid)?.[k].delete(item); sessionRegistry.get(sid)?.messageSources?.delete(item); if(k === 'permissions')sessionRegistry.get(sid)?.permissions?.delete(item);
    }
  }
  function ancestry(id, messageID) {
    const s = state(id); if (!s.supported) return 'external';
    const seen = new Set();
    while (messageID && !seen.has(messageID)) {
      seen.add(messageID); const info = s.messages.get(messageID);
      if (!info) return 'external';
      if (info.role === 'user') return s.roots.get(messageID) === 'accepted' ? 'governed' : s.roots.get(messageID) === 'pending' ? 'pending' : 'external';
      messageID = info.parentID;
    }
    return 'external';
  }
  function observeMessage(id, info) {
    if (!object(info) || !validId(info.id) || !['user','assistant'].includes(info.role) || (info.parentID !== undefined && !validId(info.parentID)) || unique([info.sessionID,info.sessionId]) !== id) throw failure();
    const previous = state(id).messages.get(info.id);
    if (previous && (previous.role !== info.role || previous.parentID !== info.parentID)) throw failure();
    remember(id, 'messages', info.id, { role: info.role, parentID: info.parentID });
    const source = ancestry(id, info.id); entry(id).messageSources.set(info.id, source === 'governed' ? source : 'external');
    return source;
  }
  function observePart(id, part) {
    if (!object(part) || !validId(part.id) || !validId(part.messageID) || unique([part.sessionID,part.sessionId]) !== id) throw failure();
    const previous = state(id).parts.get(part.id);
    if (previous && previous.messageID !== part.messageID) throw failure();
    remember(id, 'parts', part.id, { messageID: part.messageID, type: part.type });
  }
  function toolSource(id, props) {
    const owner = unique([props.part?.messageID, props.messageID]);
    const sid = unique([props.sessionID, props.sessionId, props.part?.sessionID, props.part?.sessionId]);
    if (sid && sid !== id) return 'external';
    if (!owner || !validId(props.part?.id)) return 'external';
    const part = state(id).parts.get(props.part.id);
    if (!part) return 'external';
    if (part.messageID !== owner) throw failure();
    if (part.type !== 'tool' || state(id).messages.get(owner)?.role !== 'assistant') return 'external';
    return ancestry(id, owner);
  }
  function attributeDiff(id, diff) {
    if (!Array.isArray(diff) || diff.some(v => !object(v))) throw failure();
    return diff.map(v => ({ ...sanitize(v), source: toolSource(id, v) === 'governed' ? 'governed' : 'external' }));
  }
  function publish(id, event, source) {
    if (!current()) return;
    const e = sessionRegistry.get(id); if (!e || e.generation !== generation) return;
    const safeEvent = sanitize(event);
    if (event.type === 'session.diff' || event.type === 'session-diff') {
      const key = Array.isArray(event.properties.diff) ? 'diff' : 'files';
      safeEvent.properties[key] = attributeDiff(id, event.properties[key]);
    }
    const envelope = { version: 1, sessionId: id, source, event: safeEvent };
    for (const sub of subscribers) if (sub.sessionId === id) sub.push(envelope);
  }
  function accept(raw, replay = false) {
    if (!current()) return;
    validateEvent(raw);
    const id = eventSessionId(raw);
    if (!id || !sessionRegistry.has(id)) return;
    const s = state(id), p = raw.properties;
    unique([p.messageID,p.messageId,p.part?.messageID,p.part?.messageId]);
    let source = 'external';
    if (/^message[.-]updated$/.test(raw.type)) source = observeMessage(id, p.info ?? p);
    else if (raw.type === 'message.part.updated') { observePart(id,p.part); source = ancestry(id,p.part.messageID); }
    else if (raw.type === 'file.edited' || raw.type === 'file-edited') source = toolSource(id,p);
    else if (raw.type === 'session.diff' || raw.type === 'session-diff') {
      const key = Array.isArray(p.diff) ? 'diff' : 'files';
      const diff = attributeDiff(id,p[key]);
      publish(id,{type:raw.type,properties:{...sanitize(p),[key]:diff}},'external'); return;
    } else if (validId(p.messageID)) source = ancestry(id,p.messageID);
    if (/^permission\.(asked|ask|updated)$/.test(raw.type)) {
      const permissionId = p.id ?? p.permissionID; if (!validId(permissionId)) throw failure();
      // Permission ownership is observed, never accepted from a reply payload.
      entry(id).permissions ??= new Set(); remember(id,'permissions',permissionId,true); entry(id).permissions.add(permissionId);
    }
    if (source === 'pending') {
      if (replay) return;
      const size = Buffer.byteLength(JSON.stringify(raw));
      if (s.pendingBytes + size > QUEUE_LIMIT) throw failure('OPENCODE_LIMIT');
      let root = p.info?.id ?? p.part?.messageID ?? p.messageID ?? p.id;
      const seen = new Set();
      while (root && !seen.has(root) && s.messages.get(root)?.role === 'assistant') { seen.add(root); root = s.messages.get(root).parentID; }
      s.pending.push({raw,root,size}); s.pendingBytes += size; return;
    }
    publish(id, { type: raw.type, properties: p }, source);
  }
  async function close(code = 'OPENCODE_STREAM_DISCONNECTED') {
    if (closePromise) return closePromise;
    terminalCode = code; controller.abort(); clearTimeout(idleTimer); clearTimeout(connectTimer);
    const captured = [...subscribers];
    // Close synchronously before canceling the upstream reader.
    const closures = captured.map(s => s.close(code));
    states.clear(); provenance.clear();
    closePromise = Promise.allSettled([...closures, reader?.cancel()]).then(() => {});
    return closePromise;
  }
  function fatal(code) { if (!current()) return; void close(code); try { Promise.resolve(onFatal(code)).catch(() => {}); } catch {} }
  function heartbeat() { clearTimeout(idleTimer); idleTimer = setTimeout(() => fatal('OPENCODE_TIMEOUT'),45000); idleTimer.unref?.(); }
  async function start() {
    if (terminalCode) throw failure(terminalCode);
    if (startPromise) return startPromise;
    startPromise = (async () => {
      let rejectDeadline;
      const aborted=()=>rejectDeadline(failure(terminalCode ?? 'OPENCODE_REVOKED'));
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      controller.signal.addEventListener('abort',aborted,{once:true});
      connectTimer = setTimeout(() => { fatal('OPENCODE_TIMEOUT'); rejectDeadline(failure('OPENCODE_TIMEOUT')); },5000);
      connectTimer.unref?.();
      try {
        const response = await Promise.race([Promise.resolve(connect({ signal: controller.signal })).then(async res => { if (!current()) { await res?.body?.cancel?.(); throw failure(terminalCode ?? 'OPENCODE_REVOKED'); } return res; }), deadline]);
        clearTimeout(connectTimer);
        if (response?.status === 401 || response?.status === 403) throw failure('OPENCODE_UPSTREAM_AUTH');
        if (response?.status !== 200) throw failure('OPENCODE_UPSTREAM_FAILED');
        if (!response.body?.getReader || !/^text\/event-stream(?:;|$)/i.test(response.headers?.get('content-type') ?? '')) throw failure();
        reader = response.body.getReader(); heartbeat();
        const parser = createOpenCodeSSEParser({ onEvent: accept, onError: () => fatal('OPENCODE_PROTOCOL_ERROR') });
        void (async () => { try { while (current()) { const { value, done } = await reader.read(); if (!current()) return; if (done) { parser.end(); fatal('OPENCODE_STREAM_DISCONNECTED'); return; } heartbeat(); parser.feed(value); } } catch { fatal('OPENCODE_STREAM_DISCONNECTED'); } })();
      } catch (error) { const code = error?.code ?? 'OPENCODE_STREAM_DISCONNECTED'; fatal(code); throw failure(code); }
      finally { clearTimeout(connectTimer); controller.signal.removeEventListener('abort',aborted); }
    })();
    return startPromise;
  }
  return {
    start, close,
    subscribe(id) {
      if (!current() || !reader) throw failure(terminalCode ?? 'OPENCODE_STREAM_DISCONNECTED');
      const e = entry(id);
      if (e.subscribers.size >= 8 || subscribers.size >= 32) throw failure('OPENCODE_LIMIT');
      const sub = subscription(id, current, s => { subscribers.delete(s); e.subscribers.delete(s); });
      subscribers.add(sub); e.subscribers.add(sub);
      sub.push({version:1,sessionId:id,source:'governed',event:{type:'bridge.ready',properties:{}}}); return sub;
    },
    // Host-private cooperation with the boundary; none of these are transport methods.
    beginPrompt(id, messageID, supported) { const s=state(id); s.supported = supported === true; if (s.supported) { if (!/^msg_[a-zA-Z0-9]+$/.test(messageID)) throw failure(); remember(id,'roots',messageID,'pending'); } },
    finishPrompt(id, messageID, success) {
      if (!current() || !sessionRegistry.has(id)) return;
      const s=state(id); if (!s.roots.has(messageID)) return;
      if (success) s.roots.set(messageID,'accepted'); else s.roots.delete(messageID);
      const pending=s.pending.filter(item=>item.root===messageID);
      s.pending=s.pending.filter(item=>item.root!==messageID);
      s.pendingBytes=s.pending.reduce((sum,item)=>sum+item.size,0);
      if (success) for (const {raw} of pending) accept(raw,true);
    },
    observeMessage, observePart, attributeDiff,
    messageSource(id,messageID) { return ancestry(id,messageID)==='governed'?'governed':'external'; },
    receipt(id,operation) { publish(id,{type:'bridge.operation',properties:{operation}},'governed'); },
    async removeSession(id,code='OPENCODE_SESSION_UNKNOWN') { const e=sessionRegistry.get(id); const pending=[...(e?.subscribers ?? [])].map(s=>s.close(code)); sessionRegistry.delete(id); states.delete(id); for (const [key,[sid]] of provenance) if(sid===id) provenance.delete(key); await Promise.all(pending); },
    get terminalCode() { return terminalCode; }
  };
}
