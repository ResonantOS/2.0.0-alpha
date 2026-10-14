import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openEmbedGovernanceStorage } from './embed-governance-storage.mjs';
import { LIMITS, UUID, NOTICE_KEY, metadata, exact, validDescriptor, activityError } from '../../src/core/embed-governance-contract.js';
const bytes=v=>Buffer.byteLength(JSON.stringify(v)+'\n');
const fresh=()=>({version:1,recordingEnabled:false,writeEpoch:randomUUID(),notices:{},events:[]});
function validRecord(v) {
  return exact(v,['version','eventId','recordedAt','harnessId','interfaceId','governance','source','event'])&&v.version===1&&typeof v.eventId==='string'&&UUID.test(v.eventId)&&typeof v.recordedAt==='string'&&Number.isFinite(Date.parse(v.recordedAt))&&new Date(v.recordedAt).toISOString()===v.recordedAt&&v.harnessId==='addon.augmentor-embed'&&v.interfaceId==='panel'&&v.governance==='self-governed'&&metadata(v.event)!==null&&v.source===(v.event.kind==='page-shared'?'local-share':'harness-report')&&bytes(v)<=LIMITS.record;
}
function parseState(raw) {
  if(raw===null) return fresh();
  if(Buffer.byteLength(raw)>LIMITS.state) throw activityError('storage-unavailable');
  const v=JSON.parse(raw);
  if(!exact(v,['version','recordingEnabled','writeEpoch','notices','events'])||v.version!==1||typeof v.recordingEnabled!=='boolean'||typeof v.writeEpoch!=='string'||!UUID.test(v.writeEpoch)||!v.notices||typeof v.notices!=='object'||Array.isArray(v.notices)||Object.entries(v.notices).some(([k,n])=>!NOTICE_KEY.test(k)||n!==1)||!Array.isArray(v.events)||v.events.length>LIMITS.records||v.events.some(e=>!validRecord(e))||new Set(v.events.map(e=>e.eventId)).size!==v.events.length) throw activityError('storage-unavailable');
  return v;
}
export async function createEmbedGovernanceHostService({userRoot,repoRoot=resolve(import.meta.dirname,'../..'),getDescriptor=()=>null,now=Date.now,storageFactory=openEmbedGovernanceStorage,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval}={}) {
  let storage=null,state=null,problem=null,retentionPending=false,closed=false,tail=Promise.resolve(),diskRaw=undefined;
  const descriptor=()=>{try{const d=getDescriptor();return validDescriptor(d)?d:null;}catch{return null;}};
  const serialize=work=>{const result=tail.then(()=>{if(closed)throw activityError('storage-unavailable');return work();});tail=result.catch(()=>{});return result;};
  async function save(next) {
    if(!storage||bytes(next)>LIMITS.state) throw activityError('storage-unavailable');
    parseState(JSON.stringify(next));
    try {const raw=JSON.stringify(next)+'\n';await storage.write(raw);diskRaw=raw;state=next;retentionPending=false;problem=null;}
    catch {throw activityError('storage-unavailable');}
  }
  async function readDisk() {
    if(!storage){state=null;problem='storage-unavailable';return;}
    try {
      // This read repeats the storage layer's path, owner and mode checks on every operation.
      const raw=await storage.read();
      if(raw!==diskRaw||state===null){const next=parseState(raw);diskRaw=raw;state=next;retentionPending=false;problem=null;}
    }catch{state=null;problem='storage-unavailable';}
  }
  async function prune() {
    await readDisk();
    if(!state) return;
    const events=state.events.filter(e=>Date.parse(e.recordedAt)>now()-LIMITS.retention);
    if(events.length!==state.events.length||retentionPending) {
      // A failed durable rewrite must still exclude expired rows from reads.
      state={...state,events};retentionPending=true;
      try{await save(state);}catch{problem='retention-failed';}
    }
    if(problem==='log-full'&&events.length<LIMITS.records&&bytes(state)<LIMITS.state- LIMITS.record) problem=null;
  }
  try {storage=await storageFactory({userRoot,repoRoot});await prune();}
  catch {problem='storage-unavailable';state=null;}
  function fullFromState() {
    if(!state)return false;
    if(state.events.length>=LIMITS.records)return true;
    // Test the smallest legal records, including JSON array separator and final newline.
    const base={version:1,eventId:'00000000-0000-4000-8000-000000000000',recordedAt:'2000-01-01T00:00:00.000Z',harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed'};
    const candidates=[{...base,source:'harness-report',event:{kind:'reply-started'}},{...base,source:'local-share',event:{kind:'page-shared',domain:'a'}}];
    return candidates.every(record=>bytes({...state,events:[...state.events,record]})>LIMITS.state);
  }
  function snapshot() {
    const currentProblem=problem??(fullFromState()?'log-full':null);
    const d=descriptor();return {recordingEnabled:state?.recordingEnabled??false,writeEpoch:state?.writeEpoch??null,noticeKey:d?.noticeKey??null,noticeVersion:1,noticeAcknowledged:!!(d&&state?.notices[d.noticeKey]===1),available:!!d,problem:currentProblem};
  }
  function requireState(){if(!state||!storage||retentionPending)throw activityError('storage-unavailable');}
  function query(request,paged=false) {
    let u;try{u=new URL(request?.url,'http://127.0.0.1');}catch{throw activityError('invalid-request');}
    const keys=[...u.searchParams.keys()];
    if(keys.length>(paged?1:0)||keys.some(k=>k!=='before')||keys.length&&(!paged||!UUID.test(u.searchParams.get('before')))) throw activityError('invalid-request');
    return u.searchParams.get('before');
  }
  const routes=[
    ['GET','state','addon-runtime-read',0,async()=>snapshot()],
    ['POST','recording','embed-governance-consent-write',512,async p=>{
      if(!exact(p,['enabled'])||typeof p.enabled!=='boolean')throw activityError('invalid-request');
      requireState();if(p.enabled&&!descriptor())throw activityError('storage-unavailable');
      if(p.enabled!==state.recordingEnabled)await save({...state,recordingEnabled:p.enabled,writeEpoch:randomUUID()});
      return {recordingEnabled:state.recordingEnabled,writeEpoch:state.writeEpoch};
    }],
    ['POST','notice','embed-governance-consent-write',512,async p=>{
      if(!exact(p,['noticeKey','version'])||p.version!==1||typeof p.noticeKey!=='string'||!NOTICE_KEY.test(p.noticeKey))throw activityError('invalid-request');
      const d=descriptor();if(!d)throw activityError('storage-unavailable');if(p.noticeKey!==d.noticeKey)throw activityError('invalid-request');
      requireState();if(state.notices[d.noticeKey]!==1)await save({...state,notices:{...state.notices,[d.noticeKey]:1}});
      return {noticeKey:d.noticeKey,noticeAcknowledged:true};
    }],
    ['POST','events','addon-record-write',2048,async p=>{
      if(!exact(p,['writeEpoch','eventId','event'])||typeof p.writeEpoch!=='string'||!UUID.test(p.writeEpoch)||typeof p.eventId!=='string'||!UUID.test(p.eventId)||!metadata(p.event))throw activityError('invalid-request');
      requireState();const d=descriptor();let reason=null;
      if(!d)reason='unavailable';else if(p.writeEpoch!==state.writeEpoch)reason='stale-epoch';else if(!state.recordingEnabled)reason='disabled';else if(state.events.some(e=>e.eventId===p.eventId))reason='duplicate';
      if(reason)return {recorded:false,reason};
      const record={version:1,eventId:p.eventId,recordedAt:new Date(now()).toISOString(),harnessId:d.harnessId,interfaceId:d.interfaceId,governance:d.governance,source:p.event.kind==='page-shared'?'local-share':'harness-report',event:metadata(p.event)};
      if(bytes(record)>LIMITS.record)throw activityError('invalid-request');
      const next={...state,events:[...state.events,record]};
      if(next.events.length>LIMITS.records||bytes(next)>LIMITS.state){problem='log-full';return {recorded:false,reason:'full'};}
      await save(next);return {recorded:true,reason:null};
    }],
    ['GET','events','addon-record-read',0,async(_p,request)=>{
      if(!state)throw activityError('storage-unavailable');const before=query(request,true);
      let end=state.events.length;if(before){end=state.events.findIndex(e=>e.eventId===before);if(end<0)throw activityError('cursor-expired');}
      const events=state.events.slice(Math.max(0,end-LIMITS.page),end).reverse();
      return {events:structuredClone(events),nextBefore:end>LIMITS.page?events.at(-1).eventId:null};
    }],
    ['POST','events/delete','addon-record-write',512,async p=>{
      if(!exact(p,[]))throw activityError('invalid-request');
      if(!storage)throw activityError('storage-unavailable');
      await save(state?{...state,events:[],writeEpoch:randomUUID()}:fresh());
      const s=snapshot();return {deleted:true,writeEpoch:s.writeEpoch,recordingEnabled:s.recordingEnabled,noticeKey:s.noticeKey,noticeAcknowledged:s.noticeAcknowledged};
    }]
  ];
  const governanceRoutes=routes.map(([method,name,requiredCapability,maxBodyBytes,operation])=>({
    method,path:'/embed-governance/'+name,requiredCapability,maxBodyBytes,loopbackHostOnly:true,requiredOrigin:'extension',errorFamily:'embed-governance',
    handler:(payload,request)=>serialize(async()=>{
      query(request,method==='GET'&&name==='events');await prune();
      return operation(payload,request);
    })
  }));
  const timer=setIntervalImpl(()=>serialize(prune).catch(()=>{}),LIMITS.prune);timer.unref?.();
  return {governanceRoutes,async close(){if(closed)return;closed=true;clearIntervalImpl(timer);await tail;await storage?.close();}};
}
