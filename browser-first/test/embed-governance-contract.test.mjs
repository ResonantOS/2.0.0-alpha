import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { metadata, domainFromUrl, validDomain, validDescriptor, publicActivityError } from '../../src/core/embed-governance-contract.js';
import { prepareEmbedGovernance } from '../../scripts/prepare-embed-governance.mjs';
test('closed metadata excludes content and uses strict tool names and booleans', () => {
  for (const kind of ['conversation-changed','reply-started','reply-finished']) {
    assert.deepEqual(metadata({kind}), {kind});
    for (const key of ['prompt','response','arguments','result','token','error','title','url','conversationId']) assert.equal(metadata({kind, [key]:'CANARY'}), null);
  }
  for (const toolName of ['read.page','read_page','Tool:read-1']) assert.deepEqual(metadata({kind:'tool-finished',toolName,error:false}), {kind:'tool-finished',toolName,error:false});
  for (const toolName of ['', 'a b', 'a'.repeat(65), 'sk_live_abcdefghijk', 'a'.repeat(40)]) assert.equal(metadata({kind:'tool-finished',toolName,error:false}), null);
  for (const error of [0,1,'false',null,undefined]) assert.equal(metadata({kind:'tool-finished',toolName:'read',error}), null);
  assert.equal(metadata({kind:'tool-finished',toolName:'read',error:false,result:'CANARY'}), null);
  assert.deepEqual(publicActivityError(Error('CANARY')), {status:503,payload:{ok:false,code:'storage-unavailable',error:'Activity storage unavailable.'}});
});
test('domain normalization is host-only and canonical', () => {
  for (const [url,domain] of [['https://Sub.Example.COM./p?q=1#x','sub.example.com'],['http://bücher.example/x','xn--bcher-kva.example'],['http://127.0.0.1:80/x','127.0.0.1'],['http://[::1]:88/x','[::1]'],['http://[2001:0DB8::1]:8080/x','[2001:db8::1]'],['http://localhost:9/x','localhost']]) {
    assert.equal(domainFromUrl(url),domain); assert.equal(validDomain(domain),true);
  }
  for (const domain of ['::1','[::1]:88','[2001:0db8::1]','x:80','user@x','x/p','x?q','x#f',' x','EXAMPLE.com','x.','','a'.repeat(254)]) assert.equal(validDomain(domain),false);
  assert.equal(domainFromUrl('file:///private/x'),null);
});
test('descriptor is a closed fixed host contract', () => {
  const d={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:'augmentor-v1-'+ 'a'.repeat(64)};
  assert.equal(validDescriptor(d),true);
  for (const [k,v] of [['governance','governed'],['label','Other'],['token','CANARY'],['noticeKey','bad']]) assert.equal(validDescriptor({...d,[k]:v}),false);
});
test('generated source is byte-identical and never independently authored', async () => {
  await prepareEmbedGovernance({check:true});
  for (const name of ['trace-redaction-core.js','trace-redaction.js','embed-governance-contract.js']) {
    assert.deepEqual(await readFile(new URL('../../src/core/'+name,import.meta.url)),await readFile(new URL('../resonantos-side-panel-extension/src/lib/generated/'+name,import.meta.url)));
  }
});
