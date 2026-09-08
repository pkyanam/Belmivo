import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createProvider, ProviderSendError } from '../src/providers.js';
import type { BridgeConfig } from '../src/types.js';

const owner = '+12025559876', line = '+12025551234';
const config = (provider: BridgeConfig['provider']): BridgeConfig => ({ provider, allowedSenders: [owner], serviceNumber: line, dataDir: '/tmp/unused', port: 0, backend: 'app-server', codexBinary: 'codex', cwd: '/tmp', fullAccess: true, maxPending: 10, maxTextChars: 10000, maxReplyChars: 10000, turnTimeoutMs: 1000, providerApiKey: 'test-key', providerApiSecret: 'test-secret', webhookSecret: provider === 'linq' ? `whsec_${Buffer.alloc(32, 7).toString('base64')}` : 'test-webhook-secret' });

// Trimmed structural fixtures from official examples, verified 2026-09-07.
// https://docs.linqapp.com/channel/imessage/guides/webhooks/events/
const linq = () => ({ api_version: 'v3', webhook_version: '2026-02-03', event_type: 'message.received', event_id: 'event-1', data: { chat: { id: 'chat-1', is_group: false, owner_handle: { handle: line, is_me: true } }, id: 'message-1', direction: 'inbound', sender_handle: { handle: owner, is_me: false }, parts: [{ type: 'text', value: 'Hello!' }], service: 'iMessage' } });
// https://docs.sendblue.com/getting-started/receiving-messages/
const sendblue = () => ({ content: 'Hello!', is_outbound: false, status: 'RECEIVED', message_handle: 'message-1', from_number: owner, number: owner, to_number: line, sendblue_number: line, service: 'iMessage', message_type: 'message', group_id: '', participants: [owner, line], media_url: '' });
// https://docs.blooio.com/webhooks — official example lacks group classification.
const blooio = () => ({ id: 'event-1', type: 'message.received', data: { message_id: 'message-1', chat_id: 'chat-1', kind: 'received', direction: 'inbound', text: 'Hello!', status: 'received', protocol: 'imessage', message_type: 'text', sender: owner, recipient: line, contact: { identifier: owner }, channel_address: line, attachments: [] } });

