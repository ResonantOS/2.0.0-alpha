import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEmbedGovernanceController } from '../resonantos-side-panel-extension/src/lib/embed-governance-controller.js';
const d={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
const settle=()=>new Promise(r=>setImmediate(r));
function fixture({enabled=false,post,confirm=true}={}) {
  const frame={},calls=[],notices=[],listeners=new Map();let polls=0,poll,timeout=()=>{},epoch=randomUUID(),asks=0,noticeKey=d.noticeKey;
  const state=()=>({recordingEnabled:enabled,writeEpoch:epoch,noticeKey,noticeVersion:1,noticeAcknowledged:false,available:true,problem:null});
  const request=async(path,options={})=>{calls.push({path,options});if(path.endsWith('/state')){polls++;return state();}return post?post(path,options):{recorded:true,reason:null};};
  const c=createEmbedGovernanceController({request,uuid:randomUUID,windowRef:{addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)},confirmShare:async()=>{asks++;return confirm;},announce:s=>notices.push(s),setIntervalImpl:(fn,ms)=>{assert.equal(ms,5000);poll=fn;return 1;},clearIntervalImpl(){},setTimeoutImpl:(fn,ms)=>{assert.equal(ms,2000);timeout=fn;return 2;},clearTimeoutImpl(){}});
  c.mount({frame,origin:'http://127.0.0.1:9',descriptor:d});
  const relay=data=>c.relay({source:frame,origin:'http://127.0.0.1:9',data});
  return {c,frame,calls,notices,listeners,relay,enable:v=>enabled=v,epoch:()=>epoch=randomUUID(),poll:()=>poll(),timeout:()=>timeout(),asks:()=>asks,polls:()=>polls,changeRecipient:key=>noticeKey=key};
}
test('unknown/off records nothing; enabling has no backfill; exact transitions never persist IDs/content',async()=>{
  const f=fixture();await f.c.refresh();
  f.relay({type:'augmentor-event',event:'turn.started',prompt:'CANARY'});assert.equal(f.c.history.length,0);
  f.enable(true);await f.c.refresh();
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'CANARY-ID-1'});
  f.relay({type:'augmentor-event',event:'conversation.changed',conversationId:'CANARY-ID-2',text:'CANARY'});
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'CANARY-ID-2'});
  f.relay({type:'augmentor-event',event:'turn.started'});f.relay({type:'augmentor-event',event:'turn.started'});
  f.relay({type:'augmentor-event',event:'turn.finished'});f.relay({type:'augmentor-event',event:'turn.finished'});
  f.relay({type:'augmentor-event',event:'tool.finished',toolName:'read.page',error:false,result:'CANARY'});
  f.relay({type:'augmentor-event',event:'tool.finished',toolName:'read.page',error:false});
  for(let i=0;i<10;i++)await settle();
  const posts=f.calls.filter(c=>c.path.endsWith('/events'));
  assert.deepEqual(posts.map(p=>p.options.body.event.kind),['conversation-changed','reply-started','reply-finished','tool-finished','tool-finished']);
  assert.equal(JSON.stringify(posts).includes('CANARY'),false);assert.equal(JSON.stringify(f.c.history).includes('CANARY'),false);
  const before=posts.length;
  f.c.relay({source:{},origin:'http://127.0.0.1:9',data:{type:'augmentor-event',event:'turn.started'}});
  f.c.relay({source:f.frame,origin:'http://evil',data:{type:'augmentor-event',event:'turn.started'}});
  f.relay({type:'augmentor-result',text:'CANARY'});f.relay({type:'augmentor-status',online:false,busy:false});
  await settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,before);
  f.c.destroy();assert.equal(f.listeners.size,0);
});
test('queue bounds, timeout drops, stale epoch refresh and pagehide cleanup',async()=>{
  const f=fixture({enabled:true,post:()=>new Promise(()=>{})});await f.c.refresh();
  for(let i=0;i<60;i++)f.relay({type:'augmentor-event',event:'tool.finished',toolName:'read',error:false});
  assert.ok(f.c.history.length<=50);await settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,1);
  f.timeout();await settle();assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,2);
  f.listeners.get('pagehide')();await settle();assert.equal(f.c.history.length,0);
  const stale=fixture({enabled:true,post:async()=>({recorded:false,reason:'stale-epoch'})});await stale.c.refresh();
  const polls=stale.polls();stale.relay({type:'augmentor-event',event:'turn.started'});await settle();await settle();
  assert.ok(stale.polls()>polls);assert.equal(stale.calls.filter(c=>c.path.endsWith('/events')).length,1);stale.c.destroy();
});
test('notice consent only follows successful-share callback and survives remember failure in this mount',async()=>{
  const f=fixture({post:async()=>{throw Error('CANARY');}});await f.c.refresh();
  const ticket=await f.c.beginShare();assert.equal(typeof ticket,'object');
  assert.equal(f.calls.some(c=>c.path.endsWith('/notice')),false);
  f.c.didShare(ticket,'https://example.test/path?q=CANARY');await settle();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/notice')).length,1);
  assert.equal(f.calls.some(c=>c.path.endsWith('/recording')),false);
  await f.c.beginShare();assert.equal(f.asks(),1);
  assert.ok(f.notices.includes('Notice preference could not be saved. It may appear again.'));
  f.c.mount({frame:{},origin:'http://127.0.0.1:9',descriptor:d});
  assert.equal(f.c.currentShare(ticket),false);await f.c.beginShare();assert.equal(f.asks(),2);f.c.destroy();
});

