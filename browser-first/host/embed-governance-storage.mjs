import * as nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, relative, sep, dirname, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIMITS, UUID, exact, activityError } from '../../src/core/embed-governance-contract.js';
export async function openEmbedGovernanceStorage({userRoot,repoRoot,fs=nativeFs,processExists=pid=>process.kill(pid,0)}={}) {
  const fail=()=>activityError('storage-unavailable');
  const uid=process.getuid?.();
  if(typeof userRoot!=='string'||!isAbsolute(userRoot)||typeof repoRoot!=='string'||uid===undefined) throw fail();
  const root=resolve(userRoot),repository=await fs.realpath(repoRoot),pins=new Map();
  const inside=(base,target)=>{const r=relative(base,target);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
  if(inside(repository,root)) throw fail();
  async function directory(path,{create=false,privateMode=false,pin=false}={}) {
    const parent=dirname(path);
    if(parent!==path) await directory(parent,{create});
    let stat;
    try { stat=await fs.lstat(path); }
    catch(e) {
      if(e.code!=='ENOENT'||!create) throw fail();
      const ancestor=await fs.realpath(parent);
      if(ancestor!==parent||inside(repository,path)) throw fail();
      try { await fs.mkdir(path,{mode:0o700}); await fs.chmod(path,0o700); } catch(e2) { if(e2.code!=='EEXIST') throw fail(); }
      stat=await fs.lstat(path);
    }
    if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(path)!==path) throw fail();
    if(privateMode&&(stat.uid!==uid||(stat.mode&0o777)!==0o700)) throw fail();
    const identity=`${stat.dev}:${stat.ino}`;
    if(pins.has(path)&&pins.get(path)!==identity) throw fail();
    if(pin) pins.set(path,identity);
  }
  // Pin every root component, not merely the final feature directory.
  try {
    await directory(root,{create:true});
    for(let p=root;;p=dirname(p)) { await directory(p,{pin:true}); if(p===parse(p).root) break; }
  } catch { throw fail(); }
  const browser=join(root,'BrowserFirst'),dir=join(browser,'EmbedGovernance'),lock=join(dir,'writer.lock'),owner=join(lock,'owner.json'),state=join(dir,'state.json');
  const recovery=join(dir,'writer.lock.recovery'),guardFile=join(recovery,'guard.json');
  const ownership=randomUUID(); let owned=false,closed=false;
  async function check() {
    await directory(root); await directory(browser); await directory(dir,{privateMode:true});
  }
  async function file(path,missing=false) {
    await check();
    let stat; try { stat=await fs.lstat(path); } catch(e) { if(missing&&e.code==='ENOENT') return null; throw fail(); }
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==uid||(stat.mode&0o777)!==0o600||stat.nlink!==1) throw fail();
    return stat;
  }
  async function readPrivate(path,limit) {
    const before=await file(path,true); if(!before) return null;
    if(before.size>limit) throw fail();
    const handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const current=await handle.stat(); if(current.dev!==before.dev||current.ino!==before.ino||current.size>limit||current.uid!==uid||(current.mode&0o777)!==0o600||current.nlink!==1) throw fail();
      const buffer=Buffer.alloc(limit+1); let used=0;
      while(used<=limit) { const {bytesRead}=await handle.read(buffer,used,buffer.length-used,null); if(!bytesRead) break; used+=bytesRead; }
      if(used>limit) throw fail(); await check(); return buffer.subarray(0,used).toString('utf8');
    } finally { await handle.close(); }
  }
  async function lockOwner() {
    await directory(lock,{privateMode:true});
    const v=JSON.parse(await readPrivate(owner,512));
    if(!exact(v,['pid','ownership'])||!Number.isSafeInteger(v.pid)||v.pid<=0||!UUID.test(v.ownership)) throw fail();
    return v;
  }
  async function release(expected) {
    const v=await lockOwner(); if(v.ownership!==expected) throw fail();
    await file(owner); await fs.unlink(owner); await fs.rmdir(lock);
  }
  function requireDead(pid) {
    try { processExists(pid); } catch(error) { if(error.code==='ESRCH') return; throw fail(); }
    throw fail();
  }
  async function writeRecord(path,value) {
    const handle=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(value)+'\n'); await handle.sync(); } finally { await handle.close(); }
  }
  async function guardOwner() {
    await directory(recovery,{privateMode:true});
    const v=JSON.parse(await readPrivate(guardFile,512));
    if(!exact(v,['pid','uuid','created'])||!Number.isSafeInteger(v.pid)||v.pid<=0||!UUID.test(v.uuid)||!Number.isSafeInteger(v.created)||v.created<0) throw fail();
    return v;
  }
  async function removeGuard(expected,abandoned=false) {
    const cleanup=abandoned?join(recovery,'cleanup'):null;
    // Serialize abandoned-guard deletion too: a delayed cleaner must never
    // unlink another recoverer's newly published guard. A crashed cleaner's
    // marker is unverifiable and is deliberately left fail-closed.
    if(cleanup) await fs.mkdir(cleanup,{mode:0o700});
    try {
      const current=await guardOwner();
      if(current.pid!==expected.pid||current.uuid!==expected.uuid||current.created!==expected.created) throw fail();
      if(abandoned) {
        if(Date.now()-current.created<=60000) throw fail();
        requireDead(current.pid);
      }
      await file(guardFile); await fs.unlink(guardFile);
    } finally { if(cleanup) await fs.rmdir(cleanup); }
    await fs.rmdir(recovery);
  }
  async function acquireGuard() {
    try { await fs.mkdir(recovery,{mode:0o700}); }
    catch(error) {
      if(error.code!=='EEXIST') throw fail();
      const abandoned=await guardOwner();
      if(Date.now()-abandoned.created<=60000) throw fail();
      requireDead(abandoned.pid);
      await removeGuard(abandoned,true);
      // One exclusive attempt: contenders never wait or spin on recovery.
      await fs.mkdir(recovery,{mode:0o700});
    }
    await fs.chmod(recovery,0o700);
    await directory(recovery,{privateMode:true});
    const guard={pid:process.pid,uuid:randomUUID(),created:Date.now()};
    await writeRecord(guardFile,guard);
    return guard;
  }
  try {
    await directory(browser,{create:true,pin:true});
    await directory(dir,{create:true,privateMode:true,pin:true});
    let guard;
    try {
      try { await fs.mkdir(lock,{mode:0o700}); }
      catch(e) {
        if(e.code!=='EEXIST') throw fail();
        const old=await lockOwner(); requireDead(old.pid);
        guard=await acquireGuard();
        // A delayed recoverer must not remove a newer owner's lock.
        const current=await lockOwner();
        if(current.pid!==old.pid||current.ownership!==old.ownership) throw fail();
        requireDead(current.pid);
        await file(owner); await fs.unlink(owner); await fs.rmdir(lock);
        await fs.mkdir(lock,{mode:0o700});
      }
      await fs.chmod(lock,0o700);
      await directory(lock,{privateMode:true});
      await writeRecord(owner,{pid:process.pid,ownership});
      owned=true;
    } finally { if(guard) await removeGuard(guard); }
    for(const name of await fs.readdir(dir)) if(/^\.state-[0-9a-f-]{36}\.tmp$/.test(name)) {const p=join(dir,name);await file(p);await fs.unlink(p);}
  } catch { if(owned) await release(ownership).catch(()=>{}); throw fail(); }
  return {
    async read() {try {if(closed) throw fail();return await readPrivate(state,LIMITS.state);}catch{throw fail();}},
    async write(text) {
      let temp;
      try {
        if(closed||typeof text!=='string'||Buffer.byteLength(text)>LIMITS.state) throw fail();
        await check(); if((await lockOwner()).ownership!==ownership) throw fail();
        await file(state,true); temp=join(dir,`.state-${randomUUID()}.tmp`);
        const handle=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try {await handle.chmod(0o600);await handle.writeFile(text,'utf8');await handle.sync();}finally{await handle.close();}
        await check(); await file(temp); await file(state,true);
        await fs.rename(temp,state); temp=null;
        const parent=await fs.open(dir,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {await parent.sync();}finally{await parent.close();}
        await check();
      } catch {throw fail();}
      finally {if(temp) {try{await file(temp);await fs.unlink(temp);}catch{ /* Startup safely removes an abandoned private snapshot. */ }}}
    },
    async close() {if(closed)return;closed=true;if(owned){owned=false;await release(ownership).catch(()=>{});}}
  };
}
