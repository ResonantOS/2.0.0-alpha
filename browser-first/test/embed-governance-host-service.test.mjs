import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';
const descriptor={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
async function fixture(t,options={}) {
  const userRoot=await mkdtemp(join(await realpath(tmpdir()),'embed-service-'));
  let now=Date.UTC(2026,9,13),tick;
  const make=()=>createEmbedGovernanceHostService({userRoot,getDescriptor:()=>descriptor,now:()=>now,setIntervalImpl:fn=>{tick=fn;return {unref(){}};},clearIntervalImpl(){},...options});
  const s=await make();
  t.after(async()=>{await s.close();await rm(userRoot,{recursive:true,force:true});});
  const call=async(path,body={},method='POST',service=s)=>service.governanceRoutes.find(r=>r.path==='/embed-governance/'+path&&r.method===method).handler(body,{url:'/embed-governance/'+path});
  return {s,make,call,userRoot,file:join(userRoot,'BrowserFirst','EmbedGovernance','state.json'),advance:ms=>now+=ms,tick:()=>tick()};
}
test('off by default, exact requests, durable preference/notice, identity stamping and epoch barriers',async t=>{
  const f=await fixture(t),state=()=>f.call('state',{},'GET');
  let s=await state();assert.equal(s.recordingEnabled,false);
  const event={kind:'page-shared',domain:'example.test'},eventId=randomUUID();
  assert.deepEqual(await f.call('events',{writeEpoch:s.writeEpoch,eventId,event}),{recorded:false,reason:'disabled'});
  const on=await f.call('recording',{enabled:true});assert.notEqual(on.writeEpoch,s.writeEpoch);
  assert.equal((await f.call('recording',{enabled:true})).writeEpoch,on.writeEpoch);
  for(const body of [{enabled:1},{enabled:true,token:'CANARY'}]) await assert.rejects(f.call('recording',body),{code:'invalid-request'});
  await assert.rejects(f.call('notice',{noticeKey:'augmentor-v1-'+ 'b'.repeat(64),version:1}),{code:'invalid-request'});
  await f.call('notice',{noticeKey:descriptor.noticeKey,version:1});
  const body={writeEpoch:on.writeEpoch,eventId,event};
  for(const key of ['eventId','writeEpoch'])for(const bad of ['not-a-uuid',eventId.toUpperCase()])await assert.rejects(f.call('events',{...body,[key]:bad}),{code:'invalid-request'});
  for(const key of ['recordedAt','harnessId','governance','source','conversationId']) await assert.rejects(f.call('events',{...body,[key]:'CANARY'}),{code:'invalid-request'});
  assert.deepEqual(await f.call('events',body),{recorded:true,reason:null});
  assert.deepEqual(await f.call('events',body),{recorded:false,reason:'duplicate'});
  const page=await f.call('events',{},'GET');assert.equal(page.events[0].source,'local-share');assert.deepEqual(page.events[0].event,event);
  assert.equal((await readFile(f.file,'utf8')).includes('CANARY'),false);
  const deleted=await f.call('events/delete');assert.equal(deleted.recordingEnabled,true);assert.equal(deleted.noticeAcknowledged,true);
  assert.deepEqual(await f.call('events',{...body,eventId:randomUUID()}),{recorded:false,reason:'stale-epoch'});
  await f.s.close();const next=await f.make();t.after(()=>next.close());
  const reopened=await f.call('state',{},'GET',next);assert.equal(reopened.recordingEnabled,true);assert.equal(reopened.noticeAcknowledged,true);
  assert.deepEqual((await f.call('events',{},'GET',next)).events,[]);
});
test('30-day inclusive cutoff, hourly disabled pruning and rollback never restore records',async t=>{
  const f=await fixture(t),s=await f.call('recording',{enabled:true});
  await f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}});
  await f.call('recording',{enabled:false});f.advance(2592000000-1);
  assert.equal((await f.call('events',{},'GET')).events.length,1);
  f.advance(1);await f.tick();assert.equal((await f.call('events',{},'GET')).events.length,0);
  f.advance(-2592000000);assert.equal((await f.call('events',{},'GET')).events.length,0);
  assert.equal(JSON.parse(await readFile(f.file,'utf8')).events.length,0);
});
test('invalid state recovery disables recording and clears notices; unavailable PoC still reads/deletes',async t=>{
  const f=await fixture(t);await f.call('recording',{enabled:true});await f.s.close();
  await writeFile(f.file,'invalid',{mode:0o600});const next=await f.make();t.after(()=>next.close());
  const state=await f.call('state',{},'GET',next);assert.equal(state.problem,'storage-unavailable');assert.equal(state.writeEpoch,null);
  const reset=await f.call('events/delete',{},'POST',next);assert.equal(reset.recordingEnabled,false);assert.equal(reset.noticeAcknowledged,false);
  const disabled=await fixture(t,{getDescriptor:()=>null});
  assert.equal((await disabled.call('state',{},'GET')).available,false);
  await assert.rejects(disabled.call('recording',{enabled:true}),{code:'storage-unavailable'});
  const ds=await disabled.call('state',{},'GET');
  assert.deepEqual(await disabled.call('events',{writeEpoch:ds.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}}),{recorded:false,reason:'unavailable'});
  assert.equal((await disabled.call('events/delete')).deleted,true);
});
test('pagination is insertion order and removed anchors expire',async t=>{
  const f=await fixture(t),s=await f.call('recording',{enabled:true});
  for(let i=0;i<101;i++) await f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}});
  const page=await f.call('events',{},'GET');assert.equal(page.events.length,100);assert.ok(page.nextBefore);
  const route=f.s.governanceRoutes.find(r=>r.method==='GET'&&r.path.endsWith('/events'));
  assert.equal((await route.handler({},{url:'/embed-governance/events?before='+page.nextBefore})).events.length,1);
  await f.call('events/delete');await assert.rejects(route.handler({},{url:'/embed-governance/events?before='+page.nextBefore}),{code:'cursor-expired'});
  await assert.rejects(route.handler({},{url:'/embed-governance/events?before=x&before=x'}),{code:'invalid-request'});
});
test('retention failure hides expired rows and blocks appends until durable repair',async t=>{
  let raw=null,fail=false;
  const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{if(fail)throw Error('CANARY');raw=v;},close:async()=>{}})});
  const on=await f.call('recording',{enabled:true});await f.call('events',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}});
  fail=true;f.advance(2592000000);
  assert.equal((await f.call('state',{},'GET')).problem,'retention-failed');
  assert.deepEqual((await f.call('events',{},'GET')).events,[]);
  await assert.rejects(f.call('events',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}}),{code:'storage-unavailable'});
  fail=false;assert.equal((await f.call('state',{},'GET')).problem,null);
});

