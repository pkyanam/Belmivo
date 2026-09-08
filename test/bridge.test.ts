import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Bridge } from '../src/bridge.js';
import { AgentError } from '../src/agent.js';
import { DesktopError } from '../src/desktop.js';
import { AgentStoppedError } from '../src/types.js';
import { ProviderSendError, createProvider } from '../src/providers.js';
import { Store, UNCERTAIN_NOTICE, conversationKey } from '../src/store.js';
import type { AgentBackend, AgentRun, BridgeConfig, InboundMessage, ProviderAdapter } from '../src/types.js';

const owner = '+12025559876', line = '+12025551234';
const secret = 'test-only-webhook-secret';
const message = (id = '1', changes: Partial<InboundMessage> = {}): InboundMessage => ({
  provider: 'test', eventId: `event-${id}`, messageId: `message-${id}`, conversationId: 'conversation-1',
  sender: owner, recipient: line, isGroup: false, text: `task-${id}`, attachments: [], ...changes,
});
const sign = (raw: string) => createHmac('sha256', secret).update(raw).digest('hex');

async function eventually(check: () => boolean, description: string): Promise<void> {
  const until = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= until) assert.fail(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext, overrides: Partial<BridgeConfig> = {}, maintainThread?:AgentBackend['maintainThread'], connectionStatus?:AgentBackend['connectionStatus']) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-imessage-http-'));
  const config: BridgeConfig = {
    provider: 'linq', allowedSenders: [owner], serviceNumber: line, dataDir: join(dir, 'data'), cwd: join(dir, 'workspace'),
    port: 0, backend: 'app-server', codexBinary: 'unused-test-binary', fullAccess: true, maxPending: 20,
    maxTextChars: 16000, maxReplyChars: 12000, turnTimeoutMs: 1000, providerApiKey: 'unused-test-key', webhookSecret: secret,
    ...overrides,
  };
  const calls: AgentRun[] = [], sends: { message: InboundMessage; text: string; key: string }[] = [];
  const logs: { event: string; details?: Record<string, unknown> }[] = [];
  let invoke: AgentBackend['run'] = async input => {
    const threadId = input.threadId ?? 'thread-1';
    input.onThread(threadId); input.onTurn?.(`turn-${calls.length}`);
    return { threadId, text: `answer:${input.text}` };
  };
  let deliver: ProviderAdapter['send'] = async (_message, _text, key) => ({ id: `reply-${key}` });
  let parseCalls = 0;
  const provider: ProviderAdapter = {
    name: 'test',
    verify(raw, headers) {
      const given = headers['x-test-signature'];
      if (typeof given !== 'string' || !/^[0-9a-f]{64}$/.test(given)) return false;
      return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(sign(raw.toString('utf8')), 'hex'));
    },
    parse(body) { parseCalls++; return body as InboundMessage; },
    async send(msg, text, key) { sends.push({ message: msg, text, key }); return deliver(msg, text, key); },
  };
  const makeAgent = (): AgentBackend => ({ run: async input => { calls.push(input); return invoke(input); }, ...(maintainThread?{maintainThread}:{}), ...(connectionStatus?{connectionStatus}:{}), close: async () => {} });
  let bridge = new Bridge({ config, provider, agent: makeAgent(), log: (event, details) => logs.push({ event, details }) });
  await bridge.start();
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const url = () => `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  return {
    config, calls, sends, logs, provider, url,
    get bridge() { return bridge; }, get parseCalls() { return parseCalls; },
    runWith(fn: AgentBackend['run']) { invoke = fn; }, sendWith(fn: ProviderAdapter['send']) { deliver = fn; },
    async restart() {
      await bridge.close();
      bridge = new Bridge({ config, provider, agent: makeAgent(), log: (event, details) => logs.push({ event, details }) });
      await bridge.start();
    },
    async post(value: unknown, headers: Record<string, string> = {}, rawOverride?: string) {
      const raw = rawOverride ?? JSON.stringify(value);
      const response = await fetch(`${url()}/webhooks/${provider.name}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-signature': sign(raw), ...headers }, body: raw,
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

test('HTTP authenticated allowlisted round trip persists continuity and replies to the same conversation', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.post(message()), { status: 200, body: { status: 'queued' } });
  await eventually(() => f.bridge.store.stats().sent === 1, 'first delivery');
  assert.equal(f.calls[0]?.text, 'task-1');
  assert.equal(f.calls[0]?.threadId, undefined);
  assert.equal(f.sends[0]?.message.conversationId, 'conversation-1');
  assert.equal(f.sends[0]?.message.sender, owner);
  assert.equal(f.sends[0]?.text, 'answer:task-1');
  assert.match(f.sends[0]!.key, /^[0-9a-f-]+:0$/);
  await f.restart();
  await f.post(message('2'));
  await eventually(() => f.bridge.store.stats().sent === 2, 'second delivery after restart');
  assert.equal(f.calls[1]?.threadId, 'thread-1');
  assert.equal(JSON.stringify(f.logs).includes('task-1'), false, 'logs must not contain task text');
});

test('HTTP unauthorized senders, groups and wrong recipients never execute or receive replies', async t => {
  const f = await fixture(t);
  const rejected = [
    message('1', { sender: '+12025550000' }), message('2', { isGroup: true }),
    message('3', { recipient: '+12025550001' }), message('4', { isGroup: undefined as unknown as boolean }),
  ];
  for (const value of rejected) assert.deepEqual(await f.post(value), { status: 200, body: { status: 'ignored' } });
  assert.equal(f.bridge.store.stats().total, 0); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
});

test('HTTP verifies raw signature before parsing and rejects malformed JSON, origin and oversized body', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(message(), { 'x-test-signature': 'wrong' })).status, 401);
  const original = JSON.stringify(message());
  assert.equal((await f.post(null, { 'x-test-signature': sign(original) }, `${original} `)).status, 401);
  assert.equal(f.parseCalls, 0);
  assert.equal((await f.post(null, {}, '{')).status, 400);
  assert.equal((await f.post(message(), { Origin: 'https://untrusted.example' })).status, 415);
  assert.equal((await f.post(message(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post(null, {}, 'x'.repeat(262145))).status, 413);
  assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  const health=await fetch(`${f.url()}/healthz`);
  assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true,relay:{configured:false,connected:false}});
  assert.equal((await fetch(`${f.url()}/webhooks/other`, { method: 'POST' })).status, 404);
});

test('HTTP health exposes only relay liveness and last durable admission ACK',async t=>{
  class RelaySocket extends EventTarget {
    readyState=0;sent:string[]=[];
    send(data:string){this.sent.push(data);}
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const socket=new RelaySocket();
  t.mock.method(globalThis,'WebSocket',function(){return socket;} as unknown as typeof WebSocket);
  const relay={url:'https://private-relay.example',deviceId:'d'.repeat(32),token:'t'.repeat(40)};
  const f=await fixture(t,{relay});
  const health=async()=>{const response=await fetch(`${f.url()}/healthz`);assert.equal(response.status,200);return response.json() as Promise<Record<string,unknown>>;};
  assert.deepEqual(await health(),{ok:true,relay:{configured:true,connected:false}});
  socket.readyState=1;socket.dispatchEvent(new Event('open'));
  assert.deepEqual(await health(),{ok:true,relay:{configured:true,connected:true}});
  const raw=JSON.stringify(message('health'));
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({v:1,type:'event',id:'a'.repeat(64),eventId:'event-health',receivedAt:Date.now(),expiresAt:Date.now()+60000,bodyBase64:Buffer.from(raw).toString('base64')})}));
  await eventually(()=>socket.sent.length>0,'relay durable ACK');
  const status=await health(),diagnostic=status.relay as Record<string,unknown>;
  assert.deepEqual(Object.keys(diagnostic).sort(),['configured','connected','lastAckAt']);
  assert.equal(diagnostic.connected,true);assert.equal(typeof diagnostic.lastAckAt,'number');
  assert.equal(f.bridge.store.stats().total,1);
  for(const value of [relay.url,relay.token,relay.deviceId,owner,line,'event-health','task-health'])assert.equal(JSON.stringify(status).includes(value),false);
  socket.close();const disconnected=(await health()).relay as Record<string,unknown>;
  assert.equal(disconnected.connected,false);assert.equal(disconnected.lastAckAt,diagnostic.lastAckAt);
});

