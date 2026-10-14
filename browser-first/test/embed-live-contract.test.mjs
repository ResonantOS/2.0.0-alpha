import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
test('live proof is syntax-valid, conductor-owned and checks every required upstream field',()=>{
  const path=new URL('./embed-live.mjs',import.meta.url),source=readFileSync(path,'utf8');
  const syntax=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8',shell:false});assert.equal(syntax.status,0,syntax.stderr);
  for(const text of ['EMBED-UPSTREAM-1','RESONANTOS_EMBED_LIVE_USER_ROOT','RESONANTOS_EMBED_LIVE_VERSION','conversationId','conversation.changed','turn.started','turn.finished','tool.finished','toolSuccess','toolError'])assert.ok(source.includes(text),text);
  assert.ok(source.includes('p.conversationId=true'));
  assert.equal(source.includes('state.last.push(event.data)'),false);
  assert.equal(source.includes('__barProofContexts'),false);
  assert.ok(source.includes("stage==='upstream'"));
  assert.ok(source.includes("assert.ok(slots&&typeof slots==='object')"));
});
