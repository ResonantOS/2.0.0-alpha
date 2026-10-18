import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createContext, runInContext, runInNewContext } from 'node:vm';

const source=readFileSync(new URL('./embed-live.mjs',import.meta.url),'utf8');
// Evaluate only the attestation declarations with fake I/O. Never import the live runner.
function attestationHarness(mode,{answer='yes',screenshotError=false}={}) {
  const calls={questions:[],screenshots:[],terminals:0};
  const evidencePage={screenshot:async options=>{calls.screenshots.push(options);if(screenshotError)throw Error('Screenshot failed');}};
  const declarations=['attestMode','terminal','summary','controlCheckpointActions'].map(name=>{
    const match=source.match(new RegExp('^const '+name+'=.*;$','m'));
    assert.ok(match,'missing '+name+' declaration');return match[0];
  }).join('\n');
  const fn=source.match(/async function attest\([\s\S]*?\n(?=async function launch\()/);
  assert.ok(fn,'missing isolated attestation function');
  const api=runInNewContext(`${declarations}\n${fn[0]}\n({attest,summary})`,{
    env:mode===undefined?{}:{RESONANTOS_EMBED_LIVE_ATTEST:mode},stage:'integration',version:'fixture',
    runControl:async()=>({}),bridge:async()=>({problem:null,available:true}),verifyStorageFailure:async()=>{},launch:async()=>{},
    assert,out:'/proof',page:evidencePage,stdin:{},stdout:{},join:(...parts)=>parts.join('/'),
    createInterface:()=>{calls.terminals++;return {question:async text=>{calls.questions.push(text);return answer;}};},
  });
  return {...api,calls,evidencePage};
}

test('default attestation still requires a human yes',async()=>{
  const h=attestationHarness();await h.attest('recipient','Verify recipient');
  assert.equal(h.calls.terminals,1);assert.equal(h.calls.questions.length,1);
  assert.match(h.calls.questions[0],/Type yes when verified/);
  assert.equal(h.summary.checks.recipient,true);assert.equal(h.calls.screenshots.length,0);
  const declined=attestationHarness(undefined,{answer:'no'});
  await assert.rejects(declined.attest('recipient','Verify recipient'));
  assert.equal(Object.hasOwn(declined.summary.checks,'recipient'),false);
});

test('screenshot attestations never read stdin or become human true checks',async()=>{
  const h=attestationHarness('screenshot');
  const keys=[...source.matchAll(/await attest\('([^']+)'/g)].map(match=>match[1]);
  assert.ok(keys.length>0);
  for(const key of keys){
    await h.attest(key,'Review '+key);
    assert.equal(h.summary.checks[key],'conductor-screenshot');
    assert.equal(h.summary.attestations[key],'Review '+key);
    assert.equal(h.calls.screenshots.at(-1).path,`/proof/attest-${key}.png`);
  }
  assert.equal(h.calls.terminals,0);assert.equal(h.calls.questions.length,0);
  assert.equal(Object.values(h.summary.checks).includes(true),false);
  assert.equal(h.summary.attestationStatus,'conductor-verified screenshots pending owner review');
  const relevant=[];
  await h.attest('workspace','Review activity',{screenshot:async options=>relevant.push(options.path)});
  assert.deepEqual(relevant,['/proof/attest-workspace.png']);
});

test('a failed screenshot cannot record a verified check',async()=>{
  const h=attestationHarness('screenshot',{screenshotError:true});
  await assert.rejects(h.attest('recipient','Verify recipient'),/Screenshot failed/);
  assert.equal(Object.hasOwn(h.summary.checks,'recipient'),false);
  assert.equal(Object.hasOwn(h.summary.attestations,'recipient'),false);
});

test('restart checkpoints retain screenshot pages and close them before relaunch',async()=>{
  const close=source.match(/async function closeForRestart\(\) \{[\s\S]*?\n\}/)?.[0];
  const launchPrefix=source.match(/async function launch\(\) \{([\s\S]*?)  context=await chromium/)?.[1];
  assert.ok(close);assert.ok(launchPrefix);
  for(const attestMode of ['human','screenshot']) {
    let closed=0;
    const h=runInNewContext(`${close}\n({closeForRestart,relaunchCleanup:async()=>{${launchPrefix}},state:()=>({context,workspace})})`,{
      attestMode,context:{close:async()=>{closed++;}},workspace:{},
    });
    await h.closeForRestart();
    assert.equal(closed,attestMode==='human'?1:0);
    if(attestMode==='screenshot')assert.ok(h.state().context);
    await h.relaunchCleanup();assert.equal(closed,1);
    assert.equal(h.state().context,null);assert.equal(h.state().workspace,null);
  }
  assert.match(source,/attest\('restartAfterDeletion',[^\n]*,workspace\)/);
  assert.match(source,/terminal\?\.close\(\)/);
});

test('tool proof requests both probe outcomes through the existing prompt relay',()=>{
  const protocol=source.match(/async function protocol\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(protocol);
  assert.match(protocol,/probe_read/);assert.match(protocol,/fail[^\n]*true/);
  assert.match(protocol,/type:'augmentor-prompt'/);assert.match(protocol,/send:true/);
  assert.match(protocol,/for\(const fail of \[false,true\]\)/);
  assert.match(protocol,/waitForFunction/);
  assert.match(source,/d\.data\?\.tool==='probe_read'/);
});
test('live proof is syntax-valid, conductor-owned and checks every required upstream field',()=>{
  const path=new URL('./embed-live.mjs',import.meta.url),source=readFileSync(path,'utf8');
  const syntax=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8',shell:false});assert.equal(syntax.status,0,syntax.stderr);
  for(const text of ['EMBED-UPSTREAM-1','RESONANTOS_EMBED_LIVE_USER_ROOT','RESONANTOS_EMBED_LIVE_VERSION','sessionId','session.changed','turn.started','turn.finished','tool.completed','isError','toolSuccess','toolError'])assert.ok(source.includes(text),text);
  assert.ok(source.includes('p.conversationId=true'));
  assert.equal(source.includes('state.last.push(event.data)'),false);
  assert.equal(source.includes('__barProofContexts'),false);
  assert.ok(source.includes("stage==='upstream'"));
  assert.ok(source.includes("assert.ok(slots&&typeof slots==='object')"));
});


// Execute only our observer with inert window/document objects, never upstream code.
function protocolObserver() {
  const init=source.match(/await context.addInitScript\(\(\)=>\{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(init);
  let listener;
  const frame={contentWindow:{},src:'http://127.0.0.1:9/embed/'};
  const window={addEventListener:(type,fn)=>{assert.equal(type,'message');listener=fn;}};
  runInNewContext(init,{window,document:{querySelector:()=>frame},URL});
  return {window,relay:(data,source=frame.contentWindow,origin='http://127.0.0.1:9')=>listener({data,source,origin})};
}

test('live observer accepts the pinned upstream shapes and retains only booleans',()=>{
  const h=protocolObserver(),p=h.window.__embedProtocol;
  h.relay({type:'augmentor-status',online:true,busy:false,sessionId:'CANARY'});
  assert.equal(p.status,true);assert.equal(p.online,true);assert.equal(p.conversationId,true);
  h.relay({type:'augmentor-event',event:'session.changed',data:{sessionId:'CANARY'}});
  h.relay({type:'augmentor-event',event:'turn.started',data:{sessionId:'CANARY'}});
  h.relay({type:'augmentor-event',event:'turn.finished',data:{sessionId:'CANARY',reason:'completed'}});
  for(const isError of ['false',0,null,undefined])h.relay({type:'augmentor-event',event:'tool.completed',data:{tool:'probe_read',isError}});
  assert.equal(p.toolSuccess,false);assert.equal(p.toolError,false);
  h.relay({type:'augmentor-event',event:'tool.completed',data:{sessionId:'CANARY',tool:'other_tool',isError:false}});
  assert.equal(p.toolSuccess,false);
  for(const isError of [false,true])h.relay({type:'augmentor-event',event:'tool.completed',data:{sessionId:'CANARY',tool:'probe_read',isError,arguments:'CANARY',result:'CANARY'}});
  assert.ok(Object.values(p).every(value=>value===true));
  assert.equal(JSON.stringify(p).includes('CANARY'),false);
  h.relay({type:'augmentor-status',online:false,busy:false});assert.equal(p.online,false);
  h.relay({type:'augmentor-status',online:true,busy:false},{},'http://127.0.0.1:9');assert.equal(p.online,false);
  h.relay({type:'augmentor-status',online:true,busy:false},undefined,'http://evil');assert.equal(p.online,false);
});

test('protocol waits for a valid online status before sending its first prompt',async()=>{
  const h=protocolObserver();
  const fn=source.match(/async function protocol\(\) \{[\s\S]*?\n\}/)?.[0];assert.ok(fn);
  const pending=[],sent=[],summary={checks:{}};
  const context=createContext({window:h.window,summary,assert,attest:async()=>{},crypto:{randomUUID:()=> 'fixture'}});
  const page={
    evaluate:async(fn,arg)=>{context.arg=arg;return runInContext('('+fn.toString()+')(arg)',context);},
    waitForFunction:(fn,arg)=>new Promise(resolve=>pending.push({fn,arg,resolve})),
  };
  h.window.__resonantosEmbed={send:message=>{sent.push(message);return true;}};
  context.page=page;
  const run=runInContext(fn+';protocol',context);
  const done=run();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,0);assert.equal(pending.length,1);
  const ready=pending.shift();
  const satisfied=()=>runInNewContext('('+ready.fn.toString()+')(arg)',{window:h.window,arg:ready.arg});
  assert.equal(satisfied(),false);
  h.relay({type:'augmentor-ready'});assert.equal(satisfied(),false);
  h.relay({type:'augmentor-status',online:false,busy:false});assert.equal(satisfied(),false);
  h.relay({type:'augmentor-status',online:true,busy:'false'});assert.equal(satisfied(),false);
  h.relay({type:'augmentor-status',online:true,busy:false,sessionId:'CANARY'});assert.equal(satisfied(),true);
  ready.resolve();
  for(const isError of [false,true]) {
    await new Promise(resolve=>setImmediate(resolve));
    h.relay({type:'augmentor-event',event:'session.changed',data:{sessionId:'CANARY'}});
    h.relay({type:'augmentor-event',event:'turn.started',data:{sessionId:'CANARY'}});
    h.relay({type:'augmentor-event',event:'tool.completed',data:{sessionId:'CANARY',tool:'probe_read',isError}});
    h.relay({type:'augmentor-event',event:'turn.finished',data:{sessionId:'CANARY',reason:'completed'}});
    const next=pending.shift();assert.ok(next);
    assert.equal(runInNewContext('('+next.fn.toString()+')(arg)',{window:h.window,arg:next.arg}),true);
    next.resolve();
  }
  await done;assert.equal(sent.length,2);assert.equal(summary.checks.upstream,true);
});

// Source contracts deliberately do not import or execute the live runner.
const controlContracts = [
  ['startup gate precedes external output/profile creation', /const control=await validateControl\(\);[\s\S]*const out=await external/],
  ['control is required only for screenshot integration', /async function validateControl\(\) \{\s*if\(attestMode!=='screenshot'\|\|stage!=='integration'\)return null;/],
  ['control reuses external path validation', /await external\('RESONANTOS_EMBED_LIVE_CONTROL'\)/],
  ['control must be a regular executable', /assert\.ok\(\(await lstat\(value\)\)\.isFile\(\)\);\s*await access\(value,constants\.X_OK\)/],
  ['invalid control has a fixed startup error', /catch\{throw new Error\('Screenshot integration requires a valid external executable RESONANTOS_EMBED_LIVE_CONTROL\.'\);\}/],
  ['restartSameRecipient executes restart', /restartSameRecipient:'restart'/],
  ['restartAfterDeletion executes restart', /restartAfterDeletion:'restart'/],
  ['stoppedForRetention executes stop', /stoppedForRetention:'stop'/],
  ['restartedForRetention executes start', /restartedForRetention:'start'/],
  ['mapped actions run before screenshots', /if\(controlCheckpointActions\[key\]\)await runControl\(key,controlCheckpointActions\[key\]\);[\s\S]*await evidencePage\.screenshot/],
  ['control uses execFile argv and a two minute timeout', /execFile\(control,\[action\],\{timeout:120000\},error=>error\?reject\(error\):resolve\(\)\)/],
  ['action results are ordered and include failures', /const result=\{key,action,ok:false\};summary\.controlActions\.push\(result\);[\s\S]*result\.ok=true/],
  ['storage checkpoint verifies before capturing the current relaunched page', /if\(key==='storageFailureIsolation'\)\{await verifyStorageFailure\(key\);evidencePage=page;\}/],
  ['storage cleanup runs even when verification fails', /finally\{\s*if\(key==='storageFailureIsolation'\)\{\s*const restored=await runControl\(key,'storage-restore'\);await runControl\(key,'restart'\);await launch\(\);[\s\S]*assert\.equal\(state\.problem,null\);assert\.equal\(state\.available,true\);/],
  ['storage damage is reopened before verification', /async function verifyStorageFailure\(key\) \{\s*const damaged=await runControl\(key,'storage-fail'\);await runControl\(key,'restart'\);await launch\(\);/],
  ['unreadable store reports its fixed problem', /assert\.equal\(state\.problem,'storage-unavailable'\)/],
  ['unreadable store is recording off', /assert\.equal\(state\.recordingEnabled,false\)/],
  ['unreadable notice state is unacknowledged', /assert\.equal\(state\.noticeAcknowledged,false\)/],
  ['storage failure still requires explicit share consent', /await clickPage\(\);await page\.getByRole\('dialog'\)\.waitFor\(\);/],
  ['storage failure checks actual local Page dispatch', /assert\.equal\(await page\.evaluate\(\(\)=>window\.__storageShares\),1\)/],
  ['failed notice persistence is visible', /await page\.getByText\('Notice preference could not be saved. It may appear again.',\{exact:true\}\)\.waitFor\(\)/],
  ['chat dispatch has requestId and must return true during failure', /requestId:crypto\.randomUUID\(\),text:'Reply with OK for the storage isolation check.',send:true\}\)\),true\)/],
  ['Workspace remains responsive during storage failure', /const card=await privacy\(\);await card\.getByText\('Recording unavailable',\{exact:true\}\)\.waitFor\(\)/],
  ['Assistant switches both ways before storage screenshot', /await choose\('normal'\);await page\.locator\('#command-input'\)\.waitFor\(\);\s*await choose\('embed'\);await page\.waitForFunction\(\(\)=>window\.__resonantosEmbed\?\.ready\);\s*\}/],
];
for(const [name,pattern] of controlContracts)test('control contract: '+name,()=>assert.match(source,pattern));

async function exerciseProtocol(outcomes) {
  const h=protocolObserver(),summary={checks:{}};
  h.relay({type:'augmentor-status',online:true,busy:false,sessionId:'fixture'});
  let turn=0;
  const context=createContext({window:h.window,summary,assert,attest:async()=>{},crypto:{randomUUID:()=> 'fixture'}});
  h.window.__resonantosEmbed={send:()=>{
    h.relay({type:'augmentor-event',event:'session.changed',data:{sessionId:'fixture'}});
    h.relay({type:'augmentor-event',event:'turn.started'});
    for(const isError of outcomes[turn++])h.relay({type:'augmentor-event',event:'tool.completed',data:{tool:'probe_read',isError}});
    h.relay({type:'augmentor-event',event:'turn.finished'});return true;
  }};
  context.page={
    evaluate:async(fn,arg)=>{context.arg=arg;return runInContext('('+fn.toString()+')(arg)',context);},
    waitForFunction:async(fn,arg)=>{context.arg=arg;if(!runInContext('('+fn.toString()+')(arg)',context))throw Error('Predicate timed out');},
  };
  const fn=source.match(/async function protocol\(\) \{[\s\S]*?\n\}/)[0];
  await runInContext(fn+';protocol()',context);return summary;
}
test('protocol rejects an error turn with no tool event',async()=>{
  await assert.rejects(exerciseProtocol([[false],[]]),/Predicate timed out/);
});
test('protocol rejects mixed first-turn outcomes followed by no tool event',async()=>{
  await assert.rejects(exerciseProtocol([[false,true],[]]),/Predicate timed out/);
});
test('protocol retains cumulative success and error from separate valid turns',async()=>{
  const summary=await exerciseProtocol([[false],[true]]);
  assert.equal(summary.protocol.toolSuccess,true);assert.equal(summary.protocol.toolError,true);
});

function controlHarness({rotate=true,connected=true,refused=true,bytesOnly=false,oldAccepted=false,newRejected=false}={}) {
  let generation=0,acted=false,clock=0;
  const summary={controlActions:[]},reads=[],connections=[],requests=[];
  const start=source.includes('async function controlConfig(')?source.indexOf('async function controlConfig('):source.indexOf('async function runControl(');
  const code=source.slice(start,source.indexOf('async function attest('));
  const api=runInNewContext(code+';({runControl})',{
    assert,summary,control:'/fake/control',extensionPath:'/external/extension',join:(...p)=>p.join('/'),createHash,
    readFile:async path=>{reads.push({path,acted});return 'globalThis.__RESONANTOS_BRIDGE_CONFIG__ = Object.freeze('+JSON.stringify({bridgeUrl:'http://127.0.0.1:'+(4000+generation),bridgeToken:'fixture-'+generation})+');'+(bytesOnly&&acted?'\n':'');},
    execFile:(_file,args,_options,done)=>{acted=true;if(rotate&&args[0]!=='stop')generation++;done(null);},
    fetch:async(url,options)=>{requests.push({url,options});return {status:options.headers['X-ResonantOS-Bridge-Token']==='fixture-0'?(oldAccepted?403:401):(newRejected?401:403),body:{cancel:async()=>{}}};},
    AbortSignal,
    Date:{now:()=>clock},setTimeout:fn=>{clock+=1000;queueMicrotask(fn);},
    net:{connect:options=>{
      connections.push(options);const socket=new EventEmitter();socket.destroy=()=>{};socket.setTimeout=()=>{};
      queueMicrotask(()=>{if(connected)socket.emit('connect');else socket.emit('error',{code:refused?'ECONNREFUSED':'ETIMEDOUT'});});return socket;
    }},
  });return {...api,summary,reads,connections,requests};
}
for(const action of ['start','restart']) {
  test('control rejects exit-zero '+action+' without config rotation',async()=>{
    const h=controlHarness({rotate:false});await assert.rejects(h.runControl('fixture',action));
    assert.equal(h.summary.controlActions[0].ok,false);
  });
  test('control rejects '+action+' with file-byte-only changes',async()=>{
    const h=controlHarness({rotate:false,bytesOnly:true});await assert.rejects(h.runControl('fixture',action));
    assert.equal(h.summary.controlActions[0].observed,undefined);
  });
  test('control rejects '+action+' when the old process still accepts the old token',async()=>{
    const h=controlHarness({oldAccepted:true});await assert.rejects(h.runControl('fixture',action));
    assert.equal(h.summary.controlActions[0].observed,undefined);
  });
  test('control rejects '+action+' when the serving process rejects the new token',async()=>{
    const h=controlHarness({newRejected:true});await assert.rejects(h.runControl('fixture',action));
    assert.equal(h.summary.controlActions[0].observed,undefined);
  });
  test('control rejects '+action+' with rotation but no listener',async()=>{
    const h=controlHarness({connected:false});await assert.rejects(h.runControl('fixture',action));
  });
  test('control observes rotated config and TCP listener after '+action,async()=>{
    const h=controlHarness();await h.runControl('fixture',action);
    assert.deepEqual(JSON.parse(JSON.stringify(h.summary.controlActions)),[{key:'fixture',action,ok:true,observed:true}]);
    assert.equal(h.reads[0].acted,false);assert.equal(h.reads[0].path,'/external/extension/src/bridge-config.generated.js');
    assert.ok(h.connections.some(c=>c.host==='127.0.0.1'&&c.port===4001));
    assert.equal(JSON.stringify(h.summary).includes('fixture-'),false);
    assert.equal(h.requests.length,2);
    assert.ok(h.requests.every(r=>r.url==='http://127.0.0.1:4001/embed-governance/state'));
    assert.deepEqual(h.requests.map(r=>r.options.headers['X-ResonantOS-Bridge-Token']),['fixture-0','fixture-1']);
  });
}
test('control rejects exit-zero stop while listener remains',async()=>{
  await assert.rejects(controlHarness().runControl('fixture','stop'));
});
test('control requires connection refusal, not another socket error',async()=>{
  await assert.rejects(controlHarness({connected:false,refused:false}).runControl('fixture','stop'));
});
test('control observes connection refusal after stop',async()=>{
  const h=controlHarness({connected:false});await h.runControl('fixture','stop');
  assert.equal(h.summary.controlActions[0].observed,true);assert.equal(h.reads[0].acted,false);
});

for(const field of ['recordingEnabled','noticeAcknowledged']) {
  test('storage-fail remains unobserved when '+field+' assertion fails',async()=>{
    const fn=source.match(/async function verifyStorageFailure\(key\) \{[\s\S]*?\n\}/)[0];
    const damaged={ok:false};
    const run=runInNewContext(fn+';verifyStorageFailure',{
      assert,runControl:async()=>damaged,launch:async()=>{},
      bridge:async()=>({problem:'storage-unavailable',recordingEnabled:false,noticeAcknowledged:false,[field]:true}),
    });
    await assert.rejects(run('fixture'),{code:'ERR_ASSERTION'});
    assert.equal(damaged.ok,false);assert.equal(damaged.observed,undefined);
  });
}

const keyboardNames=['expectedControls','badgeInitiallyHidden','badgeRefocus','badgeBlur','badgeLeave','assistantFocusEntered','statusTooltip','consentExternalFocusTrap','tabOrder','visibleFocus','accessibleNames','tooltips','badgeDescription','badgeEscape','badgeHover','assistantOpen','assistantEscape','assistantFocusRestored','statusLabel','reducedMotion','consentInitialFocus','consentFocusTrap','consentEscape','consentNoShare','consentFocusRestored'];
test('keyboard step precedes first integration Page share and keeps layout screenshot',()=>{
  const integration=source.slice(source.indexOf("if(stage==='upstream')"));
  assert.ok(integration.indexOf('await keyboard();')>0);
  assert.ok(integration.indexOf('await keyboard();')<integration.indexOf('await clickPage();'));
  assert.match(integration,/attest\('keyboardAndLayout'/);
  assert.match(integration,/await keyboardConsent\(\);/);
});
test('keyboard records and asserts every required boolean, including false results',()=>{
  const fn=source.match(/function keyboardCheck\(name,value\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn,'missing keyboard assertion');
  for(const name of keyboardNames) {
    assert.ok(source.includes("keyboardCheck('"+name+"',"),name);
    const summary={checks:{}};
    const check=runInNewContext(fn+';keyboardCheck',{summary,assert});
    check(name,true);assert.equal(summary.checks.keyboard[name],true);
    assert.throws(()=>check(name,false),{name:'AssertionError'});
    assert.equal(summary.checks.keyboard[name],false);
  }
});
test('keyboard proof uses real key input and DOM focus, descriptions and computed motion',()=>{
  for(const text of ["page.keyboard.press('Tab')","page.keyboard.press('Shift+Tab')","page.keyboard.press('Escape')","page.keyboard.press('Enter')","document.activeElement",":focus-visible","outlineStyle","boxShadow","aria-describedby","animationName","transitionDuration","__localShares"])assert.ok(source.includes(text),text);
});

// Contract-level browser fake: execute only keyboard declarations, never the live runner.
// State faults model independent regressions; computed AX names are supplied by CDP,
// deliberately separate from DOM text (including aria-hidden descendants).
async function keyboardFixture(fault='', input=source, consent=false) {
  const { JSDOM }=await import('jsdom');
  const dom=new JSDOM(`<body><nav id="resonantos-bar">
    ${['workspace','assistant','page','approvals'].map(name=>`<button data-control="${name}" title="${name}" aria-label="${name}"><span aria-hidden="true">icon</span></button>`).join('')}
    <span data-tier="self-governed" tabindex="0" aria-describedby="tip">Self-governed</span>
    <span data-control="status" title="Online" aria-label="Status: Online"><span class="embed-status-text">Online</span></span>
    <span id="tip" hidden>Augmentor runs outside ResonantOS approvals. Its own approvals cover its tools. ResonantOS access still requires separate permission.</span>
    <div role="menu" aria-label="Assistant" hidden><button>Augmentor</button></div>
  </nav><button id="outside">Outside</button><div role="dialog" hidden><button>Cancel</button><button>Share page</button></div></body>`,{runScripts:'outside-only'});
  const w=dom.window,d=w.document,bar=d.querySelector('nav'),badge=d.querySelector('[data-tier]'),tip=d.querySelector('#tip'),assistant=d.querySelector('[data-control=assistant]'),menu=d.querySelector('[role=menu]'),dialog=d.querySelector('[role=dialog]');
  const visible=n=>Boolean(n&&!n.closest('[hidden]'));
  if(fault==='missing-control')d.querySelector('[data-control=approvals]').remove();
  if(fault==='extra-control')bar.insertAdjacentHTML('afterbegin','<button data-control="extra" title="extra" aria-label="extra">Extra</button>');
  if(fault==='status-title')d.querySelector('[data-control=status]').title='';
  if(fault==='status-mismatch')d.querySelector('[data-control=status]').title='Busy';
  if(fault==='hidden-name')assistant.removeAttribute('aria-label');
  if(fault==='badge-initial')tip.hidden=false;
  badge.addEventListener('focus',()=>{if(fault!=='badge-keyboard')tip.hidden=false;});
  badge.addEventListener('blur',()=>{if(fault!=='badge-blur')tip.hidden=true;});
  let viewport={width:420,height:900},media=true;
  const widths=[],motionReads=[];
  const evaluate=(fn,arg)=>{w.__arg=arg;return w.eval('('+fn.toString()+')(__arg)');};
  const locator=nodes=>({
    count:async()=>nodes.length,nth:i=>locator([nodes[i]]),
    evaluate:async(fn,arg)=>{w.__node=nodes[0];w.__arg=arg;return w.eval('('+fn.toString()+')(__node,__arg)');},
    evaluateAll:async fn=>{w.__nodes=nodes;return w.eval('('+fn.toString()+')(__nodes)');},
    getAttribute:async key=>nodes[0].getAttribute(key),textContent:async()=>nodes[0].textContent,
    isVisible:async()=>visible(nodes[0]),focus:async()=>nodes[0].focus(),
    hover:async()=>{if(nodes[0]===badge)tip.hidden=false;},waitFor:async()=>{},
    boundingBox:async()=>nodes[0]===badge?{x:154,y:7,width:87,height:22}:{x:0,y:36,width:420,height:864},
    getByRole:(role,{name}={})=>locator([...nodes[0].querySelectorAll(role==='button'?'button':`[role=${role}]`)].filter(n=>!name||n.textContent===name)),
  });
  w.matchMedia=()=>({matches:media});
  w.__localShares=0;
  w.getComputedStyle=(node,pseudo)=>{
    const focused=d.activeElement===node;
    const s={outlineStyle:focused?'solid':'none',outlineWidth:focused?'2px':'0px',outlineColor:'rgb(255, 255, 255)',backgroundColor:'rgb(0, 0, 0)',boxShadow:'none',visibility:'visible',animationName:'none',animationDuration:'0s',transitionDuration:'0.01s'};
    if(fault==='resting-shadow'){s.outlineStyle='none';s.outlineWidth='0px';s.boxShadow='0 0 2px black';}
    if(fault==='same-outline'){s.outlineStyle='solid';s.outlineWidth='2px';}
    if(fault==='background-outline')s.outlineColor=s.backgroundColor;
    if(fault==='shadow-focus'){s.outlineStyle='none';s.outlineWidth='0px';s.boxShadow=focused?'0 0 2px white':'none';}
    if(pseudo||node===bar)motionReads.push([viewport.width,node.tagName,pseudo]);
    if(node===assistant&&pseudo==='::after'&&(fault==='motion-child'||(fault==='motion-320'&&viewport.width===320)))s.animationName='spin',s.animationDuration='1s';
    if(node===assistant&&pseudo==='::before'&&fault==='motion-boundary')s.transitionDuration='0.010001s';
    if(node===assistant&&fault==='motion-zero')s.animationName='spin',s.animationDuration='0s';
    return s;
  };
  const originalMatches=w.Element.prototype.matches;
  w.Element.prototype.matches=function(selector){return selector===':focus-visible'?d.activeElement===this:originalMatches.call(this,selector);};
  d.addEventListener('focusin',e=>{if(!dialog.hidden&&!dialog.contains(e.target)&&fault!=='consent-outside')dialog.querySelector('button').focus();});
  const page={
    bringToFront:async()=>{},evaluate:async(fn,arg)=>evaluate(fn,arg),
    locator:s=>locator([...d.querySelectorAll(s)]),
    getByRole:(role,{name}={})=>locator([...d.querySelectorAll(`[role=${role}]`)].filter(n=>!name||n.getAttribute('aria-label')===name)),
    viewportSize:()=>({...viewport}),setViewportSize:async v=>{viewport=v;widths.push(v.width);},emulateMedia:async()=>{media=true;},
    mouse:{move:async()=>{if(fault!=='badge-leave'&&fault!=='badge-initial')tip.hidden=true;}},
    keyboard:{press:async key=>{
      if(key==='Escape'){
        if(!dialog.hidden){dialog.hidden=true;d.querySelector('[data-control=page]').focus();}
        else if(!menu.hidden){menu.hidden=true;assistant.setAttribute('aria-expanded','false');if(fault!=='assistant-return')assistant.focus();}
        else if(fault!=='badge-escape')tip.hidden=true;
      } else if(key==='Enter'&&d.activeElement===assistant){menu.hidden=false;assistant.setAttribute('aria-expanded','true');if(fault!=='assistant-entry')menu.querySelector('button').focus();}
      else if(key==='Tab'||key==='Shift+Tab'){
        const nodes=dialog.hidden?[...bar.querySelectorAll('button,[data-tier]')].filter(visible):[...dialog.querySelectorAll('button')];
        const index=nodes.indexOf(d.activeElement),step=key==='Tab'?1:-1;
        nodes[(index+step+nodes.length)%nodes.length].focus();
      }
    }},
  };
  const cdp={send:async(method,args)=>{
    if(method==='DOM.getDocument')return {root:{nodeId:1}};
    if(method==='DOM.querySelector')return {nodeId:args.selector};
    if(method==='Accessibility.getPartialAXTree'){
      const n=d.querySelector(args.nodeId);
      const name=fault==='badge-name'&&n===badge?'':n.getAttribute('aria-label')||(n===badge?n.textContent:'');
      return {nodes:[{ignored:false,name:{value:name}}]};
    }
    throw Error('Unexpected CDP method '+method);
  },detach:async()=>{}};
  const summary={checks:{}};
  const code=input.slice(input.indexOf('function keyboardCheck('),input.indexOf('async function closeForRestart('));
  const run=runInNewContext(code+';({keyboard,keyboardConsent})',{assert,summary,page,context:{newCDPSession:async()=>cdp},clickPage:async()=>{dialog.hidden=false;dialog.querySelector('button').focus();}});
  try {await (consent?run.keyboardConsent():run.keyboard());return {summary,widths,motionReads,viewport};}
  finally {dom.window.close();}
}

test('keyboard fake accepts valid focus, motion and interaction state',async()=>{
  const h=await keyboardFixture();assert.equal(h.summary.checks.keyboard.visibleFocus,true);
});
for(const [fault,check] of [
  ['resting-shadow','visibleFocus'],['same-outline','visibleFocus'],['background-outline','visibleFocus'],
  ['motion-child','reducedMotion'],['motion-320','reducedMotion'],['motion-boundary','reducedMotion'],
  ['badge-initial','badgeInitiallyHidden'],['badge-keyboard','badgeDescription'],['badge-escape','badgeEscape'],['badge-blur','badgeBlur'],['badge-leave','badgeLeave'],
  ['hidden-name','accessibleNames'],['badge-name','accessibleNames'],
  ['missing-control','expectedControls'],['extra-control','expectedControls'],
  ['status-title','statusTooltip'],['status-mismatch','statusTooltip'],
  ['assistant-entry','assistantFocusEntered'],['assistant-return','assistantFocusRestored'],
  ['consent-outside','consentExternalFocusTrap'],
])test('keyboard rejects broken '+fault,async()=>{
  await assert.rejects(keyboardFixture(fault,source,fault.startsWith('consent')),new RegExp('keyboard\\.'+check));
});

test('keyboard scans both widths and restores viewport; zero-duration animations and focus shadows pass',async()=>{
  for(const fault of ['motion-zero','shadow-focus']) {
    const h=await keyboardFixture(fault);
    assert.deepEqual(h.widths,[320,420,420]);assert.equal(h.viewport.width,420);
  }
});

function keyboardSourceContract(text) {
  assert.doesNotMatch(text,/keyboardCheck\(\s*[^,]+,\s*(?:true|false)\s*\)/);
  const integration=text.slice(text.indexOf("if(stage==='upstream')"));
  const keyboard=integration.indexOf('await keyboard();');
  for(const next of ['await keyboardConsent();','await clickPage();'])assert.ok(keyboard>=0&&keyboard<integration.indexOf(next),next);
  assert.match(text,/const expectedControls=\['workspace','assistant','page','approvals','tier','status'\];/);
}
test('keyboard source contract rejects literal results, reordered steps and DOM-derived expectations',()=>{
  keyboardSourceContract(source);
  for(const mutant of [
    source.replace("keyboardCheck('tabOrder',", "keyboardCheck('fake',true);keyboardCheck('tabOrder',"),
    source.replace("keyboardCheck('tabOrder',", "keyboardCheck('fake',false);keyboardCheck('tabOrder',"),
    source.replace('await keyboard();','').replace('await keyboardConsent();','await keyboardConsent();await keyboard();'),
    source.replace('await keyboard();','').replace('await clickPage();await page.getByRole', 'await clickPage();await keyboard();await page.getByRole'),
    source.replace("const expectedControls=['workspace','assistant','page','approvals','tier','status'];",'const expectedControls=await page.locator("[data-control]").evaluateAll(nodes=>nodes.map(n=>n.dataset.control));'),
  ])assert.throws(()=>keyboardSourceContract(mutant));
});