test('HTTP duplicate event/message deliveries after restart never rerun the agent', async t => {
  const f = await fixture(t);
  await f.post(message());
  await eventually(() => f.bridge.store.stats().sent === 1, 'initial delivery');
  await f.restart();
  assert.deepEqual(await f.post(message()), { status: 200, body: { status: 'duplicate' } });
  assert.deepEqual(await f.post(message('1', { eventId: 'event-retry' })), { status: 200, body: { status: 'duplicate' } });
  assert.equal((await f.post(message('1', { text: 'conflicting task' }))).status, 400);
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.bridge.store.stats().total, 1);
});

test('uncertain agent execution blocks that conversation through restart, while another can run', async t => {
  const f = await fixture(t);
  f.runWith(async input => { input.onThread('ambiguous-thread'); input.onTurn?.('ambiguous-turn'); throw new AgentError('test disconnect', true); });
  await f.post(message());
  await eventually(() => f.bridge.store.stats().uncertain === 1, 'uncertain execution');
  await f.restart();
  f.runWith(async input => ({ threadId: input.threadId ?? 'other-thread', text: 'other result' }));
  await f.post(message('2'));
  await f.post(message('3', { conversationId: 'conversation-2' }));
  await eventually(() => f.bridge.store.stats().sent === 1, 'independent conversation');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]?.text, 'task-3');
  assert.equal(f.bridge.store.stats().queued, 1); assert.equal(f.bridge.store.stats().uncertain, 1);
  assert.equal(f.sends.length, 2);assert.equal(f.sends[0]!.text,UNCERTAIN_NOTICE);
});

test('ambiguous multipart delivery is never replayed and blocks subsequent execution', async t => {
  const f = await fixture(t);
  f.runWith(async () => ({ threadId: 'thread-1', text: 'a'.repeat(1900) }));
  f.sendWith(async (_msg, _text, key) => { if (key.endsWith(':1')) throw new ProviderSendError('test timeout', true); return { id: 'accepted-first-part' }; });
  await f.post(message());
  await eventually(() => f.bridge.store.stats().uncertain === 1, 'ambiguous second part');
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends[0]!.text.startsWith('(1/2) '));
  await f.restart();
  await f.post(message('2'));
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 2);
  assert.equal(f.bridge.store.stats().queued, 1);
});

test('bounded pending queue returns retryable HTTP 503 without accepting or executing overflow', async t => {
  const f = await fixture(t, { maxPending: 1 });
  f.runWith(async () => { throw new AgentError('uncertain', true); });
  await f.post(message());
  await eventually(() => f.bridge.store.stats().uncertain === 1, 'blocked queue');
  assert.deepEqual(await f.post(message('2')), { status: 503, body: { status: 'full' } });
  assert.equal(f.bridge.store.stats().total, 1); assert.equal(f.calls.length, 1);
});

test('recovery converts persisted running work to uncertain without reexecution', async t => {
  const f = await fixture(t);
  await f.bridge.close();
  const store = new Store(join(f.config.dataDir, 'bridge.sqlite'));
  store.enqueue(message(), 20); store.start(store.next()!.id); store.close();
  await f.restart();
  assert.equal(f.bridge.store.stats().uncertain, 1);
  await eventually(()=>f.sends.length===1,'recovery notice');
  assert.equal(f.calls.length, 0); assert.equal(f.sends[0]!.text,UNCERTAIN_NOTICE);
  assert.deepEqual(await f.post(message()), { status: 200, body: { status: 'duplicate' } });
});

test('real Linq parser and signature verifier compose with the HTTP bridge', async t => {
  const f = await fixture(t);
  const adapter = createProvider({ ...f.config, webhookSecret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` });
  f.provider.name=adapter.name;f.provider.verify = adapter.verify; f.provider.parse = adapter.parse;
  const body = { api_version: 'v3', webhook_version: '2026-02-03', event_type: 'message.received', event_id: 'event-1', data: {
    chat: { id: 'chat-1', is_group: false, owner_handle: { handle: line, is_me: true } }, id: 'message-1', direction: 'inbound',
    sender_handle: { handle: owner, is_me: false }, parts: [{ type: 'text', value: 'test task' }], service: 'iMessage',
  } };
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(`event-1.${timestamp}.${raw}`).digest('base64');
  assert.equal((await f.post(body, { 'webhook-id': 'event-1', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` })).status, 200);
  await eventually(() => f.bridge.store.stats().sent === 1, 'Linq-shaped event delivery');
  assert.equal(f.calls[0]?.text, 'test task'); assert.equal(f.sends[0]?.message.conversationId, 'chat-1');
});

test('short reply budget includes truncation notice and multipart prefixes', async t => {
  const f = await fixture(t, { maxReplyChars: 100 });
  f.runWith(async () => ({ threadId: 'thread-1', text: 'Long answer. '.repeat(100) }));
  f.sendWith(async (_msg, text, key) => {
    if (text.length > f.config.maxReplyChars) throw new ProviderSendError('oversized reply', false);
    return { id: key };
  });
  await f.post(message());
  await eventually(() => f.bridge.store.stats().sent === 1, 'bounded reply delivery');
  assert.ok(f.sends.every(send => send.text.length <= 100));
  assert.ok(f.sends.map(send => send.text).join('').includes('Full result is on your Mac.'));
  assert.equal(f.bridge.store.stats().uncertain, 0);
});

test('optional typing and reaction failures never turn a delivered reply uncertain',async t=>{
  const f=await fixture(t,{statusReactions:true});let typingCalls=0,reactionCalls=0;
  f.provider.setTyping=async()=>{typingCalls++;throw Error('private provider detail');};
  f.provider.react=async()=>{reactionCalls++;throw Error('private provider detail');};
  await f.post(message());
  await eventually(()=>f.bridge.store.stats().sent===1 && reactionCalls===2,'reply despite optional failures');
  assert.equal(f.bridge.store.stats().uncertain,0);assert.equal(typingCalls,2);
  assert.equal(JSON.stringify(f.logs).includes('private provider detail'),false);
});

test('formatting-only output without files still delivers a completion reply',async t=>{
  const f=await fixture(t);
  f.runWith(async()=>({threadId:'thread-1',text:'```text\n```'}));
  await f.post(message());await eventually(()=>f.bridge.store.stats().sent===1,'nonempty completion reply');
  assert.equal(f.sends.length,1);assert.match(f.sends[0]!.text,/Task completed/);
});

test('typing stop starts before reply send and duplicate or unauthorized events produce no new indicators',async t=>{
  const f=await fixture(t,{statusReactions:true}),events:string[]=[];
  f.provider.setTyping=async(_m,active)=>{events.push(active?'typing':'stop-started');};
  f.provider.react=async(_m,phase)=>{events.push(phase);};
  f.sendWith(async()=>{assert.ok(events.includes('stop-started'));events.push('sent');return{id:'accepted'};});
  await f.post(message());await eventually(()=>events.includes('done'),'final reaction');
  assert.ok(events.indexOf('done')>events.indexOf('sent'));
  const count=events.length;
  await f.post(message());await f.post(message('foreign',{sender:'+12025550999'}));
  assert.equal(events.length,count);assert.equal(f.calls.length,1);
});

