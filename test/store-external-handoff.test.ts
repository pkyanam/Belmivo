import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store,EXTERNAL_HANDOFF_REASON,type JobState} from '../src/store.js';
import type {InboundMessage} from '../src/types.js';

const message=(id='one',overrides:Partial<InboundMessage>={}):InboundMessage=>({provider:'photon',eventId:'event-'+id,messageId:'message-'+id,conversationId:'synthetic-conversation',sender:'+12025550101',recipient:'shared',text:'Synthetic exact handoff request',isGroup:false,attachments:[],...overrides});
function fixture(t:test.TestContext){
 const directory=mkdtempSync(join(realpathSync(tmpdir()),'belmivo-handoff-')),path=join(directory,'bridge.sqlite');let current:Store|undefined=new Store(path);
 const close=()=>{current?.close();current=undefined;};t.after(()=>{close();rmSync(directory,{recursive:true,force:true});});
 return{directory,path,get store(){assert.ok(current);return current;},close,reopen(){close();current=new Store(path);}};
}
function rows(path:string,table:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT * FROM '+table).all();}finally{db.close();}}
function sql(path:string,statement:string){const db=new DatabaseSync(path);try{db.exec(statement);}finally{db.close();}}

test('external handoff inserts failed directly and exposes no work, reply, notice or cancellation',t=>{
 const f=fixture(t);sql(f.path,"CREATE TRIGGER reject_queued BEFORE INSERT ON jobs WHEN NEW.state='queued' BEGIN SELECT RAISE(ABORT,'unexpected queued insert'); END;");
 assert.equal(f.store.reserveExternalHandoff(message(),5),'reserved');
 const job=rows(f.path,'jobs')[0]!;assert.equal(job.state,'failed');assert.equal(job.reason,EXTERNAL_HANDOFF_REASON);assert.equal(job.reply,null);assert.equal(job.turn_id,null);assert.equal(job.provider_message_id,null);
 assert.equal(rows(f.path,'events').length,1);assert.equal(f.store.next(),undefined);assert.deepEqual(f.store.pendingReplies(),[]);
 for(const table of ['job_notices','job_cancellations','conversations','thread_sessions'])assert.deepEqual(rows(f.path,table),[]);
 const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,4);}finally{db.close();}
});

test('reservation survives restart and normal enqueue cannot revive it after selector removal',t=>{
 const f=fixture(t),m=message();assert.equal(f.store.reserveExternalHandoff(m,5),'reserved');
 assert.equal(f.store.reserveExternalHandoff({...m,eventId:'second-delivery'},5),'duplicate');f.reopen();assert.equal(f.store.recover(),0);
 assert.equal(f.store.reserveExternalHandoff(m,5),'duplicate');assert.equal(f.store.enqueue({...m,eventId:'after-selector-removal'},5),'duplicate');
 assert.equal(f.store.stats().total,1);assert.equal(rows(f.path,'events').length,3);assert.equal(f.store.next(),undefined);assert.deepEqual(f.store.pendingNotices(),[]);
});

test('capacity and identifier conflicts keep existing dedup semantics',t=>{
 const f=fixture(t),m=message();f.store.enqueue(message('ordinary'),1);
 assert.equal(f.store.reserveExternalHandoff(m,1),'full');assert.equal(rows(f.path,'events').length,1);assert.equal(f.store.stats().total,1);
 f.store.fail(f.store.next()!.id,'Ordinary retained failure');assert.equal(f.store.reserveExternalHandoff(m,1),'reserved');
 f.store.enqueue(message('other'),1);assert.equal(f.store.reserveExternalHandoff(m,1),'duplicate');
 const before=rows(f.path,'events');
 for(const changed of [{...m,text:m.text+' '},{...m,sender:'+12025550199'},{...m,messageId:'different-message'}, {...m,eventId:'new-conflict',attachments:[{url:'https://example.invalid/file'}]}]){
  assert.throws(()=>f.store.reserveExternalHandoff(changed,1),/conflicting message content/);
 }
 assert.deepEqual(rows(f.path,'events'),before);assert.throws(()=>f.store.enqueue({...m,text:'changed'},1),/conflicting message content/);
 assert.throws(()=>f.store.reserveExternalHandoff(m,0),/positive integer/);
});