test('Linq Standard Webhooks binds raw bytes, event ID and a fresh timestamp', () => {
  const c = config('linq'), adapter = createProvider(c), raw = Buffer.from(JSON.stringify(linq()));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = (id: string, time: string) => createHmac('sha256', Buffer.from(c.webhookSecret.slice(6), 'base64')).update(`${id}.${time}.`).update(raw).digest('base64');
  const headers = { 'webhook-id': 'event-1', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${sign('event-1', timestamp)}` };
  assert.equal(adapter.verify(raw, headers), true);
  assert.equal(adapter.verify(Buffer.concat([raw, Buffer.from(' ')]), headers), false);
  assert.equal(adapter.verify(raw, { ...headers, 'webhook-id': 'event-2' }), false);
  assert.equal(adapter.verify(raw, { ...headers, 'webhook-signature': ['v1,fake'] }), false);
  assert.equal(adapter.verify(raw, { ...headers, 'webhook-signature': `v1,bad ${headers['webhook-signature']}` }), true);
  const old = String(Number(timestamp) - 301), future = String(Number(timestamp) + 301);
  for (const t of [old, future]) assert.equal(adapter.verify(raw, { ...headers, 'webhook-timestamp': t, 'webhook-signature': `v1,${sign('event-1', t)}` }), false);
  assert.equal(adapter.verify(raw, { 'x-webhook-signature': 'legacy' }), false);
});

test('Blooio HMAC verifies raw body and rejects stale or duplicate headers', () => {
  const c = config('blooio'), adapter = createProvider(c), raw = Buffer.from('{}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', c.webhookSecret).update(`${timestamp}.`).update(raw).digest('hex');
  assert.equal(adapter.verify(raw, { 'X-Blooio-Signature': `t=${timestamp},v1=${signature}` }), true);
  assert.equal(adapter.verify(Buffer.from('{ }'), { 'x-blooio-signature': `t=${timestamp},v1=${signature}` }), false);
  assert.equal(adapter.verify(raw, { 'x-blooio-signature': `t=${timestamp},t=${timestamp},v1=${signature}` }), false);
  assert.equal(adapter.verify(raw, {}), false);
});

test('Sendblue messaging uses static secret, never Verify product signature', () => {
  const adapter = createProvider(config('sendblue'));
  assert.equal(adapter.verify(Buffer.from('{}'), { 'sb-signing-secret': 'test-webhook-secret' }), true);
  assert.equal(adapter.verify(Buffer.from('{}'), { 'sb-signing-secret': 'wrong' }), false);
  assert.equal(adapter.verify(Buffer.from('{}'), { 'sb-signing-secret': ['test-webhook-secret'] }), false);
  assert.equal(adapter.verify(Buffer.from('{}'), { 'x-sendblue-signature': 't=1,v1=bogus' }), false);
});

test('Linq supported fixture extracts identity and rejects groups, echoes and unknown versions', () => {
  const adapter = createProvider(config('linq')), fixture = linq();
  const message = adapter.parse(fixture);
  assert.equal(message?.sender, owner); assert.equal(message?.recipient, line); assert.equal(message?.text, 'Hello!');
  assert.equal(adapter.parse({ ...fixture, webhook_version: 'future' }), null);
  assert.equal(adapter.parse({ ...fixture, event_type: 'message.delivered' }), null);
  assert.equal(adapter.parse({ ...fixture, data: { ...fixture.data, direction: 'outbound' } }), null);
  assert.equal(adapter.parse({ ...fixture, data: { ...fixture.data, chat: { ...fixture.data.chat, is_group: true } } }), null);
  assert.equal(adapter.parse({ ...fixture, data: { ...fixture.data, chat: { id: 'chat-1' } } }), null);
  assert.equal(adapter.parse({ ...fixture, data: { ...fixture.data, service: 'SMS' } }), null);
  assert.equal(adapter.parse({ ...fixture, data: { ...fixture.data, sender_handle: { handle: 'person@example.com', is_me: false } } }), null);
});

test('Linq old documented webhook version extracts the recipient handle, not a configured guess', () => {
  const adapter = createProvider(config('linq'));
  const fixture = { api_version: 'v3', webhook_version: '2025-01-01', event_type: 'message.received', event_id: 'event-1', data: { chat_id: 'chat-1', from: owner, from_handle: { handle: owner, is_me: false }, is_from_me: false, is_group: false, message: { id: 'message-1', parts: [{ type: 'text', value: 'Hello!' }] }, recipient_handle: { handle: line, is_me: true }, service: 'iMessage' } };
  assert.equal(adapter.parse(fixture)?.recipient, line);
  assert.equal(adapter.parse({ ...fixture, data: { ...fixture.data, recipient_handle: null } }), null);
});

test('Sendblue direct fixture rejects groups, receipts, spoofed routing and malformed values', () => {
  const adapter = createProvider(config('sendblue')), fixture = sendblue();
  assert.equal(adapter.parse(fixture)?.sender, owner);
  for (const change of [{ group_id: 'group-1' }, { participants: [owner, line, '+12025550000'] }, { participants: [owner, owner] }, { status: 'DELIVERED' }, { is_outbound: true }, { message_type: 'reaction' }, { to_number: '+12025550000' }, { service: 'SMS' }, { media_url: 'http://localhost/secret' }, { content: {} }]) assert.equal(adapter.parse({ ...fixture, ...change }), null);
});

test('Blooio published message example is held until group status can be proved', () => {
  const adapter = createProvider(config('blooio')), fixture = blooio();
  assert.equal(adapter.parse(fixture), null);
  // Explicit group proof is a conservative gate, not a claim the live API emits it.
  const classified = { ...fixture, data: { ...fixture.data, is_group: false } };
  assert.equal(adapter.parse(classified)?.sender, owner);
  assert.equal(adapter.parse({ ...classified, data: { ...classified.data, group_id: 'group-1' } }), null);
  assert.equal(adapter.parse({ ...classified, type: 'message.reaction' }), null);
});

test('parsers safely reject malformed inputs and oversized content', () => {
  for (const provider of ['linq', 'sendblue', 'blooio'] as const) {
    const adapter = createProvider(config(provider));
    for (const value of [null, undefined, false, 2, [], 'message', {}, { data: null }]) assert.equal(adapter.parse(value), null);
  }
  assert.equal(createProvider(config('sendblue')).parse({ ...sendblue(), content: 'x'.repeat(10001) }), null);
});

test('send wire formats preserve chosen line and idempotency; uncertain outcomes are explicit', async (t) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => { requests.push({ url, init }); return new Response(JSON.stringify({ message: { id: 'out-1' }, message_handle: 'out-1', message_id: 'out-1' }), { status: 202 }); });
  const la = createProvider(config('linq')), lm = la.parse(linq())!;
  assert.deepEqual(await la.send(lm, 'Result', 'stable-key'), { id: 'out-1' });
  assert.equal(requests[0]?.url, 'https://api.linqapp.com/api/partner/v3/chats/chat-1/messages');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), { message: { parts: [{ type: 'text', value: 'Result' }], idempotency_key: 'stable-key' } });
  assert.equal(requests[0]?.init?.redirect, 'error'); assert.ok(requests[0]?.init?.signal);
  const sa = createProvider(config('sendblue'));
  await sa.send(sa.parse(sendblue())!, 'Result', 'stable-key');
  assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { number: owner, from_number: line, content: 'Result' });
  assert.equal((requests[1]?.init?.headers as Record<string, string>)['Idempotency-Key'], undefined);
  await assert.rejects(() => la.send({ ...lm, sender: '+12025550000' }, 'Result', 'stable-key'), (error: unknown) => error instanceof ProviderSendError && !error.ambiguous);
  assert.equal(requests.length, 2);
});

test('network failures, 5xx and malformed success are ambiguous; 401 is a rejection', async (t) => {
  const adapter = createProvider(config('linq')), message = adapter.parse(linq())!;
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-secret-containing-error'); });
  await assert.rejects(() => adapter.send(message, 'Result', 'key'), (e: unknown) => e instanceof ProviderSendError && e.ambiguous && !e.message.includes('private-secret'));
  mocked.mock.mockImplementation(async () => new Response('{}', { status: 502 }));
  await assert.rejects(() => adapter.send(message, 'Result', 'key'), (e: unknown) => e instanceof ProviderSendError && e.ambiguous);
  mocked.mock.mockImplementation(async () => new Response('{}', { status: 401 }));
  await assert.rejects(() => adapter.send(message, 'Result', 'key'), (e: unknown) => e instanceof ProviderSendError && !e.ambiguous && e.status === 401);
  mocked.mock.mockImplementation(async () => new Response('{}', { status: 200 }));
  await assert.rejects(() => adapter.send(message, 'Result', 'key'), (e: unknown) => e instanceof ProviderSendError && e.ambiguous);
});
