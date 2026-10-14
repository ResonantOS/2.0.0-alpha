import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createEmbedBarActions } from '../resonantos-side-panel-extension/src/lib/embed-bar-actions.js';
import { confirmEmbedShare } from '../resonantos-side-panel-extension/src/lib/embed-governance-dialog.js';
function fixture({confirm=true,change,dispatch=true}={}) {
  const tab={id:2,url:'https://example.test/path?q=CANARY',title:'Fixture'},sent=[],remembered=[];let mode='read-only',reads=0,notices=0,current=true;
  const chromeApi={tabs:{query:async()=>[tab],get:async()=>tab},webNavigation:{getAllFrames:async()=>[]},storage:{local:{get:async key=>{if(key==='augmentorSitePermissions'){reads++;return {[key]:{'example.test':mode}};}return {};},set:async()=>{}}}};
  const ticket={frame:{},noticeKey:'key',remember:true};
  const actions=createEmbedBarActions({chromeApi,locationRef:{},sendContext:m=>{if(dispatch==='throw')throw Error('CANARY');sent.push(m);return dispatch;},beforeShare:async()=>{notices++;if(change==='url')tab.url='https://example.test/other';if(change==='permission')mode='blocked';if(change==='frame')current=false;if(change==='read')chromeApi.storage.local.get=async()=>{throw Error('CANARY');};return confirm?ticket:'';},isShareCurrent:()=>current,onShared:(value,url)=>remembered.push({value,url})});
  return {actions,sent,remembered,reads:()=>reads,notices:()=>notices};
}
test('cancel, navigation, permission failure, frame replacement and failed dispatch remember nothing',async()=>{
  for(const opts of [{confirm:false},{change:'url'},{change:'permission'},{change:'frame'},{change:'read'},{dispatch:false},{dispatch:'throw'}]) {
    const f=fixture(opts);assert.notEqual(await f.actions.sharePage(),'Page shared');assert.deepEqual(f.remembered,[]);
    if(!Object.hasOwn(opts,'dispatch'))assert.deepEqual(f.sent,[]);
  }
  const f=fixture();assert.equal(await f.actions.sharePage(),'Page shared');assert.equal(f.sent.length,1);assert.equal(f.remembered.length,1);assert.equal(f.reads(),2);
  assert.equal(f.remembered[0].url,'https://example.test/path');
});
test('dialog focuses Cancel, traps Tab, escapes, names recipient and restores Page focus',async t=>{
  const dom=new JSDOM('<button id="page">Page</button>');t.after(()=>dom.window.close());const documentRef=dom.window.document,page=documentRef.querySelector('#page');page.focus();
  const answer=confirmEmbedShare({documentRef,label:'Augmentor',returnFocus:page});
  const dialog=documentRef.querySelector('[role=dialog]'),buttons=[...dialog.querySelectorAll('button')];
  assert.equal(documentRef.activeElement,buttons[0]);assert.equal(dialog.getAttribute('aria-modal'),'true');
  assert.match(dialog.textContent,/does not give Augmentor permission/);
  buttons[0].dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(documentRef.activeElement,buttons[1]);
  dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(await answer,false);assert.equal(documentRef.activeElement,page);
  const yes=confirmEmbedShare({documentRef,label:'Augmentor',returnFocus:page});documentRef.querySelector('[data-confirm]').click();assert.equal(await yes,true);
});
