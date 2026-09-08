import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { LIMITS, configured, socketAuth, verifyPhoton, allowedEvent, readBounded, makeEvent, Ledger } from '../src/core.mjs';

const env = { DEVICE_ID: 'd'.repeat(40), DEVICE_TOKEN: 't'.repeat(40), PHOTON_WEBHOOK_SECRET: 's'.repeat(40), ALLOWED_SENDER: '+15555550101', SERVICE_NUMBER: 'shared' };
function payload(id = 'event-1') {
  const space = { platform: 'imessage', id: 'dm-1', type: 'dm', phone: 'shared' };
  return { event: 'messages', space, message: { id, direction: 'inbound', platform: 'imessage', space: { ...space }, sender: { id: env.ALLOWED_SENDER, platform: 'imessage', service: 'iMessage' }, content: { type: 'text', text: 'hello' } } };
}
function signature(raw, timestamp) { return new Headers({ 'x-spectrum-timestamp': timestamp, 'x-spectrum-signature': `v0=${createHmac('sha256', env.PHOTON_WEBHOOK_SECRET).update(`v0:${timestamp}:`).update(raw).digest('hex')}` }); }
class Storage {
  map = new Map(); alarm;
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = undefined; }
  async transaction(callback) { const before = structuredClone(this.map); try { return await callback(this); } catch (error) { this.map = before; throw error; } }
}

test('requires explicit private operator device and phone binding', () => {
  assert.equal(configured(env), true);
  for (const name of Object.keys(env)) assert.equal(configured({ ...env, [name]: '' }), false);
  assert.equal(configured({ ...env, ALLOWED_SENDER: 'any' }), false);
});

test('socket token authentication supports protocol or Bearer, rejects origin and ambiguity', () => {
  const req = headers => new Request('https://relay.example/socket', { headers });
  assert.equal(socketAuth(req({ 'sec-websocket-protocol': `codex-imessage-relay, auth.${env.DEVICE_TOKEN}` }), env.DEVICE_TOKEN).ok, true);
  assert.equal(socketAuth(req({ authorization: `Bearer ${env.DEVICE_TOKEN}` }), env.DEVICE_TOKEN).ok, true);
  for (const headers of [{ authorization: 'Bearer bad' }, { authorization: `Bearer ${env.DEVICE_TOKEN}`, origin: 'https://other.example' }, { 'sec-websocket-protocol': `codex-imessage-relay, auth.${env.DEVICE_TOKEN}, auth.${env.DEVICE_TOKEN}` }, { authorization: `Bearer ${env.DEVICE_TOKEN}`, 'sec-websocket-protocol': 'codex-imessage-relay' }]) assert.equal(socketAuth(req(headers), env.DEVICE_TOKEN).ok, false);
});

test('Photon raw signature verifies original bytes and enforces timestamp freshness', async () => {
  const raw = Buffer.from('{"test":"🔐"}'), timestamp = '1800000000', headers = signature(raw, timestamp), now = Number(timestamp) * 1000;
  assert.equal(await verifyPhoton(raw, headers, env.PHOTON_WEBHOOK_SECRET, now), true);
  assert.equal(await verifyPhoton(Buffer.concat([raw, Buffer.from(' ')]), headers, env.PHOTON_WEBHOOK_SECRET, now), false);
  assert.equal(await verifyPhoton(raw, headers, env.PHOTON_WEBHOOK_SECRET, now + 301000), false);
  headers.append('x-spectrum-timestamp', timestamp);
  assert.equal(await verifyPhoton(raw, headers, env.PHOTON_WEBHOOK_SECRET, now), false);
});

test('edge admission ignores other senders, groups, own events, wrong line and rich events', () => {
  assert.equal(allowedEvent(payload(), env), 'event-1');
  const cases = [x => x.message.sender.id = '+15555550102', x => x.space.type = 'group', x => x.message.space.id = 'different', x => x.message.direction = 'outbound', x => x.message.sender.service = 'SMS', x => x.message.content.type = 'reaction', x => x.space.phone = '+15555550103'];
  for (const mutate of cases) { const value = payload(); mutate(value); assert.equal(allowedEvent(value, env), null); }
});

test('body limits enforce streamed bytes and reject encoding', async () => {
  await assert.rejects(readBounded(new Request('https://relay.example', { method: 'POST', body: new Uint8Array(LIMITS.body + 1) })), /body_limit/);
  await assert.rejects(readBounded(new Request('https://relay.example', { method: 'POST', body: 'x', headers: { 'content-encoding': 'gzip' } })), /body_encoding/);
  assert.deepEqual(await readBounded(new Request('https://relay.example', { method: 'POST', body: 'hello' })), new TextEncoder().encode('hello'));
});

test('incomplete request streams cannot keep the object awake indefinitely', async () => {
  const request = new Request('https://relay.example', { method: 'POST', body: new ReadableStream(), duplex: 'half' });
  await assert.rejects(readBounded(request, 5), /body_timeout/);
});

