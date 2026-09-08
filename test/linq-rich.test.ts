import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinqRich } from '../src/linq-rich.js';
import type { InboundMessage } from '../src/types.js';

const config = { provider: 'linq' as const, providerApiKey: 'test-api-secret', serviceNumber: '+12025550123', allowedSenders: ['+12025550124'] };
const message: InboundMessage = {
  provider: 'linq', eventId: 'event-distinct-from-message',
  messageId: '22222222-2222-4222-8222-222222222222', conversationId: '11111111-1111-4111-8111-111111111111',
  sender: config.allowedSenders[0]!, recipient: config.serviceNumber, isGroup: false, text: 'test task', attachments: [],
};

test('Linq native typing starts/stops the original chat without inventing a request body', async () => {
  const calls: Array<{url: string; init: RequestInit}> = [];
  const rich = createLinqRich(config, { fetch: async (url,init) => { calls.push({url,init}); return new Response(null,{status:204}); } });
  await rich.setTyping(message,true); await rich.setTyping(message,false);
  assert.deepEqual(calls.map(c=>c.init.method),['POST','DELETE']);
  for (const call of calls) {
    assert.equal(call.url,`https://api.linqapp.com/api/partner/v3/chats/${message.conversationId}/typing`);
    assert.equal(call.init.body,undefined);
    assert.equal(call.init.redirect,'error');
    assert.deepEqual(call.init.headers,{Authorization:'Bearer test-api-secret'});
  }
});

test('Linq phase reactions address inbound message ID and documented native types', async () => {
  const calls: Array<{url: string; body: unknown}> = [];
  const rich = createLinqRich(config,{fetch: async (url,init) => {calls.push({url,body:JSON.parse(String(init.body))});return new Response('{}');}});
  for (const phase of ['working','done','failed'] as const) await rich.react(message,phase);
  assert.deepEqual(calls.map(c=>c.body),['emphasize','like','question'].map(type=>({operation:'add',type,part_index:0})));
  for (const call of calls) assert.equal(call.url,`https://api.linqapp.com/api/partner/v3/messages/${message.messageId}/reactions`);
});

test('Linq optional signals reject unauthorized, group, cross-provider and malformed destinations before network', async () => {
  let calls=0;
  const rich=createLinqRich(config,{fetch:async()=>{calls++;return new Response(null,{status:204});}});
  for (const mutation of [{sender:'+12025550999'},{recipient:'+12025550999'},{isGroup:true},{provider:'photon' as const},{conversationId:'../another-chat'},{messageId:'bad-message-id'}]) {
    await assert.rejects(rich.setTyping({...message,...mutation},true));
    await assert.rejects(rich.react({...message,...mutation},'done'));
  }
  assert.equal(calls,0);
});

test('Linq signal failures are sanitized and never retried', async () => {
  for (const fetcher of [async()=>{throw new Error('test-api-secret private-message');},async()=>new Response('private-provider-body',{status:503})]) {
    let calls=0;
    const rich=createLinqRich(config,{fetch:async()=>{calls++;return fetcher();}});
    await assert.rejects(rich.react(message,'done'),error=>error instanceof Error && error.message==='Linq optional message indicator could not be confirmed');
    assert.equal(calls,1);
  }
});

test('Linq timeout aborts even when the transport never resolves, bounding optional work', async () => {
  let signal: AbortSignal | null | undefined;
  const rich=createLinqRich(config,{timeoutMs:20,fetch:async(_url,init)=>{signal=init.signal;return new Promise<Response>(()=>{});}});
  const started=Date.now();
  await assert.rejects(rich.setTyping(message,true));
  assert.equal(signal?.aborted,true);
  assert.ok(Date.now()-started<1000);
});


test('Linq caller cancellation aborts in-flight work and prevents already-cancelled requests', async () => {
  let calls=0; let transportSignal: AbortSignal | null | undefined;
  const rich=createLinqRich(config,{fetch:async(_url,init)=>{calls++;transportSignal=init.signal;return new Promise<Response>(()=>{});}});
  const cancelled=new AbortController(); cancelled.abort();
  await assert.rejects(rich.setTyping(message,true,cancelled.signal));
  assert.equal(calls,0);
  const active=new AbortController();
  const pending=rich.react(message,'working',active.signal);
  await Promise.resolve();
  active.abort();
  await assert.rejects(pending);
  assert.equal(calls,1);
  assert.equal(transportSignal?.aborted,true);
});


test('Linq preserves each conversational native reaction without converting it to workflow status', async () => {
  const calls: unknown[]=[];
  const rich=createLinqRich(config,{fetch:async(_url,init)=>{calls.push(JSON.parse(String(init.body)));return new Response('{}');}});
  const choices=['like','love','laugh','emphasize','question','dislike'] as const;
  for (const choice of choices) await rich.react(message,choice);
  assert.deepEqual(calls,choices.map(type=>({operation:'add',type,part_index:0})));
  await assert.rejects(rich.react(message,'custom-arbitrary-value' as never));
  assert.equal(calls.length,choices.length);
});
