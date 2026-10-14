import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
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
async function staleFixture(t) {
  const f=await fixture(t),initial=await openEmbedGovernanceStorage(f); await initial.close();
  const lock=join(f.dir,'writer.lock'),owner=join(lock,'owner.json');
  const guard=join(f.dir,'writer.lock.recovery'),guardFile=join(guard,'guard.json');
  const dead={pid:12345,ownership:randomUUID()};
  await fs.mkdir(lock,{mode:0o700});
  await fs.writeFile(owner,JSON.stringify(dead),{mode:0o600});
  const processExists=pid=>{
    if(pid===dead.pid) throw Object.assign(Error(),{code:'ESRCH'});
  };
  return {...f,lock,owner,guard,guardFile,dead,processExists};
}
test('losing stale-lock recoverer never unlinks the winning bridge owner',async t=>{
  const f=await staleFixture(t);
  let winner,winningOwner,foreignUnlinks=0;
  t.after(()=>winner?.close());
  async function installWinner() {
    winner=await openEmbedGovernanceStorage(f);
    winningOwner=await fs.readFile(f.owner,'utf8');
  }
  const losingFs={...fs,
    async mkdir(path,...args) {
      // Delay recovery after the dead-PID check, before acquiring its guard.
      if(path===f.guard&&!winner) await installWinner();
      return fs.mkdir(path,...args);
    },
    async unlink(path) {
      if(path===f.owner) {
        if(!winner) await installWinner();
        foreignUnlinks++;
      }
      return fs.unlink(path);
    },
    async rename(from,to) {
      if(from===f.lock&&!winner) await installWinner();
      // The old tombstone path steals the fresh live lock here.
      return fs.rename(from,to);
    }
  };
  const outcome=await openEmbedGovernanceStorage({...f,fs:losingFs})
    .then(store=>({store}),error=>({error}));
  t.after(()=>outcome.store?.close());
  assert.equal(foreignUnlinks,0,'stale recovery must not unlink a fresh owner');
  assert.equal(outcome.error?.code,'storage-unavailable','only one bridge may acquire the writer lock');
  assert.equal(await fs.readFile(f.owner,'utf8').catch(()=>null),winningOwner,'delayed recovery must leave the live writer lock in place');
  await assert.rejects(openEmbedGovernanceStorage(f),{code:'storage-unavailable'},'a third writer must not acquire a stolen lock');
  await winner.write('{"winner":true}\n');
  assert.equal(await winner.read(),'{"winner":true}\n');
  assert.deepEqual((await fs.readdir(f.dir)).sort(),['state.json','writer.lock']);
});
test('second recoverer fails closed while the exclusive recovery guard is held',async t=>{
  const f=await staleFixture(t); let checked=false,exclusive=false;
  const store=await openEmbedGovernanceStorage({...f,fs:{...fs,
    async open(path,flags,...args) {
      if(path===f.guardFile&&(flags&constants.O_CREAT)) exclusive=Boolean(flags&constants.O_EXCL);
      return fs.open(path,flags,...args);
    },
    async unlink(path) {
      if(path===f.owner) {
        checked=true;
        const before=await fs.readFile(f.guardFile,'utf8'),guard=JSON.parse(before);
        assert.equal(guard.pid,process.pid);
        assert.match(guard.uuid,/^[0-9a-f-]{36}$/);
        assert.ok(Number.isSafeInteger(guard.created)&&guard.created<=Date.now());
        assert.equal((await fs.stat(f.guard)).mode&0o777,0o700);
        assert.equal((await fs.stat(f.guardFile)).mode&0o777,0o600);
        await assert.rejects(openEmbedGovernanceStorage(f),{code:'storage-unavailable'});
        assert.equal(await fs.readFile(f.guardFile,'utf8'),before);
      }
      return fs.unlink(path);
    }
  }});
  t.after(()=>store.close());
  assert.equal(checked,true,'recovery must hold its guard when breaking the stale lock');
  assert.equal(exclusive,true,'guard metadata must be created exclusively');
  await assert.rejects(fs.stat(f.guard),{code:'ENOENT'});
  await store.write('{}');
});
for(const [label,age,pid,code,recoverable] of [
  ['younger than 60 seconds',30000,12345,'ESRCH',false],
  ['older than 60 seconds with a dead pid',61000,12345,'ESRCH',true],
  ['older than 60 seconds with a live pid',61000,54321,null,false],
  ['older than 60 seconds with EPERM',61000,54321,'EPERM',false]
]) test(`abandoned recovery guard ${label}`,async t=>{
  const f=await staleFixture(t),guard={pid,uuid:randomUUID(),created:Date.now()-age};
  await fs.mkdir(f.guard,{mode:0o700});
  await fs.writeFile(f.guardFile,JSON.stringify(guard),{mode:0o600});
  const options={...f,processExists:probe=>{
    if(probe===f.dead.pid||probe===pid&&code) throw Object.assign(Error(),{code:probe===f.dead.pid?'ESRCH':code});
  }};
  if(recoverable) {
    const store=await openEmbedGovernanceStorage(options);t.after(()=>store.close());
    await assert.rejects(fs.stat(f.guard),{code:'ENOENT'},'recovery must remove its own guard');
    await store.write('{}');assert.equal(await store.read(),'{}');
  } else {
    await assert.rejects(openEmbedGovernanceStorage(options),{code:'storage-unavailable'});
    assert.deepEqual(JSON.parse(await fs.readFile(f.guardFile,'utf8')),guard);
    assert.deepEqual(JSON.parse(await fs.readFile(f.owner,'utf8')),f.dead);
  }
});
test('unpublished recovery guard fails closed without taking over its directory',async t=>{
  const f=await staleFixture(t);
  await fs.mkdir(f.guard,{mode:0o700});
  const outcome=await openEmbedGovernanceStorage(f).then(store=>({store}),error=>({error}));
  t.after(()=>outcome.store?.close());
  assert.equal(outcome.error?.code,'storage-unavailable','an exclusive guard directory must block another recoverer before metadata is published');
  assert.deepEqual(await fs.readdir(f.guard),[]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.owner,'utf8')),f.dead);
});
test('second abandoned-guard cleaner fails closed while cleanup is in progress',async t=>{
  const f=await staleFixture(t),abandoned={pid:f.dead.pid,uuid:randomUUID(),created:Date.now()-61000};
  await fs.mkdir(f.guard,{mode:0o700});
  await fs.writeFile(f.guardFile,JSON.stringify(abandoned),{mode:0o600});
  let second,interleaved=false;
  t.after(()=>second?.store?.close());
  const first=await openEmbedGovernanceStorage({...f,fs:{...fs,
    async unlink(path) {
      if(path===f.guardFile&&!interleaved) {
        interleaved=true;
        // Both cleaners have seen the abandoned guard. Pause the first
        // before unlink so the second could replace it with a fresh guard.
        second=await openEmbedGovernanceStorage(f).then(store=>({store}),error=>({error}));
      }
      return fs.unlink(path);
    }
  }}).then(store=>({store}),error=>({error}));
  t.after(()=>first.store?.close());
  assert.equal(interleaved,true);
  assert.equal(second.error?.code,'storage-unavailable','abandoned-guard cleanup must also have one exclusive owner');
  assert.ok(first.store,'the cleanup owner must finish recovery');
  await first.store.write('{}');assert.equal(await first.store.read(),'{}');
  await assert.rejects(fs.stat(f.guard),{code:'ENOENT'});
});
test('interrupted abandoned-guard cleanup remains fail closed',async t=>{
  const f=await staleFixture(t),abandoned={pid:f.dead.pid,uuid:randomUUID(),created:Date.now()-61000};
  await fs.mkdir(f.guard,{mode:0o700});
  await fs.writeFile(f.guardFile,JSON.stringify(abandoned),{mode:0o600});
  await fs.mkdir(join(f.guard,'cleanup'),{mode:0o700});
  await assert.rejects(openEmbedGovernanceStorage(f),{code:'storage-unavailable'});
  assert.deepEqual(JSON.parse(await fs.readFile(f.guardFile,'utf8')),abandoned);
  assert.deepEqual(JSON.parse(await fs.readFile(f.owner,'utf8')),f.dead);
  assert.deepEqual((await fs.readdir(f.guard)).sort(),['cleanup','guard.json']);
});
test('recovery cleanup preserves a guard whose UUID changed',async t=>{
  const f=await staleFixture(t);let replacement;
  const outcome=await openEmbedGovernanceStorage({...f,fs:{...fs,
    async unlink(path) {
      await fs.unlink(path);
      if(path===f.owner) {
        replacement={pid:process.pid,uuid:randomUUID(),created:Date.now()};
        await fs.writeFile(f.guardFile,JSON.stringify(replacement),{mode:0o600});
      }
    }
  }}).then(store=>({store}),error=>({error}));
  t.after(()=>outcome.store?.close());
  assert.equal(outcome.error?.code,'storage-unavailable');
  assert.deepEqual(JSON.parse(await fs.readFile(f.guardFile,'utf8')),replacement);
});
for(const change of ['pid','ownership','liveness']) test(`owner recheck rejects changed ${change} under the recovery guard`,async t=>{
  const f=await staleFixture(t),replacement={...f.dead};let guarded=false;
  if(change==='pid') replacement.pid++;
  if(change==='ownership') replacement.ownership=randomUUID();
  const outcome=await openEmbedGovernanceStorage({...f,
    processExists:()=>{if(change==='liveness'&&guarded) return;throw Object.assign(Error(),{code:'ESRCH'});},
    fs:{...fs,async mkdir(path,...args) {
      await fs.mkdir(path,...args);
      if(path===f.guard) {guarded=true;await fs.writeFile(f.owner,JSON.stringify(replacement),{mode:0o600});}
    }}
  }).then(store=>({store}),error=>({error}));
  t.after(()=>outcome.store?.close());
  assert.equal(outcome.error?.code,'storage-unavailable','changed ownership or liveness must reject recovery');
  assert.deepEqual(JSON.parse(await fs.readFile(f.owner,'utf8')),replacement);
  await assert.rejects(fs.stat(f.guard),{code:'ENOENT'});
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
