import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, conversationKey, UNCERTAIN_NOTICE } from '../src/store.js';
import type { InboundMessage } from '../src/types.js';

function message(id = 'm1', overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { provider: 'test', eventId: `event-${id}`, messageId: id, conversationId: 'c1',
    sender: '+15555550101', recipient: '+15555550102', text: 'Run the task', isGroup: false, attachments: [], ...overrides };
}

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-imessage-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'bridge.sqlite');
}

test('dedup survives restart, includes event aliases, rejects conflicting reused IDs', t => {
  const path = fixture(t);
  let store = new Store(path);
  assert.equal(store.enqueue(message(), 5), 'queued');
  assert.equal(store.enqueue(message('m1', { eventId: 'new-event' }), 5), 'duplicate');
  assert.throws(() => store.enqueue(message('m2', { eventId: 'new-event' }), 5), /conflicting/);
  assert.throws(() => store.enqueue(message('m1', { text: 'Different action' }), 5), /conflicting/);
  store.close();
  store = new Store(path);
  assert.equal(store.enqueue(message(), 5), 'duplicate');
  assert.equal(store.stats().total, 1);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
});

test('queue saturation does not poison dedup and serial execution preserves binding', t => {
  const store = new Store(fixture(t));
  t.after(() => store.close());
  assert.equal(store.enqueue(message(), 1), 'queued');
  assert.equal(store.enqueue(message('m2'), 1), 'full');
  const first = store.next()!;
  store.start(first.id);
  assert.equal(store.next(), undefined);
  assert.throws(() => store.start(first.id));
  store.setThread(first.conversationKey, 'thread-one');
  store.setTurn(first.id, 'turn-one');
  store.complete(first.id, 'Done');
  store.markSending(first.id);
  store.markSent(first.id, 'out-one');
  assert.equal(store.enqueue(message('m2'), 1), 'queued');
  const second = store.next()!;
  assert.equal(store.getThread(second.conversationKey), 'thread-one');
  assert.notEqual(conversationKey(message()), conversationKey(message('m3', { sender: '+15555550103' })));
  assert.notEqual(conversationKey(message()), conversationKey(message('m3', { recipient: '+15555550104' })));
});

test('recovery never replays running work and preserves completed outbox', t => {
  const path = fixture(t);
  let store = new Store(path);
  store.enqueue(message(), 10);
  const first = store.next()!;
  store.start(first.id);
  store.complete(first.id, 'Durable reply');
  store.enqueue(message('m2'), 10);
  const second = store.next()!;
  store.start(second.id);
  store.setTurn(second.id, 'active-turn');
  store.enqueue(message('m3'), 10);
  store.close();
  store = new Store(path);
  assert.equal(store.recover(), 1);
  assert.equal(store.recover(), 0);
  assert.equal(store.next(), undefined, 'uncertain prior task blocks this conversation');
  assert.equal(store.pendingReplies()[0]?.reply, 'Durable reply');
  assert.equal(store.stats().uncertain, 1);
  assert.equal(store.enqueue(message('m4', { conversationId: 'different' }), 10), 'queued');
  assert.equal(store.next()?.message.messageId, 'm4');
  store.close();
});

test('possibly delivered replies cannot be failed into retryable state', t => {
  const path = fixture(t);
  let store = new Store(path);
  store.enqueue(message(), 10);
  const first = store.next()!;
  store.start(first.id);
  store.complete(first.id, 'Only once');
  store.markSending(first.id);
  assert.throws(() => store.fail(first.id, 'Network timed out'), /possibly delivered/);
  store.close();
  store = new Store(path);
  store.recover();
  assert.equal(store.pendingReplies().length, 0);
  assert.equal(store.stats().uncertain, 1);
  assert.equal(store.enqueue(message(), 10), 'duplicate');
  store.close();
});

test('process death after durable acceptance preserves queue and suppresses replay', t => {
  const path = fixture(t);
  const moduleUrl = new URL('../src/store.js', import.meta.url).href;
  const script = `import { Store } from ${JSON.stringify(moduleUrl)};
    const store = new Store(${JSON.stringify(path)});
    store.enqueue(${JSON.stringify(message())}, 10);
    process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const store = new Store(path);
  assert.equal(store.enqueue(message(), 10), 'duplicate');
  assert.equal(store.next()?.message.messageId, 'm1');
  store.close();
});

test('process death while running is held for inspection, never automatically restarted', t => {
  const path = fixture(t);
  const moduleUrl = new URL('../src/store.js', import.meta.url).href;
  const script = `import { Store } from ${JSON.stringify(moduleUrl)};
    const store = new Store(${JSON.stringify(path)});
    store.enqueue(${JSON.stringify(message())}, 10);
    store.start(store.next().id);
    process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const store = new Store(path);
  assert.equal(store.recover(), 1);
  assert.equal(store.next(), undefined);
  assert.equal(store.stats().uncertain, 1);
  store.close();
});