test('reply delivery overlaps pending typing stop while the next task waits for cleanup',async t=>{
  const f=await fixture(t),events:string[]=[];
  let finishAgent!:()=>void,finishStop!:()=>void;
  const firstAgent=new Promise<void>(resolve=>{finishAgent=resolve;});
  const stop=new Promise<void>(resolve=>{finishStop=resolve;});
  t.after(()=>{finishAgent();finishStop();});
  f.runWith(async input=>{
    const first=f.calls.length===1;
    events.push(first?'agent-1':'agent-2');
    if(first)await firstAgent;
    return{threadId:input.threadId??'thread-1',text:'Completed'};
  });
  f.provider.setTyping=async(m,active)=>{
    events.push(`${active?'typing':'stop-started'}:${m.messageId}`);
    if(!active && m.messageId==='message-1')await stop;
    if(!active)events.push(`stop-completed:${m.messageId}`);
  };
  f.sendWith(async m=>{events.push(`send:${m.messageId}`);return{id:'reply-'+m.messageId};});
  await f.post(message());await eventually(()=>f.calls.length===1,'first task running');
  await f.post(message('2'));finishAgent();
  await eventually(()=>f.bridge.store.stats().sent===1,'first reply while typing stop is pending');
  assert.ok(events.includes('stop-started:message-1'));
  assert.ok(events.indexOf('stop-started:message-1')<events.indexOf('send:message-1'));
  assert.equal(events.includes('stop-completed:message-1'),false);
  assert.equal(f.calls.length,1,'the next agent must wait for the old stop');
  assert.equal(events.includes('typing:message-2'),false);
  finishStop();
  await eventually(()=>f.bridge.store.stats().sent===2,'next task after old typing cleanup');
  assert.ok(events.indexOf('stop-completed:message-1')<events.indexOf('agent-2'));
  assert.ok(events.indexOf('stop-completed:message-1')<events.indexOf('typing:message-2'));
  assert.equal(f.bridge.store.stats().uncertain,0);
});

test('attachment prompt preserves full admitted text and bounds attachment metadata', async t => {
  const f = await fixture(t, { maxTextChars: 100 });
  const text = 'x'.repeat(100);
  await f.post(message('1', { text, attachments: [{ url: 'https://example.com/document.pdf', name: 'document.pdf', mimeType: 'application/pdf' }] }));
  await eventually(() => f.bridge.store.stats().sent === 1, 'attachment request');
  assert.ok(f.calls[0]!.text.startsWith(text));
  assert.ok(f.calls[0]!.text.includes('https://example.com/document.pdf'));
  assert.ok(f.calls[0]!.text.length <= f.config.maxTextChars + 40000);
  for (const attachment of [
    { url: `https://example.com/${'a'.repeat(2048)}` },
    { url: 'https://example.com/file', name: 'n'.repeat(513) },
    { url: 'https://example.com/file', mimeType: 'm'.repeat(257) },
  ]) {
    assert.deepEqual(await f.post(message('2', { attachments: [attachment] })), { status: 200, body: { status: 'ignored' } });
  }
  assert.equal(f.calls.length, 1);
});

test('transient durable enqueue failure returns retryable HTTP status and accepts a later retry', async t => {
  const f = await fixture(t);
  const enqueue = t.mock.method(f.bridge.store, 'enqueue', () => { throw new Error('test-only disk full'); });
  assert.equal((await f.post(message())).status, 503);
  assert.equal(f.calls.length, 0); assert.equal(f.bridge.store.stats().total, 0);
  enqueue.mock.restore();
  assert.deepEqual(await f.post(message()), { status: 200, body: { status: 'queued' } });
  await eventually(() => f.bridge.store.stats().sent === 1, 'retry after storage recovery');
  assert.equal(f.calls.length, 1);
});

test('operator resolution unblocks queued work without replaying the uncertain task or erasing deduplication', async t => {
  const f = await fixture(t);
  f.runWith(async () => { throw new AgentError('test unknown outcome', true); });
  await f.post(message());
  await eventually(() => f.bridge.store.stats().uncertain === 1, 'task awaiting review');
  await f.post(message('2'));
  const held = f.bridge.store.listUncertain();
  assert.equal(held.length, 1);
  f.bridge.store.resolveUncertain(held[0]!.id, 'abandon');
  assert.equal(f.bridge.store.stats().failed, 1);
  assert.throws(() => f.bridge.store.resolveUncertain(held[0]!.id, 'delivered'), /not uncertain/);
  f.runWith(async () => ({ threadId: 'thread-1', text: 'next result' }));
  await f.restart();
  await eventually(() => f.bridge.store.stats().sent === 1, 'queued task after operator review');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1]?.text, 'task-2');
  assert.equal(f.sends.length, 2);assert.equal(f.sends[0]!.text,UNCERTAIN_NOTICE);
  assert.deepEqual(await f.post(message()), { status: 200, body: { status: 'duplicate' } });
  assert.equal(f.calls.length, 2);
});

test('HTTP reply formatting keeps media after the phone text budget and hides artifact Markdown paths', async t => {
  const f = await fixture(t, { artifactsDir: '/safe/out', maxReplyChars: 100 });
  const files: { path: string; key: string }[] = [];
  f.provider.sendMedia = async (_message, file, key) => { files.push({ path: file.path, key }); return { id: 'media-accepted' }; };
  f.runWith(async () => ({ threadId: 'thread-1', text: '**Answer**\n' + 'long explanation '.repeat(40) + '\n![Generated image](/safe/out/image (final).png)' }));
  await f.post(message());
  await eventually(() => f.bridge.store.stats().sent === 1, 'formatted text and late artifact');
  assert.equal(files.length, 1); assert.equal(files[0]?.path, '/safe/out/image (final).png');
  assert.ok(files[0]!.key.endsWith(':file:0'));
  assert.ok(f.sends.length > 0);
  const text = f.sends.map(send => send.text).join('');
  assert.equal(text.includes('**'), false); assert.equal(text.includes('/safe/out'), false); assert.equal(text.includes('!['), false);
  assert.ok(f.sends.every(send => send.text.length <= 100));
});

test('HTTP image-only reply delivers one attachment without an empty or fallback text message', async t => {
  const f = await fixture(t, { artifactsDir: '/safe/out' });
  const files: string[] = [];
  f.provider.sendMedia = async (_message, file) => { files.push(file.path); return { id: 'media-accepted' }; };
  f.runWith(async () => ({ threadId: 'thread-1', text: '![Generated image](/safe/out/image.png)' }));
  await f.post(message());
  await eventually(() => f.bridge.store.stats().sent === 1, 'image-only delivery');
  assert.deepEqual(files, ['/safe/out/image.png']); assert.equal(f.sends.length, 0);
});

test('HTTP coding reply strips prose Markdown and code fences while preserving code operators', async t => {
  const f = await fixture(t);
  f.runWith(async () => ({ threadId: 'thread-1', text: '**Result**\n```python\nvalue_name = 2 ** 3\nprint("__init__")\n```' }));
  await f.post(message());
  await eventually(() => f.bridge.store.stats().sent === 1, 'formatted code delivery');
  assert.equal(f.sends[0]?.text, 'Result\nvalue_name = 2 ** 3\nprint("__init__")');
});


test('ordinary answers keep typing but have no automatic tapbacks',async t=>{
  const f=await fixture(t),events:string[]=[];
  f.provider.setTyping=async(_m,active)=>{events.push(active?'typing':'stopped');};
  f.provider.react=async(_m,kind)=>{events.push(kind);};
  f.runWith(async()=>({threadId:'thread-1',text:'Here is your answer.'}));
  await f.post(message());await eventually(()=>f.bridge.store.stats().sent===1,'ordinary delivery');
  await f.bridge.close();
  assert.deepEqual(events,['typing','stopped']);
  assert.match(f.calls[0]!.text,/Most replies should have NO reaction/);
});

