import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock } from '../src/lock.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
test('two workers cannot recover or run the same database concurrently',()=>{
  const dir=mkdtempSync(join(tmpdir(),'imsg-lock-'));
  try {
    const release=acquireLock(dir);
    assert.throws(()=>acquireLock(dir),/already using/);
    release();release();
    acquireLock(dir)();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('kernel releases worker ownership after a killed process',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'imsg-crash-lock-'));
  const script=`import {acquireLock} from ${JSON.stringify(new URL('../src/lock.js',import.meta.url).href)}; acquireLock(process.argv[1]);process.stdout.write('locked\\n');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script,dir],{stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout,'data');
    assert.throws(()=>acquireLock(dir),/already using/);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    acquireLock(dir)();
  } finally {child.kill();rmSync(dir,{recursive:true,force:true});}
});
