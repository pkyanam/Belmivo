import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerBackend, AgentError, createAgent } from '../src/agent.js';
import { AgentStoppedError, type BridgeConfig } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, timeout = 1500, delayedPreflight = '') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-imessage-agent-'));
  const executable = join(dir, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
const requestLog = ${JSON.stringify(join(dir, 'requests.jsonl'))};
const delayedPreflight = ${JSON.stringify(delayedPreflight)};
let thread = 0;
const settings = new Map();
const turns = new Map();
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 fs.appendFileSync(requestLog, JSON.stringify({method:m.method})+'\\n');
 if(m.method===delayedPreflight) return setTimeout(()=>send({id:m.id,result:m.method==='thread/start'?{thread:{id:'delayed-thread'}}:{}}),200);
 if (m.method === 'initialize') return send({id:m.id,result:{}});
 if (m.method === 'thread/start' || m.method === 'thread/resume') {
  if(m.params.approvalPolicy !== 'never' || m.params.sandbox !== 'danger-full-access') return send({id:m.id,error:{code:-10}});
  const id=m.params.threadId || 'thread-'+(++thread);
  if(m.method==='thread/start')settings.set(id,m.params.developerInstructions);
  return send({id:m.id,result:{thread:{id}}});
 }
 if (m.method === 'thread/name/set') return send({id:m.id,result:{}});
 if (m.method === 'turn/interrupt') {
  send({id:m.id,result:{}});
  const mode=turns.get(m.params.turnId);
  if(mode==='stop-disconnect') return process.exit(0);
  if(mode==='stop-ack-only') return;
  if(mode?.startsWith('stop-')) {
   send({method:'turn/completed',params:{threadId:'foreign-thread',turn:{id:m.params.turnId,status:'interrupted'}}});
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'foreign-turn',status:'interrupted'}}});
   send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{status:'interrupted'}}});
   send({method:'turn/completed',params:{threadId:m.params.threadId,turnId:m.params.turnId,turn:{id:'conflicting-turn',status:'interrupted'}}});
   const status=mode==='stop-completed'?'completed':mode==='stop-failed'?'failed':'interrupted';
   return setTimeout(()=>send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status}}}),30);
  }
  return;
 }
 if (m.method !== 'turn/start') return;
 const text = m.params.input[0].text, threadId=m.params.threadId, turnId='turn-'+m.id;
 if (text === 'disconnect') return process.exit(0);
 if (text === 'reject') return send({id:m.id,error:{code:-32602}});
 if(text.startsWith('stop-')) {
  turns.set(turnId,text);
  if(text==='stop-unidentified') {
   setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id:'foreign-turn',status:'interrupted'}}}),50);
   return setTimeout(()=>send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}}),100);
  }
  if(text==='stop-terminal-before-id') {
   send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
   setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}}),10);
   return setTimeout(()=>send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}}),80);
  }
  if(text==='stop-late-id') {
   send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
   return setTimeout(()=>send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}}),80);
  }
  send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
  return;
 }
 send({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
 if (text === 'hang') return;
 if (text === 'badframe') return process.stdout.write('not-json\\n');
 send({method:'item/completed',params:{threadId:'unrelated',turnId,item:{type:'agentMessage',id:'wrong',text:'LEAK'}}});
 send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'progress',phase:'commentary',text:'working'}}});
 const done = () => {
  if(text !== 'empty') send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'answer',phase:'final_answer',text:text==='instructions'?settings.get(threadId):'reply:'+text}}});
  send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
 };
 setTimeout(done,text==='slow'?80:5);
});
`, { mode: 0o700 });
  const config = {
    backend: 'app-server', codexBinary: executable, cwd: dir,
    fullAccess: true, maxTextChars: 10_000, turnTimeoutMs: timeout,
  } as BridgeConfig;
  const agent = new AppServerBackend(config);
  t.after(async () => { await agent.close(); await rm(dir, { recursive: true, force: true }); });
  return { agent, config, requestLog: join(dir, 'requests.jsonl') };
}

test('starts, records IDs, returns final only, and resumes a conversation', async t => {
  const { agent } = await fixture(t);
  const threadIds: string[] = [], turnIds: string[] = [];
  const first = await agent.run({ text: 'hello', onThread: id => threadIds.push(id), onTurn: id => turnIds.push(id) });
  assert.equal(first.text, 'reply:hello');
  const second = await agent.run({ threadId: first.threadId, text: 'again', onThread: id => threadIds.push(id) });
  assert.equal(second.threadId, first.threadId);
  assert.deepEqual(threadIds, [first.threadId, first.threadId]);
  assert.equal(turnIds.length, 1);
});

test('separates simultaneous conversations', async t => {
  const { agent } = await fixture(t);
  const [a, b] = await Promise.all([
    agent.run({ text: 'slow', onThread: () => {} }),
    agent.run({ text: 'fast', onThread: () => {} }),
  ]);
  assert.equal(a.text, 'reply:slow'); assert.equal(b.text, 'reply:fast');
  assert.notEqual(a.threadId, b.threadId);
});

test('disconnect after turn submission is uncertain and does not replay', async t => {
  const { agent } = await fixture(t);
  await assert.rejects(agent.run({ text: 'disconnect', onThread: () => {} }), error => error instanceof AgentError && error.outcomeUnknown);
  assert.equal((await agent.run({ text: 'reconnect', onThread: () => {} })).text, 'reply:reconnect');
});

test('protocol turn rejection is definite', async t => {
  const { agent } = await fixture(t);
  await assert.rejects(agent.run({ text: 'reject', onThread: () => {} }), error => error instanceof AgentError && !error.outcomeUnknown);
});

test('turn timeout interrupts and marks outcome uncertain', async t => {
  const { agent } = await fixture(t, 200);
  await assert.rejects(agent.run({ text: 'hang', onThread: () => {} }), error => error instanceof AgentError && error.outcomeUnknown);
});

test('cancellation after turn starts marks outcome uncertain', async t => {
  const { agent } = await fixture(t);
  const abort = new AbortController();
  await assert.rejects(agent.run({ text: 'hang', signal: abort.signal, onThread: () => {}, onTurn: () => abort.abort() }), error => error instanceof AgentError && error.outcomeUnknown);
});

test('fails closed on malformed protocol and empty answer', async t => {
  const { agent } = await fixture(t);
  await assert.rejects(agent.run({ text: 'badframe', onThread: () => {} }), /Invalid Codex protocol/);
  await assert.rejects(agent.run({ text: 'empty', onThread: () => {} }), /without a text reply/);
});

test('desktop mode requires explicit dedicated task binding', async t => {
  const { config } = await fixture(t);
  assert.throws(() => createAgent({ ...config, backend: 'desktop' }), /explicitly bound dedicated task ID/);
});

test('newThread creates a fresh app-server task and persists initial instructions', async t => {
  const { agent } = await fixture(t);
  const first = await agent.run({ text: 'hello', onThread: () => {} });
  const persisted: string[] = [];
  const fresh = await agent.run({ threadId: first.threadId, newThread: true, title: 'Fresh task', threadInstructions: 'Owner preference: terse explanations.', text: 'instructions', onThread: id => persisted.push(id) });
  assert.notEqual(fresh.threadId, first.threadId);
  assert.deepEqual(persisted, [fresh.threadId]);
  assert.match(fresh.text, /private iMessage bridge/);
  assert.match(fresh.text, /Owner preference: terse explanations/);
  const resumed = await agent.run({ threadId: fresh.threadId, text: 'instructions', onThread: () => {} });
  assert.equal(resumed.text, fresh.text);
  const attached = await agent.run({ threadId: fresh.threadId, threadInstructions: 'Initial bridge context for an existing task.', text: 'continue', onThread: () => {} });
  assert.equal(attached.text, 'reply:Initial bridge context for an existing task.\n\ncontinue');
});

for (const outcome of ['interrupted', 'completed', 'failed'] as const) {
  test(`explicit cancellation waits for exact terminal ${outcome}, ignoring foreign and missing IDs`, async t => {
    const { agent } = await fixture(t);
    const abort = new AbortController();
    let cancelledAt = 0;
    await assert.rejects(agent.run({ text: `stop-${outcome}`, signal: abort.signal, onThread: () => {},
      onTurn: () => { cancelledAt = Date.now(); abort.abort('user-cancel'); },
    }), error => error instanceof AgentStoppedError && error.outcome === outcome && !error.outcomeUnknown);
    assert.ok(Date.now() - cancelledAt >= 20, 'foreign terminal or interrupt ACK must not confirm stop');
  });
}

test('user cancellation retains active turn until late authoritative ID and exact terminal', async t => {
  const { agent } = await fixture(t);
  const abort = new AbortController();
  let selected = '', count = 0;
  const result = agent.run({ text: 'stop-late-id', signal: abort.signal, onThread: id => { selected = id; },
    onTurn: () => { count++; abort.abort('user-cancel'); },
  });
  const rejected = assert.rejects(result, error => error instanceof AgentStoppedError && error.outcome === 'interrupted');
  while (!abort.signal.aborted) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(agent.run({ text: 'no duplicate', threadId: selected, onThread: () => {} }), /already has an active turn/);
  await rejected;
  assert.equal(count, 1);
});

test('interrupt acknowledgment alone times out as unknown and keeps conversation occupied', async t => {
  const { agent } = await fixture(t, 30_000);
  const abort = new AbortController();
  const before = Date.now();
  await assert.rejects(agent.run({ text: 'stop-ack-only', signal: abort.signal, onThread: () => {},
    onTurn: () => abort.abort('user-cancel'),
  }), error => error instanceof AgentError && error.outcomeUnknown && !(error instanceof AgentStoppedError));
  assert.ok(Date.now() - before >= 9900);
});

test('disconnect after interrupt ACK remains unknown', async t => {
  const { agent } = await fixture(t);
  const abort = new AbortController();
  await assert.rejects(agent.run({ text: 'stop-disconnect', signal: abort.signal, onThread: () => {},
    onTurn: () => abort.abort('user-cancel'),
  }), error => error instanceof AgentError && error.outcomeUnknown);
});

test('user cancellation before submission is typed not-started, including metadata callback boundary', async t => {
  const { agent } = await fixture(t);
  for (const preaborted of [true, false]) {
    const abort = new AbortController();
    if (preaborted) abort.abort('user-cancel');
    let turnCallbacks = 0;
    await assert.rejects(agent.run({ text: 'never execute', title: 'metadata only', signal: abort.signal,
      onThread: () => abort.abort('user-cancel'), onTurn: () => { turnCallbacks++; },
    }), error => error instanceof AgentStoppedError && error.outcome === 'not-started');
    assert.equal(turnCallbacks, 0);
  }
});

test('terminal preceding authoritative start response is confirmed only after matching response', async t => {
  const { agent } = await fixture(t);
  const abort = new AbortController();
  let at = 0;
  await assert.rejects(agent.run({ text: 'stop-terminal-before-id', signal: abort.signal, onThread: () => {},
    onTurn: () => { at = Date.now(); abort.abort('user-cancel'); },
  }), error => error instanceof AgentStoppedError && error.outcome === 'completed');
  assert.ok(Date.now() - at >= 65, 'terminal alone must not establish submitted turn identity');
});

for (const stage of ['initialize', 'thread/start', 'thread/name/set']) {
  test(`explicit cancellation during pending ${stage} returns promptly without later model submission`, async t => {
    const { agent, requestLog } = await fixture(t, 1500, stage);
    const abort = new AbortController();
    const result = assert.rejects(agent.run({ text: 'never execute', title: 'metadata only', signal: abort.signal,
      onThread: () => {},
    }), error => error instanceof AgentStoppedError && error.outcome === 'not-started');
    const until = Date.now() + 1000;
    for (;;) {
      const log = await readFile(requestLog, 'utf8').catch(() => '');
      if (log.includes(JSON.stringify({ method: stage }))) break;
      assert.ok(Date.now() < until, 'fixture reached selected preflight request');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const before = Date.now(); abort.abort('user-cancel');
    await result;
    assert.ok(Date.now() - before < 100, 'do not wait for delayed metadata response');
    await new Promise(resolve => setTimeout(resolve, 250));
    const methods = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    assert.ok(!methods.includes('turn/start'));
  });
}

test('foreign terminal before turn identity cannot poison a later matching confirmation', async t => {
  const { agent, requestLog } = await fixture(t);
  const abort = new AbortController();
  const result = assert.rejects(agent.run({ text: 'stop-unidentified', signal: abort.signal, onThread: () => {} }),
    error => error instanceof AgentStoppedError && error.outcome === 'interrupted');
  const until = Date.now() + 1000;
  while (!(await readFile(requestLog, 'utf8').catch(() => '')).includes(JSON.stringify({ method: 'turn/start' }))) {
    assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 5));
  }
  abort.abort('user-cancel');
  await result;
});