test('chosen conversational tapback follows delivery once and its directive never reaches the phone',async t=>{
  const f=await fixture(t),events:string[]=[];
  f.provider.react=async(_m,kind)=>{assert.equal(f.bridge.store.stats().sent,1);events.push(kind);};
  f.runWith(async()=>({threadId:'thread-1',text:'That made me laugh.\n[[imessage-reaction:laugh]]'}));
  f.sendWith(async()=>{events.push('sent');return{id:'accepted'};});
  await f.post(message());await eventually(()=>events.includes('laugh'),'chosen reaction');
  assert.deepEqual(events,['sent','laugh']);assert.equal(f.sends[0]!.text,'That made me laugh.');
  await f.restart();await f.post(message());
  assert.deepEqual(events,['sent','laugh']);assert.equal(f.calls.length,1);
});

test('delivery failure suppresses a chosen tapback and does not replay it after restart',async t=>{
  const f=await fixture(t),reactions:string[]=[];
  f.provider.react=async(_m,kind)=>{reactions.push(kind);};
  f.runWith(async()=>({threadId:'thread-1',text:'a'.repeat(1900)+'\n[[imessage-reaction:like]]'}));
  f.sendWith(async(_m,_text,key)=>{if(key.endsWith(':1'))throw new ProviderSendError('uncertain',true);return{id:'first'};});
  await f.post(message());await eventually(()=>f.bridge.store.stats().uncertain===1,'partial send');
  await f.restart();assert.deepEqual(reactions,[]);assert.equal(f.sends.length,2);
});

test('directive-only output gets a neutral fallback and no reaction',async t=>{
  const f=await fixture(t),reactions:string[]=[];
  f.provider.react=async(_m,kind)=>{reactions.push(kind);};
  f.runWith(async()=>({threadId:'thread-1',text:'[[imessage-reaction:like]]'}));
  await f.post(message());await eventually(()=>f.bridge.store.stats().sent===1,'fallback');
  await f.bridge.close();assert.deepEqual(reactions,[]);assert.equal(f.sends[0]!.text,'Got it.');
});

test('disabled conversational reactions suppress model choices and omit their prompt instructions',async t=>{
  const f=await fixture(t,{conversationalReactions:false}),reactions:string[]=[];
  f.provider.react=async(_m,kind)=>{reactions.push(kind);};
  f.runWith(async()=>({threadId:'thread-1',text:'You are welcome.\n[[imessage-reaction:love]]'}));
  await f.post(message());await eventually(()=>f.bridge.store.stats().sent===1,'disabled reaction delivery');
  await f.bridge.close();assert.deepEqual(reactions,[]);
  assert.equal(f.calls[0]!.text,'task-1');assert.equal(f.sends[0]!.text,'You are welcome.');
});

test('help and status bypass a long running agent, preserve dedup and sender scope',async t=>{
  const f=await fixture(t);let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  t.after(()=>release());
  f.runWith(async input=>{input.onThread('thread-1');await gate;return{threadId:'thread-1',text:'Finished'};});
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('status',{text:'/status'}));
  await eventually(()=>f.sends.length===1,'status before long turn finishes');
  assert.match(f.sends[0]!.text,/Working/);assert.equal(f.bridge.store.stats().running,1);
  await f.post(message('help',{text:'/help'}));await eventually(()=>f.sends.length===2,'help without model');
  await f.post(message('help',{text:'/help'}));
  await f.post(message('foreign',{sender:'+12025550999',text:'/status'}));
  assert.equal(f.sends.length,2);assert.equal(f.calls.length,1);
  release();await eventually(()=>f.bridge.store.stats().sent===3,'original result');
});

test('new task receives instructions and greeting once, and switching restores its prior context',async t=>{
  const f=await fixture(t,{threadInstructions:'Personal test instructions.'});let fresh=0;
  f.runWith(async input=>{
    const id=input.newThread?`new-${++fresh}`:input.threadId??'original';
    input.onThread(id);return{threadId:id,text:input.newThread?'Hello! How can I help?':'Useful answer'};
  });
  await f.post(message());await eventually(()=>f.bridge.store.stats().sent===1,'original');
  const original=f.bridge.store.listThreads(f.bridge.store.pendingReplies()[0]?.conversationKey??JSON.stringify(['test',line,owner,'conversation-1'])).find(t=>t.threadId==='original')!;
  await f.post(message('new',{text:'/new Research'}));await eventually(()=>f.bridge.store.stats().sent===2,'greeting');
  assert.equal(f.calls[1]!.newThread,true);assert.equal(f.calls[1]!.title,'Research');
  assert.equal(f.calls[1]!.threadInstructions,'Personal test instructions.');assert.match(f.calls[1]!.text,/Hello! How can I help/);
  await f.post(message('followup'));await eventually(()=>f.bridge.store.stats().sent===3,'new continuity');
  assert.equal(f.calls[2]!.threadId,'new-1');assert.equal(f.calls[2]!.threadInstructions,undefined);
  await f.restart();await f.post(message('switch',{text:`/switch ${original.number}`}));
  await eventually(()=>f.bridge.store.stats().sent===4,'switch confirmation');assert.equal(f.calls.length,3);
  await f.post(message('again'));await eventually(()=>f.bridge.store.stats().sent===5,'old continuity');
  assert.equal(f.calls[3]!.threadId,'original');assert.equal(f.calls[3]!.threadInstructions,undefined);
});

test('cancel requests stop only active work in its own conversation and remains available during uncertainty',async t=>{
  const f=await fixture(t);let stopped=0;
  f.runWith(async input=>new Promise((_resolve,reject)=>{input.signal!.addEventListener('abort',()=>{stopped++;reject(new AgentError('stopped',true));},{once:true});}));
  await f.post(message());await eventually(()=>f.calls.length===1,'active job');
  await f.post(message('cancel',{text:'/cancel'}));
  await eventually(()=>f.bridge.store.stats().uncertain===1 && f.bridge.store.stats().sent===1,'stop and acknowledgment');
  await f.post(message('cancel',{text:'/cancel'}));assert.equal(stopped,1);
  await f.post(message('status',{text:'/status'}));await eventually(()=>f.bridge.store.stats().sent===2,'status despite review hold');
  assert.ok(f.sends.some(send=>/1 need review/.test(send.text)));assert.equal(f.calls.length,1);
});

test('slash commands with attachments never create tasks or download attachments',async t=>{
  const f=await fixture(t);let prepared=0;
  f.provider.prepareInbound=async m=>{prepared++;return m;};
  await f.post(message('new',{text:'/new',attachments:[{url:'https://example.com/file'}]}));
  await eventually(()=>f.bridge.store.stats().sent===1,'command guidance');
  assert.equal(f.calls.length,0);assert.equal(prepared,0);assert.match(f.sends[0]!.text,/without attachments/);
});

test('uncertain task sends one bounded notice with no details or tapback and remains held across restart',async t=>{
  const f=await fixture(t,{maxReplyChars:100,statusReactions:false}),reactions:string[]=[];
  f.provider.react=async(_m,reaction)=>{reactions.push(reaction);};
  f.runWith(async()=>{throw new AgentError('private-path-and-token',true);});
  f.sendWith(async(_m,text,key)=>{
    assert.equal(f.bridge.store.stats().uncertain,1);assert.ok(text.length<=100);
    assert.equal(f.bridge.store.pendingNotices().length,0,'claim persisted before provider invocation');
    assert.match(key,/:uncertain-notice$/);return{id:'accepted-notice'};
  });
  await f.post(message());await eventually(()=>f.sends.length===1,'uncertainty notice');
  await f.restart();await f.post(message());await f.post(message('next'));
  assert.equal(f.calls.length,1);assert.equal(f.sends.length,1);assert.equal(f.sends[0]!.text,UNCERTAIN_NOTICE);
  assert.equal(f.sends[0]!.message.sender,owner);assert.equal(f.sends[0]!.message.conversationId,'conversation-1');
  assert.equal(f.bridge.store.stats().uncertain,1);assert.equal(f.bridge.store.stats().queued,1);
  assert.deepEqual(reactions,[]);assert.equal(JSON.stringify(f.logs).includes('private-path-and-token'),false);
});

