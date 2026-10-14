import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createEmbedHostService } from '../host/embed-host-service.mjs';
test('descriptor binds origin, survives profile/restart and never exposes configuration',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'embed-descriptor-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const tokenFile=join(root,'token'); await writeFile(tokenFile,'private-fixture',{mode:0o600});
  const env={RESONANTOS_EMBED_POC:'1',RESONANTOS_EMBED_UPSTREAM_URL:'http://127.0.0.1:18872',RESONANTOS_EMBED_PROFILE:'one',RESONANTOS_EMBED_TOKEN_FILE:tokenFile};
  const key='augmentor-v1-'+createHash('sha256').update(JSON.stringify(['addon.augmentor-embed',env.RESONANTOS_EMBED_UPSTREAM_URL])).digest('hex');
  const expected={harnessId:'addon.augmentor-embed',interfaceId:'panel',label:'Augmentor',governance:'self-governed',noticeKey:key};
  for(const profile of ['one','two']) {
    const s=createEmbedHostService({env:{...env,RESONANTOS_EMBED_PROFILE:profile}}); t.after(()=>s.close());
    assert.deepEqual(s.getDescriptor(),expected);
    assert.deepEqual((await s.embedRoutes[0].handler()).harness,expected);
    assert.deepEqual((await s.embedRoutes[1].handler()).harness,expected);
    assert.equal(JSON.stringify(s.getDescriptor()).includes('127.0.0.1'),false);
    s.close(); assert.equal(s.getDescriptor(),null);
  }
  const changed=createEmbedHostService({env:{...env,RESONANTOS_EMBED_UPSTREAM_URL:'http://127.0.0.1:18873'}}); t.after(()=>changed.close());
  assert.notEqual(changed.getDescriptor().noticeKey,key);
  const disabled=createEmbedHostService({env:{}});
  assert.equal(disabled.getDescriptor(),null); assert.equal((await disabled.embedRoutes[0].handler()).harness,null);
});