test('every read revalidates private paths and modes; unsafe state cannot be reset',async t=>{
  const f=await fixture(t);await f.call('recording',{enabled:true});
  const {chmod,rename,mkdir}=await import('node:fs/promises');
  await chmod(f.file,0o644);
  assert.equal((await f.call('state',{},'GET')).problem,'storage-unavailable');
  await assert.rejects(f.call('events',{},'GET'),{code:'storage-unavailable'});
  await assert.rejects(f.call('events/delete'),{code:'storage-unavailable'});
  await chmod(f.file,0o600);
  assert.equal((await f.call('state',{},'GET')).recordingEnabled,true);
  const dir=join(f.userRoot,'BrowserFirst','EmbedGovernance');
  await rename(dir,dir+'-moved');await mkdir(dir,{mode:0o700});
  assert.equal((await f.call('state',{},'GET')).problem,'storage-unavailable');
  await assert.rejects(f.call('events',{},'GET'),{code:'storage-unavailable'});
});

test('unknown versions, invalid records/notices/epochs and oversized state require explicit recovery',async t=>{
  for(const kind of ['version','record','notice','epoch','oversized']) {
    const f=await fixture(t);await f.call('recording',{enabled:true});await f.s.close();
    const saved=JSON.parse(await readFile(f.file,'utf8'));
    if(kind==='version')saved.version=2;
    if(kind==='record')saved.events=[{kind:'reply-finished',text:'CANARY'}];
    if(kind==='notice')saved.notices={invalid:1};
    if(kind==='epoch')saved.writeEpoch='invalid';
    await writeFile(f.file,kind==='oversized'?' '.repeat(10*1024*1024+1):JSON.stringify(saved),{mode:0o600});
    const next=await f.make();t.after(()=>next.close());
    assert.equal((await f.call('state',{},'GET',next)).problem,'storage-unavailable');
    await assert.rejects(f.call('events',{},'GET',next),{code:'storage-unavailable'});
    assert.equal((await f.call('events/delete',{},'POST',next)).recordingEnabled,false);
    assert.equal((await f.call('state',{},'GET',next)).problem,null);
  }
});
test('10 MiB cap includes notice bytes and preserves prior state when an append cannot fit',async t=>{
  let raw=null;const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{raw=v;},close:async()=>{}})});
  const on=await f.call('recording',{enabled:true});await f.s.close();
  const saved=JSON.parse(raw),key='augmentor-v1-'+ '0'.repeat(64);
  const entryBytes=Buffer.byteLength(JSON.stringify({[key]:1}))-1;
  const count=Math.floor((10*1024*1024-Buffer.byteLength(JSON.stringify(saved)+'\n'))/entryBytes);
  saved.notices=Object.fromEntries(Array.from({length:count},(_,i)=>['augmentor-v1-'+i.toString(16).padStart(64,'0'),1]));
  raw=JSON.stringify(saved)+'\n';assert.ok(Buffer.byteLength(raw)<=10*1024*1024);
  const next=await f.make();t.after(()=>next.close());const before=raw;
  assert.equal((await f.call('state',{},'GET',next)).problem,'log-full');
  assert.deepEqual(await f.call('events',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}},'POST',next),{recorded:false,reason:'full'});
  assert.equal(raw,before);
  await next.close();const restarted=await f.make();t.after(()=>restarted.close());
  assert.equal((await f.call('state',{},'GET',restarted)).problem,'log-full');
});
test('startup pruning frees a full record log before exposing state',async t=>{
  let raw=null;const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{raw=v;},close:async()=>{}})});
  await f.call('recording',{enabled:true});await f.s.close();
  const saved=JSON.parse(raw),record={version:1,recordedAt:new Date(Date.UTC(2026,9,13)).toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'harness-report',event:{kind:'reply-started'}};
  raw=JSON.stringify({...saved,events:Array.from({length:10000},()=>({...record,eventId:randomUUID()}))})+'\n';
  f.advance(2592000000);const next=await f.make();t.after(()=>next.close());
  assert.equal((await f.call('state',{},'GET',next)).problem,null);
  assert.deepEqual(JSON.parse(raw).events,[]);
});

