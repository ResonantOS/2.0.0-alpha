import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridgeServer, evaluateBridgeRequestForSelfTest } from '../host/bridge-server.mjs';
import { createEmbedHostService } from '../host/embed-host-service.mjs';
import { createEmbedGovernanceHostService } from '../host/embed-governance-host-service.mjs';
import { ERRORS } from '../../src/core/embed-governance-contract.js';
const origin='chrome-extension://cdpdmmalhmokbfcfgogoepnjplaakgnl';
const caps={'addon-runtime-read':'read','addon-runtime-control':'control','addon-record-read':'records','addon-record-write':'write','embed-governance-consent-write':'consent'};
async function fixture(t) {
  const userRoot=await mkdtemp(join(await realpath(tmpdir()),'embed-http-'));
  const service=await createEmbedGovernanceHostService({userRoot});
  const embed=createEmbedHostService({env:{}});let calls=0;
  const routes=service.governanceRoutes.map(r=>({...r,handler:async(...args)=>{calls++;return r.handler(...args);}}));
  const options={port:0,host:'127.0.0.1',bridgeToken:'bridge',bridgeCapabilityTokens:caps,extensionOrigin:origin,allowedOrigins:['chrome-extension://*'],routes,embedService:embed};
  const server=await startBridgeServer(options),port=server.address().port;
  t.after(async()=>{await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(userRoot,{recursive:true,force:true});});
  const request=async(path='/embed-governance/state',method='GET',token='read',extra={})=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':token,...extra},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {status:response.status,payload:response.status===204?await response.text():await response.json()};
  };
  const rawRequest=(path,extra={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method:'GET',headers:{Host:`127.0.0.1:${port}`,Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':'read',...extra}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>{
        try{assert.equal(res.headers['cache-control'],'no-store');resolve({status:res.statusCode,payload:JSON.parse(body)});}catch(error){reject(error);}
      });
    });
    req.on('error',reject);req.setTimeout(1500,()=>req.destroy(Error('Raw request timed out')));req.end();
  });
  return {request,rawRequest,port,options,routes,calls:()=>calls};
}
function error(result,code){assert.deepEqual(result,{status:ERRORS[code][0],payload:{ok:false,code,error:ERRORS[code][1]}});}
test('family authentication precedes method lookup and wildcards never authorize',async t=>{
  const f=await fixture(t);
  error(await f.request('/embed-governance/state','GET','read',{'X-ResonantOS-Bridge-Token':''}), 'unauthorized');
  error(await f.request('/embed-governance/state','GET','read',{Origin:''}), 'forbidden');
  error(await f.request('/embed-governance/state','GET','read',{Origin:'chrome-extension://foreign'}), 'forbidden');
  error(await f.request('/embed-governance/state','GET','read',{Origin:`http://127.0.0.1:${f.port}`}), 'forbidden');
  const beforeForged=f.calls();
  error(await f.rawRequest('/embed-governance/state',{Host:'evil.test'}), 'forbidden');
  assert.equal(f.calls(),beforeForged);
  error(await f.request('/embed-governance/state','PUT','read'), 'method-not-allowed');
  error(await f.request('/embed-governance/unknown'), 'unknown-route');
  for(const token of ['control','write']) for(const path of ['recording','notice']) error(await f.request('/embed-governance/'+path,'POST',token),'forbidden');
  error(await f.request('/embed-governance/state?x=1'), 'invalid-request');
  const beforeMalformed=f.calls();
  for(const path of ['/embed-governance/state?x=%ZZ','/embed-governance/%ZZ'])error(await f.rawRequest(path), 'invalid-request');
  assert.equal(f.calls(),beforeMalformed);
  assert.deepEqual(await f.request('/embed-governance/state','OPTIONS'),{status:204,payload:''});
  assert.equal((await f.request()).status,200);
});
test('self-test uses the same method-independent family and fixed exception serializer',async t=>{
  const f=await fixture(t),headers={host:`127.0.0.1:${f.port}`,origin,'x-resonantos-bridge-token':'bridge','x-resonantos-bridge-capability-token':'read'};
  const rawHeaders=['Host',headers.host,'Origin',origin];
  const run=(url,method='GET',changes={})=>evaluateBridgeRequestForSelfTest({...f.options,listenerPort:f.port,url,method,headers,rawHeaders,...changes});
  error(await run('/embed-governance/state','PUT'),'method-not-allowed');
  error(await run('/embed-governance/state','GET',{rawHeaders:[...rawHeaders,'Origin',origin]}),'forbidden');
  error(await run('/embed-governance/state','GET',{routes:f.routes.map(r=>({...r,handler:()=>{throw Error('CANARY');}}))}),'storage-unavailable');
  error(await run('/embed-governance/state','GET',{headers:{...headers,'content-length':'1'}}),'invalid-request');
});
test('chunked POST limits reject before stream end and never invoke a service',async t=>{
  const f=await fixture(t);
  for(const [path,limit,token] of [['recording',512,'consent'],['events',2048,'write']]) {
    const before=f.calls();
    const result=await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:f.port,path:'/embed-governance/'+path,method:'POST',headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':token,'Transfer-Encoding':'chunked'}},res=>{
        let body='';res.on('data',c=>body+=c);res.on('end',()=>{req.destroy();resolve({status:res.statusCode,payload:JSON.parse(body)});});
      });
      req.on('error',reject);req.setTimeout(1500,()=>{req.destroy();reject(Error('Did not reject before end'));});
      req.write(Buffer.alloc(limit+1,32));
    });
    error(result,'request-too-large');assert.equal(f.calls(),before);
  }
});

test('cookie cannot authorize, parser errors stay fixed, GET bodies and IP refusal never dispatch',async t=>{
  const f=await fixture(t);
  error(await f.request('/embed-governance/state','GET','',{'X-ResonantOS-Bridge-Token':'',Cookie:'ros_embed=fixture'}),'unauthorized');
  async function raw(method,body,headers={}) {
    return new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:f.port,path:'/embed-governance/state',method,headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':'read','Content-Length':Buffer.byteLength(body),...headers}},res=>{
        let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,payload:JSON.parse(data)}));
      });req.on('error',reject);req.end(body);
    });
  }
  error(await raw('GET','x'),'invalid-request');
  error(await raw('GET','',{Origin:[origin,origin]}),'forbidden');
  const response=await fetch(`http://127.0.0.1:${f.port}/embed-governance/events/delete`,{method:'POST',headers:{Origin:origin,'X-ResonantOS-Bridge-Token':'bridge','X-ResonantOS-Bridge-Capability-Token':'write'},body:'{'});
  error({status:response.status,payload:await response.json()},'invalid-request');
  const server=await startBridgeServer({...f.options,allowedCidrs:['192.0.2.1/32']});t.after(()=>new Promise(r=>server.close(r)));
  const denied=await fetch(`http://127.0.0.1:${server.address().port}/embed-governance/state`);
  assert.equal(denied.headers.get('cache-control'),'no-store');error({status:denied.status,payload:await denied.json()},'forbidden');
});
