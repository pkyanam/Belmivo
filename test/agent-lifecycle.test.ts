import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerBackend, AgentError } from '../src/agent.js';
import type { BridgeConfig } from '../src/types.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3500;
  while (!(await check())) { if (Date.now() > deadline) assert.fail('Lifecycle condition timed out'); await pause(10); }
}
function running(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-agent-lifecycle-'));
  const executable = join(directory, 'fake-codex'), events = join(directory, 'events.jsonl');
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const event=value=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({...value,pid:process.pid})+'\\n');
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let previousAlive=false;try{const prior=fs.readFileSync(${JSON.stringify(events)},'utf8').trim().split('\\n').map(JSON.parse).filter(e=>e.type==='spawn').at(-1);if(prior){try{process.kill(prior.pid,0);previousAlive=true;}catch{}}}catch{}
event({type:'spawn',previousAlive});process.on('SIGTERM',()=>event({type:'sigterm'}));
setInterval(()=>{},1000);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);event({type:'request',method:m.method});
 if(m.method==='initialize')return setTimeout(()=>send({id:m.id,result:{}}),40);
 if(m.method==='thread/start'||m.method==='thread/resume')return setTimeout(()=>send({id:m.id,result:{thread:{id:'thread-synthetic'}}}),40);
 if(m.method==='thread/name/set')return setTimeout(()=>send({id:m.id,result:{}}),40);
 if(m.method==='turn/interrupt'){event({type:'interrupt',turnId:m.params.turnId});return send({id:m.id,result:{}});}
 if(m.method!=='turn/start')return;
 const text=m.params.input[0].text,threadId=m.params.threadId,turnId='turn-synthetic';
 if(text==='badframe')return process.stdout.write('malformed-protocol\\n');
 if(text==='late'){event({type:'awaiting-turn-id'});return setTimeout(()=>send({id:m.id,result:{turn:{id:turnId}}}),120);}
 if(text==='exit')return process.exit(0);
 send({id:m.id,result:{turn:{id:turnId}}});
 send({method:'item/completed',params:{threadId,turnId,item:{id:'item-synthetic',type:'agentMessage',phase:'final_answer',text:'synthetic reply'}}});
 send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
});
`, { mode: 0o700 });
  const config = { backend: 'app-server', codexBinary: executable, cwd: directory, fullAccess: true, maxTextChars: 1000, turnTimeoutMs: 1000 } as BridgeConfig;
  const agent = new AppServerBackend(config);
  const readEvents = async (): Promise<Array<{ type: string; pid: number; method?: string; turnId?: string; previousAlive?: boolean }>> => {
    try { return (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  t.after(async () => { await agent.close(); await rm(directory, { recursive: true, force: true }); });
  return { agent, config, readEvents };
}

test('malformed protocol reaps a child that ignores SIGTERM even when close follows disconnection', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.agent.run({ text: 'badframe', onThread: () => {} }), error => error instanceof AgentError && error.outcomeUnknown);
  const pid = (await f.readEvents()).find(event => event.type === 'spawn')!.pid;
  assert.equal(running(pid), true);
  await f.agent.close();
  assert.equal(running(pid), false);
  assert.equal((await f.readEvents()).filter(event => event.type === 'sigterm').length, 1);
});

test('cleanup of an old failed child cannot terminate its replacement and never replays the old turn', { timeout: 7500 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.agent.run({ text: 'badframe', onThread: () => {} }), error => error instanceof AgentError && error.outcomeUnknown);
  assert.equal((await f.agent.run({ text: 'complete', onThread: () => {} })).text, 'synthetic reply');
  const events = await f.readEvents(), pids = events.filter(event => event.type === 'spawn').map(event => event.pid);
  assert.equal(pids.length, 2);assert.equal(running(pids[0]!), false);assert.equal(running(pids[1]!), true);
  assert.equal(events.filter(event => event.type === 'spawn')[1]!.previousAlive, false);
  assert.equal(events.filter(event => event.method === 'turn/start').length, 2);
  await f.agent.close();assert.equal(running(pids[1]!), false);
});

test('normal close is idempotent and escalates its own unresponsive child', { timeout: 5000 }, async t => {
  const f = await fixture(t);await f.agent.run({ text: 'complete', onThread: () => {} });
  const pid = (await f.readEvents()).find(event => event.type === 'spawn')!.pid;
  await Promise.all([f.agent.close(), f.agent.close()]);assert.equal(running(pid), false);
  assert.equal((await f.readEvents()).filter(event => event.type === 'sigterm').length, 1);
});

test('failed spawn and an already exited worker close without waiting for a missing exit event', { timeout: 2500 }, async t => {
  const f = await fixture(t);
  const missing = new AppServerBackend({ ...f.config, codexBinary: join(f.config.cwd, 'missing-executable') });
  await assert.rejects(missing.run({ text: 'complete', onThread: () => {} }), error => error instanceof AgentError && !error.outcomeUnknown);
  await missing.close();await missing.close();
  await assert.rejects(f.agent.run({ text: 'exit', onThread: () => {} }), error => error instanceof AgentError && error.outcomeUnknown);
  await f.agent.close();
  assert.equal((await f.readEvents()).filter(event => event.type === 'spawn').every(event => !running(event.pid)), true);
});

test('a late turn ID after cancellation is interrupted on its original child without late persistence', { timeout: 5000 }, async t => {
  const f = await fixture(t), controller = new AbortController();let persisted = 0;
  const run = f.agent.run({ text: 'late', signal: controller.signal, onThread: () => {}, onTurn: () => { persisted++; } });
  const rejected = assert.rejects(run, error => error instanceof AgentError && error.outcomeUnknown);
  await eventually(async () => (await f.readEvents()).some(event => event.type === 'awaiting-turn-id'));
  controller.abort();await rejected;
  await eventually(async () => (await f.readEvents()).some(event => event.type === 'interrupt'));
  assert.equal(persisted, 0);
  const events = await f.readEvents();assert.equal(events.filter(event => event.type === 'spawn').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'interrupt').map(event => event.turnId), ['turn-synthetic']);
});

test('close during a delayed turn ID never invokes persistence or sends an interrupt on a closed connection', { timeout: 5000 }, async t => {
  const f = await fixture(t);let persisted = 0;
  const run = f.agent.run({ text: 'late', onThread: () => {}, onTurn: () => { persisted++; } });
  const rejected = assert.rejects(run, error => error instanceof AgentError && error.outcomeUnknown);
  await eventually(async () => (await f.readEvents()).some(event => event.type === 'awaiting-turn-id'));
  await f.agent.close();await rejected;assert.equal(persisted, 0);
  assert.equal((await f.readEvents()).filter(event => event.type === 'interrupt').length, 0);
});

test('cancellation across preflight awaits prevents subsequent task effects and late callbacks', { timeout: 10000 }, async t => {
  for (const boundary of ['initialize', 'thread/start', 'thread/name/set']) {
    const f = await fixture(t), controller = new AbortController();let persisted = 0;
    const run = f.agent.run({ text: 'complete', title: 'Synthetic task', signal: controller.signal, onThread: () => { persisted++; } });
    const rejected = assert.rejects(run, error => error instanceof AgentError && !error.outcomeUnknown);
    await eventually(async () => (await f.readEvents()).some(event => event.method === boundary));
    controller.abort();await rejected;
    const events = await f.readEvents();assert.equal(events.some(event => event.method === 'turn/start'), false);
    if (boundary !== 'thread/name/set') assert.equal(persisted, 0);
    await f.agent.close();
  }
});

test('cancellation from thread persistence prevents later naming and model submission', { timeout: 5000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(f.agent.run({ text: 'complete', title: 'Synthetic task', signal: controller.signal, onThread: () => controller.abort() }), error => error instanceof AgentError && !error.outcomeUnknown);
  assert.equal((await f.readEvents()).some(event => event.method === 'thread/name/set' || event.method === 'turn/start'), false);
});
