import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createSingleInstanceLock} from '../src/runtime/single-instance-lock.mjs';
function fixture(run){const root=fs.mkdtempSync(path.join(os.tmpdir(),'cfb-lock-race-'));try{run({lockPath:path.join(root,'lock'),pidPath:path.join(root,'pid')})}finally{fs.rmSync(root,{recursive:true,force:true})}}
test('live owner is protected before bridge.pid is published',()=>fixture(paths=>{
 const first=createSingleInstanceLock({...paths,owner:{pid:100},processAlive:p=>p===100});
 assert.equal(first.acquire(),true);let duplicate=false;
 const second=createSingleInstanceLock({...paths,owner:{pid:101},processAlive:p=>p===100,onDuplicate:()=>{duplicate=true}});
 assert.equal(second.acquire(),false);assert.equal(duplicate,true);
 assert.equal(JSON.parse(fs.readFileSync(paths.lockPath)).pid,100);
}));
test('fresh partial lock is not removed',()=>fixture(paths=>{
 fs.writeFileSync(paths.lockPath,'');
 const lock=createSingleInstanceLock({...paths,owner:{pid:101},processAlive:()=>false});
 assert.throws(()=>lock.acquire(),/being initialized/);assert.equal(fs.readFileSync(paths.lockPath,'utf8'),'');
}));
test('dead owner and old corrupt lock can be reclaimed',()=>fixture(paths=>{
 fs.writeFileSync(paths.lockPath,JSON.stringify({pid:100}));
 const lock=createSingleInstanceLock({...paths,owner:{pid:101},processAlive:()=>false});
 assert.equal(lock.acquire(),true);assert.equal(lock.release(),true);
 fs.writeFileSync(paths.lockPath,'');const old=new Date(Date.now()-10000);fs.utimesSync(paths.lockPath,old,old);
 assert.equal(lock.acquire(),true);
}));