test('uncertain notice delivery is held independently with no send retry or agent replay',async t=>{
  const f=await fixture(t);
  f.runWith(async()=>{throw new AgentError('unknown task',true);});
  f.sendWith(async()=>{throw new ProviderSendError('private ambiguous provider detail',true);});
  await f.post(message());await eventually(()=>f.logs.some(l=>l.event==='uncertainty-notice-needs-review'),'notice hold');
  await f.restart();await f.post(message());
  assert.equal(f.sends.length,1);assert.equal(f.calls.length,1);
  assert.equal(f.bridge.store.pendingNotices().length,0);assert.equal(f.bridge.store.stats().uncertain,1);
  assert.equal(JSON.stringify(f.logs).includes('private ambiguous provider detail'),false);
});

test('recovery notice is suppressed if its sender is no longer authorized',async t=>{
  const f=await fixture(t);await f.bridge.close();
  const store=new Store(join(f.config.dataDir,'bridge.sqlite'));
  store.enqueue(message(),20);store.start(store.next()!.id);store.close();
  f.config.allowedSenders=['+12025550099'];await f.restart();
  await eventually(()=>f.bridge.store.pendingNotices().length===0,'revoked notice skipped');
  assert.equal(f.sends.length,0);assert.equal(f.calls.length,0);assert.equal(f.bridge.store.stats().uncertain,1);
});

test('restart suppresses revoked queued tasks and commands before preparation or execution while allowed work continues',async t=>{
  const f=await fixture(t),allowed='+12025550099',key=conversationKey(message());
  await f.bridge.close();
  const store=new Store(join(f.config.dataDir,'bridge.sqlite'));
  store.setThread(key,'original','Original');store.setThread(key,'other','Other');store.switchThread(key,1);
  const revoked=[message('revoked',{attachments:[{url:'https://example.com/private.pdf'}]}),message('new',{text:'/new Private'}),message('switch',{text:'/switch 2'})];
  for(const m of revoked)store.enqueue(m,20);
  store.enqueue(message('allowed',{sender:allowed}),20);store.close();
  const prepared:string[]=[],indicators:string[]=[];
  f.provider.prepareInbound=async m=>{prepared.push(m.sender);return m;};
  f.provider.setTyping=async m=>{indicators.push(m.sender);};
  f.config.allowedSenders=[allowed];await f.restart();
  await eventually(()=>f.bridge.store.stats().sent===1,'allowed queued work after revocation');
  assert.equal(f.bridge.store.stats().failed,3);assert.equal(f.bridge.store.stats().uncertain,0);
  assert.equal(f.bridge.store.getThread(key),'original');assert.equal(f.bridge.store.listThreads(key).length,2);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.text,'task-allowed');assert.deepEqual(prepared,[allowed]);
  assert.ok(indicators.every(sender=>sender===allowed));assert.equal(f.sends.length,1);assert.equal(f.sends[0]!.message.sender,allowed);
  assert.equal(f.logs.filter(l=>l.event==='pending-policy-rejected' && l.details?.reason==='unauthorized-sender').length,3);
  // Restoring authorization must not turn an old rejected request into new work.
  f.config.allowedSenders=[owner,allowed];await f.restart();
  for(const m of revoked)assert.deepEqual(await f.post(m),{status:200,body:{status:'duplicate'}});
  assert.equal(f.calls.length,1);assert.equal(f.sends.length,1);assert.equal(f.bridge.store.stats().failed,3);
});

test('restart suppresses revoked completed text, media and control replies but sends unchanged authorized outbox',async t=>{
  const f=await fixture(t,{artifactsDir:'/safe/out'}),allowed='+12025550099';await f.bridge.close();
  const store=new Store(join(f.config.dataDir,'bridge.sqlite'));
  const old=message('old'),help=message('help',{text:'/help'});
  store.enqueue(old,20);const job=store.next()!;store.start(job.id);store.complete(job.id,'Private result [file](/safe/out/result.pdf)');
  store.enqueue(help,20,'Private command response');
  store.enqueue(message('allowed',{sender:allowed}),20,'Allowed persisted reply');store.close();
  let media=0,indicators=0;f.provider.sendMedia=async()=>{media++;return{id:'unexpected'};};
  f.provider.setTyping=async()=>{indicators++;};f.provider.react=async()=>{indicators++;};
  f.config.allowedSenders=[allowed];await f.restart();
  await eventually(()=>f.bridge.store.stats().sent===1,'authorized durable reply');
  assert.equal(f.bridge.store.stats().failed,2);assert.equal(f.bridge.store.pendingReplies().length,0);
  assert.equal(f.calls.length,0);assert.equal(f.sends.length,1);assert.equal(f.sends[0]!.text,'Allowed persisted reply');
  assert.equal(media,0);assert.equal(indicators,0);
  f.config.allowedSenders=[owner,allowed];await f.restart();
  for(const m of [old,help])assert.deepEqual(await f.post(m),{status:200,body:{status:'duplicate'}});
  assert.equal(f.sends.length,1);assert.equal(f.calls.length,0);
});

test('a changed service line or provider blocks persisted work without touching uncertain delivery holds',async t=>{
  for(const change of ['line','provider'] as const)await t.test(change,async t=>{
    const f=await fixture(t);await f.bridge.close();
    const store=new Store(join(f.config.dataDir,'bridge.sqlite'));
    store.enqueue(message('sending'),20);const sending=store.next()!;store.start(sending.id);store.complete(sending.id,'Possibly sent');store.markSending(sending.id);
    store.enqueue(message('queued',{conversationId:'other-chat'}),20);
    store.enqueue(message('completed'),20,'Pending private reply');store.close();
    if(change==='line')f.config.serviceNumber='+12025550098';else f.provider.name='linq';
    await f.restart();await eventually(()=>f.bridge.store.stats().failed===2,'stale provider/line rejected');
    assert.equal(f.bridge.store.stats().uncertain,1);assert.equal(f.bridge.store.listUncertain()[0]!.id,sending.id);
    assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);assert.equal(f.bridge.store.pendingNotices().length,0);
  });
});


test('cancel reaches inbound preparation and never submits or replays the interrupted request',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});let preparing=false,aborted=false;
  f.provider.prepareInbound=async(_message,signal)=>new Promise((_resolve,reject)=>{
    assert.ok(signal);preparing=true;
    signal.addEventListener('abort',()=>{aborted=true;reject(new Error('synthetic download cancelled'));},{once:true});
  });
  await f.post(message('download'));
  await eventually(()=>preparing,'inbound preparation');
  await f.post(message('stop-download',{text:'/cancel'}));
  await eventually(()=>aborted && f.bridge.store.stats().failed===1 && f.bridge.store.stats().sent===1,'cancelled download acknowledgment');
  assert.equal(f.calls.length,0);
  await f.restart();
  assert.equal((await f.post(message('download'))).body.status,'duplicate');
  assert.equal(f.calls.length,0);assert.equal(f.bridge.store.stats().uncertain,0);
  assert.match(f.sends[0]!.text,/before the agent started/);
});

test('late successful inbound preparation cannot start the agent after cancellation',async t=>{
  let release:()=>void=()=>{},preparing=false;
  t.after(()=>release());
  const f=await fixture(t,{turnTimeoutMs:10000});
  f.provider.prepareInbound=async m=>{await new Promise<void>(resolve=>{release=resolve;preparing=true;});return m;};
  await f.post(message('late-download'));
  await eventually(()=>preparing,'late preparation');
  await f.post(message('stop-late',{text:'/cancel'}));
  release();
  await eventually(()=>f.bridge.store.stats().failed===1 && f.bridge.store.stats().sent===1,'cancellation after late preparation');
  assert.equal(f.calls.length,0);
});

