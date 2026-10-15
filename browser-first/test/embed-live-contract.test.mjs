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
