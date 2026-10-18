#!/usr/bin/env node
// EMBED-UPSTREAM-1 and final live acceptance. Conductor only; never a deterministic test.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, lstat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const env=process.env,stage=env.RESONANTOS_EMBED_LIVE_STAGE??'integration';
const attestMode=env.RESONANTOS_EMBED_LIVE_ATTEST==='screenshot'?'screenshot':'human';
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
async function validateControl() {
  if(attestMode!=='screenshot'||stage!=='integration')return null;
  try {
    const value=await external('RESONANTOS_EMBED_LIVE_CONTROL');
    assert.ok((await lstat(value)).isFile());
    await access(value,constants.X_OK);return value;
  }catch{throw new Error('Screenshot integration requires a valid external executable RESONANTOS_EMBED_LIVE_CONTROL.');}
}
const control=await validateControl();
const controlCheckpointActions={restartSameRecipient:'restart',restartAfterDeletion:'restart',stoppedForRetention:'stop',restartedForRetention:'start'};
const out=await external('RESONANTOS_EMBED_LIVE_OUT',true),userRoot=await external('RESONANTOS_EMBED_LIVE_USER_ROOT'),extensionPath=await external('RESONANTOS_EMBED_LIVE_EXTENSION_ROOT');
const extensionId='cdpdmmalhmokbfcfgogoepnjplaakgnl',panelUrl=`chrome-extension://${extensionId}/src/side-panel.html?agentView=embed`;
const statePath=join(userRoot,'BrowserFirst','EmbedGovernance','state.json');
const profile=await mkdtemp(join(await realpath(tmpdir()),'embed-live-profile-'));
const terminal=attestMode==='screenshot'?null:createInterface({input:stdin,output:stdout});
const summary={pass:false,stage,upstreamVersion:version,attestationStatus:attestMode==='screenshot'?'conductor-verified screenshots pending owner review':'human attestations',checks:{},attestations:{},protocol:{},controlActions:[]};
let context,page,workspace;
const fixtureTitle='Fixture '+randomUUID(),fixture=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(`<title>${fixtureTitle}</title><h1>Local page sharing fixture</h1>`);});
async function controlConfig() {
  // Same JSON-only wrapper parser as bridge-client.js; never execute this file.
  try {
    const source=await readFile(join(extensionPath,'src','bridge-config.generated.js'),'utf8');
    const text=source.trim(),prefix='globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze(',suffix=');';
    if(!text.startsWith(prefix)||!text.endsWith(suffix))throw Error();
    const config=JSON.parse(text.slice(prefix.length,-suffix.length));
    const match=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(config.bridgeUrl);
    if(!match||Number(match[1])>65535||typeof config.bridgeToken!=='string'||!config.bridgeToken)throw Error();
    return {token:config.bridgeToken,url:config.bridgeUrl,digest:createHash('sha256').update(config.bridgeToken).digest('hex'),host:'127.0.0.1',port:Number(match[1])};
  }catch{throw new Error('Control config unavailable or invalid.');}
}
async function controlTcp(config,timeout) {
  return new Promise(resolve=>{
    const socket=net.connect({host:config.host,port:config.port});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>finish('connected'));
    socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'refused':'unavailable'));
    socket.setTimeout(timeout,()=>finish('unavailable'));
  });
}
async function controlAuthStatus(config,token) {
  // authorizeBridgeRoute checks bridge auth before Origin/capabilities on this read route.
  // Credentials stay in memory; neither responses nor request details enter evidence.
  try {
    const response=await fetch(config.url+'/embed-governance/state',{
      headers:{'X-ResonantOS-Bridge-Token':token},redirect:'error',signal:AbortSignal.timeout(1000),
    });
    await response.body?.cancel();return response.status;
  }catch{return null;}
}
async function runControl(key,action) {
  const result={key,action,ok:false};summary.controlActions.push(result);
  const lifecycle=['stop','start','restart'].includes(action);
  const before=lifecycle?await controlConfig():null;
  await new Promise((resolve,reject)=>execFile(control,[action],{timeout:120000},error=>error?reject(error):resolve()));
  // Storage actions are marked observed by the state assertions after restart.
  if(!lifecycle)return result;
  const deadline=Date.now()+(action==='stop'?15000:60000);
  while(Date.now()<deadline) {
    let current;
    try{current=action==='stop'?before:await controlConfig();}catch{}
    const remaining=deadline-Date.now();
    if(remaining<=0)break;
    if(current&&(action==='stop'||current.digest!==before.digest)) {
      const state=await controlTcp(current,Math.min(1000,remaining));
      if(state===(action==='stop'?'refused':'connected')) {
        if(action!=='stop') {
          if(await controlAuthStatus(current,before.token)!==401)throw new Error('Control old credential rejection was not observed.');
          const status=await controlAuthStatus(current,current.token);
          if(status===null||status===401)throw new Error('Control new credential acceptance was not observed.');
        }
        result.ok=true;result.observed=true;return result;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,Math.min(200,Math.max(0,deadline-Date.now()))));
  }
  throw new Error('Control action effect was not observed.');
}
async function attest(key,text,evidencePage=page) {
  if(attestMode==='screenshot') {
    try {
      if(controlCheckpointActions[key])await runControl(key,controlCheckpointActions[key]);
      if(key==='storageFailureIsolation'){await verifyStorageFailure(key);evidencePage=page;}
      await evidencePage.screenshot({path:join(out,`attest-${key}.png`),fullPage:true});
      summary.checks[key]='conductor-screenshot';
      summary.attestations[key]=text;
    }finally{
      if(key==='storageFailureIsolation'){
        const restored=await runControl(key,'storage-restore');await runControl(key,'restart');await launch();
        const state=await bridge('/embed-governance/state');
        assert.equal(state.problem,null);assert.equal(state.available,true);
        restored.ok=true;restored.observed=true;
      }
    }
    return;
  }
  assert.equal((await terminal.question(text+' Type yes when verified: ')).trim(),'yes');
  summary.checks[key]=true;
}
async function launch() {
  // Screenshot mode retains the relevant page across external restart checkpoints.
  // Close it only after those screenshots, before launching the next context.
  await context?.close();context=null;workspace=null;
  context=await chromium.launchPersistentContext(profile,{headless:false,viewport:{width:420,height:900},args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`,'--no-first-run','--no-default-browser-check'],...(env.RESONANTOS_LIVE_CHROME_PATH?{executablePath:env.RESONANTOS_LIVE_CHROME_PATH}:{})});
  await context.addInitScript(()=>{
    window.__embedProtocol={status:false,online:false,conversationId:false,conversationChanged:false,replyStarted:false,replyFinished:false,toolSuccess:false,toolError:false};
    window.addEventListener('message',event=>{
      const frame=document.querySelector('#embed-root iframe');if(!frame||event.source!==frame.contentWindow||event.origin!==new URL(frame.src).origin)return;
      const d=event.data,p=window.__embedProtocol;
      if(d?.type==='augmentor-status'){
        if(typeof d.online!=='boolean'||typeof d.busy!=='boolean')return;
        p.status=true;p.online=d.online;
        if(typeof d.sessionId==='string'&&[...d.sessionId].length>=1&&[...d.sessionId].length<=128&&!/[\x00-\x1f\x7f]/.test(d.sessionId))p.conversationId=true;
      }
      if(d?.type==='augmentor-event'){
        if(d.event==='session.changed'&&typeof d.data?.sessionId==='string'&&[...d.data.sessionId].length>=1&&[...d.data.sessionId].length<=128&&!/[\x00-\x1f\x7f]/.test(d.data.sessionId))p.conversationChanged=true;
        if(d.event==='turn.started')p.replyStarted=true;
        if(d.event==='turn.finished')p.replyFinished=true;
        if(d.event==='tool.completed'&&d.data?.tool==='probe_read'){
          if(d.data.isError===false)p.toolSuccess=true;if(d.data.isError===true)p.toolError=true;
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
  await page.waitForFunction(()=>window.__embedProtocol.online===true,null,{timeout:90000});
  await page.evaluate(()=>{const p=window.__embedProtocol;p.conversationChanged=false;p.replyStarted=false;p.replyFinished=false;p.toolSuccess=false;p.toolError=false;});
  const observed={toolSuccess:false,toolError:false};
  for(const fail of [false,true]) {
    assert.equal(await page.evaluate(fail=>{
      const p=window.__embedProtocol;p.replyFinished=false;p.toolSuccess=false;p.toolError=false;
      return window.__resonantosEmbed.send({type:'augmentor-prompt',requestId:crypto.randomUUID(),text:fail
        ?'Call probe_read exactly once with fail true. This intentional fixed error is expected; do not retry or call any other tool. Then finish your reply.'
        :'Call probe_read exactly once with no arguments. Do not call any other tool. Then finish your reply.',send:true,fresh:!fail});
    },fail),true);
    await page.waitForFunction(fail=>{const p=window.__embedProtocol;return p.replyFinished&&(fail?p.toolError&&!p.toolSuccess:p.toolSuccess&&!p.toolError);},fail,{timeout:180000});
    const turn=await page.evaluate(()=>({...window.__embedProtocol}));
    observed.toolSuccess ||= turn.toolSuccess;observed.toolError ||= turn.toolError;
  }
  await attest('upstreamExercise','Verify the fresh conversation, completed replies, and probe_read success and intentional error in the real harness. Do not enter credentials or perform an external mutation.');
  summary.protocol={...await page.evaluate(()=>({...window.__embedProtocol})),...observed};
  assert.deepEqual(summary.protocol,{status:true,online:true,conversationId:true,conversationChanged:true,replyStarted:true,replyFinished:true,toolSuccess:true,toolError:true},'EMBED-UPSTREAM-1 failed: a required field/event is absent. Stop mapping implementation; obtain a reviewed narrow spec update.');
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
  await workspace.locator('.rail-settings[data-workspace=settings]').click();
  await workspace.getByRole('button',{name:/Privacy/}).click();
  await workspace.getByText('Embedded harness activity',{exact:true}).waitFor();
  return workspace.locator('[data-embed-activity]');
}
async function recording(card,enabled) {
  // The card shows only durable host state: a click reverts and disables the box
  // until the bridge confirms, so setChecked() cannot observe the change.
  await card.locator('input[type=checkbox]:not([disabled])').waitFor();
  const box=card.getByLabel('Record harness activity');
  if(await box.isChecked()!==enabled)await box.click();
  await card.getByText(enabled?'Recording is on':'Recording is off',{exact:true}).waitFor();
  await card.locator('input[type=checkbox]:not([disabled])').waitFor();
  assert.equal(await box.isChecked(),enabled);
}
// Sharing before the harness reports online is correctly refused ('Assistant offline');
// every share follows a launch, so wait for the relay status first.
async function clickPage(){await page.waitForFunction(()=>window.__embedProtocol?.online===true,null,{timeout:90000});await page.evaluate(()=>{const n=document.querySelector('.embed-bar-notice');if(n)n.textContent='';});await page.locator('[data-control=page]').click();}
async function durable(){return JSON.parse(await readFile(statePath,'utf8'));}
async function choose(mode) {
  await page.locator('[data-control=assistant]').click();
  await Promise.all([page.waitForNavigation(),page.locator(`[data-mode=${mode}]`).click()]);
}
async function verifyStorageFailure(key) {
  const damaged=await runControl(key,'storage-fail');await runControl(key,'restart');await launch();
  // An unreadable store is unavailable, not silently reset (governance design).
  const state=await bridge('/embed-governance/state');
  assert.equal(state.problem,'storage-unavailable');
  assert.equal(state.recordingEnabled,false);assert.equal(state.noticeAcknowledged,false);
  damaged.ok=true;damaged.observed=true;
  await page.waitForFunction(()=>window.__embedProtocol.online===true,null,{timeout:90000});
  await page.evaluate(()=>{const s=window.__resonantosEmbed,send=s.send;window.__storageShares=0;s.send=m=>{const ok=send(m);if(ok&&m?.type==='augmentor-context')window.__storageShares++;return ok;};});
  await clickPage();await page.getByRole('dialog').waitFor();
  await page.getByRole('button',{name:'Share page',exact:true}).click();
  // The persistence warning can replace Page shared before Playwright observes it.
  await page.waitForFunction(()=>window.__storageShares===1);
  assert.equal(await page.evaluate(()=>window.__storageShares),1);
  await page.getByText('Notice preference could not be saved. It may appear again.',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__resonantosEmbed.send({type:'augmentor-prompt',requestId:crypto.randomUUID(),text:'Reply with OK for the storage isolation check.',send:true})),true);
  const card=await privacy();await card.getByText('Recording unavailable',{exact:true}).waitFor();
  await page.bringToFront();
  await choose('normal');await page.locator('#command-input').waitFor();
  await choose('embed');await page.waitForFunction(()=>window.__resonantosEmbed?.ready);
}
function keyboardCheck(name,value) {
  summary.checks.keyboard ??= {};
  summary.checks.keyboard[name]=value===true;
  assert.equal(summary.checks.keyboard[name],true,'keyboard.'+name);
}
async function keyboard() {
  await page.bringToFront();
  // Design literals must not shrink when a required control disappears.
  const expectedControls=['workspace','assistant','page','approvals','tier','status'];
  const actualControls=await page.locator('#resonantos-bar [data-control], #resonantos-bar [data-tier]').evaluateAll(nodes=>nodes.map(n=>n.hasAttribute('data-tier')?'tier':n.dataset.control));
  keyboardCheck('expectedControls',JSON.stringify(actualControls)===JSON.stringify(expectedControls));
  // Status remains a live text label, not an interactive tooltip/tab-order target.
  const interactive='#resonantos-bar :is(button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"]))[data-control]';
  const targets=['workspace','assistant','page','approvals','tier'];
  const resetFocus=()=>page.evaluate(()=>{
    const body=document.body,previous=body.getAttribute('tabindex');
    body.setAttribute('tabindex','-1');body.focus();
    if(previous===null)body.removeAttribute('tabindex');else body.setAttribute('tabindex',previous);
  });
  const pointerAway=()=>page.mouse.move(0,page.viewportSize().height-1);
  await pointerAway();await resetFocus();
  const badge=page.locator('#resonantos-bar [data-tier]');
  const description=await badge.getAttribute('aria-describedby');
  const tooltip=description?page.locator('[id='+JSON.stringify(description)+']'):null;
  keyboardCheck('badgeInitiallyHidden',Boolean(tooltip&&await tooltip.count()===1&&!await tooltip.isVisible()));
  const blurred=await page.locator(`${interactive}, #resonantos-bar [data-tier]`).evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>{
    const s=getComputedStyle(n);
    return [n.hasAttribute('data-tier')?'tier':n.dataset.control,{outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,boxShadow:s.boxShadow}];
  })));
  const visited=[],indicators=[];
  for(let i=0;i<targets.length+2;i++) {
    await page.keyboard.press('Tab');
    const focus=await page.evaluate(blurred=>{
      const n=document.activeElement;
      if(!n?.closest('#resonantos-bar')||!n.matches('[data-control], [data-tier]'))return null;
      const name=n.hasAttribute('data-tier')?'tier':n.dataset.control,s=getComputedStyle(n),before=blurred[name];
      const background=getComputedStyle(document.querySelector('#resonantos-bar')).backgroundColor;
      const changedOutline=before&&(s.outlineStyle!==before.outlineStyle||s.outlineWidth!==before.outlineWidth||s.outlineColor!==before.outlineColor);
      return {name,visible:Boolean(before&&n.matches(':focus-visible')&&(
        (s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0&&s.outlineColor!==background&&changedOutline)||s.boxShadow!==before.boxShadow))};
    },blurred);
    if(focus){visited.push(focus.name);indicators.push(focus.visible);}
    if(visited.length===targets.length)break;
  }
  keyboardCheck('tabOrder',JSON.stringify(visited)===JSON.stringify(targets));
  keyboardCheck('visibleFocus',indicators.length===targets.length&&indicators.every(Boolean));
  // CDP returns Chromium's computed name, excluding aria-hidden descendants.
  const cdp=await context.newCDPSession(page);
  let named=true;
  try {
    const {root}=await cdp.send('DOM.getDocument');
    for(const name of targets) {
      const selector=name==='tier'?'#resonantos-bar [data-tier]':`#resonantos-bar [data-control="${name}"]`;
      const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});
      const {nodes}=await cdp.send('Accessibility.getPartialAXTree',{nodeId,fetchRelatives:false});
      named=Boolean(nodes[0]&&!nodes[0].ignored&&nodes[0].name?.value?.trim())&&named;
    }
  } finally {await cdp.detach();}
  keyboardCheck('accessibleNames',named);
  keyboardCheck('tooltips',await page.locator(interactive).evaluateAll(nodes=>nodes.length>0&&nodes.every(n=>Boolean(n.getAttribute('title')?.trim()))));
  const tabTo=async target=>{
    await resetFocus();
    for(let i=0;i<targets.length+2;i++) {
      await page.keyboard.press('Tab');
      if(await target.evaluate(n=>document.activeElement===n))return;
    }
    assert.fail('Keyboard could not reach control');
  };
  await tabTo(badge);
  keyboardCheck('badgeDescription',await tooltip.isVisible()&&
    (await tooltip.textContent()).trim()==='Augmentor runs outside ResonantOS approvals. Its own approvals cover its tools. ResonantOS access still requires separate permission.');
  await page.keyboard.press('Escape');
  keyboardCheck('badgeEscape',!await tooltip.isVisible());
  await tabTo(badge);
  keyboardCheck('badgeRefocus',await tooltip.isVisible());
  await page.keyboard.press('Tab');
  keyboardCheck('badgeBlur',!await tooltip.isVisible());
  await pointerAway();await badge.hover();
  keyboardCheck('badgeHover',await tooltip.isVisible());
  // Leave by two realistic paths: onto the bar, and a stepped move down into the
  // harness frame. A single-event jump from the badge straight into the
  // cross-origin frame delivers no boundary event to this document at all
  // (conductor evidence 2026-10-17: zero mouseleave/mouseout/pointerleave/blur),
  // so no parent listener can observe it; that browser limit is documented.
  const box=await badge.boundingBox(),frame=await page.locator('#embed-root iframe').boundingBox();
  await page.mouse.move(2,box.y+box.height/2,{steps:6});
  const leftToBar=!await tooltip.isVisible();
  await badge.hover();
  await page.mouse.move(box.x+box.width/2,frame.y+40,{steps:8});
  keyboardCheck('badgeLeave',leftToBar&&!await tooltip.isVisible());
  const assistant=page.locator('#resonantos-bar [data-control=assistant]');
  await tabTo(assistant);await page.keyboard.press('Enter');
  const menu=page.getByRole('menu',{name:'Assistant',exact:true});
  keyboardCheck('assistantOpen',await menu.isVisible());
  keyboardCheck('assistantFocusEntered',await menu.evaluate(n=>n.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  keyboardCheck('assistantEscape',!await menu.isVisible()&&await assistant.getAttribute('aria-expanded')==='false');
  keyboardCheck('assistantFocusRestored',await assistant.evaluate(n=>document.activeElement===n));
  const status=page.locator('#resonantos-bar [data-control=status]');
  keyboardCheck('statusLabel',await status.evaluate(n=>{
    return Boolean((n.getAttribute('aria-label')||n.textContent).trim())&&!n.closest('[aria-hidden="true"],[hidden]')&&getComputedStyle(n).visibility==='visible';
  }));
  keyboardCheck('statusTooltip',await status.evaluate(n=>{
    const title=n.getAttribute('title'),label=n.querySelector('.embed-status-text')?.textContent;
    return Boolean(title?.trim()&&title===label&&n.getAttribute('aria-label')===`Status: ${label}`);
  }));
  const viewport=page.viewportSize();
  await page.emulateMedia({reducedMotion:'reduce'});
  const motion=[];
  try {
    for(const width of [320,420]) {
      await page.setViewportSize({width,height:viewport.height});
      motion.push(await page.evaluate(()=>{
        const seconds=value=>value.trim().endsWith('ms')?parseFloat(value)/1000:parseFloat(value);
        const bar=document.querySelector('#resonantos-bar');
        const nodes=bar?[bar,...bar.querySelectorAll('*')]:[];
        return matchMedia('(prefers-reduced-motion: reduce)').matches&&nodes.length>0&&nodes.every(n=>[null,'::before','::after'].every(pseudo=>{
          const s=getComputedStyle(n,pseudo);
          return (s.animationName.split(',').every(v=>v.trim()==='none')||s.animationDuration.split(',').every(v=>seconds(v)===0))&&
            s.transitionDuration.split(',').every(v=>seconds(v)<=0.01);
        }));
      }));
    }
  } finally {await page.setViewportSize(viewport);}
  keyboardCheck('reducedMotion',motion.length===2&&motion.every(Boolean));
}
async function keyboardConsent() {
  const before=await page.evaluate(()=>window.__localShares);
  await clickPage();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  const cancel=dialog.getByRole('button',{name:'Cancel',exact:true});
  const share=dialog.getByRole('button',{name:'Share page',exact:true});
  keyboardCheck('consentInitialFocus',await cancel.evaluate(n=>document.activeElement===n));
  let trapped=true;
  // Check both boundaries and repeated cycles, not merely one interior Tab.
  for(let i=0;i<3;i++) {
    await page.keyboard.press('Tab');
    trapped=await share.evaluate(n=>document.activeElement===n)&&trapped;
    await page.keyboard.press('Tab');
    trapped=await cancel.evaluate(n=>document.activeElement===n)&&trapped;
  }
  await page.keyboard.press('Shift+Tab');
  trapped=await share.evaluate(n=>document.activeElement===n)&&trapped;
  await page.keyboard.press('Shift+Tab');
  trapped=await cancel.evaluate(n=>document.activeElement===n)&&trapped;
  keyboardCheck('consentFocusTrap',trapped);
  // Exercise the focusin guard independently of the keyboard Tab handler.
  await page.locator('#resonantos-bar [data-control=assistant]').focus();
  keyboardCheck('consentExternalFocusTrap',await dialog.evaluate(n=>n.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  keyboardCheck('consentEscape',!await dialog.isVisible());
  keyboardCheck('consentNoShare',await page.evaluate(()=>window.__localShares)===before);
  // Page is re-enabled and focused by the async share action's finally handler.
  await page.locator('#resonantos-bar [data-control=page]:not([disabled])').waitFor();
  keyboardCheck('consentFocusRestored',await page.locator('#resonantos-bar [data-control=page]').evaluate(n=>document.activeElement===n));
}
async function closeForRestart() {
  // External stop/restart instructions still require conductor action and owner
  // review; a screenshot records the UI, not proof that a process was restarted.
  if(attestMode==='screenshot')return;
  await context.close();context=null;
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
    await attest('keyboardAndLayout','Verify layout only: the harness panel looks unchanged. Keyboard and accessibility are automated.');
    await keyboard();
    await page.evaluate(()=>{const s=window.__resonantosEmbed,send=s.send;window.__localShares=0;s.send=m=>{const ok=send(m);if(ok&&m?.type==='augmentor-context')window.__localShares++;return ok;};});
    await keyboardConsent();
    await clickPage();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>window.__localShares),0);
    await clickPage();await page.getByRole('button',{name:'Share page',exact:true}).click();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__localShares),1);
    const inner=page.frames().find(f=>f.parentFrame()?.parentFrame()===page.mainFrame()&&new URL(f.url()).pathname.startsWith('/embed/'));assert.ok(inner);
    const before=await inner.getByText(fixtureTitle,{exact:true}).count();
    assert.equal(await page.evaluate(()=>window.__resonantosEmbed.send({type:'augmentor-prompt',requestId:crypto.randomUUID(),text:'What is the title of the page shared by ResonantOS? Reply with exactly that title and no other text.',send:true,fresh:true})),true);
    await inner.getByText(fixtureTitle,{exact:true}).nth(before).waitFor({timeout:180000});summary.checks.fixtureReply=true;
    assert.deepEqual((await bridge('/embed-governance/events')).events,[]);
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
    await closeForRestart();
    await attest('restartSameRecipient','Restart the spike bridge with the SAME external user root and upstream origin, refresh the disposable extension configuration, and leave recording off.');
    await launch();await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
    let card=await privacy();await recording(card,true);await page.bringToFront();await page.waitForTimeout(5200);await protocol();
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();
    await page.waitForTimeout(2200);
    const stored=await durable(),events=(await bridge('/embed-governance/events')).events;
    assert.ok(events.some(r=>r.event.kind==='page-shared'&&r.event.domain==='127.0.0.1'));
    for(const kind of ['conversation-changed','reply-started','reply-finished','tool-finished'])assert.ok(events.some(r=>r.event.kind===kind),kind);
    for(const error of [true,false])assert.ok(events.some(r=>r.event.kind==='tool-finished'&&r.event.toolName==='probe_read'&&r.event.error===error));
    for(const r of stored.events){assert.equal(Object.hasOwn(r,'conversationId'),false);assert.equal(Object.hasOwn(r.event,'conversationId'),false);assert.equal(Object.hasOwn(r.event,'text'),false);assert.equal(Object.hasOwn(r.event,'url'),false);assert.equal(Object.hasOwn(r.event,'title'),false);}
    assert.equal(JSON.stringify(stored).includes(fixtureTitle),false);assert.equal(JSON.stringify(stored).includes('canary'),false);summary.checks.domainOnly=true;
    await workspace.bringToFront();await card.getByRole('button',{name:'View activity',exact:true}).click();await card.getByText(/Page shared: 127.0.0.1/).waitFor();
    await recording(card,false);const count=(await durable()).events.length;await page.bringToFront();await clickPage();await page.waitForTimeout(2200);assert.equal((await durable()).events.length,count);
    await workspace.bringToFront();await card.getByRole('button',{name:'Delete activity',exact:true}).click();await workspace.getByRole('dialog').getByRole('button',{name:'Delete activity',exact:true}).click();await card.getByText('Activity deleted',{exact:true}).waitFor();
    assert.deepEqual((await durable()).events,[]);assert.ok(Object.keys((await durable()).notices).length>0);
    await closeForRestart();
    await attest('restartAfterDeletion','Restart the bridge with the same test root and recipient; refresh the disposable extension configuration.',workspace);
    await launch();assert.deepEqual((await bridge('/embed-governance/events')).events,[]);assert.equal((await bridge('/embed-governance/state')).noticeAcknowledged,true);
    await clickPage();await page.getByText('Page shared',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);summary.checks.deleteSurvivesRestart=true;
    await closeForRestart();
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
  terminal?.close();await context?.close();fixture.closeAllConnections();if(fixture.listening)await new Promise(r=>fixture.close(r));await rm(profile,{recursive:true,force:true});
  await writeFile(join(out,'embed-governance-summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});
}
console.log(JSON.stringify(summary));
