#!/usr/bin/env node
// EMBED-UPSTREAM-1 and final live acceptance. Conductor only; never a deterministic test.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const env=process.env,stage=env.RESONANTOS_EMBED_LIVE_STAGE??'integration';
const version=env.RESONANTOS_EMBED_LIVE_VERSION;
assert.ok(typeof version==='string'&&/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version),'Supply the verified upstream version, not an endpoint.');
assert.ok(['upstream','integration'].includes(stage));
const repository=await realpath(resolve(import.meta.dirname,'../..'));
async function external(name,create=false) {
  const value=env[name];assert.ok(value&&isAbsolute(value),name+' must be an absolute test-owned path');
  const lexical=relative(repository,resolve(value));
  assert.ok(lexical&&(lexical==='..'||lexical.startsWith('..'+sep)||isAbsolute(lexical)),name+' must be outside Git');
  let ancestor=resolve(value);
  for(;;){try{await lstat(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;ancestor=dirname(ancestor);}}
  const ancestorRelative=relative(repository,await realpath(ancestor));
  assert.ok(ancestorRelative&&(ancestorRelative==='..'||ancestorRelative.startsWith('..'+sep)||isAbsolute(ancestorRelative)),name+' resolves inside Git');
  if(create)await mkdir(value,{recursive:true,mode:0o700});
  const stat=await lstat(value);assert.equal(stat.isSymbolicLink(),false);
  const canonical=await realpath(value),r=relative(repository,canonical);
  assert.ok(r&&(r==='..'||r.startsWith('..'+sep)||isAbsolute(r)),name+' must be outside Git');return canonical;
}
const out=await external('RESONANTOS_EMBED_LIVE_OUT',true),userRoot=await external('RESONANTOS_EMBED_LIVE_USER_ROOT'),extensionPath=await external('RESONANTOS_EMBED_LIVE_EXTENSION_ROOT');
const extensionId='cdpdmmalhmokbfcfgogoepnjplaakgnl',panelUrl=`chrome-extension://${extensionId}/src/side-panel.html?agentView=embed`;
const statePath=join(userRoot,'BrowserFirst','EmbedGovernance','state.json');
const profile=await mkdtemp(join(await realpath(tmpdir()),'embed-live-profile-'));
const terminal=createInterface({input:stdin,output:stdout});
const summary={pass:false,stage,upstreamVersion:version,checks:{},protocol:{}};
let context,page,workspace;
const fixtureTitle='Fixture '+randomUUID(),fixture=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(`<title>${fixtureTitle}</title><h1>Local page sharing fixture</h1>`);});
async function attest(key,text){assert.equal((await terminal.question(text+' Type yes when verified: ')).trim(),'yes');summary.checks[key]=true;}
async function launch() {
  context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:420,height:900},args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,'--no-first-run','--no-default-browser-check'],...(env.RESONANTOS_LIVE_CHROME_PATH?{executablePath:env.RESONANTOS_LIVE_CHROME_PATH}:{})});
  await context.addInitScript(()=>{
    window.__embedProtocol={status:false,conversationId:false,conversationChanged:false,replyStarted:false,replyFinished:false,toolSuccess:false,toolError:false};
    window.addEventListener('message',event=>{
      const frame=document.querySelector('#embed-root iframe');if(!frame||event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin)return;
      const d=event.data,p=window.__embedProtocol;
      if(d?.type==='augmentor-status'){
        if(typeof d.online==='boolean'&&typeof d.busy==='boolean')p.status=true;
        if(typeof d.conversationId==='string'&&[...d.conversationId].length>=1&&[...d.conversationId].length<=128&&!/[\x00-\x1f\x7f]/.test(d.conversationId))p.conversationId=true;
      }
      if(d?.type==='augmentor-event'){
        if(d.event==='conversation.changed'&&typeof d.conversationId==='string'&&[...d.conversationId].length>=1&&[...d.conversationId].length<=128&&!/[\x00-\x1f\x7f]/.test(d.conversationId))p.conversationChanged=true;
        if(d.event==='turn.started')p.replyStarted=true;
        if(d.event==='turn.finished')p.replyFinished=true;
        if(d.event==='tool.finished'&&typeof d.toolName==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(d.toolName)){
          if(d.error===false)p.toolSuccess=true;if(d.error===true)p.toolError=true;
        }
      }
    });
  });
  const fixturePage=await context.newPage();await fixturePage.goto(`http://127.0.0.1:${fixture.address().port}/fixture/path?q=canary#fragment`);
  page=await context.newPage();await page.goto(panelUrl);
  await page.waitForFunction(()=>window.__resonantosEmbed?.ready===true,null,{timeout:90000});
}
async function protocol() {
  await attest('recipient','Verify in Manolo’s container/version UI that the configured recipient is Augmentor and matches the supplied version.');
  await attest('upstreamExercise','In the real harness, change conversation, start/finish a reply, and exercise a safe tool success and a safe tool error. Do not enter credentials or perform an external mutation.');
  summary.protocol=await page.evaluate(()=>({...window.__embedProtocol}));
  assert.deepEqual(summary.protocol,{status:true,conversationId:true,conversationChanged:true,replyStarted:true,replyFinished:true,toolSuccess:true,toolError:true},'EMBED-UPSTREAM-1 failed: a required field/event is absent. Stop mapping implementation; obtain a reviewed narrow spec update.');
  summary.checks.upstream=true;
}
async function bridge(route,options={}) {
  return page.evaluate(async({route,options})=>{
    const api=await import('./lib/bridge-client.js');const config=await api.resolveBridgeConfig({refreshGenerated:true});await api.initCapabilityTokens(config);
    return api.createBridgeClient(config)(route,options);
  },{route,options});
}
async function privacy() {
  await page.locator('[data-control=workspace]').click();
  workspace=context.pages().find(p=>p.url().includes('/src/main-workspace.html'));
  if(!workspace){workspace=await context.waitForEvent('page');await workspace.waitForURL('**/src/main-workspace.html');}
  await workspace.locator('[data-workspace=settings]').click();
  await workspace.getByRole('button',{name:/Privacy/}).click();
  await workspace.getByText('Embedded harness activity',{exact:true}).waitFor();
  return workspace.locator('[data-embed-activity]');
}
async function recording(card,enabled) {
  await card.getByLabel('Record harness activity').setChecked(enabled);
  await card.getByText(enabled?'Recording is on':'Recording is off',{exact:true}).waitFor();
}
async function clickPage(){await page.evaluate(()=>{const n=document.querySelector('.embed-bar-notice');if(n)n.textContent='';});await page.locator('[data-control=page]').click();}
async function durable(){return JSON.parse(await readFile(statePath,'utf8'));}
async function choose(mode) {
  await page.locator('[data-control=assistant]').click();
  await Promise.all([page.waitForNavigation(),page.locator(`[data-mode=${mode}]`).click()]);
}
try {
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');await launch();
  if(stage==='upstream'){await protocol();summary.pass=true;}
  else {
    assert.equal((await bridge('/embed-governance/state')).recordingEnabled,false);
    for(const width of [320,420]) {
      await page.setViewportSize({width,height:900});
      const layout=await page.evaluate(()=>{const b=document.querySelector('#resonantos-bar').getBoundingClientRect(),f=document.querySelector('#embed-root iframe').getBoundingClientRect(),t=document.querySelector('[data-tier]').getBoundingClientRect();return {height:b.height,aligned:Math.abs(f.top-b.bottom)<=1,fit:document.documentElement.scrollWidth<=innerWidth,tier:t.width>0};});
      assert.ok(layout.height<=36&&layout.height>0&&layout.aligned&&layout.fit&&layout.tier);summary.checks['layout'+width]=true;
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    await attest('keyboardAndLayout','Verify keyboard focus, badge description and Escape, reduced motion, and that the harness panel looks unchanged.');
    await page.evaluate(()=>{const s=window.__resonantosEmbed,send=s.send;window.__localShares=0;s.send=m=>{const ok=send(m);if(ok&&m?.type==='augmentor-context')window.__localShares++;return ok;};});
    await clickPage();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>window.__localShares),0);
    await clickPage();await page.getByRole('button',{name:'Share page',exact:true}).click();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__localShares),1);
    const inner=page.frames().find(f=>f.parentFrame()?.parentFrame()===page.mainFrame()&&new URL(f.url()).pathname.startsWith('/embed/'));assert.ok(inner);
    const before=await inner.getByText(fixtureTitle,{exact:true}).count();
    assert.equal(await page.evaluate(()=>window.__resonantosEmbed.send({type:'augmentor-prompt',text:'What is the title of the page shared by ResonantOS? Reply with exactly that title and no other text.',send:true,fresh:true})),true);
    await inner.getByText(fixtureTitle,{exact:true}).nth(before).waitFor({timeout:180000});summary.checks.fixtureReply=true;
    assert.deepEqual((await bridge('/embed-governance/events')).events,[]);
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
    await context.close();context=null;
    await attest('restartSameRecipient','Restart the spike bridge with the SAME external user root and upstream origin, refresh the disposable extension configuration, and leave recording off.');
    await launch();await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
    let card=await privacy();await recording(card,true);await page.bringToFront();await page.waitForTimeout(5200);await protocol();
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();
    await page.waitForTimeout(2200);
    const stored=await durable(),events=(await bridge('/embed-governance/events')).events;
    assert.ok(events.some(r=>r.event.kind==='page-shared'&&r.event.domain==='127.0.0.1'));
    for(const kind of ['conversation-changed','reply-started','reply-finished','tool-finished'])assert.ok(events.some(r=>r.event.kind===kind),kind);
    for(const error of [true,false])assert.ok(events.some(r=>r.event.kind==='tool-finished'&&r.event.error===error));
    for(const r of stored.events){assert.equal(Object.hasOwn(r,'conversationId'),false);assert.equal(Object.hasOwn(r.event,'conversationId'),false);assert.equal(Object.hasOwn(r.event,'text'),false);assert.equal(Object.hasOwn(r.event,'url'),false);assert.equal(Object.hasOwn(r.event,'title'),false);}
    assert.equal(JSON.stringify(stored).includes(fixtureTitle),false);assert.equal(JSON.stringify(stored).includes('canary'),false);summary.checks.domainOnly=true;
    await workspace.bringToFront();await card.getByRole('button',{name:'View activity',exact:true}).click();await card.getByText(/Page shared: 127.0.0.1/).waitFor();
    await recording(card,false);const count=(await durable()).events.length;await page.bringToFront();await clickPage();await page.waitForTimeout(2200);assert.equal((await durable()).events.length,count);
    await workspace.bringToFront();await card.getByRole('button',{name:'Delete activity',exact:true}).click();await workspace.getByRole('dialog').getByRole('button',{name:'Delete activity',exact:true}).click();await card.getByText('Activity deleted',{exact:true}).waitFor();
    assert.deepEqual((await durable()).events,[]);assert.ok(Object.keys((await durable()).notices).length>0);
    await context.close();context=null;
    await attest('restartAfterDeletion','Restart the bridge with the same test root and recipient; refresh the disposable extension configuration.');
    await launch();assert.deepEqual((await bridge('/embed-governance/events')).events,[]);assert.equal((await bridge('/embed-governance/state')).noticeAcknowledged,true);
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);summary.checks.deleteSurvivesRestart=true;
    await context.close();context=null;
    await attest('stoppedForRetention','Stop the bridge before seeding this test-owned state. Verify no bridge owns this root.');
    const seed=await durable();seed.events=[{version:1,eventId:randomUUID(),recordedAt:new Date(Date.now()-2592000001).toISOString(),harnessId:'addon.augmentor-embed',interfaceId:'panel',governance:'self-governed',source:'harness-report',event:{kind:'reply-finished'}}];await writeFile(statePath,JSON.stringify(seed)+'\n',{mode:0o600});
    await attest('restartedForRetention','Restart the bridge with the same test root; refresh the disposable extension config.');await launch();assert.deepEqual((await bridge('/embed-governance/events')).events,[]);assert.deepEqual((await durable()).events,[]);summary.checks.retention=true;
    await attest('storageFailureIsolation','Using only this disposable root, induce a storage failure, verify Page sharing, chat, Workspace and Assistant still work, then restore safe permissions.');
    const slots=(await bridge('/addons/registry')).slots;assert.ok(slots&&typeof slots==='object');
    await choose('normal');await page.locator('#command-input').waitFor();assert.deepEqual(await page.locator('#resonantos-bar [data-control]').evaluateAll(nodes=>nodes.map(n=>n.dataset.control)),['assistant']);
    await choose('embed');await page.waitForFunction(()=>window.__resonantosEmbed?.ready);assert.deepEqual((await bridge('/addons/registry')).slots,slots);summary.checks.viewOnly=true;
    summary.pass=true;
  }
}catch{summary.pass=false;summary.failure='Live acceptance incomplete; inspect fixed check names and rerun with the conductor.';process.exitCode=1;}
finally{
  terminal.close();await context?.close();fixture.closeAllConnections();if(fixture.listening)await new Promise(r=>fixture.close(r));await rm(profile,{recursive:true,force:true});
  await writeFile(join(out,'embed-governance-summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify(summary));
