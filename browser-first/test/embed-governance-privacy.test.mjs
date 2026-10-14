import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { mountEmbedActivityCard } from '../resonantos-side-panel-extension/src/lib/settings/privacy-section.js';
import { createEmbedGovernanceController } from '../resonantos-side-panel-extension/src/lib/embed-governance-controller.js';
const settle=()=>new Promise(r=>setImmediate(r));
const initial=()=>({recordingEnabled:true,writeEpoch:randomUUID(),noticeKey:'augmentor-v1-'+ 'a'.repeat(64),noticeVersion:1,noticeAcknowledged:true,available:true,problem:null});
async function fixture(t,request,confirm=async()=>true,chromeApi) {
  const dom=new JSDOM('<main></main>');t.after(()=>dom.window.close());const container=dom.window.document.querySelector('main');
  const card=mountEmbedActivityCard({container,documentRef:dom.window.document,chromeApi,request,confirm});t.after(()=>card.destroy());await card.ready;
  return {dom,container,card,checkbox:container.querySelector('input')};
}
test('load fails closed; toggles wait for durable acknowledgement and never display exception text',async t=>{
  const failed=await fixture(t,async()=>{throw Error('CANARY');});assert.equal(failed.checkbox.checked,false);assert.equal(failed.checkbox.disabled,true);assert.match(failed.container.textContent,/Recording unavailable/);assert.equal(failed.container.textContent.includes('CANARY'),false);
  let resolveSave;const state=initial();const f=await fixture(t,async(path)=>path.endsWith('/state')?state:new Promise(r=>resolveSave=r));
  f.checkbox.checked=false;f.checkbox.dispatchEvent(new f.dom.window.Event('change'));await settle();
  assert.equal(f.container.textContent.includes('Recording is off'),false);
  resolveSave({recordingEnabled:false,writeEpoch:randomUUID()});await settle();assert.match(f.container.textContent,/Recording is off/);
});
test('Settings off reaches another page, clears queued data and fences reads before durable save',async t=>{
  const listeners=new Set(),signals=[],chromeApi={storage:{onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},local:{set:async value=>{signals.push(value);for(const fn of listeners)fn(Object.fromEntries(Object.entries(value).map(([key,newValue])=>[key,{newValue}])), 'local');}}}};
  const panel=new JSDOM('<main></main>');t.after(()=>panel.window.close());
  const state=initial(),posts=[];let save,oldRead,holdRead=false;
  const controller=createEmbedGovernanceController({windowRef:panel.window,chromeApi,confirmShare:async()=>true,request:async(path,options)=>{
    if(path.endsWith('/state'))return holdRead?new Promise(resolve=>oldRead=resolve):{...state};
    posts.push(options);return new Promise(()=>{});
  }});t.after(()=>controller.destroy());
  const frame={},descriptor={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:state.noticeKey};
  controller.mount({frame,origin:'http://127.0.0.1:9',descriptor});await controller.refresh();
  const relay=()=>controller.relay({source:frame,origin:'http://127.0.0.1:9',data:{type:'augmentor-event',event:'tool.finished',toolName:'read',error:false}});
  relay();relay();await settle();assert.equal(posts.length,1);
  holdRead=true;const stale=controller.refresh();await settle();
  const f=await fixture(t,async path=>path.endsWith('/state')?{...state}:new Promise(resolve=>save=resolve),async()=>true,chromeApi);
  assert.notEqual(f.dom.window,panel.window);
  f.checkbox.checked=false;f.checkbox.dispatchEvent(new f.dom.window.Event('change'));await settle();
  assert.equal(signals[0]['resonantos.embedRecordingChange'].pending,true);
  assert.equal(posts[0].signal.aborted,true);assert.equal(controller.history.length,0);
  oldRead({...state});await stale;await controller.refresh();relay();await settle();
  assert.equal(posts.length,1);assert.equal(f.container.textContent.includes('Recording is off'),false);
  holdRead=false;state.recordingEnabled=false;state.writeEpoch=randomUUID();save({recordingEnabled:false,writeEpoch:state.writeEpoch});await settle();await settle();
  assert.match(f.container.textContent,/Recording is off/);assert.equal(signals.at(-1)['resonantos.embedRecordingChange'].pending,false);
  relay();await settle();assert.equal(posts.length,1);
  controller.destroy();assert.equal(listeners.size,0);
});
test('delete recovery snapshot wins over older reads and clears rows before success',async t=>{
  let reads=0,oldRead;const state={...initial(),problem:'storage-unavailable',writeEpoch:null,recordingEnabled:false,noticeAcknowledged:false};
  const f=await fixture(t,async(path)=>{
    if(path.endsWith('/state')){reads++;if(reads===1)return state;return new Promise(r=>oldRead=r);}
    if(path.endsWith('/events/delete'))return {deleted:true,recordingEnabled:false,writeEpoch:randomUUID(),noticeKey:state.noticeKey,noticeAcknowledged:false};
    return {events:[],nextBefore:null};
  });
  const stale=f.card.refresh();await settle();f.container.querySelector('[data-action=delete]').click();await settle();
  oldRead(initial());await stale;assert.equal(f.checkbox.checked,false);assert.equal(f.container.dataset.noticeAcknowledged,'false');assert.match(f.container.textContent,/Activity deleted/);
});
test('history is text only, pagination expires explicitly and deletion failure retains rows',async t=>{
  let failDelete=false,expired=false;const state=initial();
  const f=await fixture(t,async(path)=>{
    if(path.endsWith('/state'))return state;
    if(path.endsWith('/events/delete')){if(failDelete)throw Error('CANARY');return {deleted:true,...state};}
    if(path.includes('?before=')){expired=true;throw Object.assign(Error(),{code:'cursor-expired'});}
    return {events:[{version:1,eventId:randomUUID(),recordedAt:new Date().toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'local-share',event:{kind:'page-shared',domain:'example.test'}}],nextBefore:randomUUID()};
  });
  f.container.querySelector('[data-action=view]').click();await settle();assert.match(f.container.textContent,/example.test/);assert.equal(f.container.querySelectorAll('a').length,0);
  f.container.querySelector('[data-action=older]').click();await settle();await settle();assert.equal(expired,true);
  failDelete=true;f.container.querySelector('[data-action=delete]').click();await settle();assert.match(f.container.textContent,/Activity could not be deleted/);assert.match(f.container.textContent,/example.test/);
});

test('history rejects content-bearing metadata without rendering it',async t=>{
  const f=await fixture(t,async path=>path.endsWith('/state')?initial():{events:[{version:1,eventId:randomUUID(),recordedAt:new Date().toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',event:{kind:'page-shared',domain:'example.test',url:'CANARY'}}],nextBefore:null});
  f.container.querySelector('[data-action=view]').click();await settle();
  assert.match(f.container.textContent,/Activity unavailable/);assert.equal(f.container.textContent.includes('CANARY'),false);
});

test('cancelled deletion does not mutate host state',async t=>{
  const calls=[];const f=await fixture(t,async path=>{calls.push(path);return initial();},async()=>false);
  f.container.querySelector('[data-action=delete]').click();await settle();
  assert.deepEqual(calls,['/embed-governance/state']);assert.equal(f.container.textContent.includes('Activity deleted'),false);
});