test('explicit uncertainty blocks replay and cannot overwrite a final state', t => {
  const store = new Store(fixture(t));
  t.after(() => store.close());
  store.enqueue(message(), 10);
  const first = store.next()!;
  store.start(first.id);
  store.uncertain(first.id, 'Start request timed out after possible acceptance');
  assert.equal(store.stats().uncertain, 1);
  assert.throws(() => store.complete(first.id, 'Invented success'));
  assert.throws(() => store.fail(first.id, 'Reset and retry'));
  assert.equal(store.next(), undefined);
});

test('task numbers are persistent and scoped to the authenticated conversation',t=>{
  const path=fixture(t),key=conversationKey(message()),other=conversationKey(message('m2',{sender:'+15555550109'}));
  let store=new Store(path);
  store.setThread(key,'first','Research');store.markThreadInitialized(key,'first');
  store.setThread(key,'second','Coding');store.setThread(other,'foreign','Private');
  const tasks=store.listThreads(key),first=tasks.find(t=>t.threadId==='first')!;
  assert.equal(tasks.length,2);assert.equal(store.threadInitialized(key,'first'),true);
  assert.equal(store.threadInitialized(key,'second'),false);
  assert.equal(store.switchThread(key,store.listThreads(other)[0]!.number),false);
  assert.equal(store.switchThread(key,first.number),true);
  store.close();store=new Store(path);
  assert.equal(store.getThread(key),'first');assert.equal(store.listThreads(key).find(t=>t.active)?.title,'Research');
  assert.equal(store.threadInitialized(key,'first'),true);store.close();
});

test('durable immediate replies survive restart without executing an agent job',t=>{
  const path=fixture(t);let store=new Store(path);
  const control=message('control',{text:'/help'});
  store.enqueue(control,10,'Command help');assert.equal(store.next(),undefined);
  store.close();store=new Store(path);store.recover();
  assert.equal(store.pendingReplies()[0]!.reply,'Command help');
  assert.equal(store.enqueue(control,10,'Changed help'),'duplicate');
  assert.equal(store.pendingReplies().length,1);store.close();
});


test('resuming, switching, and opening status do not consume new task numbers',t=>{
  const path=fixture(t),key=conversationKey(message());
  let store=new Store(path);
  store.setThread(key,'first','First');
  for(let i=0;i<4;i++){
    store.setThread(key,'first');
    assert.equal(store.switchThread(key,1),true);
    store.close();store=new Store(path);
    assert.equal(store.listThreads(key)[0]!.number,1);
  }
  store.setThread(key,'second','Second');
  assert.deepEqual(store.listThreads(key).map(t=>[t.number,t.title]),[[2,'Second'],[1,'First']]);
  store.close();
});

test('uncertain execution durably queues one independent notice without releasing its hold',t=>{
  const path=fixture(t);let store=new Store(path);
  store.enqueue(message(),10);const first=store.next()!;store.start(first.id);
  store.uncertain(first.id,'Private exception details');store.close();
  store=new Store(path);store.recover();
  assert.equal(store.pendingNotices().length,1);
  assert.equal(store.pendingNotices()[0]!.text,UNCERTAIN_NOTICE);
  assert.ok(UNCERTAIN_NOTICE.length<=100);
  assert.equal(store.claimNotice(first.id),true);assert.equal(store.claimNotice(first.id),false);
  store.finishNotice(first.id,'sent','provider-notice');
  assert.equal(store.stats().uncertain,1);assert.equal(store.pendingNotices().length,0);
  assert.equal(store.next(),undefined);assert.equal(store.enqueue(message(),10),'duplicate');
  store.close();store=new Store(path);store.recover();
  assert.equal(store.pendingNotices().length,0);assert.equal(store.claimNotice(first.id),false);store.close();
});

