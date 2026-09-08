import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const env = { DEVICE_ID: 'd'.repeat(40), DEVICE_TOKEN: 't'.repeat(40), PHOTON_WEBHOOK_SECRET: 's'.repeat(40), ALLOWED_SENDER: '+15555550101', SERVICE_NUMBER: 'shared' };
const base = 'https://relay.example', hook = `${base}/v1/webhooks/photon/${env.DEVICE_ID}`, socket = `${base}/v1/devices/${env.DEVICE_ID}/socket`;
function payload(id = 'event-1', text = 'hello') { const space = { id: 'dm1', type: 'dm', phone: 'shared', platform: 'imessage' }; return { event: 'messages', space, message: { id, direction: 'inbound', platform: 'imessage', space: { ...space }, sender: { id: env.ALLOWED_SENDER, platform: 'imessage' }, content: { type: 'text', text } } }; }
function signed(body, timestamp = String(Math.floor(Date.now() / 1000))) { return { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-spectrum-timestamp': timestamp, 'x-spectrum-signature': `v0=${createHmac('sha256', env.PHOTON_WEBHOOK_SECRET).update(`v0:${timestamp}:`).update(body).digest('hex')}` } }; }
async function fixture(t) {
  const modules = ['worker.mjs', 'core.mjs'].map(name => ({ type: 'ESModule', path: fileURLToPath(new URL(`../src/${name}`, import.meta.url)) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'relay', modules, compatibilityDate: '2026-08-20', compatibilityFlags: ['nodejs_compat'], bindings: env, durableObjects: { INBOX: { className: 'DeviceInbox', useSQLite: true } } }] }));
  t.after(() => mf.dispose()); return mf;
}
async function connect(mf) {
  const response = await mf.dispatchFetch(socket, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': `codex-imessage-relay, auth.${env.DEVICE_TOKEN}` } });
  assert.equal(response.status, 101); assert.equal(response.headers.get('sec-websocket-protocol'), 'codex-imessage-relay');
  const ws = response.webSocket, received = [], waiters = [];
  ws.addEventListener('message', event => { const waiter = waiters.shift(); if (waiter) waiter(event.data); else received.push(event.data); }); ws.accept();
  return { ws, next: () => received.length ? Promise.resolve(received.shift()) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('socket timeout')), 3000); waiters.push(value => { clearTimeout(timer); resolve(value); }); }) };
}

test('real Worker runtime authenticates ingress, sends byte-exact event and replays before ACK', async t => {
  const mf = await fixture(t), body = JSON.stringify(payload());
  assert.equal((await mf.dispatchFetch(hook, signed(body))).status, 202);
  const first = await connect(mf), frame = JSON.parse(await first.next());
  assert.equal(Buffer.from(frame.bodyBase64, 'base64').toString(), body);
  assert.equal(frame.v, 1); assert.equal(frame.expiresAt - frame.receivedAt, 86400000);
  first.ws.close();
  const again = await connect(mf); assert.equal(JSON.parse(await again.next()).id, frame.id);
  again.ws.send(JSON.stringify({ v: 1, type: 'ack', id: frame.id }));
  again.ws.send('ping'); assert.equal(await again.next(), 'pong');
  // A subsequent ingress request serializes after the ACK transaction.
  const duplicate = await mf.dispatchFetch(hook, signed(body)); assert.equal((await duplicate.json()).duplicate, true);
  again.ws.close();
  const afterAck = await connect(mf); afterAck.ws.send('ping'); assert.equal(await afterAck.next(), 'pong'); afterAck.ws.close();
});

test('real Worker runtime rejects invalid signature, stale signature and oversized body', async t => {
  const mf = await fixture(t), body = JSON.stringify(payload()), wrong = signed(body); wrong.headers['x-spectrum-signature'] = `v0=${'0'.repeat(64)}`;
  assert.equal((await mf.dispatchFetch(hook, wrong)).status, 401);
  assert.equal((await mf.dispatchFetch(hook, signed(body, '1000000000'))).status, 401);
  assert.equal((await mf.dispatchFetch(hook, signed('x'.repeat(262145)))).status, 413);
});

test('real Worker runtime rejects origin, unauthenticated sockets and unknown routes', async t => {
  const mf = await fixture(t);
  assert.equal((await mf.dispatchFetch(socket, { headers: { upgrade: 'websocket' } })).status, 401);
  assert.equal((await mf.dispatchFetch(socket, { headers: { origin: 'https://evil.example', authorization: `Bearer ${env.DEVICE_TOKEN}` } })).status, 404);
  assert.equal((await mf.dispatchFetch(base + '/admin')).status, 404);
  assert.equal((await mf.dispatchFetch(socket + '?token=anything')).status, 404);
});

test('real Worker runtime ignores unallowed sender and rejects same-ID content conflict', async t => {
  const mf = await fixture(t), denied = payload(); denied.message.sender.id = '+15555550199';
  const result = await mf.dispatchFetch(hook, signed(JSON.stringify(denied))); assert.deepEqual(await result.json(), { accepted: false });
  assert.equal((await mf.dispatchFetch(hook, signed(JSON.stringify(payload())))).status, 202);
  assert.equal((await mf.dispatchFetch(hook, signed(JSON.stringify(payload('event-1', 'changed'))))).status, 409);
});
