import { timingSafeEqual } from 'node:crypto';

export const LIMITS = Object.freeze({ body: 262144, pending: 100, bytes: 8 * 1024 * 1024, remembered: 2000, ttl: 86400000 });
export const PROTOCOL = 'codex-imessage-relay';
const encoder = new TextEncoder();
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) ? x : {};
const clean = (x, max = 512) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\x00-\x1f]/.test(x);
const phone = x => typeof x === 'string' && /^\+[1-9]\d{7,14}$/.test(x);
const platform = x => x === 'iMessage' || x === 'imessage';
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export function configured(env) {
  return /^[A-Za-z0-9_-]{32,128}$/.test(env.DEVICE_ID ?? '') && /^[A-Za-z0-9_-]{32,128}$/.test(env.DEVICE_TOKEN ?? '') && typeof env.PHOTON_WEBHOOK_SECRET === 'string' && env.PHOTON_WEBHOOK_SECRET.length >= 16 && env.PHOTON_WEBHOOK_SECRET.length <= 512 && phone(env.ALLOWED_SENDER) && (env.SERVICE_NUMBER === 'shared' || phone(env.SERVICE_NUMBER));
}

export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = encoder.encode(a), right = encoder.encode(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function socketAuth(request, token) {
  if (request.headers.has('origin')) return { ok: false };
  const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const auth = protocols.filter(s => s.startsWith('auth.'));
  const bearer = request.headers.get('authorization');
  if (bearer && auth.length) return { ok: false };
  if (bearer) return { ok: protocols.length === 0 && secureEqual(bearer, `Bearer ${token}`) };
  return { ok: protocols.length === 2 && protocols.includes(PROTOCOL) && auth.length === 1 && secureEqual(auth[0].slice(5), token), protocol: PROTOCOL };
}

export async function readBounded(request, deadlineMs = 10000) {
  const size = request.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > LIMITS.body)) throw new Error('body_limit');
  if (request.headers.get('content-encoding')) throw new Error('body_encoding');
  if (!request.body) throw new Error('body_empty');
  const reader = request.body.getReader(), chunks = []; let length = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, deadlineMs);
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > LIMITS.body) { await reader.cancel(); throw new Error('body_limit'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  if (timedOut) throw new Error('body_timeout');
  if (!length) throw new Error('body_empty');
  const result = new Uint8Array(length); let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.byteLength; }
  return result;
}

export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function verifyPhoton(raw, headers, secret, now = Date.now()) {
  const timestamp = headers.get('x-spectrum-timestamp') ?? '', signature = headers.get('x-spectrum-signature') ?? '';
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const prefix = encoder.encode(`v0:${timestamp}:`), signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix); signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const expected = Uint8Array.from(signature.slice(3).match(/../g), pair => parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, expected, signed);
}

function attachment(x) {
  return x.type === 'attachment' && clean(x.id, 256) && clean(x.name, 512) && clean(x.mimeType, 256) && (x.size === undefined || (Number.isSafeInteger(x.size) && x.size >= 0 && x.size <= 20 * 1024 * 1024));
}

// Admission proves this operator's direct conversation. Mac policy is checked again.
export function allowedEvent(value, env) {
  const event = object(value), message = object(event.message), space = object(event.space), nested = object(message.space), sender = object(message.sender), content = object(message.content);
  if (event.event !== 'messages' || message.direction !== 'inbound' || !clean(message.id, 256) || !clean(space.id)) return null;
  if (![message.platform, space.platform, nested.platform, sender.platform].every(platform)) return null;
  if (space.type !== 'dm' || nested.type !== 'dm' || nested.id !== space.id || nested.phone !== space.phone || space.phone !== env.SERVICE_NUMBER || sender.id !== env.ALLOWED_SENDER || sender.id === space.phone) return null;
  if (sender.service !== undefined && sender.service !== 'iMessage') return null;
  if (content.type === 'text') {
    if (typeof content.text !== 'string' || !content.text.trim() || content.text.length > 20000) return null;
  } else if (content.type === 'attachment') {
    if (!attachment(content)) return null;
  } else if (content.type === 'group') {
    if (!Array.isArray(content.items) || !content.items.length || content.items.length > 10) return null;
    let attachments = 0, textLength = 0, captions = 0;
    for (const item of content.items) {
      const child = object(item), from = object(child.sender), part = object(child.content);
      if (child.direction !== 'inbound' || !platform(child.platform) || !platform(from.platform) || from.id !== sender.id || !clean(child.id, 256) || (from.service !== undefined && from.service !== 'iMessage')) return null;
      if (attachment(part)) attachments++;
      else if (part.type === 'text') {
        if (typeof part.text !== 'string' || !part.text.trim()) return null;
        textLength += part.text.length + (captions++ ? 1 : 0);
        // Match the Mac's default ceiling; a stricter configured Mac limit
        // remains authoritative when it verifies the original signed event.
        if (textLength > 16000) return null;
      } else return null;
    }
    if (!attachments) return null;
  } else return null;
  return message.id;
}

export function encodeBase64(bytes) {
  let str = ''; for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(str);
}

export async function makeEvent(raw, headers, eventId, now = Date.now()) {
  const id = await digest(encoder.encode(`photon:${eventId}`));
  return { v: 1, type: 'event', id, eventId, receivedAt: now, expiresAt: now + LIMITS.ttl,
    headers: { 'x-spectrum-timestamp': headers.get('x-spectrum-timestamp'), 'x-spectrum-signature': headers.get('x-spectrum-signature'), 'content-type': 'application/json' },
    bodyBase64: encodeBase64(raw) };
}

/** Uses SQLite-backed DO storage KV methods. Each event stays below the 2MB value limit. */
export class Ledger {
  constructor(storage) { this.storage = storage; }
  async change(action, now = Date.now()) {
    return this.storage.transaction(async tx => {
      let items = await tx.get('meta') ?? [];
      for (const item of items) if (item.expiresAt <= now) await tx.delete(`event:${item.id}`);
      items = items.filter(item => item.expiresAt > now);
      const result = await action(tx, items);
      await tx.put('meta', items);
      if (items.length) await tx.setAlarm(Math.min(...items.map(item => item.expiresAt)));
      else await tx.deleteAlarm();
      return result;
    });
  }
  async enqueue(event, bodyDigest, now = Date.now()) {
    return this.change(async (tx, items) => {
      const old = items.find(item => item.id === event.id);
      if (old) return { state: old.digest === bodyDigest ? 'duplicate' : 'conflict' };
      const size = encoder.encode(JSON.stringify(event)).length, pending = items.filter(item => !item.acked);
      if (items.length >= LIMITS.remembered || pending.length >= LIMITS.pending || pending.reduce((sum, item) => sum + item.size, size) > LIMITS.bytes) return { state: 'full' };
      items.push({ id: event.id, digest: bodyDigest, expiresAt: event.expiresAt, size, acked: false });
      await tx.put(`event:${event.id}`, event);
      return { state: 'queued' };
    }, now);
  }
  async pending(now = Date.now()) {
    return this.change(async (tx, items) => {
      const result = [];
      for (const item of items) if (!item.acked) { const event = await tx.get(`event:${item.id}`); if (event) result.push(event); }
      return result;
    }, now);
  }
  async ack(id, now = Date.now()) {
    return this.change(async (tx, items) => {
      const item = items.find(item => item.id === id);
      if (!item) return false;
      item.acked = true; item.size = 0; await tx.delete(`event:${id}`); return true;
    }, now);
  }
}