test('capacity preserves history and queued pre-delete appends cannot resurrect it',async t=>{
  let raw=null;
  const f=await fixture(t,{storageFactory:async()=>({read:async()=>raw,write:async v=>{raw=v;},close:async()=>{}})});
  const s=await f.call('recording',{enabled:true});
  const initial=JSON.parse(raw),record={version:1,eventId:randomUUID(),recordedAt:new Date(Date.UTC(2026,9,13)).toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'harness-report',event:{kind:'reply-started'}};
  await f.s.close();raw=JSON.stringify({...initial,events:Array.from({length:10000},()=>({...record,eventId:randomUUID()}))});
  const next=await f.make();t.after(()=>next.close());
  const before=raw;
  assert.equal((await f.call('state',{},'GET',next)).problem,'log-full');
  assert.deepEqual(await f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}},'POST',next),{recorded:false,reason:'full'});
  assert.equal(raw,before);assert.equal((await f.call('state',{},'GET',next)).problem,'log-full');
  const deletion=f.call('events/delete',{},'POST',next);
  const stale=f.call('events',{writeEpoch:s.writeEpoch,eventId:randomUUID(),event:{kind:'reply-started'}},'POST',next);
  await deletion;assert.equal((await stale).reason,'stale-epoch');assert.deepEqual((await f.call('events',{},'GET',next)).events,[]);
  assert.equal((await f.call('state',{},'GET',next)).problem,null);
  await next.close();const afterDelete=await f.make();t.after(()=>afterDelete.close());
  assert.equal((await f.call('state',{},'GET',afterDelete)).problem,null);
});
