import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openEmbedGovernanceStorage } from '../host/embed-governance-storage.mjs';
async function fixture(t) {
  const base=await fs.mkdtemp(join(await fs.realpath(tmpdir()),'embed-store-'));
  t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const userRoot=join(base,'user'),repoRoot=join(base,'repository');
  await fs.mkdir(repoRoot,{mode:0o700});
  return {base,userRoot,repoRoot,dir:join(userRoot,'BrowserFirst','EmbedGovernance')};
}
test('private durable snapshot, lock contention, restart and stale temporary cleanup',async t=>{
  const f=await fixture(t),s=await openEmbedGovernanceStorage(f); t.after(()=>s.close());
  assert.equal(await s.read(),null); await s.write('{"version":1}\n');
  assert.equal((await fs.stat(join(f.dir,'state.json'))).mode&0o777,0o600);
  assert.equal((await fs.stat(f.dir)).mode&0o777,0o700);
  await assert.rejects(openEmbedGovernanceStorage(f),{code:'storage-unavailable'});
  await s.close();
  const temp=join(f.dir,`.state-${randomUUID()}.tmp`); await fs.writeFile(temp,'abandoned',{mode:0o600});
  const next=await openEmbedGovernanceStorage(f); t.after(()=>next.close());
  assert.equal(await next.read(),'{"version":1}\n'); await assert.rejects(fs.stat(temp),{code:'ENOENT'});
});
test('restrictive umask does not remove owner access from new private paths or files',async t=>{
  const f=await fixture(t),previous=process.umask(0o277);let store;
  try {
    store=await openEmbedGovernanceStorage(f);await store.write('{}\n');
    for(const path of [f.userRoot,join(f.userRoot,'BrowserFirst'),f.dir,join(f.dir,'writer.lock')])assert.equal((await fs.stat(path)).mode&0o777,0o700);
    for(const path of [join(f.dir,'state.json'),join(f.dir,'writer.lock','owner.json')])assert.equal((await fs.stat(path)).mode&0o777,0o600);
    assert.equal(await store.read(),'{}\n');await store.close();
    store=await openEmbedGovernanceStorage(f);assert.equal(await store.read(),'{}\n');
  } finally {process.umask(previous);await store?.close();}
});
test('root and ancestor links, repository destinations and missing roots beneath links create no feature data',async t=>{
  for(const destination of ['outside','repo']) {
    const f=await fixture(t),target=destination==='repo'?f.repoRoot:join(f.base,'target');
    if(destination==='outside') await fs.mkdir(target);
    await fs.symlink(target,f.userRoot);
    for(const root of [f.userRoot,join(f.userRoot,'missing')]) await assert.rejects(openEmbedGovernanceStorage({...f,userRoot:root}),{code:'storage-unavailable'});
    if(destination==='outside') assert.deepEqual(await fs.readdir(target),[]);
  }
  const f=await fixture(t);
  await assert.rejects(openEmbedGovernanceStorage({...f,userRoot:f.repoRoot}),{code:'storage-unavailable'});
});
test('permission and path substitution refuse reads and replacements',async t=>{
  const f=await fixture(t),s=await openEmbedGovernanceStorage(f); t.after(()=>s.close());
  await s.write('{}\n'); await fs.chmod(join(f.dir,'state.json'),0o644);
  await assert.rejects(s.read(),{code:'storage-unavailable'});
  await assert.rejects(s.write('{}\n'),{code:'storage-unavailable'});
  await fs.chmod(join(f.dir,'state.json'),0o600);
  await fs.rename(f.dir,f.dir+'-old'); await fs.cp(f.dir+'-old',f.dir,{recursive:true});
  await assert.rejects(s.read(),{code:'storage-unavailable'});
  await assert.rejects(s.write('{}\n'),{code:'storage-unavailable'});
  assert.equal(await fs.readFile(join(f.dir,'state.json'),'utf8'),'{}\n');
});
test('only ESRCH permits stale-lock recovery; malformed, interrupted, EPERM and reused live PID refuse',async t=>{
  for(const mode of ['dead','alive','denied','malformed','interrupted']) {
    const f=await fixture(t); const first=await openEmbedGovernanceStorage(f); await first.close();
    const lock=join(f.dir,'writer.lock'); await fs.mkdir(lock,{mode:0o700});
    if(mode!=='interrupted') await fs.writeFile(join(lock,'owner.json'),mode==='malformed'?'bad':JSON.stringify({pid:12345,ownership:randomUUID()}),{mode:0o600});
    const processExists=()=>{if(mode==='dead'||mode==='denied') throw Object.assign(Error(),{code:mode==='dead'?'ESRCH':'EPERM'});};
    if(mode==='dead') { const s=await openEmbedGovernanceStorage({...f,processExists}); await s.close(); }
    else await assert.rejects(openEmbedGovernanceStorage({...f,processExists}),{code:'storage-unavailable'});
  }
});
test('failed atomic rename preserves old state; oversized snapshots are refused',async t=>{
  const f=await fixture(t); let fail=false;
  const s=await openEmbedGovernanceStorage({...f,fs:{...fs,rename:async(...args)=>{if(fail) throw Error('PRIVATE'); return fs.rename(...args);}}}); t.after(()=>s.close());
  await s.write('{"old":true}\n'); fail=true;
  await assert.rejects(s.write('{"new":true}\n'),{code:'storage-unavailable'});
  assert.equal(await s.read(),'{"old":true}\n');
  fail=false;await assert.rejects(s.write('x'.repeat(10*1024*1024+1)),{code:'storage-unavailable'});
});