test('one in flight and at most 32 waiting; full queue drops newest without retry',async()=>{
  const releases=[];
  const f=fixture({enabled:true,post:()=>new Promise(resolve=>releases.push(resolve))});await f.c.refresh();
  for(let i=0;i<60;i++)f.relay({type:'augmentor-event',event:'tool.finished',toolName:'tool'+i,error:false});
  await settle();assert.equal(releases.length,1);
  for(let i=0;i<33;i++){assert.equal(releases.length,1);releases.shift()({recorded:true,reason:null});await settle();}
  assert.equal(releases.length,0);
  assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/events')).map(c=>c.options.body.event.toolName),Array.from({length:33},(_,i)=>'tool'+i));
  assert.deepEqual(f.notices,['Activity was not recorded']);f.c.destroy();
});

test('disablement clears pending metadata and keeps only bounded ready/status proof',async()=>{
  const f=fixture({enabled:true});await f.c.refresh();
  f.relay({type:'augmentor-ready'});f.relay({type:'augmentor-event',event:'turn.started'});await settle();
  assert.ok(f.c.history.some(row=>row.kind==='reply-started'));
  f.enable(false);await f.c.refresh();
  assert.ok(f.c.history.every(row=>row.type==='augmentor-ready'||row.type==='augmentor-status'));
  const count=f.calls.filter(c=>c.path.endsWith('/events')).length;
  f.relay({type:'augmentor-event',event:'turn.finished'});await settle();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,count);f.c.destroy();
});

test('offline resets baselines without synthesizing finishes; busy transitions are not turns',async()=>{
  const f=fixture({enabled:true});await f.c.refresh();
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'first'});
  f.relay({type:'augmentor-event',event:'turn.started'});
  f.relay({type:'augmentor-status',online:false,busy:false});
  f.relay({type:'augmentor-status',online:true,busy:true,conversationId:'second'});
  f.relay({type:'augmentor-status',online:true,busy:false,conversationId:'second'});
  await settle();assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/events')).map(c=>c.options.body.event.kind),['reply-started']);
  f.relay({type:'augmentor-event',event:'turn.started'});await settle();
  assert.equal(f.calls.filter(c=>c.path.endsWith('/events')).length,2);f.c.destroy();
});
test('changed host recipient key invalidates this mounted frame and never remembers a share',async()=>{
  const f=fixture();await f.c.refresh();const ticket=await f.c.beginShare();
  f.changeRecipient('augmentor-v1-'+ 'b'.repeat(64));await f.c.refresh();
  assert.equal(f.c.currentShare(ticket),false);assert.equal(await f.c.beginShare(),'Assistant unavailable');
  f.c.didShare(ticket,'https://example.test/');await settle();
  assert.equal(f.calls.some(c=>c.path.endsWith('/notice')),false);f.c.destroy();
});

test('off-to-on emits only new transitions and focus/poll never write consent',async()=>{
  const f=fixture();await f.c.refresh();
  f.relay({type:'augmentor-event',event:'turn.started'});
  f.relay({type:'augmentor-event',event:'turn.finished'});
  f.enable(true);await f.c.refresh();f.listeners.get('focus')();f.poll();await settle();
  assert.equal(f.calls.some(c=>c.path.endsWith('/recording')||c.path.endsWith('/notice')||c.path.endsWith('/events')),false);
  f.relay({type:'augmentor-event',event:'turn.started'});await settle();
  assert.deepEqual(f.calls.filter(c=>c.path.endsWith('/events')).map(c=>c.options.body.event),[{kind:'reply-started'}]);f.c.destroy();
});

test('failed notice read discards host-only acknowledgement but preserves this mount successful-share fallback',async()=>{
  for(const localShare of [false,true]) {
    let fail=false,asks=0;
    const frame={},c=createEmbedGovernanceController({windowRef:{addEventListener(){},removeEventListener(){}},
      setIntervalImpl:()=>0,clearIntervalImpl(){},confirmShare:async()=>{asks++;return true;},
      request:async path=>{
        if(fail)throw Error('CANARY');
        return {recordingEnabled:false,writeEpoch:randomUUID(),noticeKey:d.noticeKey,noticeVersion:1,noticeAcknowledged:!localShare,available:true,problem:null};
      }});
    c.mount({frame,origin:'http://127.0.0.1:9',descriptor:d});await c.refresh();
    if(localShare){const ticket=await c.beginShare();c.didShare(ticket,'https://example.test/');await settle();}
    fail=true;const before=asks;const ticket=await c.beginShare();
    assert.equal(typeof ticket,'object');assert.equal(asks-before,localShare?0:1);
    c.destroy();
  }
});

test('recording-off refresh preserves notice persistence and reports a later save failure',async()=>{
  let noticeSignal,rejectNotice;
  const announcements=[],frame={};
  const c=createEmbedGovernanceController({windowRef:{addEventListener(){},removeEventListener(){}},
    setIntervalImpl:()=>0,clearIntervalImpl(){},confirmShare:async()=>true,announce:s=>announcements.push(s),
    request:async(path,options)=>{
      if(path.endsWith('/notice')){noticeSignal=options.signal;return new Promise((_,reject)=>{rejectNotice=reject;});}
      return {recordingEnabled:false,writeEpoch:randomUUID(),noticeKey:d.noticeKey,noticeVersion:1,noticeAcknowledged:false,available:true,problem:null};
    }});
  try {
    c.mount({frame,origin:'http://127.0.0.1:9',descriptor:d});await c.refresh();
    const ticket=await c.beginShare();c.didShare(ticket,'https://example.test/');await settle();
    await c.refresh();assert.equal(noticeSignal.aborted,false);
    rejectNotice(Error('CANARY'));await settle();
    assert.deepEqual(announcements,['Notice preference could not be saved. It may appear again.']);
  } finally {c.destroy();}
});
