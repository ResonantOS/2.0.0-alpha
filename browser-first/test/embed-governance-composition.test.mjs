import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { mountEmbedView } from '../resonantos-side-panel-extension/src/side-panel-entry.js';
const d={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
const settle=()=>new Promise(r=>setImmediate(r));
async function fixture(t,harness=d) {
  const dom=new JSDOM('<body></body>',{url:'https://extension.test/'});const calls=[];
  const event={addListener(){},removeListener(){}};
  const chromeApi={runtime:{getURL:p=>'chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl/'+p},tabs:{query:async()=>[],onUpdated:event,onActivated:event,onRemoved:event},storage:{onChanged:event,local:{get:async()=>({}),set:async()=>{}}}};
  const view=await mountEmbedView({documentRef:dom.window.document,windowRef:dom.window,chromeApi,locationRef:dom.window.location,getConnection:async()=>({bridgeUrl:'http://127.0.0.1:9',request:async(path)=>{calls.push(path);if(path==='/embed/session')return {hostPath:'/embed-host/?ticket='+ 'a'.repeat(43),harness};return {recordingEnabled:false,writeEpoch:randomUUID(),noticeKey:d.noticeKey,noticeVersion:1,noticeAcknowledged:false,available:true,problem:null};}})});
  t.after(()=>{view.bar.destroy();dom.window.close();});return {dom,view,calls};
}
test('real composition refuses foreign relays and retains safe proof state only',async t=>{
  const f=await fixture(t),frame=f.view.root.querySelector('iframe');
  const relay=(data,source=frame.contentWindow,origin='http://127.0.0.1:9')=>f.dom.window.dispatchEvent(new f.dom.window.MessageEvent('message',{source,origin,data}));
  relay({type:'augmentor-ready'});relay({type:'augmentor-status',online:true,busy:false,sessionId:'CANARY'});
  relay({type:'augmentor-result',text:'CANARY'});relay({type:'augmentor-event',event:'turn.finished',text:'CANARY'});
  relay({type:'augmentor-status',online:false,busy:false},{},'http://evil');
  await settle();assert.equal(f.view.state.ready,true);assert.equal(JSON.stringify(f.view.state.last).includes('CANARY'),false);
  assert.deepEqual(f.view.state.last,[{type:'augmentor-ready'},{type:'augmentor-status',online:true,busy:false}]);
  assert.equal(f.calls.some(p=>p.includes('/slots/')||p.includes('/grants')||p.endsWith('/recording')),false);
});
test('malformed descriptor never mounts an alternative harness and keeps escape controls',async t=>{
  const f=await fixture(t,{...d,label:'Other'});assert.equal(f.view.root.querySelector('iframe'),null);
  assert.ok(f.view.bar.root.querySelector('[data-control=workspace]'));assert.ok(f.view.bar.root.querySelector('[data-control=assistant]'));
  assert.equal(f.view.bar.root.querySelector('[data-tier]').textContent,'Self-governed');
});