test('envelope preserves raw bytes and 24h lifetime while original signature remains unchanged', async () => {
  const raw = Buffer.from(' { "emoji" : "👋" }\n'), headers = signature(raw, '1800000000');
  const event = await makeEvent(raw, headers, 'original-id', 1800000000000);
  assert.deepEqual(Buffer.from(event.bodyBase64, 'base64'), raw);
  assert.equal(event.expiresAt - event.receivedAt, LIMITS.ttl);
  assert.equal(event.headers['x-spectrum-signature'], headers.get('x-spectrum-signature'));
});

test('durable ledger replays across restart, detects conflicts, and retains ACK dedup tombstone', async () => {
  const storage = new Storage(), first = new Ledger(storage), event = { id: 'a', expiresAt: 10000, bodyBase64: 'a' };
  assert.equal((await first.enqueue(event, 'digest', 1)).state, 'queued');
  const restarted = new Ledger(storage);
  assert.deepEqual(await restarted.pending(2), [event]);
  assert.equal((await restarted.enqueue(event, 'different', 2)).state, 'conflict');
  assert.equal(await restarted.ack('a', 3), true);
  assert.deepEqual(await restarted.pending(4), []);
  assert.equal((await restarted.enqueue(event, 'digest', 5)).state, 'duplicate');
  assert.equal(await restarted.ack('unknown', 5), false);
});

test('queue capacity, byte limit and expiry remain bounded', async () => {
  const ledger = new Ledger(new Storage());
  for (let i = 0; i < LIMITS.pending; i++) assert.equal((await ledger.enqueue({ id: String(i), expiresAt: 1000 }, String(i), 1)).state, 'queued');
  assert.equal((await ledger.enqueue({ id: 'overflow', expiresAt: 1000 }, 'overflow', 1)).state, 'full');
  assert.deepEqual(await ledger.pending(1001), []);
  assert.equal((await ledger.enqueue({ id: 'new', expiresAt: 2000 }, 'new', 1001)).state, 'queued');
  assert.equal((await ledger.enqueue({ id: 'huge', expiresAt: 2000, bodyBase64: 'x'.repeat(LIMITS.bytes) }, 'huge', 1001)).state, 'full');
});

function captionAlbum() {
  const event = payload();
  const child = (part, content) => ({ ...event.message, id: `p:${part}/synthetic-parent`, content });
  event.message.content = { type: 'group', items: [
    child(0, { type: 'attachment', id: 'synthetic-pdf', name: 'sample.pdf', mimeType: 'application/pdf', size: 1367 }),
    child(1, { type: 'text', text: 'Read this PDF.' }),
  ] };
  return event;
}

test('edge admits a signed-envelope shape with a PDF and caption under one message identity', () => {
  assert.equal(allowedEvent(captionAlbum(), env), 'event-1');
  const event = captionAlbum();event.message.content.items.reverse();
  assert.equal(allowedEvent(event, env), 'event-1');
});

test('edge bounds aggregate captions including newlines and keeps file and child limits', () => {
  const event = captionAlbum();event.message.content.items[1].content.text = 'a'.repeat(7999);
  event.message.content.items.push({ ...event.message.content.items[1], id: 'p:2/synthetic-parent', content: { type: 'text', text: 'b'.repeat(8000) } });
  assert.equal(allowedEvent(event, env), 'event-1');
  event.message.content.items[2].content.text += 'b';assert.equal(allowedEvent(event, env), null);
  const tooMany = captionAlbum();tooMany.message.content.items = Array.from({ length: 11 }, () => tooMany.message.content.items[0]);assert.equal(allowedEvent(tooMany, env), null);
  const file = captionAlbum();file.message.content.items[0].content.size = 20 * 1024 * 1024 + 1;assert.equal(allowedEvent(file, env), null);
});

test('edge rejects foreign, non-iMessage, unsupported and unverified text-only multipart content', () => {
  const changes = [
    e => e.message.content.items[1].sender = { id: '+15555550102', platform: 'imessage' },
    e => e.message.content.items[1].platform = 'SMS',
    e => e.message.content.items[1].sender = { id: env.ALLOWED_SENDER, platform: 'whatsapp' },
    e => e.message.content.items[1].sender = { id: env.ALLOWED_SENDER, platform: 'imessage', service: 'SMS' },
    e => e.message.content.items[1].direction = 'outbound',
    e => e.message.content.items[1].id = '',
    e => e.message.content.items[1].content = { type: 'reaction', emoji: '👍' },
    e => e.message.content.items[1].content = { type: 'group', items: [] },
    e => e.message.content.items[1].content = { type: 'text', text: '   ' },
    e => e.message.content.items.shift(),
  ];
  for (const change of changes) { const event = captionAlbum();change(event);assert.equal(allowedEvent(event, env), null); }
});
