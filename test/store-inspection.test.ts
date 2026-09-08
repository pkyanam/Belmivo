import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';
import type { InboundMessage } from '../src/types.js';

const message: InboundMessage = {provider:'linq',eventId:'event',messageId:'message',conversationId:'conversation',sender:'+12025550123',recipient:'+12025550124',text:'Fixture',isGroup:false,attachments:[]};
function fixture(t:test.TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'belmivo-inspection-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,path:join(directory,'bridge.sqlite')};
}
function legacy(path:string) {
  const writer=new Store(path);writer.enqueue(message,10);writer.close();
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=DELETE; DROP TABLE job_cancellations; DROP TABLE job_notices; PRAGMA user_version=2;');
  db.close();
}

test('inspection preserves legacy version, absent migration table, bytes and permissions',t=>{
  const f=fixture(t);legacy(f.path);chmodSync(f.path,0o400);
  const before=readFileSync(f.path),reader=new Store(f.path,{readOnly:true});
  assert.equal(reader.stats().queued,1);assert.deepEqual(reader.listUncertain(),[]);
  assert.throws(()=>reader.enqueue({...message,eventId:'other',messageId:'other'},10),/readonly|read.only/i);
  reader.close();
  assert.deepEqual(readFileSync(f.path),before);assert.equal(statSync(f.path).mode&0o777,0o400);
});

test('read-only readers see committed WAL work without preventing the existing writer',t=>{
  const f=fixture(t),writer=new Store(f.path),reader=new Store(f.path,{readOnly:true});
  try {
    assert.equal(reader.stats().total,0);
    assert.equal(writer.enqueue(message,10),'queued');assert.equal(reader.stats().queued,1);
    assert.equal(writer.enqueue({...message,eventId:'other',messageId:'other'},10),'queued');
    assert.equal(reader.stats().queued,2);
  } finally {reader.close();writer.close();}
});

test('inspection neither creates missing files nor repairs insecure permissions',t=>{
  const f=fixture(t),missing=join(f.directory,'missing','bridge.sqlite');
  assert.throws(()=>new Store(missing,{readOnly:true}),/No bridge database/);
  assert.equal(existsSync(join(f.directory,'missing')),false);
  assert.throws(()=>new Store(':memory:',{readOnly:true}),/existing database/);
  const writer=new Store(f.path);writer.close();chmodSync(f.path,0o644);
  assert.throws(()=>new Store(f.path,{readOnly:true}),/private, owned/);
  assert.equal(statSync(f.path).mode&0o777,0o644);
});

test('unsupported inspection schemas fail without migrating their bytes',t=>{
  for(const version of [0,5]) {
    const f=fixture(t);legacy(f.path);
    const db=new DatabaseSync(f.path);db.exec(`PRAGMA user_version=${version}`);db.close();
    const before=readFileSync(f.path);
    assert.throws(()=>new Store(f.path,{readOnly:true}),/schema/);
    assert.deepEqual(readFileSync(f.path),before);
  }
});

test('local status and review use read-only inspection on a legacy journal',t=>{
  const f=fixture(t);legacy(f.path);const before=readFileSync(f.path);
  const config=join(f.directory,'config.json');
  writeFileSync(config,JSON.stringify({provider:'linq',allowedSenders:[message.sender],serviceNumber:message.recipient,providerApiKey:'fixture-only',webhookSecret:'fixture-only-signing-secret',dataDir:f.directory}),{mode:0o600});
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  for(const command of ['status','review']) {
    const result=spawnSync(process.execPath,[cli,command,'--config',config],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,0,result.stderr);
    const output=JSON.parse(result.stdout);
    if(command==='status')assert.equal(output.queued,1);else assert.deepEqual(output,[]);
    assert.deepEqual(readFileSync(f.path),before);
  }
});

test('corrupt database inspection closes every failed open handle',t=>{
  if(!existsSync('/dev/fd')){t.skip('Descriptor enumeration unavailable');return;}
  const f=fixture(t);writeFileSync(f.path,Buffer.alloc(4096,65),{mode:0o600});
  const before=readdirSync('/dev/fd').length;
  for(let attempt=0;attempt<30;attempt++)assert.throws(()=>new Store(f.path,{readOnly:true}),/database/i);
  assert.equal(readdirSync('/dev/fd').length,before);
});
