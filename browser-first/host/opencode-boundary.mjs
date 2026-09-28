// Credential custody and generation ownership for the allowlisted OpenCode proxy.
import { randomBytes } from 'node:crypto';
import { createOpenCodeEventBus, eventSessionId } from './opencode-event-bus.mjs';

const ERROR_TEXT = 'OpenCode boundary request failed.';
const STATUSES = Object.freeze({
  OPENCODE_BRIDGE_UNAUTHORIZED:401, OPENCODE_CAPABILITY_REQUIRED:403, OPENCODE_HOST_REJECTED:403,
  OPENCODE_EXECUTION_DISABLED:403, OPENCODE_REVOKED:403, OPENCODE_UNAVAILABLE:503,
  OPENCODE_SESSION_UNKNOWN:404, OPENCODE_ROUTE_UNKNOWN:404, OPENCODE_INVALID_REQUEST:400,
  OPENCODE_UPSTREAM_AUTH:502, OPENCODE_UPSTREAM_FAILED:502, OPENCODE_PROTOCOL_ERROR:502,
  OPENCODE_TIMEOUT:504, OPENCODE_STREAM_DISCONNECTED:503, OPENCODE_SLOW_CONSUMER:503,
  OPENCODE_LIMIT:429, OPENCODE_INTERNAL:500
});
export function publicOpenCodeError(code) {
  const safe = Object.hasOwn(STATUSES, code) ? code : 'OPENCODE_INTERNAL';
  return { status: STATUSES[safe], payload: { ok:false, code:safe, error:ERROR_TEXT } };
}
export class OpenCodeBoundaryError extends Error {
  constructor(code, _status) { const safe=publicOpenCodeError(code); super(ERROR_TEXT); this.name='OpenCodeBoundaryError'; this.code=safe.payload.code; this.status=safe.status; }
}
const fail = code => new OpenCodeBoundaryError(code);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = v => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 256;
const blockedKey = /(?:auth|credential|password|passwd|secret|cookie)|^(?:username|authorization|eventAuthorization|eventUrl|baseUrl|url|headers?|cookies?|set-cookie|password|passwd|secret|credentials?|tokens?|api[-_]?key|access[-_]?token|refresh[-_]?token|source|__proto__|prototype|constructor)$/i;
export function sanitizeOpenCodePayload(value, forbiddenValues = []) {
  const patterns = new Set();
  for (const value of forbiddenValues) {
    if (typeof value !== 'string' || !value) continue;
    for (const variant of [value, encodeURIComponent(value), encodeURI(value), JSON.stringify(value).slice(1,-1), value.replace(/\//g,'\\/'),
      [...value].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')]) {
      patterns.add(variant);
      if (variant.includes('%')) patterns.add(variant.replace(/%[A-F0-9]{2}/g,m=>m.toLowerCase()));
    }
  }
  const ordered=[...patterns].sort((a,b)=>b.length-a.length);
  const redact = text => { for (const pattern of ordered) text=text.split(pattern).join('[redacted]'); return text; };
  const seen=new Set();
  function walk(v,depth=0) {
    if (depth>64) throw fail('OPENCODE_PROTOCOL_ERROR');
    if (typeof v==='string') return redact(v);
    if (v===null || typeof v==='boolean' || (typeof v==='number' && Number.isFinite(v))) return v;
    if (!v || typeof v!=='object' || seen.has(v)) throw fail('OPENCODE_PROTOCOL_ERROR');
    seen.add(v);
    let result;
    if (Array.isArray(v)) result=v.map(x=>walk(x,depth+1));
    else { result={}; for (const [key,x] of Object.entries(v)) if (!blockedKey.test(key) && x!==undefined) { const safeKey=redact(key); if (!blockedKey.test(safeKey)) Object.defineProperty(result,safeKey,{value:walk(x,depth+1),enumerable:true,writable:true,configurable:true}); } }
    seen.delete(v); return result;
  }
  return walk(value);
}
function classify(error) {
  if (error instanceof OpenCodeBoundaryError) return error;
  if (Object.hasOwn(STATUSES,error?.code)) return fail(error.code);
  if (error?.status===401 || error?.status===403) return fail('OPENCODE_UPSTREAM_AUTH');
  if (error?.status>=300) return fail('OPENCODE_UPSTREAM_FAILED');
  if (error?.name==='TimeoutError' || error?.code==='ETIMEDOUT') return fail('OPENCODE_TIMEOUT');
  if (['ECONNRESET','ECONNREFUSED','EPIPE','ENOTFOUND'].includes(error?.code)) return fail('OPENCODE_UPSTREAM_FAILED');
  return fail('OPENCODE_INTERNAL');
}
const requestKeys = Object.freeze({start:['title'],list:[],agents:[],stop:[],web:[],prompt:['sessionId','text','agent','model'],permission:['sessionId','permissionId','decision'],messages:['sessionId'],abort:['sessionId'],diff:['sessionId'],rename:['sessionId','title'],delete:['sessionId'],archive:['sessionId','archived']});
const scoped = new Set(['prompt','permission','messages','abort','diff','rename','delete','archive']);
function validateRequest(operation,payload) {
  if (!Object.hasOwn(requestKeys,operation)) throw fail('OPENCODE_ROUTE_UNKNOWN');
  if (!object(payload) || Object.keys(payload).some(k=>!requestKeys[operation].includes(k))) throw fail('OPENCODE_INVALID_REQUEST');
  if (scoped.has(operation) && !validId(payload.sessionId)) throw fail('OPENCODE_INVALID_REQUEST');
  for (const key of ['title','text','agent','model']) if (payload[key]!==undefined && (typeof payload[key]!=='string' || !payload[key].trim())) throw fail('OPENCODE_INVALID_REQUEST');
  if (operation==='prompt' && typeof payload.text!=='string') throw fail('OPENCODE_INVALID_REQUEST');
  if (operation==='rename' && typeof payload.title!=='string') throw fail('OPENCODE_INVALID_REQUEST');
  if (payload.archived!==undefined && (!Number.isFinite(payload.archived) || payload.archived<0)) throw fail('OPENCODE_INVALID_REQUEST');
  if (operation==='permission' && (!validId(payload.permissionId) || !object(payload.decision) || Object.keys(payload.decision).some(k=>!['approved','remember'].includes(k)) || typeof payload.decision.approved!=='boolean' || (payload.decision.remember!==undefined && typeof payload.decision.remember!=='boolean'))) throw fail('OPENCODE_INVALID_REQUEST');
  if (Buffer.byteLength(JSON.stringify(payload))>1048576) throw fail('OPENCODE_INVALID_REQUEST');
}
function sessionShape(raw) {
  if (!object(raw)) throw fail('OPENCODE_PROTOCOL_ERROR');
  const id=raw.id ?? raw.sessionID ?? raw.sessionId;
  if (!validId(id) || [raw.id,raw.sessionID,raw.sessionId].some(v=>v!==undefined && v!==id) || (raw.title!==undefined && typeof raw.title!=='string')) throw fail('OPENCODE_PROTOCOL_ERROR');
  const created=raw.time?.created ?? raw.created ?? 0, updated=raw.time?.updated ?? raw.updated ?? created;
  if (!Number.isFinite(created) || !Number.isFinite(updated)) throw fail('OPENCODE_PROTOCOL_ERROR');
  return {id,title:raw.title ?? '',created,updated};
}
export function createOpenCodeBoundary({ ensureServer, createClient, fetchImpl, executionEnabled, forgetServer, log } = {}) {
  for (const dep of [ensureServer,createClient,fetchImpl,executionEnabled,forgetServer,log]) if (typeof dep!=='function') throw new TypeError('OpenCode boundary dependencies required.');
  let generation=0, disabledLatch=false, disposed=false, active=null;
  const cleanups=new Set(), pendingBootstraps=new Set();
  const current = ctx => active===ctx && generation===ctx.generation && !ctx.controller.signal.aborted && !disposed;
  const check = ctx => { if (!current(ctx)) throw fail(ctx.code ?? 'OPENCODE_REVOKED'); };
  const record = (code,operation) => { try { log({code,operation}); } catch {} };
  async function enabled() { try { return await executionEnabled()===true; } catch { return false; } }
  function track(promise) { cleanups.add(promise); promise.finally(()=>cleanups.delete(promise)).catch(()=>{}); return promise; }
  function killOwned(info) {
    const child=info?.process;
    if (!child) return Promise.resolve();
    return new Promise(resolve=>{
      let timer,settled=false;
      const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);child.removeListener?.('exit',finish);resolve();};
      if (child.exitCode!=null || child.signalCode!=null) { finish(); return; }
      child.once?.('exit',finish);
      timer=setTimeout(()=>{if(!settled && child.exitCode==null && child.signalCode==null)try{child.kill?.('SIGKILL');}catch{}finish();},1000);timer.unref?.();
      try { child.kill?.('SIGTERM'); } catch { finish(); }
    });
  }
  function cleanupInfo(info) {
    return track(Promise.allSettled([killOwned(info), Promise.resolve().then(()=>forgetServer(info))]).then(()=>{}));
  }
  function retire(ctx,code,latch=true) {
    if (latch) disabledLatch=true;
    if (!ctx || active!==ctx) return Promise.resolve();
    // No await before the generation fence, request abort, or subscriber close.
    generation++; active=null; ctx.code=code; ctx.controller.abort(); clearInterval(ctx.monitor);
    ctx.info?.process?.removeListener?.('exit',ctx.onExit);
    const streamClose=ctx.bus?.close(code) ?? Promise.resolve();
    ctx.registry.clear();
    return track(Promise.allSettled([streamClose,ctx.info?cleanupInfo(ctx.info):Promise.resolve()]).then(()=>{}));
  }
  function revoke(code='OPENCODE_REVOKED') {
    disabledLatch=true;
    if (!active) { generation++; return Promise.resolve(); }
    return retire(active,publicOpenCodeError(code).payload.code);
  }
  async function gate(ctx, rearm=false) {
    const observed=generation;
    const allowed=await enabled();
    if (observed!==generation) throw fail(ctx?.code ?? 'OPENCODE_REVOKED');
    if (!allowed || disposed) { await revoke(); throw fail('OPENCODE_EXECUTION_DISABLED'); }
    if (ctx) check(ctx);
    if (disabledLatch && !rearm) throw fail('OPENCODE_EXECUTION_DISABLED');
  }
  async function guarded(ctx,fn) {
    check(ctx);
    let rejectAbort;
    const canceled=new Promise((_,reject)=>{rejectAbort=()=>reject(fail(ctx.code ?? 'OPENCODE_REVOKED'));ctx.controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    try { const result=await Promise.race([Promise.resolve().then(fn),canceled]);check(ctx);await gate(ctx);check(ctx);return result; }
    finally { ctx.controller.signal.removeEventListener('abort',rejectAbort); }
  }
  function createGeneration() {
    const ctx={generation:generation,controller:new AbortController(),registry:new Map(),info:null,client:null,bus:null,serverPromise:null,code:null,startSlots:0};
    active=ctx;disabledLatch=false;
    let checking=false;
    ctx.monitor=setInterval(()=>{if(checking || !current(ctx))return;checking=true;void enabled().then(value=>{if(current(ctx) && !value)return retire(ctx,'OPENCODE_REVOKED');}).finally(()=>{checking=false;});},250);ctx.monitor.unref?.();
    const predecessors=[...pendingBootstraps];
    ctx.serverPromise=(async()=>{
      let info;
      try {
        await Promise.allSettled(predecessors);check(ctx);
        info=await ensureServer();
        if (!current(ctx)) { await cleanupInfo(info); throw fail(ctx.code ?? 'OPENCODE_REVOKED'); }
        ctx.info=info;
        if(info?.process?.exitCode!=null || info?.process?.signalCode!=null)throw fail('OPENCODE_UNAVAILABLE');
        ctx.onExit=()=>{if(current(ctx))void retire(ctx,'OPENCODE_UNAVAILABLE',false);};info?.process?.once?.('exit',ctx.onExit);
        await gate(ctx);check(ctx);
        let origin;
        try { origin=new URL(info?.baseUrl); } catch { throw fail('OPENCODE_UNAVAILABLE'); }
        if (origin.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash || !origin.port || typeof info.directory!=='string' || !info.directory) throw fail('OPENCODE_UNAVAILABLE');
        const auth=info.auth;
        if (!auth || typeof auth.password!=='string' || !auth.password || typeof auth.username!=='string' || !auth.username || auth.header!=='Basic '+Buffer.from(`${auth.username}:${auth.password}`).toString('base64')) throw fail('OPENCODE_UPSTREAM_AUTH');
        const forbidden=[auth.password,auth.header,auth.header.slice(6),origin.origin];
        ctx.sanitize=value=>sanitizeOpenCodePayload(value,forbidden);
        // Preserve the established two-argument client factory; credentials remain host-owned.
        ctx.client=createClient(info.baseUrl,{directory:info.directory,headers:{Authorization:auth.header},signal:ctx.controller.signal});
        ctx.bus=createOpenCodeEventBus({generation:ctx.generation,sessionRegistry:ctx.registry,isCurrent:()=>current(ctx),sanitize:ctx.sanitize,
          connect:({signal})=>{check(ctx);const url=new URL('/event',origin);url.searchParams.set('directory',info.directory);return fetchImpl(url.toString(),{method:'GET',headers:{Authorization:auth.header,Accept:'text/event-stream'},redirect:'error',signal:AbortSignal.any([signal,ctx.controller.signal])});},
          onFatal:code=>current(ctx)?retire(ctx,code,false):undefined});
        await ctx.bus.start();check(ctx);await gate(ctx);return ctx;
      } catch (error) { const safe=ctx.code?fail(ctx.code):classify(error); if(current(ctx))await retire(ctx,safe.code,false);throw safe; }
    })();
    pendingBootstraps.add(ctx.serverPromise);
    ctx.serverPromise.finally(()=>pendingBootstraps.delete(ctx.serverPromise)).catch(()=>{});
    return ctx;
  }
  function registered(ctx,id) { if (!ctx.registry.has(id) || ctx.registry.get(id).generation!==ctx.generation) throw fail('OPENCODE_SESSION_UNKNOWN'); }
  function register(ctx,id) { check(ctx);if(ctx.sanitize(id)!==id)throw fail('OPENCODE_PROTOCOL_ERROR');if(!ctx.registry.has(id))ctx.registry.set(id,{generation:ctx.generation,subscribers:new Set(),messageSources:new Map(),permissions:new Set()}); }
  async function run(operation,payload={}) {
    let ctx=active;
    try {
      validateRequest(operation,payload);
      await gate(ctx,operation==='start'||operation==='list');
      if (operation==='web') { record('OPENCODE_HANDOFF_REFUSED','web');return {url:'',requiresCredential:true}; }
      if (operation==='stop') { if(ctx)await retire(ctx,'OPENCODE_UNAVAILABLE',false);return {ok:true}; }
      if (!ctx) {
        if (operation!=='start' && operation!=='list') throw fail('OPENCODE_UNAVAILABLE');
        ctx=active ?? createGeneration();
      }
      await guarded(ctx,()=>ctx.serverPromise);
      const id=payload.sessionId;
      if(scoped.has(operation))registered(ctx,id);
      let result;
      switch(operation) {
        case 'start': {
          if(ctx.registry.size+ctx.startSlots>=1000)throw fail('OPENCODE_LIMIT');
          ctx.startSlots++;
          try { const raw=await guarded(ctx,()=>ctx.client.createSession(payload.title));const session=sessionShape(raw);if(raw.time?.archived)throw fail('OPENCODE_PROTOCOL_ERROR');register(ctx,session.id);result={ok:true,sessionId:session.id}; }
          finally {ctx.startSlots--;}
          break;
        }
        case 'list': {
          const raw=await guarded(ctx,()=>ctx.client.listSessions());
          if(!Array.isArray(raw))throw fail('OPENCODE_PROTOCOL_ERROR');
          const sessions=raw.filter(s=>!s?.time?.archived).map(sessionShape),ids=new Set(sessions.map(s=>s.id));
          if(ids.size!==sessions.length)throw fail('OPENCODE_PROTOCOL_ERROR');
          if(sessions.length+ctx.startSlots>1000)throw fail('OPENCODE_LIMIT');
          for(const old of ctx.registry.keys())if(!ids.has(old)){await guarded(ctx,()=>ctx.bus.removeSession(old));}
          for(const session of sessions)register(ctx,session.id);
          result={ok:true,sessions:ctx.sanitize(sessions)};break;
        }
        case 'prompt': {
          const supported=await guarded(ctx,()=>ctx.client.supportsPromptMessageId());
          const messageID='msg_'+randomBytes(16).toString('hex');
          ctx.bus.beginPrompt(id,messageID,supported===true);
          try { await guarded(ctx,()=>ctx.client.prompt(id,payload.text,{model:payload.model,agent:payload.agent,...(supported===true?{messageID}:{})}));ctx.bus.finishPrompt(id,messageID,true); }
          catch(error){ctx.bus.finishPrompt(id,messageID,false);throw error;}
          result={ok:true};break;
        }
        case 'permission':
          if(!ctx.registry.get(id).permissions.has(payload.permissionId))throw fail('OPENCODE_SESSION_UNKNOWN');
          await guarded(ctx,()=>ctx.client.replyPermission(id,payload.permissionId,payload.decision));ctx.registry.get(id).permissions.delete(payload.permissionId);result={ok:true};break;
        case 'messages': {
          const messages=await guarded(ctx,()=>ctx.client.messages(id));
          if(!Array.isArray(messages))throw fail('OPENCODE_PROTOCOL_ERROR');
          for(const item of messages){
            if(!object(item) || !object(item.info) || !Array.isArray(item.parts) || eventSessionId({type:'message.updated',properties:item})!==id)throw fail('OPENCODE_PROTOCOL_ERROR');
            ctx.bus.observeMessage(id,item.info);
            for(const part of item.parts){if(part.messageID!==item.info.id)throw fail('OPENCODE_PROTOCOL_ERROR');ctx.bus.observePart(id,part);}
          }
          result={ok:true,sessionId:id,messages:messages.map(item=>({info:ctx.sanitize(item.info),parts:ctx.sanitize(item.parts),source:ctx.bus.messageSource(id,item.info.id)}))};break;
        }
        case 'diff': {const diff=await guarded(ctx,()=>ctx.client.sessionDiff(id,{}));result={ok:true,sessionId:id,diff:ctx.bus.attributeDiff(id,diff)};break;}
        case 'agents': {const agents=await guarded(ctx,()=>ctx.client.listAgents());if(!Array.isArray(agents)||agents.some(a=>!object(a)||typeof a.name!=='string'))throw fail('OPENCODE_PROTOCOL_ERROR');result={ok:true,agents:agents.map(a=>ctx.sanitize({name:a.name,description:a.description,mode:a.mode,model:a.model,hidden:a.hidden}))};break;}
        case 'abort':await guarded(ctx,()=>ctx.client.abort(id));result={ok:true};break;
        case 'rename':case 'archive': {
          const raw=await guarded(ctx,()=>operation==='rename'?ctx.client.rename(id,payload.title.trim()):ctx.client.archive(id,payload.archived));
          const session=sessionShape(raw);if(session.id!==id)throw fail('OPENCODE_PROTOCOL_ERROR');result={ok:true,session:ctx.sanitize(session)};
          if(operation==='archive')await guarded(ctx,()=>ctx.bus.removeSession(id));break;
        }
        case 'delete': {const deleted=await guarded(ctx,()=>ctx.client.remove(id));if(typeof deleted!=='boolean')throw fail('OPENCODE_PROTOCOL_ERROR');result={ok:true,deleted};if(deleted)await guarded(ctx,()=>ctx.bus.removeSession(id));break;}
      }
      check(ctx);await gate(ctx);check(ctx);
      if(scoped.has(operation) && ctx.registry.has(id))ctx.bus.receipt(id,operation);
      return result;
    } catch(error) {
      const safe=ctx?.code?fail(ctx.code):classify(error);
      if(ctx && current(ctx) && ['OPENCODE_UPSTREAM_AUTH','OPENCODE_UPSTREAM_FAILED','OPENCODE_PROTOCOL_ERROR','OPENCODE_TIMEOUT','OPENCODE_INTERNAL'].includes(safe.code))await retire(ctx,safe.code,false);
      record(safe.code,Object.hasOwn(requestKeys,operation)?operation:'unknown');throw safe;
    }
  }
  async function validateEvents(id) {
    if(!validId(id))throw fail('OPENCODE_INVALID_REQUEST');
    const ctx=active;await gate(ctx);
    if(!ctx || !ctx.client || !ctx.bus)throw fail('OPENCODE_UNAVAILABLE');
    check(ctx);registered(ctx,id);
    if(ctx.bus.terminalCode)throw fail(ctx.bus.terminalCode);
  }
  async function openEvents(id) {const ctx=active;await validateEvents(id);check(ctx);return ctx.bus.subscribe(id);}
  async function dispose() {disposed=true;await revoke();await Promise.allSettled([...pendingBootstraps]);await Promise.allSettled([...cleanups]);}
  return {run,validateEvents,openEvents,revoke,dispose};
}