test('shutdown aborts inbound preparation and releases the receiver lock',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});let preparing=false,aborted=false;
  f.provider.prepareInbound=async(_message,signal)=>new Promise((_resolve,reject)=>{
    assert.ok(signal);preparing=true;
    signal.addEventListener('abort',()=>{aborted=true;reject(new Error('synthetic download stopped'));},{once:true});
  });
  await f.post(message('shutdown-download'));
  await eventually(()=>preparing,'shutdown preparation');
  const started=Date.now();
  await f.bridge.close();
  assert.ok(Date.now()-started<2000,'shutdown must not wait for the turn timeout');
  assert.equal(aborted,true);assert.equal(f.calls.length,0);
  await f.restart();
  assert.equal(f.bridge.store.stats().uncertain,1);assert.equal(f.calls.length,0);
});

test('queued status refreshes after an earlier send becomes uncertain',async t=>{
  const f=await fixture(t);let failFirst!:(error:Error)=>void;
  f.sendWith(async(msg)=>{
    if(msg.messageId==='message-first')await new Promise<void>((_resolve,reject)=>{failFirst=reject;});
    return{id:'synthetic-status'};
  });
  try {
  await f.post(message('first'));await eventually(()=>!!failFirst,'pending first send');
  await f.post(message('status-refresh',{text:'/status'}));
  const waiting=f.bridge.store.pendingReplies().find(job=>job.message.messageId==='message-status-refresh')!;
  assert.match(waiting.reply!,/Reply awaiting delivery/);
  assert.match(waiting.reply!,/1 awaiting delivery/);
  failFirst(new Error('Synthetic unknown send outcome'));
  await eventually(()=>f.sends.some(send=>send.message.messageId==='message-status-refresh'),'refreshed status');
  const text=f.sends.find(send=>send.message.messageId==='message-status-refresh')!.text;
  assert.match(text,/Status at send time:/);assert.match(text,/Paused for review/);assert.match(text,/1 need review/);
  assert.doesNotMatch(text,/\bReady\b/);assert.equal(f.bridge.store.stats().uncertain,1);
  assert.equal(f.calls.length,1);
  } finally {failFirst?.(new Error('fixture cleanup'));}
});

test('threads under first-task uncertainty guides local resolution and never recommends blocked new work',async t=>{
  const f=await fixture(t);f.runWith(async()=>{throw new AgentError('Synthetic uncertain creation',true);});
  await f.post(message('first'));await eventually(()=>f.bridge.store.stats().uncertain===1,'first task hold');
  await f.post(message('held-threads',{text:'/threads'}));
  await eventually(()=>f.sends.some(send=>send.message.messageId==='message-held-threads'),'held threads guidance');
  const text=f.sends.find(send=>send.message.messageId==='message-held-threads')!.text;
  assert.match(text,/No tasks yet/);assert.match(text,/paused for review/);assert.match(text,/\/status/);assert.match(text,/resolve the hold on your Mac/);
  assert.doesNotMatch(text,/Send a message or \/new|Use \/switch/);
  await f.post(message('new-after-hold',{text:'/new'}));
  assert.equal(f.bridge.store.stats().queued,1);assert.equal(f.bridge.store.next(),undefined);assert.equal(f.calls.length,1);
});

test('status excludes its own reply but reports other completed replies waiting for delivery',async t=>{
  const f=await fixture(t);
  f.bridge.store.enqueue(message('queued-status',{text:'/status'}),20,'Old status');
  f.bridge.store.enqueue(message('queued-answer'),20,'Synthetic pending answer');
  await f.post(message('trigger',{text:'/help'}));
  await eventually(()=>f.sends.some(send=>send.message.messageId==='message-queued-status'),'delivery-aware status');
  const text=f.sends.find(send=>send.message.messageId==='message-queued-status')!.text;
  assert.match(text,/Reply awaiting delivery/);assert.match(text,/2 awaiting delivery/);assert.doesNotMatch(text,/\bReady\b/);
  assert.equal(f.calls.length,0);
});

test('definite desktop failures use only static diagnostic codes and actionable phone guidance',async t=>{
  const f=await fixture(t);
  const cases:[string,RegExp][]=[
    ['desktop-snapshot-timeout',/did not respond.*Open the app/],
    ['desktop-unavailable',/could not connect.*connection checks/],
    ['desktop-owner-unavailable',/not available.*Open that task/],
    ['desktop-owner-protocol',/app connection needs attention.*app version/],
    ['desktop-busy',/busy.*Wait for it to finish/],
    ['desktop-full-access',/requires Full Access.*permissions/],
    ['desktop-create-inheritance',/built-in Full Access.*\/new again/],
  ];
  for(const [code,guidance] of cases) {
    const marker='PRIVATE_ERROR_CONTENT_09876';
    f.runWith(async()=>{throw new DesktopError(marker,false,code);});
    await f.post(message(code));
    await eventually(()=>f.sends.some(send=>send.message.messageId===`message-${code}`),'classified failure guidance');
    const text=f.sends.find(send=>send.message.messageId===`message-${code}`)!.text;
    assert.match(text,guidance);assert.ok(text.length<220);assert.equal(f.bridge.store.stats().uncertain,0);
    assert.equal(f.logs.filter(log=>log.event==='task-error').at(-1)!.details!.diagnostic,code);
    assert.equal(JSON.stringify([f.sends,f.logs]).includes(marker),false);
  }
});

test('arbitrary or spoofed diagnostic codes cannot leak error content or claim a known desktop condition',async t=>{
  const f=await fixture(t),marker='PRIVATE_ERROR_CONTENT_56789';
  const failures=[new DesktopError(marker,false,marker),new DesktopError(marker,false,'__proto__'),new DesktopError(marker,false,'x'.repeat(10000)),Object.assign(new Error(marker),{code:'desktop-busy'})];
  for(const [index,error] of failures.entries()) {
    f.runWith(async()=>{throw error;});await f.post(message(`private-${index}`));
    await eventually(()=>f.sends.length===index+1,'generic failure');
    assert.match(f.sends[index]!.text,/agent could not complete.*setup guide/);
    const diagnostic=f.logs.filter(log=>log.event==='task-error').at(-1)!.details!.diagnostic;
    assert.equal(diagnostic,error instanceof DesktopError?'desktop-error':'agent-error');
  }
  assert.equal(JSON.stringify([f.sends,f.logs]).includes(marker),false);
  assert.equal(JSON.stringify([f.sends,f.logs]).includes('x'.repeat(100)),false);
});

test('known desktop codes with unknown outcomes preserve holds and never send definite-failure retry guidance',async t=>{
  const f=await fixture(t),marker='PRIVATE_UNCERTAIN_ERROR_001';
  f.runWith(async()=>{throw new DesktopError(marker,true,'desktop-owner-unavailable');});
  await f.post(message('unknown-desktop'));
  await eventually(()=>f.sends.length===1,'unchanged uncertainty notice');
  assert.equal(f.sends[0]!.text,UNCERTAIN_NOTICE);
  assert.equal(f.bridge.store.stats().uncertain,1);
  assert.equal(f.logs.find(log=>log.event==='task-error')!.details!.diagnostic,'desktop-owner-unavailable');
  assert.equal(f.logs.find(log=>log.event==='task-error')!.details!.outcomeUnknown,true);
  await f.post(message('held-followup'));assert.equal(f.bridge.store.next(),undefined);assert.equal(f.calls.length,1);
  assert.equal(JSON.stringify([f.sends,f.logs]).includes(marker),false);
});

