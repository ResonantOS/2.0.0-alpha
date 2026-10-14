import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbedHostService } from '../host/embed-host-service.mjs';
import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';
import { startBridgeServer } from '../host/bridge-server.mjs';
import { capabilityForBridgeRoute } from '../resonantos-side-panel-extension/src/lib/bridge-client.js';
const origin='chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl';
test('enabled and disabled compositions use authenticated governance, never the cookie proxy',async t=>{
  for(const enabled of [false,true]) {
    const userRoot=await mkdtemp(join(await realpath(tmpdir()),'embed-accept-')),tokenFile=join(userRoot,'fixture-token');
    await writeFile(tokenFile,'synthetic-upstream-token',{mode:0o600});
    const embed=createEmbedHostService({env:enabled?{RESONANTOS_EMBED_POC:'1',RESONANTOS_EMBED_UPSTREAM_URL:'http://127.0.0.1:18872',RESONANTOS_EMBED_PROFILE:'proof',RESONANTOS_EMBED_TOKEN_FILE:tokenFile}:{}});
    const service=await createEmbedGovernanceHostService({userRoot,getDescriptor:()=>embed.getDescriptor()});
    const tokens=Object.fromEntries(service.governanceRoutes.map(r=>[r.requiredCapability,randomUUID()]));tokens['addon-runtime-control']=randomUUID();
    const server=await startBridgeServer({port:0,host:'127.0.0.1',bridgeToken:'bridge',bridgeCapabilityTokens:tokens,extensionOrigin:origin,routes:[...embed.embedRoutes,...service.governanceRoutes],embedService:embed});
    t.after(async()=>{await service.close();embed.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(userRoot,{recursive:true,force:true});});
    async function call(path,method='GET',body){const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':tokens[capabilityForBridgeRoute(path,method)]},...(method==='POST'?{body:JSON.stringify(body)}:{})});return {status:res.status,payload:await res.json()};}
    for(const r of service.governanceRoutes){assert.equal(embed.matches(r.path),false);const res=await fetch(`http://127.0.0.1:${server.address().port}${r.path}`,{method:r.method,headers:{Origin:origin,Cookie:'ros_embed=fixture'},...(r.method==='POST'?{body:'{}'}:{})});assert.equal(res.status,401);}
    const state=(await call('/embed-governance/state')).payload;assert.equal(state.available,enabled);assert.equal(state.recordingEnabled,false);
    if(enabled){
      const on=(await call('/embed-governance/recording','POST',{enabled:true})).payload;
      assert.equal((await call('/embed-governance/events','POST',{writeEpoch:on.writeEpoch,eventId:randomUUID(),event:{kind:'page-shared',domain:'example.test'}})).payload.recorded,true);
      assert.equal((await call('/embed-governance/events')).payload.events.length,1);
    }
    assert.equal((await call('/embed-governance/events/delete','POST',{})).payload.deleted,true);
  }
});
test('operator docs separate deterministic results from live acceptance and release authority',async()=>{
  const doc=await readFile(new URL('../README.md',import.meta.url),'utf8');
  assert.ok(doc.includes('Deterministic green does not complete EMBED-UPSTREAM-1 or authorize a merge into dev.'));
});
