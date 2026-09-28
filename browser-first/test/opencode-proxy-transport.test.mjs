import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import * as transport from '../host/bridge-server.mjs';
import { createBridgeRouteSelfTestInvoker } from '../host/bridge-self-test-invoker.mjs';
import { createOpenCodeBoundary } from '../host/opencode-boundary.mjs';
const ORIGIN = 'chrome-extension://test';
const secret = () => randomBytes(32).toString('hex');
const PATH = '/opencode/session/start';
const EVENTS = '/opencode/session/events?sessionId=A';
const CAP = 'addon-runtime-read';
const errorTuple = (r) => [r.status, r.payload.code ?? null, r.origin];
async function fixture(run, options = {}) {
  const bridgeToken = secret(), token = secret();
  let calls = 0;
  const routes = options.routes ?? [{method:'POST',path:PATH,loopbackHostOnly:true,requiredCapability:CAP,handler:async () => { calls++; return {sessionId:'A'}; }}];
  const server = await transport.startBridgeServer({port:0,bridgeToken,bridgeCapabilityTokens:{[CAP]:token},extensionOrigin:ORIGIN,routes,...options});
  const port = server.address().port;
  const headers = {Host:`127.0.0.1:${port}`,Origin:ORIGIN,[transport.bridgeTokenHeaderName]:bridgeToken,[transport.bridgeCapabilityHeaderName]:token};
  const request = ({path=PATH,method='POST',body='{}',headers:overrides={},rawHosts,agent,httpVersion='1.1'}={}) => new Promise((resolve,reject) => {
    const h = {...headers,...overrides};
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    if (rawHosts !== undefined) {
      const socket = net.connect(port,'127.0.0.1',() => {
        const pairs = Object.entries(h).filter(([k]) => k !== 'Host').map(([k,v]) => `${k}: ${v}`);
        socket.end(`${method} ${path} HTTP/${httpVersion}\r\n${rawHosts.map(v=>`Host: ${v}\r\n`).join('')}${pairs.join('\r\n')}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
      let data=''; socket.on('data',c=>data+=c); socket.on('error',reject); socket.on('end',()=>{
        const [head,...tail]=data.split('\r\n\r\n');
        const match=tail.join('\r\n\r\n').match(/\{.*\}/s);
        resolve({status:Number(head.split(' ')[1]),payload:match?JSON.parse(match[0]):{},origin:head.match(/Access-Control-Allow-Origin: ([^\r]+)/i)?.[1]});
      }); return;
    }
    const req=http.request({host:'127.0.0.1',port,path,method,headers:h,agent},res=>{
      let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,payload:data?JSON.parse(data):{},origin:res.headers['access-control-allow-origin']}));
    });req.on('error',reject);req.end(body);
  });
  try {await run({server,port,headers,request,routes,bridgeToken,token,calls:()=>calls,reset:()=>{calls=0;}});} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
for (const kind of ['missing','wrong']) test(`bridge auth refuses before upstream: ${kind}`,async()=>fixture(async f=>{
  const control=await f.request();f.reset(); const r=await f.request({headers:{[transport.bridgeTokenHeaderName]:kind==='missing'?undefined:secret()}});
  assert.deepEqual([errorTuple(control),errorTuple(r),f.calls()],[[200,null,ORIGIN],[401,'OPENCODE_BRIDGE_UNAUTHORIZED',ORIGIN],0]);
}));
for (const kind of ['missing','wrong','undeclared']) test(`capability refuses before upstream: ${kind}`,async()=>fixture(async f=>{
  const control=await f.request();f.reset();if(kind==='undeclared') delete f.routes[0].requiredCapability;
  const r=await f.request({headers:kind==='undeclared'?{}:{[transport.bridgeCapabilityHeaderName]:kind==='missing'?undefined:secret()}});
  assert.deepEqual([errorTuple(control),errorTuple(r),f.calls()],[[200,null,ORIGIN],[403,'OPENCODE_CAPABILITY_REQUIRED',ORIGIN],0]);
}));
for (const kind of ['evil','suffix','wrong-port','missing','duplicate','absolute-target']) test(`Host refuses before upstream: ${kind}`,async()=>fixture(async f=>{
  const control=await f.request();f.reset();const h=`127.0.0.1:${f.port}`;
  const opts={evil:{headers:{Host:`evil.example:${f.port}`}},suffix:{headers:{Host:`127.0.0.1.evil:${f.port}`}},'wrong-port':{headers:{Host:`127.0.0.1:${f.port===65535?65534:f.port+1}`}},missing:{rawHosts:[],httpVersion:'1.0'},duplicate:{rawHosts:[h,h]},'absolute-target':{path:`http://${h}${PATH}`}}[kind];
  const r=await f.request(opts);
  assert.deepEqual([errorTuple(control),errorTuple(r),f.calls()],[[200,null,ORIGIN],[403,'OPENCODE_HOST_REJECTED',ORIGIN],0]);
}));
for (const [kind,host] of [['ipv4','127.0.0.1'],['localhost','LOCALHOST'],['ipv6','[::1]']]) test(`canonical loopback Host is accepted: ${kind}`,async()=>fixture(async f=>{
  assert.equal((await f.request({headers:{Host:`${host}:${f.port}`}})).status,200);
}));
for (const [name,opts,status,code] of [['malformed request JSON is typed',{body:'{'},400,'OPENCODE_INVALID_REQUEST'],['unknown proxy path is typed',{path:'/opencode/session/nope'},404,'OPENCODE_ROUTE_UNKNOWN']]) test(name,async()=>fixture(async f=>{
  const control=await f.request();const r=await f.request(opts);
  assert.deepEqual([errorTuple(control),errorTuple(r)],[[200,null,ORIGIN],[status,code,ORIGIN]]);
}));
test('self-test validates boundary: Host',async()=>{
  const bridgeToken=secret(),token=secret();
  const result=await transport.evaluateBridgeRequestForSelfTest({method:'POST',url:PATH,headers:{host:'evil.example:12345','x-resonantos-bridge-token':bridgeToken,'x-resonantos-bridge-capability-token':token},rawHeaders:['Host','evil.example:12345'],listenerPort:12345,bridgeToken,bridgeCapabilityTokens:{[CAP]:token},routes:[{method:'POST',path:PATH,requiredCapability:CAP,loopbackHostOnly:true,handler:async()=>({sessionId:'A'})}]});
  assert.deepEqual([result.status,result.payload.code],[403,'OPENCODE_HOST_REJECTED']);
});
test('configured-front-port Host succeeds after listen',async()=>{
  let publicPort;
  await fixture(async f=>{publicPort=String(f.port===19443?19444:19443);assert.deepEqual(errorTuple(await f.request({headers:{Host:`localhost:${publicPort}`}})),[200,null,ORIGIN]);},{getPublicPort:()=>publicPort});
});
test('unconfigured front port is refused',async()=>fixture(async f=>{
  const control=await f.request();f.reset();const r=await f.request({headers:{Host:'localhost:19443'}});
  assert.deepEqual([errorTuple(control),[...errorTuple(r),f.calls()]],[[200,null,ORIGIN],[403,'OPENCODE_HOST_REJECTED',ORIGIN,0]]);
}));
test('forwarded headers cannot replace Host',async()=>fixture(async f=>{
  const control=await f.request();f.reset();const r=await f.request({headers:{Host:`evil.example:${f.port}`,'X-Forwarded-Host':`127.0.0.1:${f.port}`,'X-Forwarded-Port':String(f.port)}});
  assert.deepEqual([errorTuple(control),[...errorTuple(r),f.calls()]],[[200,null,ORIGIN],[403,'OPENCODE_HOST_REJECTED',ORIGIN,0]]);
}));

// Local implementation of the frozen Subscription interface, independent of A.
function subscriptionFixture(sessionId='A') {
  let terminalCode=null, queuedBytes=0, transportHook, wake, resolveClosed;
  const queue=[];
  const closed=new Promise(r=>resolveClosed=r);
  const metrics={pulls:0,blocked:false,pullsWhileBlocked:0};
  const subscription={
    get terminalCode(){return terminalCode;},get queuedBytes(){return queuedBytes;},closed,metrics,
    attachTransport(hook){transportHook=hook;return()=>{transportHook=undefined;};},
    close(code='OPENCODE_STREAM_DISCONNECTED'){
      if(terminalCode)return closed;
      terminalCode=code;queue.length=0;queuedBytes=0;wake?.();
      Promise.resolve(transportHook?.terminate(code)).then(()=>transportHook?.closed).then(resolveClosed,resolveClosed);
      return closed;
    },
    publish(envelope){
      if(terminalCode)return;
      const size=Buffer.byteLength(`data: ${JSON.stringify(envelope)}\n\n`);
      if(queuedBytes+size+(transportHook?.bufferedBytes()??0)>1044480){void subscription.close('OPENCODE_SLOW_CONSUMER');return;}
      queuedBytes+=size;queue.push({envelope,size});wake?.();
    },
    events:{[Symbol.asyncIterator](){return {async next(){
      metrics.pulls++;if(metrics.blocked)metrics.pullsWhileBlocked++;
      while(!queue.length&&!terminalCode) await new Promise(r=>wake=r);
      if(terminalCode)return {done:true};
      const {envelope,size}=queue.shift();queuedBytes-=size;return {done:false,value:envelope};
    }};}},
  };
  subscription.publish({version:1,sessionId,source:'governed',event:{type:'bridge.ready',properties:{}}});
  return subscription;
}
function eventsRoute(subscription, extra={}) {
  return {method:'GET',path:'/opencode/session/events',requiredCapability:CAP,loopbackHostOnly:true,responseType:'sse',handler:async(_,request)=>request.selfTest?{stream:true}:subscription,...extra};
}
import { EventEmitter } from 'node:events';
function responseFixture() {
  const response=new EventEmitter();Object.assign(response,{headersSent:false,writableLength:0,destroyed:false,writableEnded:false,chunks:[],writes:0,heads:0,
    writeHead(status,headers){this.heads++;this.status=status;this.headers=headers;this.headersSent=true;},flushHeaders(){},
    write(chunk){this.writes++;this.chunks.push(chunk);return true;},
    end(chunk){if(chunk)this.chunks.push(chunk);this.writableEnded=true;queueMicrotask(()=>this.emit('close'));},
    destroy(){this.destroyed=true;queueMicrotask(()=>this.emit('close'));},
  });return response;
}
function liveEventsBoundary(t) {
  let subscribers=0, enabled=true;
  const child=new EventEmitter();
  child.kill=()=>{child.exitCode=0;child.emit('exit');};
  const password=secret();
  const header='Basic '+Buffer.from(`opencode:${password}`).toString('base64');
  const info={baseUrl:'http://127.0.0.1:45125',directory:'/fixture',auth:{username:'opencode',password,header},process:child};
  const client={createSession:async()=>({id:'A'}),listSessions:async()=>[{id:'A'}],supportsPromptMessageId:async()=>false,prompt:async()=>null,replyPermission:async()=>true,messages:async()=>[],abort:async()=>true,sessionDiff:async()=>[],rename:async()=>({id:'A'}),remove:async()=>true,archive:async()=>({id:'A'}),listAgents:async()=>[]};
  const inner=createOpenCodeBoundary({
    ensureServer:async()=>info,
    createClient:()=>client,
    fetchImpl:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}}),
    executionEnabled:async()=>enabled,
    forgetServer:async()=>{},
    log:()=>{},
  });
  t.after(()=>inner.dispose());
  return {
    run:(...a)=>inner.run(...a),
    validateEvents:(...a)=>inner.validateEvents(...a),
    openEvents:async(...a)=>{subscribers+=1;return inner.openEvents(...a);},
    revoke:(...a)=>inner.revoke(...a),
    dispose:(...a)=>inner.dispose(...a),
    get subscribers(){return subscribers;},
    setEnabled(value){enabled=value;},
  };
}
function liveEventsRoutes(boundary) {
  return createOpencodeSessionHostService(createOpencodeSessionHandlers({boundary})).opencodeSessionRoutes;
}
test('self-test events marker is JSON safe',async t=>{
  const boundary=liveEventsBoundary(t);
  await boundary.run('start',{});
  const bridgeToken=secret(),token=secret();
  const invoke=createBridgeRouteSelfTestInvoker({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},listenerPort:12345,routes:liveEventsRoutes(boundary)});
  const evaluated=await invoke({method:'GET',routePath:EVENTS,capabilityToken:token});
  const direct=await createOpencodeSessionHandlers({boundary}).executeOpenCodeSessionEvents({}, {
    url:EVENTS,selfTest:true,headers:{host:'127.0.0.1:12345'},rawHeaders:['Host','127.0.0.1:12345'],
    socket:{localPort:12345},openCodeTransport:{listenerPort:12345,getPublicPort:()=>undefined},
  });
  assert.deepEqual([evaluated, direct],[{status:200,payload:{stream:true}},{stream:true}]);
});
test('self-test never subscribes',async t=>{
  const boundary=liveEventsBoundary(t);
  await boundary.run('start',{});
  const bridgeToken=secret(),token=secret();
  const invoke=createBridgeRouteSelfTestInvoker({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},listenerPort:12345,routes:liveEventsRoutes(boundary)});
  const result=await invoke({method:'GET',routePath:EVENTS,capabilityToken:token});
  assert.deepEqual([result, boundary.subscribers],[{status:200,payload:{stream:true}},0]);
});
test('self-test validates boundary: registry',async t=>{
  const boundary=liveEventsBoundary(t);
  await boundary.run('start',{});
  const bridgeToken=secret(),token=secret();
  const invoke=createBridgeRouteSelfTestInvoker({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},listenerPort:12345,routes:liveEventsRoutes(boundary)});
  const result=await invoke({method:'GET',routePath:'/opencode/session/events?sessionId=missing',capabilityToken:token});
  assert.deepEqual([result.status,result.payload.code],[404,'OPENCODE_SESSION_UNKNOWN']);
});
test('self-test validates boundary: execution',async t=>{
  let enabled=true;
  const child=new EventEmitter();
  child.kill=()=>{child.exitCode=0;child.emit('exit');};
  const password=secret();
  const header='Basic '+Buffer.from(`opencode:${password}`).toString('base64');
  const info={baseUrl:'http://127.0.0.1:45125',directory:'/fixture',auth:{username:'opencode',password,header},process:child};
  const client={createSession:async()=>({id:'A'}),listSessions:async()=>[{id:'A'}],supportsPromptMessageId:async()=>false,prompt:async()=>null,replyPermission:async()=>true,messages:async()=>[],abort:async()=>true,sessionDiff:async()=>[],rename:async()=>({id:'A'}),remove:async()=>true,archive:async()=>({id:'A'}),listAgents:async()=>[]};
  const boundary=createOpenCodeBoundary({
    ensureServer:async()=>info,
    createClient:()=>client,
    fetchImpl:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}}),
    executionEnabled:async()=>enabled,
    forgetServer:async()=>{},
    log:()=>{},
  });
  t.after(()=>boundary.dispose());
  await boundary.run('start',{});
  enabled=false;
  const bridgeToken=secret(),token=secret();
  const route=eventsRoute(null,{handler:async(_,request)=>{
    await boundary.validateEvents('A');
    if(request.selfTest===true)return {stream:true};
    return boundary.openEvents('A');
  }});
  const invoke=createBridgeRouteSelfTestInvoker({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},listenerPort:12345,routes:[route]});
  const result=await invoke({method:'GET',routePath:EVENTS,capabilityToken:token});
  assert.deepEqual([result.status,result.payload.code],[403,'OPENCODE_EXECUTION_DISABLED']);
});
test('SSE transport sends envelopes not JSON wrapper',async()=>{
  const sub=subscriptionFixture(),response=responseFixture();
  const writing=transport.writeBridgeEventStream(response,{url:EVENTS,headers:{origin:ORIGIN}},sub,{extensionOrigin:ORIGIN});
  await new Promise(r=>setImmediate(r));await sub.close('OPENCODE_REVOKED');await writing;
  assert.deepEqual(JSON.parse(response.chunks[0].slice(6)),{version:1,sessionId:'A',source:'governed',event:{type:'bridge.ready',properties:{}}});
});
test('hijack path carries CORS',async()=>fixture(async f=>{
  const result=await new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port:f.port,path:EVENTS,headers:f.headers},res=>{resolve([res.statusCode,res.headers['access-control-allow-origin']]);res.destroy();});req.on('error',reject);
  });assert.deepEqual(result,[200,ORIGIN]);
},{routes:[eventsRoute(subscriptionFixture())]}));
test('SSE preflight never opens upstream',async()=>{
  let calls=0;await fixture(async f=>{const r=await f.request({method:'OPTIONS',path:EVENTS,headers:{[transport.bridgeTokenHeaderName]:undefined,[transport.bridgeCapabilityHeaderName]:undefined}});assert.deepEqual([r.status,calls],[204,0]);},{routes:[eventsRoute(null,{handler:async()=>{calls++;return subscriptionFixture();}})]});
});
test('open-prefix configuration cannot exempt events',async()=>fixture(async f=>{
  const control=await f.request();const r=await f.request({path:EVENTS,method:'GET',headers:{[transport.bridgeTokenHeaderName]:undefined}});
  assert.deepEqual([errorTuple(control),errorTuple(r)],[[200,null,ORIGIN],[401,'OPENCODE_BRIDGE_UNAUTHORIZED',ORIGIN]]);
},{openPathPrefixes:['/opencode']}));
test('throw-after-headers destroys without a second write',async()=>{
  const bridgeToken=secret(),token=secret(),response=responseFixture();
  const sub=subscriptionFixture();sub.events={[Symbol.asyncIterator](){return {next:async()=>{throw new Error('fixture failure');}};}};
  const handle=transport.createBridgeRequestHandler({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},routes:[eventsRoute(sub)]});
  const req=new EventEmitter();Object.assign(req,{method:'GET',url:EVENTS,headers:{host:'127.0.0.1:12345','x-resonantos-bridge-token':bridgeToken,'x-resonantos-bridge-capability-token':token},rawHeaders:['Host','127.0.0.1:12345'],socket:{localPort:12345},resume(){}});
  await handle(req,response);assert.deepEqual([response.destroyed,response.heads],[true,1]);
});
test('live SSE route bypasses writeJson',async()=>{
  const bridgeToken=secret(),token=secret(),response=responseFixture(),sub=subscriptionFixture();let jsonWrites=0;
  const original=response.writeHead;response.writeHead=function(status,headers){if(headers['Content-Type']==='application/json')jsonWrites++;original.call(this,status,headers);};
  const handle=transport.createBridgeRequestHandler({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},routes:[eventsRoute(sub)]});
  const req={method:'GET',url:EVENTS,headers:{host:'127.0.0.1:12345','x-resonantos-bridge-token':bridgeToken,'x-resonantos-bridge-capability-token':token},rawHeaders:['Host','127.0.0.1:12345'],socket:{localPort:12345}};
  const work=handle(req,response);await new Promise(r=>setImmediate(r));await sub.close();await work;assert.equal(jsonWrites,0);
});