test('residency restores only currently authorized saved bindings without invoking the agent',async t=>{
  const maintained:(string|undefined)[]=[];
  const f=await fixture(t,{},id=>{maintained.push(id);});
  assert.deepEqual(maintained,[undefined]);
  await f.post(message('resident-original'));
  await eventually(()=>f.bridge.store.stats().sent===1,'original completed');
  assert.deepEqual(maintained,[undefined,'thread-1']);
  const stale=message('stale-resident',{sender:'+12025550111',conversationId:'stale-chat'});
  f.bridge.store.enqueue(stale,20);f.bridge.store.setThread(conversationKey(stale),'stale-thread');
  const changedProvider=message('old-provider',{provider:'photon',conversationId:'old-provider-chat'});
  f.bridge.store.enqueue(changedProvider,20);f.bridge.store.setThread(conversationKey(changedProvider),'wrong-provider-thread');
  await f.restart();
  assert.equal(maintained.at(-1),'thread-1');assert.equal(maintained.length,3);
  assert.equal(f.calls.length,1);
  await eventually(()=>f.bridge.store.stats().failed===2,'old policy rejected');
});

test('residency follows valid task switches and binds but ignores missing and unauthorized switches',async t=>{
  const maintained:(string|undefined)[]=[];
  const f=await fixture(t,{},id=>{maintained.push(id);});
  await f.post(message('first-resident'));await eventually(()=>f.bridge.store.stats().sent===1,'first task');
  const key=conversationKey(message());f.bridge.store.setThread(key,'thread-2','Second');
  const second=f.bridge.store.listThreads(key).find(task=>task.threadId==='thread-2')!.number;
  f.bridge.store.setThread(key,'thread-1');
  await f.post(message('switch-resident',{text:`/switch ${second}`}));
  await eventually(()=>f.bridge.store.stats().sent===2,'switch delivered');
  assert.deepEqual(maintained,[undefined,'thread-1','thread-2']);assert.equal(f.calls.length,1);
  await f.post(message('missing-resident',{text:'/switch 9999'}));
  await eventually(()=>f.bridge.store.stats().sent===3,'missing task reply');
  await f.post(message('unauthorized-resident',{text:'/switch 1',sender:'+12025550111'}));
  assert.deepEqual(maintained,[undefined,'thread-1','thread-2']);
});

test('residency failures do not change task outcomes or leak errors',async t=>{
  for(const maintain of [()=>{throw new Error('PRIVATE_RESIDENCY_ERROR');},async()=>{throw new Error('PRIVATE_RESIDENCY_ERROR');}]) {
    const f=await fixture(t,{},maintain);
    await f.post(message('residency-failure'));await eventually(()=>f.bridge.store.stats().sent===1,'normal completion');
    assert.equal(f.bridge.store.stats().uncertain,0);assert.equal(f.calls.length,1);
    assert.equal(f.logs.filter(log=>log.event==='desktop-residency-unavailable').length,2);
    assert.equal(JSON.stringify([f.logs,f.sends]).includes('PRIVATE_RESIDENCY_ERROR'),false);
  }
});

test('backend health exposes only cached bounded counts while receiver liveness stays independent',async t=>{
  let snapshot={expected:2,connected:0,diagnostic:'connecting' as const,threadId:'PRIVATE_CONNECTION_MARKER'};
  const f=await fixture(t,{},undefined,()=>snapshot);
  const health=async()=>{const response=await fetch(`${f.url()}/healthz`);assert.equal(response.status,200);return response.json();};
  assert.deepEqual(await health(),{ok:true,relay:{configured:false,connected:false},backend:{expected:2,connected:0,diagnostic:'connecting'}});
  snapshot={...snapshot,connected:1};
  assert.deepEqual((await health() as any).backend,{expected:2,connected:1,diagnostic:'connecting'});
  assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);assert.equal(f.bridge.store.stats().uncertain,0);
  assert.equal(JSON.stringify([await health(),f.logs]).includes('PRIVATE_CONNECTION_MARKER'),false);
});

test('status requires positive established backend connections and leaves hook-free backend output unchanged',async t=>{
  for(const snapshot of [{expected:0,connected:0,diagnostic:'connecting' as const},{expected:2,connected:1,diagnostic:'connecting' as const},{expected:2,connected:2},undefined]) {
    const f=await fixture(t,{},undefined,snapshot?()=>snapshot:undefined);
    await f.post(message('connection-status',{text:'/status'}));await eventually(()=>f.sends.length===1,'connection status');
    const text=f.sends[0]!.text;
    if(snapshot && snapshot.connected<snapshot.expected || snapshot?.expected===0) {
      assert.match(text,/Waiting for Mac connection/);assert.doesNotMatch(text,/\bReady\b/);assert.match(text,/Open the app and its dedicated task/);
    } else assert.match(text,/\bReady\b/);
    if(snapshot)assert.match(text,new RegExp(`${snapshot.connected}/${snapshot.expected} connected`));
    else assert.doesNotMatch(text,/Mac connection/);
    assert.equal(f.calls.length,0);assert.equal(f.bridge.store.stats().uncertain,0);
  }
});

test('malformed throwing and accidentally asynchronous status hooks cannot leak or affect commands',async t=>{
  const hooks:unknown[]=[
    ()=>{throw Error('PRIVATE_CONNECTION_MARKER');},
    async()=>{throw Error('PRIVATE_CONNECTION_MARKER');},
    ()=>({expected:3,connected:0}),()=>({expected:1,connected:2}),
    ()=>({expected:NaN,connected:0}),()=>({expected:1,connected:-1}),
    ()=>({expected:1.5,connected:0}),()=>({expected:1,connected:0,diagnostic:'PRIVATE_CONNECTION_MARKER'}),
  ];
  for(const hook of hooks) {
    const f=await fixture(t,{},undefined,hook as AgentBackend['connectionStatus']);
    const response=await fetch(`${f.url()}/healthz`),health=await response.json();
    assert.equal(response.status,200);assert.equal(health.ok,true);
    assert.deepEqual(health.backend,{expected:0,connected:0,diagnostic:'unavailable'});
    await f.post(message('bad-connection',{text:'/status'}));await eventually(()=>f.sends.length===1,'safe connection fallback');
    assert.match(f.sends[0]!.text,/Waiting for Mac connection/);
    assert.equal(JSON.stringify([health,f.logs,f.sends]).includes('PRIVATE_CONNECTION_MARKER'),false);
    assert.equal(f.calls.length,0);assert.equal(f.bridge.store.stats().uncertain,0);
  }
});

test('connection status refreshes at send time and never replaces uncertainty or triggers task retries',async t=>{
  let connected=0,release!:()=>void;
  const f=await fixture(t,{},undefined,()=>({expected:1,connected,...(connected?{}:{diagnostic:'connecting' as const})}));
  f.sendWith(async msg=>{if(msg.messageId==='message-blocker')await new Promise<void>(resolve=>{release=resolve;});return{id:'synthetic-connection'};});
  try {
    await f.post(message('blocker',{text:'/help'}));await eventually(()=>!!release,'blocked provider send');
    await f.post(message('fresh-connection',{text:'/status'}));
    assert.match(f.bridge.store.pendingReplies().find(job=>job.message.messageId==='message-fresh-connection')!.reply!,/Mac connection: waiting/);
    connected=1;release();
    await eventually(()=>f.sends.some(send=>send.message.messageId==='message-fresh-connection'),'refreshed backend');
    assert.match(f.sends.find(send=>send.message.messageId==='message-fresh-connection')!.text,/Mac connection: connected/);
    f.runWith(async()=>{throw new AgentError('Synthetic uncertain task',true);});
    await f.post(message('held-connection'));await eventually(()=>f.bridge.store.stats().uncertain===1,'uncertain task');
    connected=0;
    await f.post(message('held-status',{text:'/status'}));await eventually(()=>f.sends.some(send=>send.message.messageId==='message-held-status'),'held status');
    const text=f.sends.find(send=>send.message.messageId==='message-held-status')!.text;
    assert.match(text,/Paused for review/);assert.match(text,/1 need review/);assert.match(text,/Mac connection: waiting/);
    assert.doesNotMatch(text,/Waiting for Mac connection\n|\bReady\b/);
    assert.equal(f.calls.length,1);assert.equal(f.bridge.store.stats().uncertain,1);
  } finally {release?.();}
});

