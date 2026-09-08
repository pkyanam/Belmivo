// Spawned by integration/client-worker.test.mjs with its ephemeral trusted CA.
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const [directory, build] = process.argv.slice(2);
assert.ok(directory && build && process.env.NODE_EXTRA_CA_CERTS === join(directory, 'cert.pem'));
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
const { RelayClient } = await import(pathToFileURL(join(build, 'src/relay-client.js')));
const { Store } = await import(pathToFileURL(join(build, 'src/store.js')));
const { parsePhoton } = await import(pathToFileURL(join(build, 'src/photon.js')));
const { authorize } = await import(pathToFileURL(join(build, 'src/policy.js')));
const source = fileURLToPath(new URL('../../src/', import.meta.url));
const env = { DEVICE_ID: 'd'.repeat(40), DEVICE_TOKEN: 't'.repeat(40), PHOTON_WEBHOOK_SECRET: 's'.repeat(40), ALLOWED_SENDER: '+15555550101', SERVICE_NUMBER: 'shared' };
const config = { serviceNumber: 'shared', allowSharedSandbox: true, allowedSenders: [env.ALLOWED_SENDER], maxTextChars: 16000 };
const local = join(directory, 'local'); mkdirSync(local, { mode: 0o700 });
const database = join(local, 'journal.sqlite');
let store = new Store(database), mf, client, inspector, releaseFirst, startedFirst = false, blockFirst = true, dropAck = true, cleanupPromise;
const sockets = new Set(), bodies = new Map(), eventByAck = new Map(), admissions = [];
const counters = { queued: 0, duplicates: 0, droppedAcks: 0, committedAckChecks: 0 };
let latestPong;
const hashId = id => createHash('sha256').update('photon:' + id).digest('hex');
async function wait(predicate, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!await predicate()) { if (Date.now() >= deadline) throw Error('Timeout: ' + label); await pause(15); }
}
async function boot() {
  // This inspection RPC exists only in the test module. Production fetch/routes
  // and ACK handling are inherited unchanged; no diagnostic HTTP route is added.
  const inspectionModule = `import worker, {DeviceInbox} from './worker.mjs';
export default worker;
export class TestInbox extends DeviceInbox {
  async inspect() { return await this.ctx.storage.get('meta') ?? []; }
}`;
  mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, https: true,
    httpsKey: readFileSync(join(directory, 'key.pem'), 'utf8'), httpsCert: readFileSync(join(directory, 'cert.pem'), 'utf8'),
    resourcePersistencePath: join(directory, 'worker-state'), telemetry: { enabled: false },
    workers: [{ name: 'relay', modules: [{ type: 'ESModule', path: join(source, '__test-inspection.mjs'), contents: inspectionModule }, ...['worker.mjs', 'core.mjs'].map(name => ({ type: 'ESModule', path: join(source, name) }))],
      compatibilityDate: '2026-08-20', compatibilityFlags: ['nodejs_compat'], bindings: env,
      durableObjects: { INBOX: { className: 'TestInbox', useSQLite: true } } }] }));
  const url = await mf.ready; assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, '127.0.0.1');
  const namespace = await mf.getDurableObjectNamespace('INBOX', 'relay'); inspector = namespace.get(namespace.idFromName(env.DEVICE_ID));
  return url.origin;
}
function body(id) {
  const space = { id: 'fixture-dm', type: 'dm', phone: 'shared', platform: 'imessage' };
  return JSON.stringify({ event: 'messages', space, message: { id, direction: 'inbound', platform: 'imessage', space: { ...space }, sender: { id: env.ALLOWED_SENDER, platform: 'imessage' }, content: { type: 'text', text: 'Synthetic offline proof ' + id } } });
}
async function ingress(origin, id) {
  const raw = body(id); bodies.set(id, raw); eventByAck.set(hashId(id), id);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const result = await fetch(origin + '/v1/webhooks/photon/' + env.DEVICE_ID, { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
    'content-type': 'application/json', 'x-spectrum-timestamp': timestamp,
    'x-spectrum-signature': 'v0=' + createHmac('sha256', env.PHOTON_WEBHOOK_SECRET).update('v0:' + timestamp + ':').update(raw).digest('hex'),
  }, body: raw });
  assert.equal(result.status, 202); return result.json();
}
async function accept(event) {
  assert.equal(event.raw.toString(), bodies.get(event.eventId)); assert.equal(event.id, hashId(event.eventId));
  if (blockFirst) { blockFirst = false; startedFirst = true; await new Promise(resolve => { releaseFirst = resolve; }); }
  const message = parsePhoton(JSON.parse(event.raw), config); assert.ok(message); assert.equal(authorize(message, config), null);
  const disposition = store.enqueue(message, 100); assert.ok(['queued', 'duplicate'].includes(disposition));
  counters[disposition === 'queued' ? 'queued' : 'duplicates']++; admissions.push({ id: event.eventId, disposition }); return true;
}
function committedAck(id) {
  // A separate reader proves this exact event/job transaction is visible before
  // the ACK leaves the client, even once unrelated jobs already exist.
  const reader = new DatabaseSync(database, { readOnly: true });
  try {
    const row = reader.prepare('SELECT jobs.message_id FROM events JOIN jobs ON jobs.id=events.job_id WHERE events.provider=? AND events.event_id=?').get('photon', eventByAck.get(id));
    assert.equal(row?.message_id, eventByAck.get(id)); assert.ok(row); counters.committedAckChecks++;
  } finally { reader.close(); }
}
function connect(origin) {
  client = new RelayClient({ url: origin, deviceId: env.DEVICE_ID, token: env.DEVICE_TOKEN }, accept, () => {}, (url, protocols) => {
    assert.equal(new URL(url).protocol, 'wss:'); assert.equal(new URL(url).hostname, '127.0.0.1');
    const socket = new WebSocket(url, protocols); sockets.add(socket);
    latestPong = { received: false };
    const pong = latestPong;
    socket.addEventListener('open', () => socket.send('ping'));
    socket.addEventListener('message', event => { if (event.data === 'pong') pong.received = true; });
    socket.addEventListener('close', () => sockets.delete(socket));
    return { get readyState() { return socket.readyState; }, addEventListener: socket.addEventListener.bind(socket), close: socket.close.bind(socket), send(data) {
      if (data !== 'ping') {
        const ack = JSON.parse(data); assert.equal(ack.type, 'ack'); committedAck(ack.id);
        if (dropAck) { dropAck = false; counters.droppedAcks++; store.close(); store = new Store(database); socket.close(4000, 'synthetic lost ack'); return; }
      }
      socket.send(data);
    } };
  }); client.start();
}
async function ackPersisted(id) { await wait(async () => (await inspector.inspect()).some(item => item.id === hashId(id) && item.acked === true), 'durable ACK transaction'); }
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => { releaseFirst?.(); await client?.close(); client = undefined; for (const socket of sockets) socket.close(); await mf?.dispose(); mf = undefined; store.close(); })();
  return cleanupPromise;
}
const stop = () => { void cleanup().then(() => { process.exitCode = 1; }, () => { process.exitCode = 1; }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  let origin = await boot(); await ingress(origin, 'offline-1');
  assert.equal((await inspector.inspect()).find(item => item.id === hashId('offline-1')).acked, false);
  connect(origin); await wait(() => startedFirst && latestPong.received, 'uncommitted admission and stream barrier');
  assert.equal(store.stats().total, 0); assert.equal(counters.committedAckChecks, 0); releaseFirst();
  await ackPersisted('offline-1'); assert.equal(counters.queued, 1); assert.equal(counters.duplicates, 1); assert.equal(counters.droppedAcks, 1);
  await client.close(); client = undefined;
  assert.equal((await ingress(origin, 'offline-1')).duplicate, true); await ingress(origin, 'offline-2');
  await mf.dispose(); mf = undefined; store.close(); store = new Store(database);
  origin = await boot();
  const persisted = await inspector.inspect(); assert.equal(persisted.find(item => item.id === hashId('offline-1')).acked, true); assert.equal(persisted.find(item => item.id === hashId('offline-2')).acked, false);
  connect(origin); await ackPersisted('offline-2'); assert.equal(store.stats().total, 2); assert.equal(counters.queued, 2);
  assert.equal(admissions.filter(item => item.id === 'offline-1').length, 2);
  await client.close(); client = undefined;
  const prior = admissions.length; connect(origin);
  // Pong is only a stream barrier after the explicit storage check above. The
  // automatic hibernation response alone does not prove an ACK has committed.
  await wait(() => client.snapshot.connected && latestPong.received, 'empty persisted queue reconnect');
  await client.close(); client = undefined; assert.equal(admissions.length, prior);
  await cleanup();
  console.log(JSON.stringify({ passed: true, durableJobs: 2, ...counters, workerRestarts: 1, tlsVerified: true, providerCalls: 0, agentCalls: 0 }));
} finally { await cleanup(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