test('private directory modes, linked state and hardlinked snapshots fail closed',async t=>{
  for(const kind of ['feature-mode','state-link','state-hardlink']) {
    const f=await fixture(t),s=await openEmbedGovernanceStorage(f);t.after(()=>s.close());await s.write('{}');
    if(kind==='feature-mode')await fs.chmod(f.dir,0o755);
    if(kind==='state-link'){await fs.rename(join(f.dir,'state.json'),join(f.base,'outside'));await fs.symlink(join(f.base,'outside'),join(f.dir,'state.json'));}
    if(kind==='state-hardlink')await fs.link(join(f.dir,'state.json'),join(f.base,'linked'));
    await assert.rejects(s.read(),{code:'storage-unavailable'});
    await assert.rejects(s.write('{}'),{code:'storage-unavailable'});
  }
});
test('foreign state owner, replaced BrowserFirst and unknown writer identity cannot be used',async t=>{
  const f=await fixture(t);let foreign=false;
  const s=await openEmbedGovernanceStorage({...f,fs:{...fs,lstat:async p=>{const st=await fs.lstat(p);if(foreign&&p===join(f.dir,'state.json'))return new Proxy(st,{get:(target,key)=>key==='uid'?st.uid+1:Reflect.get(target,key)});return st;}}});t.after(()=>s.close());
  await s.write('{}');foreign=true;await assert.rejects(s.read(),{code:'storage-unavailable'});foreign=false;
  const owner=join(f.dir,'writer.lock','owner.json');await fs.writeFile(owner,JSON.stringify({pid:process.pid,ownership:randomUUID()}),{mode:0o600});
  await assert.rejects(s.write('{}'),{code:'storage-unavailable'});
  await fs.rename(join(f.userRoot,'BrowserFirst'),join(f.userRoot,'BrowserFirst-old'));await fs.mkdir(join(f.userRoot,'BrowserFirst'),{mode:0o700});
  await assert.rejects(s.read(),{code:'storage-unavailable'});
});

test('close never removes a lock whose ownership UUID changed',async t=>{
  const f=await fixture(t),s=await openEmbedGovernanceStorage(f);
  const owner=join(f.dir,'writer.lock','owner.json'),replacement={pid:process.pid,ownership:randomUUID()};
  await fs.writeFile(owner,JSON.stringify(replacement),{mode:0o600});await s.close();
  assert.deepEqual(JSON.parse(await fs.readFile(owner,'utf8')),replacement);
});