test('confirmed user cancellation sends one acknowledgment then permits fresh work without replay or local review',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});
  f.runWith(async input=>{
    input.onThread('thread-cancel');input.onTurn?.('turn-cancel');
    return new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>{
      assert.equal(input.signal!.reason,'user-cancel');reject(new AgentStoppedError('interrupted'));
    },{once:true}));
  });
  await f.post(message('waiting'));await eventually(()=>f.calls.length===1,'running turn');
  await f.post(message('stop',{text:'/cancel'}));
  await eventually(()=>f.bridge.store.stats().sent===1,'sole confirmed acknowledgment');
  assert.equal(f.bridge.store.stats().failed,1);assert.equal(f.bridge.store.stats().uncertain,0);
  assert.equal(f.sends.length,1);assert.match(f.sends[0]!.text,/Stopped/);assert.doesNotMatch(f.sends[0]!.text,/Check.*Mac|paused/i);
  await f.restart();
  assert.equal((await f.post(message('waiting'))).body.status,'duplicate');
  assert.equal((await f.post(message('stop',{text:'/cancel'}))).body.status,'duplicate');
  f.runWith(async input=>({threadId:input.threadId!,text:'FRESH_OK'}));
  await f.post(message('fresh'));await eventually(()=>f.bridge.store.stats().sent===2,'fresh reply');
  assert.equal(f.calls.length,2);assert.equal(f.calls[1]!.threadId,'thread-cancel');assert.equal(f.sends[1]!.text,'FRESH_OK');
  assert.equal(f.bridge.store.stats().failed,1);assert.equal(f.bridge.store.stats().pending,0);
});

test('stop acknowledgment waits for confirmation, repeated stops coalesce, and status remains available',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});let confirm!:(error:Error)=>void;
  f.runWith(async input=>new Promise((_resolve,reject)=>{confirm=reject;input.onTurn?.('pending-stop');}));
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('stop-a',{text:'/cancel'}));await f.post(message('stop-b',{text:'/cancel'}));
  assert.equal(f.sends.length,0);assert.equal(f.bridge.store.stats().running,1);
  await f.post(message('stop-status',{text:'/status'}));await eventually(()=>f.sends.length===1,'stopping status');
  assert.match(f.sends[0]!.text,/Stopping; waiting for confirmation/);
  confirm(new AgentStoppedError('interrupted'));
  await eventually(()=>f.bridge.store.stats().running===0 && f.sends.length===2,'one terminal stop acknowledgment');
  assert.match(f.sends[1]!.text,/Stopped/);assert.equal(f.bridge.store.stats().uncertain,0);
});

test('a stop accepted without terminal proof sends one warning and cannot unlock new work',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});
  f.runWith(async input=>new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(new AgentError('receipt only',true)),{once:true})));
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('stop',{text:'/cancel'}));await eventually(()=>f.bridge.store.stats().sent===1,'unconfirmed warning');
  assert.equal(f.sends.length,1);assert.equal(f.bridge.store.stats().uncertain,1);
  assert.doesNotMatch(f.sends[0]!.text,/^Stopped|You can send your next/);
  await f.restart();await f.post(message('blocked'));
  assert.equal(f.calls.length,1);assert.equal(f.sends.length,1);assert.equal(f.bridge.store.stats().queued,1);
});

test('a normal completion racing user stop is recorded without delivering a stale answer or claiming interruption',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});let complete!:(result:{threadId:string;text:string})=>void;
  f.runWith(async()=>new Promise(resolve=>{complete=resolve;}));
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('stop',{text:'/cancel'}));complete({threadId:'race-thread',text:'OLD_RESULT'});
  await eventually(()=>f.bridge.store.stats().sent===1,'completion race acknowledgment');
  assert.equal(f.sends.length,1);assert.match(f.sends[0]!.text,/finished before/);
  assert.equal(f.bridge.store.stats().uncertain,0);assert.equal(f.bridge.store.stats().failed,1);
});

test('uncertain cancellation acknowledgment delivery remains held despite confirmed agent stop',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});
  f.runWith(async input=>new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(new AgentStoppedError('interrupted')),{once:true})));
  f.sendWith(async()=>{throw new ProviderSendError('lost acknowledgment',true);});
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('stop',{text:'/cancel'}));await eventually(()=>f.bridge.store.stats().uncertain===1,'uncertain acknowledgment');
  assert.equal(f.bridge.store.stats().failed,1);assert.equal(f.sends.length,1);
  await f.restart();await f.post(message('later'));
  assert.equal(f.calls.length,1);assert.equal(f.sends.length,1);assert.equal(f.bridge.store.stats().queued,1);
});

test('cancellation from another conversation cannot stop the active turn',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});let complete!:(result:{threadId:string;text:string})=>void;
  f.runWith(async()=>new Promise(resolve=>{complete=resolve;}));
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('foreign',{text:'/cancel',conversationId:'other'}));
  await eventually(()=>f.sends.length===1,'other conversation response');
  assert.match(f.sends[0]!.text,/No active work/);assert.equal(f.calls[0]!.signal!.aborted,false);
  complete({threadId:'active-thread',text:'DONE'});await eventually(()=>f.bridge.store.stats().sent===2,'original completion');
});

test('confirmed stop acknowledgment removes readiness if another control send becomes uncertain afterward',async t=>{
  const f=await fixture(t,{turnTimeoutMs:10000});let failStatus!:(error:Error)=>void;
  f.runWith(async input=>new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(new AgentStoppedError('interrupted')),{once:true})));
  f.sendWith(async msg=>{
    if(msg.text==='/status')return new Promise((_resolve,reject)=>{failStatus=reject;});
    return{id:'cancel-ack'};
  });
  await f.post(message());await eventually(()=>f.calls.length===1,'active turn');
  await f.post(message('status',{text:'/status'}));await eventually(()=>!!failStatus,'status send in flight');
  await f.post(message('cancel',{text:'/cancel'}));await eventually(()=>f.bridge.store.stats().failed===1,'confirmed stop persisted');
  failStatus(new ProviderSendError('ambiguous status delivery',true));
  await eventually(()=>f.bridge.store.stats().sent===1,'stop acknowledgment after status hold');
  const reply=f.sends.find(s=>s.message.text==='/cancel')!.text;
  assert.match(reply,/Stopped/);assert.doesNotMatch(reply,/You can send your next request/);assert.match(reply,/separate outcome awaiting review/);
  await f.post(message('blocked'));assert.equal(f.calls.length,1);assert.equal(f.bridge.store.stats().queued,1);
});

test('timeout cannot use typed stop evidence to impersonate an authenticated user cancellation',async t=>{
  const f=await fixture(t,{turnTimeoutMs:30});
  f.runWith(async input=>new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>{
    assert.equal(input.signal!.reason,'timeout');reject(new AgentStoppedError('interrupted'));
  },{once:true})));
  await f.post(message());await eventually(()=>f.bridge.store.stats().uncertain===1 && f.sends.length===1,'timeout hold');
  assert.equal(f.sends[0]!.text,UNCERTAIN_NOTICE);assert.equal(f.bridge.store.stats().failed,0);
  await f.post(message('next'));assert.equal(f.calls.length,1);assert.equal(f.bridge.store.stats().queued,1);
});
