import { DurableObject } from 'cloudflare:workers';
import { configured, json, socketAuth, readBounded, verifyPhoton, allowedEvent, makeEvent, digest, Ledger } from './core.mjs';

export default {
  async fetch(request, env) {
    if (!configured(env)) return json({ error: 'not_configured' }, 503);
    const url = new URL(request.url);
    if (url.search || request.headers.has('origin')) return json({ error: 'not_found' }, 404);
    const socket = `/v1/devices/${env.DEVICE_ID}/socket`, webhook = `/v1/webhooks/photon/${env.DEVICE_ID}`;
    // Exact compatibility path permits an operator-owned Worker route to replace an existing tunnel without re-registering Photon.
    const webhookPath = url.pathname === webhook || url.pathname === '/webhooks/photon';
    if (!((url.pathname === socket && request.method === 'GET') || (webhookPath && request.method === 'POST'))) return json({ error: 'not_found' }, 404);
    return env.INBOX.get(env.INBOX.idFromName(env.DEVICE_ID)).fetch(request);
  }
};

export class DeviceInbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.env = env; this.ledger = new Ledger(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request) {
    if (request.method === 'GET') return this.connect(request);
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'content_type' }, 415);
      const raw = await readBounded(request);
      if (!await verifyPhoton(raw, request.headers, this.env.PHOTON_WEBHOOK_SECRET)) return json({ error: 'unauthorized' }, 401);
      let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return json({ error: 'invalid_json' }, 400); }
      const eventId = allowedEvent(value, this.env);
      if (!eventId) return json({ accepted: false });
      const event = await makeEvent(raw, request.headers, eventId), result = await this.ledger.enqueue(event, await digest(raw));
      if (result.state === 'conflict') return json({ error: 'event_conflict' }, 409);
      if (result.state === 'full') return json({ error: 'queue_full' }, 503);
      if (result.state === 'queued') this.broadcast(event);
      return json({ accepted: true, duplicate: result.state === 'duplicate' }, 202);
    } catch (error) {
      if (error?.message === 'body_limit') return json({ error: 'body_limit' }, 413);
      if (error?.message?.startsWith('body_')) return json({ error: 'invalid_body' }, 400);
      return json({ error: 'temporarily_unavailable' }, 503);
    }
  }
  async connect(request) {
    const auth = socketAuth(request, this.env.DEVICE_TOKEN);
    if (!auth.ok) return json({ error: 'unauthorized' }, 401);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'upgrade_required' }, 426);
    // Only one active Mac connection. New authenticated connections replace stale ones.
    for (const previous of this.ctx.getWebSockets()) previous.close(4001, 'connection_replaced');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ deviceId: this.env.DEVICE_ID });
    try { for (const event of await this.ledger.pending()) server.send(JSON.stringify(event)); }
    catch { server.close(1011, 'queue_unavailable'); }
    return new Response(null, { status: 101, webSocket: client, headers: auth.protocol ? { 'sec-websocket-protocol': auth.protocol } : {} });
  }
  broadcast(event) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify(event)); } catch { try { ws.close(1011, 'reconnect'); } catch {} }
    }
  }
  async webSocketMessage(ws, message) {
    if (ws.deserializeAttachment()?.deviceId !== this.env.DEVICE_ID || typeof message !== 'string' || message.length > 256) { ws.close(1008, 'invalid_frame'); return; }
    let frame; try { frame = JSON.parse(message); } catch { ws.close(1008, 'invalid_frame'); return; }
    if (frame?.v !== 1 || frame.type !== 'ack' || !/^[0-9a-f]{64}$/.test(frame.id ?? '') || Object.keys(frame).some(key => !['v', 'type', 'id'].includes(key))) { ws.close(1008, 'invalid_frame'); return; }
    try { await this.ledger.ack(frame.id); }
    catch { ws.close(1011, 'queue_unavailable'); }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code); } catch {} }
  async webSocketError(ws) { try { ws.close(1011, 'reconnect'); } catch {} }
  async alarm() { await this.ledger.change(async () => undefined); }
}