test('recovery queues agent interruption notices but never notices for ambiguous reply delivery',t=>{
  const store=new Store(fixture(t));t.after(()=>store.close());
  store.enqueue(message(),10);const reply=store.next()!;store.start(reply.id);store.complete(reply.id,'Answer');store.markSending(reply.id);
  store.enqueue(message('m2',{conversationId:'other'}),10);const running=store.next()!;store.start(running.id);
  assert.equal(store.recover(),2);assert.equal(store.recover(),0);
  assert.deepEqual(store.pendingNotices().map(n=>n.jobId),[running.id]);
  store.resolveUncertain(running.id,'abandon');
  assert.equal(store.pendingNotices().length,0);assert.equal(store.claimNotice(running.id),false);
});

test('process death after a notice claim never replays a potentially delivered notice',t=>{
  const path=fixture(t),moduleUrl=new URL('../src/store.js',import.meta.url).href;
  const script=`import {Store} from ${JSON.stringify(moduleUrl)};
    const store=new Store(${JSON.stringify(path)});store.enqueue(${JSON.stringify(message())},10);
    const id=store.next().id;store.start(id);store.uncertain(id,'unknown');store.claimNotice(id);
    process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script]);
  assert.equal(child.signal,'SIGKILL',child.stderr.toString());
  const store=new Store(path);store.recover();
  assert.equal(store.stats().uncertain,1);assert.equal(store.pendingNotices().length,0);
  assert.equal(store.claimNotice(store.listUncertain()[0]!.id),false);store.close();
});

test('v2 migration preserves history without sending retroactive uncertain notices',t=>{
  const path=fixture(t);let store=new Store(path);
  store.enqueue(message(),10);const id=store.next()!.id;store.start(id);store.uncertain(id,'historical');store.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE job_notices; PRAGMA user_version=2;');db.close();
  store=new Store(path);store.recover();
  assert.equal(store.stats().uncertain,1);assert.equal(store.pendingNotices().length,0);
  assert.equal(store.enqueue(message(),10),'duplicate');store.close();
  const migrated=new DatabaseSync(path);assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version,4);migrated.close();
});

test('policy rejection durably fails only unsent work while retaining dedup and uncertain holds',t=>{
  const path=fixture(t);let store=new Store(path);
  const reason='Current authorization rejected execution: unauthorized-sender. No automatic retry.';
  store.enqueue(message('queued'),10);const queued=store.next()!;store.fail(queued.id,reason);
  store.enqueue(message('completed'),10,'Unsent reply');const completed=store.pendingReplies()[0]!;store.fail(completed.id,reason);
  store.enqueue(message('sending'),10,'Possibly sent');const sending=store.pendingReplies()[0]!;store.markSending(sending.id);
  assert.throws(()=>store.fail(sending.id,reason),/possibly delivered/);
  store.uncertain(sending.id,'Existing delivery hold');assert.throws(()=>store.fail(sending.id,reason),/possibly delivered/);
  store.close();store=new Store(path);store.recover();
  assert.equal(store.stats().failed,2);assert.equal(store.stats().uncertain,1);
  assert.equal(store.listUncertain()[0]!.reason,'Existing delivery hold');
  assert.equal(store.enqueue(message('queued'),10),'duplicate');assert.equal(store.enqueue(message('completed'),10),'duplicate');
  assert.equal(store.pendingReplies().length,0);assert.equal(store.pendingNotices().length,0);store.close();
  const db=new DatabaseSync(path,{readOnly:true});
  assert.equal(db.prepare('SELECT reason FROM jobs WHERE id=?').get(queued.id)!.reason,reason);db.close();
});

test('refreshed control snapshot commits with send claim and restart holds that exact text without replay',t=>{
  const path=fixture(t);let store=new Store(path);
  store.enqueue(message('status',{text:'/status'}),10,'Ready');
  const pending=store.pendingReplies()[0]!;
  store.markSending(pending.id,'Status at send time: Paused for review');
  const reader=new DatabaseSync(path,{readOnly:true});
  try {assert.deepEqual({...reader.prepare('SELECT state,reply FROM jobs WHERE id=?').get(pending.id)},
    {state:'sending',reply:'Status at send time: Paused for review'});}finally{reader.close();}
  assert.throws(()=>store.markSending(pending.id,'Unsafe replacement'));
  store.close();store=new Store(path);
  try {
    store.recover();
    assert.equal(store.listUncertain()[0]!.reply,'Status at send time: Paused for review');
    assert.equal(store.pendingReplies().length,0);assert.equal(store.next(),undefined);
    assert.equal(store.enqueue(message('status',{text:'/status'}),10),'duplicate');
  }finally{store.close();}
});

test('startup residency reads only the latest hundred admissions and current bindings without mutations',t=>{
  const path=fixture(t),store=new Store(path);t.after(()=>store.close());
  const old=message('old-resident',{conversationId:'old'});store.enqueue(old,200);store.setThread(conversationKey(old),'old-thread');
  for(let i=0;i<100;i++)store.enqueue(message(`recent-${i}`,{conversationId:'recent'}),200);
  store.setThread(conversationKey(message('recent',{conversationId:'recent'})),'new-thread');
  const before=store.stats(),recent=store.recentActiveThreads();
  assert.equal(recent.length,100);assert.equal(recent[0]!.message.messageId,'recent-99');
  assert.equal(recent.at(-1)!.message.messageId,'recent-0');
  assert.ok(recent.every(entry=>entry.threadId==='new-thread'));assert.deepEqual(store.stats(),before);
  store.setThread(conversationKey(message('recent',{conversationId:'recent'})),'selected-thread');
  assert.ok(store.recentActiveThreads().every(entry=>entry.threadId==='selected-thread'));
});

test('confirmed cancellation preserves audit and dedup while allowing the next queued request',t=>{
  for (const outcome of ['not-started','interrupted','completed','failed'] as const) {
    const path=fixture(t);const store=new Store(path);t.after(()=>store.close());
    store.enqueue(message('target'),10);const target=store.next()!;store.start(target.id);store.setTurn(target.id,'exact-turn');
    store.enqueue(message('next'),10);
    assert.equal(store.enqueue(message('cancel',{text:'/cancel'}),10,'must not send before confirmation',target.id),'queued');
    assert.equal(store.cancellationRequested(target.id),true);assert.deepEqual(store.pendingReplies(),[]);
    const reader=new DatabaseSync(path,{readOnly:true});t.after(()=>reader.close());
    const control=reader.prepare('SELECT control_job_id FROM job_cancellations WHERE target_job_id=?').get(target.id)!;
    assert.throws(()=>store.markSending(String(control.control_job_id),'premature success'),/non-completed/);
    store.finishCancellation(target.id,outcome);store.finishCancellation(target.id,outcome);
    const audit=reader.prepare('SELECT * FROM jobs WHERE id=?').get(target.id)!;
    assert.equal(audit.state,'failed');assert.equal(audit.turn_id,'exact-turn');assert.match(String(audit.reason),/User cancellation confirmed/);
    assert.equal(audit.reply,null);assert.equal(audit.provider_message_id,null);
    assert.equal(store.cancellationRequested(target.id),false);
    assert.equal(store.pendingReplies().length,1);assert.equal(store.pendingReplies()[0]!.message.messageId,'cancel');
    assert.match(store.pendingReplies()[0]!.reply!,/You can send your next request/);
    assert.equal(store.pendingNotices().length,0);assert.equal(store.stats().uncertain,0);
    assert.equal(store.next()?.message.messageId,'next');
    assert.equal(store.enqueue(message('target'),10),'duplicate');
    assert.equal(store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,target.id),'duplicate');
    assert.throws(()=>store.finishCancellation(target.id,'unknown'),/already recorded/);
    assert.equal(store.stats().total,3);
  }
});

test('cancel admission validates exact active conversation and rolls back rejected controls',t=>{
  const path=fixture(t);const store=new Store(path);t.after(()=>store.close());
  store.enqueue(message('target'),10);const target=store.next()!;
  assert.throws(()=>store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,target.id),/must be running/);
  store.start(target.id);
  for (const overrides of [{sender:'+15555550103'},{recipient:'+15555550104'},{conversationId:'other'},{provider:'photon' as const}]) {
    assert.throws(()=>store.enqueue(message('cancel',{...overrides,text:'/cancel'}),10,undefined,target.id),/same conversation/);
  }
  assert.throws(()=>store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,'missing'),/must be running/);
  assert.equal(store.enqueue(message('cancel',{text:'/cancel'}),1,undefined,target.id),'full');
  assert.equal(store.stats().total,1);assert.equal(store.cancellationRequested(target.id),false);
  assert.equal(store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,target.id),'queued');
  store.finishCancellation(target.id,'interrupted');
  assert.throws(()=>store.enqueue(message('late',{text:'/cancel'}),10,undefined,target.id),/must be running/);
  assert.equal(store.stats().total,2);
});

test('repeated distinct cancel commands retain dedup identities but only the first acknowledgment',t=>{
  const path=fixture(t);let store=new Store(path);
  store.enqueue(message('target'),10);const target=store.next()!;store.start(target.id);
  store.enqueue(message('first-stop',{text:'/cancel'}),10,undefined,target.id);
  store.enqueue(message('second-stop',{text:'/cancel'}),10,undefined,target.id);
  assert.equal(store.enqueue(message('second-stop',{text:'/cancel',eventId:'alias'}),10,undefined,target.id),'duplicate');
  assert.throws(()=>store.enqueue(message('second-stop',{text:'different'}),10,undefined,target.id),/conflicting/);
  assert.equal(store.pendingReplies().length,0);assert.equal(store.stats().failed,1);
  store.finishCancellation(target.id,'interrupted');store.close();store=new Store(path);t.after(()=>store.close());store.recover();
  assert.equal(store.pendingReplies().length,1);assert.equal(store.pendingReplies()[0]!.message.messageId,'first-stop');
  assert.equal(store.pendingNotices().length,0);assert.equal(store.stats().total,3);
  assert.equal(store.enqueue(message('second-stop',{text:'/cancel'}),10,undefined,target.id),'duplicate');
  const reader=new DatabaseSync(path,{readOnly:true});t.after(()=>reader.close());
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM job_cancellations').get()!.n,1);
  assert.equal(reader.prepare('SELECT reason FROM jobs WHERE message_id=?').get('second-stop')!.reason,'Stop already requested; original acknowledgment retained');
});

test('unconfirmed stop has one control warning and retains its hold through late confirmation',t=>{
  const store=new Store(fixture(t));t.after(()=>store.close());
  store.enqueue(message('target'),10);const target=store.next()!;store.start(target.id);
  store.enqueue(message('next'),10);store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,target.id);
  store.finishCancellation(target.id,'unknown');store.finishCancellation(target.id,'unknown');
  assert.equal(store.stats().uncertain,1);assert.equal(store.next(),undefined);assert.equal(store.pendingNotices().length,0);
  const reply=store.pendingReplies()[0]!;assert.match(reply.reply!,/couldn't confirm that the task stopped/);
  store.markSending(reply.id);store.markSent(reply.id,'one-accepted-warning');
  assert.throws(()=>store.finishCancellation(target.id,'interrupted'),/already recorded/);
  assert.equal(store.stats().uncertain,1);assert.equal(store.pendingReplies().length,0);
  store.enqueue(message('other',{conversationId:'different'}),10);assert.equal(store.next()?.message.messageId,'other');
});

test('cancellation finalization is atomic if acknowledgment persistence fails',t=>{
  const path=fixture(t);const store=new Store(path);t.after(()=>store.close());
  store.enqueue(message('target'),10);const target=store.next()!;store.start(target.id);
  store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,target.id);
  const db=new DatabaseSync(path);t.after(()=>db.close());
  db.exec("CREATE TRIGGER reject_cancel_reply BEFORE UPDATE OF reply ON jobs WHEN NEW.message_id='cancel' BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;");
  assert.throws(()=>store.finishCancellation(target.id,'interrupted'),/synthetic write failure/);
  assert.equal(store.stats().running,1);assert.equal(store.stats().failed,0);assert.equal(store.cancellationRequested(target.id),true);
  assert.equal(store.pendingReplies().length,0);
  db.exec('DROP TRIGGER reject_cancel_reply');
  store.finishCancellation(target.id,'interrupted');assert.equal(store.stats().failed,1);assert.equal(store.pendingReplies().length,1);
});

test('real process death around cancellation preserves one acknowledgment and never replays work',t=>{
  for (const phase of ['requested','confirmed','sending'] as const) {
    const path=fixture(t);const moduleUrl=new URL('../src/store.js',import.meta.url).href;
    const script=`import {Store} from ${JSON.stringify(moduleUrl)};
      const store=new Store(${JSON.stringify(path)});
      store.enqueue(${JSON.stringify(message('target'))},10);const target=store.next();store.start(target.id);
      store.enqueue(${JSON.stringify(message('next'))},10);
      store.enqueue(${JSON.stringify(message('cancel',{text:'/cancel'}))},10,undefined,target.id);
      ${phase!=='requested'?"store.finishCancellation(target.id,'interrupted');":''}
      ${phase==='sending'?'store.markSending(store.pendingReplies()[0].id);':''}
      process.kill(process.pid,'SIGKILL');`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script]);assert.equal(child.signal,'SIGKILL',child.stderr.toString());
    const store=new Store(path);t.after(()=>store.close());
    assert.equal(store.recover(),phase==='confirmed'?0:1);assert.equal(store.recover(),0);
    assert.equal(store.pendingNotices().length,0);assert.equal(store.enqueue(message('target'),10),'duplicate');
    assert.equal(store.enqueue(message('cancel',{text:'/cancel'}),10),'duplicate');
    if (phase==='confirmed') {
      assert.equal(store.stats().failed,1);assert.equal(store.stats().uncertain,0);
      assert.equal(store.pendingReplies().length,1);assert.equal(store.next()?.message.messageId,'next');
    } else {
      assert.equal(store.stats().uncertain,1);assert.equal(store.next(),undefined);
      assert.equal(store.pendingReplies().length,phase==='requested'?1:0);
      if(phase==='requested')assert.match(store.pendingReplies()[0]!.reply!,/couldn't confirm/);
      else assert.equal(store.listUncertain()[0]!.message.messageId,'cancel','an ambiguous ACK holds itself, not a revived target');
    }
  }
});

test('cancellation cannot clear unrelated uncertain delivery or rewrite a possibly delivered target',t=>{
  const store=new Store(fixture(t));t.after(()=>store.close());
  store.enqueue(message('delivery'),10);const delivery=store.next()!;store.start(delivery.id);store.complete(delivery.id,'Reply');store.markSending(delivery.id);
  assert.throws(()=>store.enqueue(message('wrong-stop',{text:'/cancel'}),10,undefined,delivery.id),/must be running/);
  store.uncertain(delivery.id,'Provider acceptance unknown');
  assert.throws(()=>store.finishCancellation(delivery.id,'interrupted'),/No cancellation/);
  store.enqueue(message('target',{conversationId:'other'}),10);const target=store.next()!;store.start(target.id);
  store.enqueue(message('cancel',{conversationId:'other',text:'/cancel'}),10,undefined,target.id);
  store.finishCancellation(target.id,'interrupted');assert.equal(store.stats().uncertain,1);
  assert.equal(store.listUncertain()[0]!.id,delivery.id);
});

test('v3 migration preserves history and creates no retroactive cancellation claims',t=>{
  const path=fixture(t);let store=new Store(path);
  store.enqueue(message('target'),10);const target=store.next()!;store.start(target.id);store.setTurn(target.id,'legacy-turn');store.close();
  const db=new DatabaseSync(path);db.exec('DROP TABLE job_cancellations; PRAGMA user_version=3;');db.close();
  store=new Store(path);t.after(()=>store.close());assert.equal(store.recover(),1);
  assert.equal(store.cancellationRequested(target.id),false);assert.equal(store.pendingNotices().length,1);assert.equal(store.listUncertain()[0]!.turnId,'legacy-turn');
  assert.equal(store.pendingReplies().length,0);assert.equal(store.enqueue(message('target'),10),'duplicate');
  const reader=new DatabaseSync(path,{readOnly:true});t.after(()=>reader.close());assert.equal(reader.prepare('PRAGMA user_version').get()!.user_version,4);
  assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM job_cancellations').get()!.n,0);
});

test('confirmed cancellation retains and describes another same-conversation delivery hold',t=>{
  const store=new Store(fixture(t));t.after(()=>store.close());
  store.enqueue(message('target'),10);const target=store.next()!;store.start(target.id);
  store.enqueue(message('status',{text:'/status'}),10,'Working');const status=store.pendingReplies()[0]!;store.markSending(status.id);store.uncertain(status.id,'Control delivery unknown');
  store.enqueue(message('cancel',{text:'/cancel'}),10,undefined,target.id);store.enqueue(message('next'),10);
  store.finishCancellation(target.id,'interrupted');
  const ack=store.pendingReplies()[0]!;assert.match(ack.reply!,/Stopped/);assert.match(ack.reply!,/another outcome awaiting review/);
  assert.doesNotMatch(ack.reply!,/You can send your next request/);assert.equal(store.next(),undefined);
  assert.equal(store.listUncertain()[0]!.id,status.id);assert.equal(store.stats().failed,1);
});