for(const state of ['queued','running','completed','sending','sent','uncertain','failed'] as JobState[])test(`prior ${state} admission remains unchanged and never reports quarantine`,t=>{
 const f=fixture(t),m=message();f.store.enqueue(m,5);const id=f.store.next()!.id;
 if(state!=='queued'&&state!=='failed')f.store.start(id);
 if(['completed','sending','sent'].includes(state))f.store.complete(id,'Retained existing reply');
 if(state==='sending'||state==='sent')f.store.markSending(id);
 if(state==='sent')f.store.markSent(id,'synthetic-provider-result');
 if(state==='uncertain')f.store.uncertain(id,'Existing uncertainty');
 if(state==='failed')f.store.fail(id,'A different failure');
 const before=rows(f.path,'jobs'),notices=rows(f.path,'job_notices');
 assert.equal(f.store.reserveExternalHandoff({...m,eventId:'alias-'+state},5),'already-admitted');
 assert.deepEqual(rows(f.path,'jobs'),before);assert.deepEqual(rows(f.path,'job_notices'),notices);assert.equal(rows(f.path,'events').length,2);
 assert.equal(f.store.reserveExternalHandoff(m,5),'already-admitted');assert.deepEqual(rows(f.path,'jobs'),before);
});

test('event insert rejection and commit failure roll back both admission tables',t=>{
 const f=fixture(t);
 sql(f.path,"CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END;");
 assert.throws(()=>f.store.reserveExternalHandoff(message(),5),/synthetic event failure/);assert.deepEqual(rows(f.path,'jobs'),[]);assert.deepEqual(rows(f.path,'events'),[]);
 sql(f.path,'DROP TRIGGER reject_event');
 const original=DatabaseSync.prototype.exec;let armed=true;
 DatabaseSync.prototype.exec=function(statement:string){if(armed&&statement==='COMMIT'){armed=false;throw Error('synthetic commit failure');}return original.call(this,statement);};
 try{assert.throws(()=>f.store.reserveExternalHandoff(message(),5),/synthetic commit failure/);}finally{DatabaseSync.prototype.exec=original;}
 assert.deepEqual(rows(f.path,'jobs'),[]);assert.deepEqual(rows(f.path,'events'),[]);
 assert.equal(f.store.reserveExternalHandoff(message(),5),'reserved');assert.equal(rows(f.path,'jobs').length,1);assert.equal(rows(f.path,'events').length,1);
});

for(const phase of ['before','after'])test(`real SIGKILL ${phase} reservation COMMIT leaves no queued intermediate or replay`,t=>{
 const f=fixture(t);f.close();const script=join(f.directory,'crash.mjs'),module=fileURLToPath(new URL('../src/store.js',import.meta.url)),m=message();
 writeFileSync(script,`import{Store}from ${JSON.stringify(module)};import{DatabaseSync}from'node:sqlite';const store=new Store(${JSON.stringify(f.path)}),original=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(statement){if(statement==='COMMIT'){${phase==='before'?"process.kill(process.pid,'SIGKILL');":"const result=original.call(this,statement);process.kill(process.pid,'SIGKILL');return result;"}}return original.call(this,statement);};store.reserveExternalHandoff(${JSON.stringify(m)},5);process.exitCode=3;`,{mode:0o600});
 const child=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:5000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin'}});assert.equal(child.error,undefined);assert.equal(child.signal,'SIGKILL');
 f.reopen();assert.equal(f.store.recover(),0);assert.equal(f.store.next(),undefined);assert.deepEqual(f.store.pendingReplies(),[]);
 if(phase==='before'){assert.deepEqual(rows(f.path,'jobs'),[]);assert.deepEqual(rows(f.path,'events'),[]);assert.equal(f.store.reserveExternalHandoff(m,5),'reserved');}
 else{assert.equal(rows(f.path,'jobs')[0]!.state,'failed');assert.equal(f.store.reserveExternalHandoff(m,5),'duplicate');assert.equal(f.store.enqueue(m,5),'duplicate');}
 assert.equal(f.store.stats().total,1);assert.equal(f.store.next(),undefined);assert.equal(rows(f.path,'events').length,1);
});