test('real slow socket stops pulls until drain',async()=>{
  const sub=subscriptionFixture();
  await fixture(async f=>{
    let falseWrites=0,maxWritableLength=0;
    f.server.prependListener('request',(_,res)=>{
      const write=res.write.bind(res);
      res.write=(chunk,...args)=>{const result=write(chunk,...args);maxWritableLength=Math.max(maxWritableLength,res.writableLength);if(!result){falseWrites++;sub.metrics.blocked=true;}return result;};
      res.on('drain',()=>{sub.metrics.blocked=false;});res.on('close',()=>{sub.metrics.blocked=false;});
    });
    const socket=net.connect(f.port,'127.0.0.1');socket.pause();socket.on('error',()=>{});
    await new Promise(r=>socket.once('connect',r));socket.write(`GET ${EVENTS} HTTP/1.1\r\n${Object.entries(f.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    const envelope={version:1,sessionId:'A',source:'external',event:{type:'message.updated',properties:{text:'x'.repeat(32768)}}};
    const deadline=Date.now()+5000;
    while(!falseWrites&&Date.now()<deadline){sub.publish(envelope);await new Promise(r=>setImmediate(r));}
    // Publish synchronously while the writer is blocked; the fixture models bus overflow.
    for(let i=0;i<64;i++)sub.publish(envelope);
    await Promise.race([sub.closed,new Promise(r=>setTimeout(r,1200))]);socket.destroy();
    assert.deepEqual([falseWrites>0,sub.metrics.pullsWhileBlocked,maxWritableLength<=1048576,sub.terminalCode],[true,0,true,'OPENCODE_SLOW_CONSUMER']);
  },{routes:[eventsRoute(sub)]});
});
test('bridge shutdown closes idle SSE',async()=>{
  const sub=subscriptionFixture();await fixture(async f=>{
    const res=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:f.port,path:EVENTS,headers:f.headers},resolve);req.on('error',reject);});res.resume();
    const started=Date.now();const completed=await Promise.race([new Promise(r=>f.server.close(()=>r(true))),new Promise(r=>setTimeout(()=>r(false),1900))]);res.destroy();
    assert.equal(completed&&Date.now()-started<2000,true);
  },{routes:[eventsRoute(sub)]});
});
test('keep-alive agent issuing two refused POSTs',async()=>fixture(async f=>{
  let explicit=0;f.server.prependListener('request',(req,res)=>{let selected=false;const resume=req.resume.bind(req),end=res.end.bind(res);req.resume=()=>{selected=true;return resume();};res.end=(...args)=>{if(selected)explicit++;return end(...args);};});
  const body=JSON.stringify({padding:'x'.repeat(65522)});
  const control=await f.request({body});explicit=0;
  const agent=new http.Agent({keepAlive:true,maxSockets:1});
  try {
    const options={agent,body,headers:{[transport.bridgeCapabilityHeaderName]:secret()}};
    const a=await f.request(options);const start=Date.now();const b=await f.request(options);
    assert.deepEqual([errorTuple(control),[a.status,a.payload.code,b.status,b.payload.code,Date.now()-start<1000,explicit]],[[200,null,ORIGIN],[403,'OPENCODE_CAPABILITY_REQUIRED',403,'OPENCODE_CAPABILITY_REQUIRED',true,2]]);
  }finally{agent.destroy();}
}));
const failureMatrix=[['OPENCODE_BRIDGE_UNAUTHORIZED',401],['OPENCODE_CAPABILITY_REQUIRED',403],['OPENCODE_HOST_REJECTED',403],['OPENCODE_ROUTE_UNKNOWN',404],['OPENCODE_EXECUTION_DISABLED',403],['OPENCODE_UNAVAILABLE',503],['OPENCODE_SESSION_UNKNOWN',404],['OPENCODE_INVALID_REQUEST',400],['OPENCODE_UPSTREAM_AUTH',502],['OPENCODE_UPSTREAM_FAILED',502],['OPENCODE_PROTOCOL_ERROR',502],['OPENCODE_TIMEOUT',504],['OPENCODE_STREAM_DISCONNECTED',503],['OPENCODE_REVOKED',403],['OPENCODE_LIMIT',429],['OPENCODE_INTERNAL',500]];
test('refusal rows carry CORS',async()=>{
  let code;const actual=[],expected=[];
  await fixture(async f=>{for(const [next,status] of failureMatrix){code=undefined;const control=await f.request();code=next;const refused=await f.request();actual.push([errorTuple(control),errorTuple(refused)]);expected.push([[200,null,ORIGIN],[status,next,ORIGIN]]);}assert.deepEqual(actual,expected);},{routes:[{method:'POST',path:PATH,requiredCapability:CAP,loopbackHostOnly:true,handler:async()=>{if(code)throw new transport.OpenCodeBoundaryError(code);return {sessionId:'A'};}}]});
});
for(const boundary of ['handleBridgeRequest','evaluateBridgeRequestForSelfTest']) test(`secrets never reach extension bodies headers or raw logs: ${boundary}`,async()=>{
  const canary=secret();const logs=[];const original={log:console.log,warn:console.warn,error:console.error};
  for(const method of Object.keys(original))console[method]=(...args)=>logs.push(args.join(' '));
  try {
    const bridgeToken=secret(),token=secret();const route=eventsRoute(null,{handler:async()=>{throw new Error(canary);}});
    const headers={host:'127.0.0.1:12345','x-resonantos-bridge-token':bridgeToken,'x-resonantos-bridge-capability-token':token};
    let output;
    if(boundary==='evaluateBridgeRequestForSelfTest')output=await transport.evaluateBridgeRequestForSelfTest({method:'GET',url:EVENTS,headers,rawHeaders:['Host',headers.host],listenerPort:12345,bridgeToken,bridgeCapabilityTokens:{[CAP]:token},routes:[route]});
    else {const response=responseFixture();const req=new EventEmitter();Object.assign(req,{method:'GET',url:EVENTS,headers,rawHeaders:['Host',headers.host],socket:{localPort:12345},resume(){},readableEnded:true});await transport.createBridgeRequestHandler({bridgeToken,bridgeCapabilityTokens:{[CAP]:token},routes:[route]})(req,response);output={headers:response.headers,chunks:response.chunks};}
    assert.equal(JSON.stringify([output,logs]).includes(canary),false);
  }finally{Object.assign(console,original);}
});

import { createOpencodeSessionHostService, createOpencodeSessionHandlers } from '../host/opencode-session-host-service.mjs';
const expectedRouteCapabilities = {
  '/opencode/session/start':'addon-runtime-control','/opencode/session/prompt':'addon-runtime-control',
  '/opencode/session/permission':'addon-runtime-control','/opencode/session/stop':'addon-runtime-control',
  '/opencode/sessions/list':CAP,'/opencode/session/messages':CAP,'/opencode/session/abort':'addon-runtime-control',
  '/opencode/session/diff':CAP,'/opencode/session/rename':'addon-runtime-control','/opencode/session/delete':'addon-runtime-control',
  '/opencode/session/archive':'addon-runtime-control','/opencode/agents/list':CAP,'/opencode/session/events':CAP,
};
const boundaryFixture = () => ({run:async()=>({sessionId:'A'}),validateEvents:async()=>{},openEvents:async()=>subscriptionFixture(),revoke:async()=>{},dispose:async()=>{}});
test('all OpenCode routes require declared capabilities',()=>{
  const routes=createOpencodeSessionHostService(createOpencodeSessionHandlers({boundary:boundaryFixture()})).opencodeSessionRoutes;
  assert.deepEqual(Object.fromEntries(routes.map(r=>[r.path,r.requiredCapability])),expectedRouteCapabilities);
});
for (const [kind,query] of [['none',''],['empty','?sessionId='],['duplicate','?sessionId=A&sessionId=B'],['extra-url','?sessionId=A&url=http://example.invalid']]) test(`events requires one sessionId: ${kind}`,async()=>{
  const routes=createOpencodeSessionHostService(createOpencodeSessionHandlers({boundary:boundaryFixture()})).opencodeSessionRoutes;
  await fixture(async f=>{
    const control=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:f.port,path:EVENTS,headers:f.headers},res=>{resolve({status:res.statusCode,payload:{},origin:res.headers['access-control-allow-origin']});res.destroy();});req.on('error',reject);});
    const refused=await f.request({method:'GET',path:'/opencode/session/events'+query,body:''});
    assert.deepEqual([errorTuple(control),errorTuple(refused)],[[200,null,ORIGIN],[400,'OPENCODE_INVALID_REQUEST',ORIGIN]]);
  },{routes});
});

// Supplement real-socket cases with deterministic checks; these are not socket proof.
for(const [kind,host,target,raw] of [
  ['valid','LOCALHOST:12345',PATH],['evil','evil.example:12345',PATH],['missing',undefined,PATH],
  ['duplicate','127.0.0.1:12345',PATH,['Host','127.0.0.1:12345','Host','127.0.0.1:12345']],
  ['absolute','127.0.0.1:12345','http://127.0.0.1:12345'+PATH],['port','127.0.0.1:012345',PATH],
]) test(`in-process Host guard: ${kind}`,()=>{
  assert.equal(transport.validateLoopbackHost({url:target,headers:{host},rawHeaders:raw??(host?['Host',host]:[]),selfTest:true},{listenerPort:12345}),kind==='valid');
});
test('in-process writer never pulls while backpressured',async()=>{
  const sub=subscriptionFixture(),response=responseFixture();let falseWrites=0;
  response.write=function(chunk){this.chunks.push(chunk);this.writes++;if(this.writes===1){sub.metrics.blocked=true;falseWrites++;return false;}return true;};
  const writing=transport.writeBridgeEventStream(response,{url:EVENTS,headers:{}},sub,{});
  await new Promise(r=>setImmediate(r));sub.publish({version:1,sessionId:'A',source:'external',event:{type:'message.updated',properties:{text:'queued'}}});
  await new Promise(r=>setImmediate(r));await sub.close('OPENCODE_REVOKED');await writing;
  assert.deepEqual([falseWrites,sub.metrics.pullsWhileBlocked,response.writes,response.destroyed],[1,0,1,true]);
});

test('listener-port Host succeeds',async()=>fixture(async f=>{assert.deepEqual(errorTuple(await f.request()),[200,null,ORIGIN]);}));

test('in-process refused incomplete body retains cleanup deadline',async()=>{
  const req=new EventEmitter(),response=responseFixture(),bridgeToken=secret();let destroyed=false;
  Object.assign(req,{method:'POST',url:PATH,headers:{'x-resonantos-bridge-token':bridgeToken},socket:{localPort:12345},resume(){},destroy(){destroyed=true;this.destroyed=true;this.emit('end');}});
  await transport.createBridgeRequestHandler({bridgeToken,routes:[{method:'POST',path:PATH,requiredCapability:CAP,loopbackHostOnly:true,handler:async()=>({})}]})(req,response);
  await new Promise(r=>setTimeout(r,1050));assert.equal(destroyed,true);
});
