import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const control = JSON.parse(await readFile(new URL('./control.json', import.meta.url), 'utf8').catch(() => '{}'));
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 5), ['--profile', 'web', '--no-open', '--host', '127.0.0.1']);
assert.equal(args[5], '--port');
const port = Number(args[6]); assert.ok(port >= 1024 && port <= 65535 && port !== 19387);
assert.equal(process.env.DSH_TELEMETRY_MODE, 'DISABLED');
const token = randomBytes(32).toString('base64url'), cookie = `dsh-auth-synthetic=${randomBytes(32).toString('base64url')}`;
const sessions = new Map(), sockets = new Set();
let exchanges = 0;
const catalog = { groups: [{ id: 'synthetic', models: [{ id: 'synthetic', name: 'Synthetic' }] }], default: { provider: 'synthetic', model: 'synthetic' } };
function frame(socket, value, opcode = 1) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length]) : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255]);
  socket.write(Buffer.concat([header, body]));
}
function emit(session, type, data) {
  const value = { type: 'event', event: { type, seq: ++session.seq, time: 1, data } };
  session.records.push(value);
  for (const socket of session.sockets) frame(socket, { type: 'item', streamId: 'augmentor', value });
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.origin, undefined); assert.equal(request.headers['x-augmentor-token'], undefined);
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' && url.searchParams.get('token') === token) {
      exchanges++; assert.equal(exchanges, 1, 'initial concurrent sessions share exactly one exchange');
      response.writeHead(303, { location: '/', 'set-cookie': `${cookie}; HttpOnly; Path=/` }); response.end(); return;
    }
    if (request.headers.cookie !== cookie) { response.writeHead(401); response.end(); return; }
    assert.ok(url.pathname.startsWith('/api/session/'));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks)); assert.equal(url.pathname, `/api/${rpc.method}`);
    const input = rpc.payload.args.request, method = rpc.method;
    let value = {}, state;
    if (method === 'session/modelCatalog') {
      if (control.conflictingAnnouncement) process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=conflict\n`);
      await new Promise(resolve => setTimeout(resolve, control.catalogDelay ?? 0));
      value = catalog;
    }
    else if (method === 'session/create') sessions.set(input.sessionId, { seq: 0, records: [], sockets: new Set() });
    else {
      state = sessions.get(input.sessionId ?? input.address?.sessionId); assert.ok(state);
      if (method === 'session/page') value = { records: state.records, hasMore: false };
      else if (method === 'session/prompt') {
        value = { accepted: true }; process.stdout.write('fixture-prompt\n');
        setTimeout(() => {
          emit(state, 'turn/start', {});
          emit(state, 'assistant/message', { message: { id: 'synthetic-message', content: control.splitSecret ? [{ type: 'text', text: 'synthetic answer ' }, { type: 'text', text: token.slice(0, 10) }, { type: 'text', text: token.slice(10) }] : [{ type: 'text', text: 'synthetic answer' }] } });
          emit(state, 'turn/end', {});
        }, control.promptDelay ?? 20);
      } else assert.ok(['session/cancel', 'session/selectModel'].includes(method));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
  } catch { response.writeHead(500); response.end(); }
});
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/api/remote.mux' || request.headers.cookie !== cookie || request.headers.origin || request.headers['x-augmentor-token']) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket); let pending = Buffer.alloc(0), state;
  socket.on('error', () => {});
  socket.on('close', () => { sockets.delete(socket); state?.sockets.delete(socket); });
  function received(chunk) {
    pending = Buffer.concat([pending, chunk]);
    try {
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, masked = (pending[1] & 128) !== 0; let length = pending[1] & 127, offset = 2;
        assert.ok(masked); assert.ok(pending[0] & 128); assert.notEqual(length, 127);
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4), body = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        pending = pending.subarray(offset + 4 + length);
        if (opcode === 8) { frame(socket, body, 8); socket.end(); return; }
        if (opcode === 9) { frame(socket, body, 10); continue; }
        assert.equal(opcode, 1);
        const open = JSON.parse(body); assert.equal(open.endpoint, 'session/follow'); assert.equal(open.streamId, 'augmentor');
        state = sessions.get(open.payload.args.request.address.sessionId); assert.ok(state); state.sockets.add(socket);
        frame(socket, { type: 'item', streamId: 'augmentor', value: { type: 'snapshot', cursor: state.seq, records: [], hasMore: false } });
      }
    } catch { socket.destroy(); }
  }
  socket.on('data', received); if (head.length) received(head);
});
setTimeout(() => server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${token}\n`);
  if (control.closeStdoutAfterAnnouncement) process.stdout.end();
}), control.startupDelay ?? 0);
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(0)); });
