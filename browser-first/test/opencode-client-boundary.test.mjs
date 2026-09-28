import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createOpencodeHttpClient, ensureOpencodeServer, resetOpencodeServerSingletonForTests, basicAuthHeader } from '../host/opencode-client.mjs';
const headers = () => ({ Authorization: basicAuthHeader('opencode', randomBytes(32).toString('hex')) });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const doc = (declared = true) => ({ paths: { '/session/{sessionID}/prompt_async': { post: { requestBody: { content: { 'application/json': { schema: { properties: declared ? { messageID: { type: 'string' } } : {} } } } } } } } });
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
function serveFixture(port = 45125) {
  resetOpencodeServerSingletonForTests();
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => { child.killed = true; child.emit('exit'); };
  let spawns = 0;
  return { child, get spawns() { return spawns; }, options: { port, env: {}, command: '/fixture/opencode', processImpl: new EventEmitter(), pidRecord: { read: async () => null, write: async () => {}, clear() {} }, maxWaitMs: 10, spawnImpl() { spawns++; setImmediate(() => child.stdout.write(`listening on http://127.0.0.1:${port}\n`)); return child; }, fetchImpl: async (_u, init) => response({}, init.headers?.Authorization ? 200 : 401) } };
}
for (const port of [4096, 4231]) test(`reserved port is rejected: ${port}`, async () => {
  const f = serveFixture(port); await codeOf(() => ensureOpencodeServer(f.options)); assert.equal(f.spawns, 0);
});
test('readiness refuses credentialless success', async () => {
  const f = serveFixture(); let adopted = false; let rejected = false;
  try { await ensureOpencodeServer({ ...f.options, fetchImpl: async () => response({}) }); adopted = true; } catch { rejected = true; }
  assert.equal(rejected && !adopted && f.child.killed, true);
});
test('missing Basic credential refuses client creation', () => {
  let count = 0; try { createOpencodeHttpClient({ baseUrl: 'http://127.0.0.1:45125', fetchImpl: async () => response({}) }); count++; } catch {}
  assert.equal(count, 0);
});
test('generation abort covers HTTP response body', async () => {
  const controller = new AbortController(); let reading;
  const started = new Promise(r => { reading = r; });
  const client = createOpencodeHttpClient({ baseUrl: 'http://127.0.0.1:45125', headers: headers(), signal: controller.signal, requestTimeoutMs: 100, fetchImpl: async () => ({ status: 200, ok: true, text() { reading(); return new Promise(r => setTimeout(() => r('{}'), 30)); } }) });
  const result = codeOf(() => client.listSessions()); await started; controller.abort(); assert.equal(await result, 'OPENCODE_REVOKED');
});
test('upstream redirect is not followed', async () => {
  let requests = 0;
  // Inject a redirect-capable fetch to exercise policy without requiring a listening socket.
  const fetchImpl = async (_url, init) => { if (init.redirect === 'error') throw new TypeError('redirect'); requests++; return response({}); };
  await codeOf(() => createOpencodeHttpClient({ fetchImpl, headers: headers(), baseUrl: 'http://127.0.0.1:45125' }).listSessions());
  assert.equal(requests, 0);
});
test('failed doc cannot select prompt fallback', async () => {
  let prompts = 0; const client = createOpencodeHttpClient({ baseUrl: 'http://127.0.0.1:45125', headers: headers(), fetchImpl: async u => { if (u.endsWith('/doc')) return response({}, 503); prompts++; return response({}); } });
  await codeOf(() => client.prompt('A', 'text')); assert.equal(prompts, 0);
});
for (const declared of [true, false]) test(`messageID support checks selected request schema: ${declared ? 'declared' : 'absent'}`, async () => {
  const client = createOpencodeHttpClient({ baseUrl: 'http://127.0.0.1:45125', headers: headers(), fetchImpl: async () => response(doc(declared)) });
  assert.equal(await client.supportsPromptMessageId(), declared);
});
test('messageID support cache ends with generation', async () => {
  const counts = [0, 0];
  for (let i = 0; i < 2; i++) { const controller = new AbortController(); const client = createOpencodeHttpClient({ baseUrl: 'http://127.0.0.1:45125', headers: headers(), signal: controller.signal, fetchImpl: async () => { counts[i]++; return response(doc()); } }); await Promise.all([client.supportsPromptMessageId(), client.supportsPromptMessageId()]); controller.abort(); }
  assert.deepEqual(counts, [1, 1]);
});
for (const variant of ['local-ref','cycle','external-ref','invalid-property']) test(`messageID schema resolution: ${variant}`,async()=>{
  const d=doc();let expected=true;
  const schema=d.paths['/session/{sessionID}/prompt_async'].post.requestBody.content['application/json'].schema;
  if(variant==='local-ref'){schema.properties.messageID={$ref:'#/components/schemas/MessageID'};d.components={schemas:{MessageID:{type:'string'}}};}
  if(variant==='cycle'){schema.properties.messageID={$ref:'#/components/schemas/MessageID'};d.components={schemas:{MessageID:{$ref:'#/components/schemas/MessageID'}}};expected='OPENCODE_PROTOCOL_ERROR';}
  if(variant==='external-ref'){schema.properties.messageID={$ref:'https://example.invalid/schema'};expected='OPENCODE_PROTOCOL_ERROR';}
  if(variant==='invalid-property'){schema.properties.messageID='string';expected=false;}
  const client=createOpencodeHttpClient({baseUrl:'http://127.0.0.1:45125',headers:headers(),fetchImpl:async()=>response(d)});
  let result;try{result=await client.supportsPromptMessageId();}catch(e){result=e.code;}assert.equal(result,expected);
});
test('oversized HTTP body cancels its reader',async()=>{let canceled=false;const client=createOpencodeHttpClient({baseUrl:'http://127.0.0.1:45125',headers:headers(),fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(1048577));},cancel(){canceled=true;}}))});const code=await codeOf(()=>client.listSessions());assert.deepEqual([code,canceled],['OPENCODE_PROTOCOL_ERROR',true]);});
