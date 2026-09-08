import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLinqRich } from './linq-rich.js';
import type { Attachment, BridgeConfig, InboundMessage, ProviderAdapter } from './types.js';
import { createPhotonProvider } from './photon.js';

type Headers = Record<string, string | string[] | undefined>;
type Obj = Record<string, unknown>;
const record = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const phone = (value: unknown): string => /^\+[1-9]\d{6,14}$/.test(string(value)) ? string(value) : '';
const identifier = (value: unknown): string => string(value).length <= 512 && !/[\x00-\x1f]/.test(string(value)) ? string(value) : '';
const header = (headers: Headers, name: string): string => {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  return matches.length === 1 && typeof matches[0]![1] === 'string' ? matches[0]![1] : '';
};
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
function fresh(timestamp: string): boolean {
  return /^\d{10}$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
}
function https(value: unknown): string {
  try { const url = new URL(string(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}
function parts(value: unknown): { text: string; attachments: Attachment[] } | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const texts: string[] = [], attachments: Attachment[] = [];
  for (const item of value) {
    const p = record(item);
    if ((p.type === 'text' || p.type === 'link') && typeof p.value === 'string') texts.push(p.value);
    else if (p.type === 'media' && https(p.url)) attachments.push({ url: https(p.url), name: string(p.filename) || undefined, mimeType: string(p.mime_type) || undefined });
    else return null;
  }
  return { text: texts.join('\n'), attachments };
}

/** Unknown means a send MAY have reached the provider. Never blindly resend it. */
export class ProviderSendError extends Error {
  constructor(message: string, public readonly ambiguous: boolean, public readonly status?: number) {
    super(message); this.name = 'ProviderSendError';
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Obj> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error' });
  } catch {
    // Do not expose request URLs, tokens, raw errors or provider bodies in logs.
    throw new ProviderSendError('Provider send outcome unknown after network failure or timeout', true);
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new ProviderSendError(`Provider rejected send with HTTP ${response.status}`, response.status >= 500 || response.status === 408, response.status);
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); throw new Error('Oversize'); }
      chunks.push(item.value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { throw new ProviderSendError('Provider accepted send but its response could not be verified', true); }
}

function validateMessage(message: InboundMessage | null, config: BridgeConfig): InboundMessage | null {
  if (!message || !message.eventId || !message.messageId || !message.conversationId || !message.sender || !message.recipient) return null;
  if (message.recipient !== config.serviceNumber || message.sender === message.recipient) return null;
  if (message.isGroup || message.text.length > config.maxTextChars || message.attachments.length > 10) return null;
  if (!message.text.trim() && !message.attachments.length) return null;
  return message;
}

function parseLinq(body: unknown): InboundMessage | null {
  // https://docs.linqapp.com/channel/imessage/guides/webhooks/events/
  const b = record(body), d = record(b.data);
  if (b.api_version !== 'v3' || b.event_type !== 'message.received' || d.service !== 'iMessage') return null;
  let sender: string, recipient: string, conversationId: string, messageId: string, content: ReturnType<typeof parts>;
  if (b.webhook_version === '2026-02-03') {
    const chat = record(d.chat), owner = record(chat.owner_handle), from = record(d.sender_handle);
    if (d.direction !== 'inbound' || chat.is_group !== false || from.is_me !== false || owner.is_me !== true) return null;
    sender = phone(from.handle); recipient = phone(owner.handle); conversationId = identifier(chat.id); messageId = identifier(d.id); content = parts(d.parts);
  } else if (b.webhook_version === '2025-01-01') {
    const from = record(d.from_handle), to = record(d.recipient_handle), message = record(d.message);
    if (d.is_from_me !== false || d.is_group !== false || from.is_me !== false || to.is_me !== true || d.from !== from.handle) return null;
    sender = phone(from.handle); recipient = phone(to.handle); conversationId = identifier(d.chat_id); messageId = identifier(message.id); content = parts(message.parts);
  } else return null;
  return content ? { provider: 'linq', eventId: identifier(b.event_id), messageId, conversationId, sender, recipient, isGroup: false, ...content } : null;
}

function parseSendblue(body: unknown): InboundMessage | null {
  // https://docs.sendblue.com/getting-started/receiving-messages/
  const b = record(body);
  if (b.is_outbound !== false || b.status !== 'RECEIVED' || b.message_type !== 'message' || b.service !== 'iMessage' || b.group_id !== '') return null;
  const sender = phone(b.from_number), recipient = phone(b.to_number);
  if (b.number !== sender || b.sendblue_number !== recipient || !Array.isArray(b.participants) || b.participants.length !== 2 || new Set(b.participants).size !== 2 || !b.participants.includes(sender) || !b.participants.includes(recipient)) return null;
  if (b.content !== null && b.content !== undefined && typeof b.content !== 'string') return null;
  if (b.media_url && !https(b.media_url)) return null;
  return { provider: 'sendblue', eventId: identifier(b.message_handle), messageId: identifier(b.message_handle), conversationId: `${recipient}:${sender}`, sender, recipient, text: string(b.content), isGroup: false, attachments: b.media_url ? [{ url: https(b.media_url) }] : [] };
}

function parseBlooio(body: unknown): InboundMessage | null {
  // v4 envelope only: https://docs.blooio.com/webhooks
  // Message examples omit group proof. Until the provider includes explicit
  // is_group=false, fail closed; never infer a direct chat from two endpoints.
  const b = record(body), d = record(b.data);
  if (b.type !== 'message.received' || d.direction !== 'inbound' || d.protocol !== 'imessage' || d.status !== 'received' || d.is_group !== false || d.group != null || d.group_id != null) return null;
  if (d.message_type !== 'text' && d.message_type !== 'media') return null;
  if (!Array.isArray(d.attachments) || d.attachments.length > 10 || (d.text != null && typeof d.text !== 'string')) return null;
  const attachments: Attachment[] = [];
  for (const item of d.attachments) { const a = record(item); if (!https(a.url)) return null; attachments.push({ url: https(a.url), mimeType: string(a.media_type) || undefined }); }
  if (record(d.contact).identifier !== d.sender || d.channel_address !== d.recipient) return null;
  return { provider: 'blooio', eventId: identifier(b.id), messageId: identifier(d.message_id), conversationId: identifier(d.chat_id), sender: phone(d.sender), recipient: phone(d.recipient), isGroup: false, text: string(d.text), attachments };
}

export function createProvider(config: BridgeConfig): ProviderAdapter {
  if(config.provider==='photon') return createPhotonProvider(config);
  if (!config.webhookSecret || !config.providerApiKey) throw new Error('Provider API key and webhook secret are required');
  if (config.provider === 'sendblue' && !config.providerApiSecret) throw new Error('Sendblue API secret is required');
  if (!['linq', 'sendblue', 'blooio'].includes(config.provider)) throw new Error('Unsupported provider');
  return {
    name: config.provider,
    ...(config.provider==='linq'?{...createLinqRich(config),typingRefreshMs:60_000}:{}),
    verify(raw, headers) {
      if (config.provider === 'sendblue') return equal(header(headers, 'sb-signing-secret'), config.webhookSecret);
      if (config.provider === 'blooio') {
        const value = header(headers, 'x-blooio-signature');
        const match = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(value);
        if (!match || !fresh(match[1]!)) return false;
        return equal(createHmac('sha256', config.webhookSecret).update(`${match[1]}.`).update(raw).digest('hex'), match[2]!);
      }
      // Standard Webhooks, NOT Linq v2 or the deprecated X-Webhook-* scheme.
      const id = header(headers, 'webhook-id'), timestamp = header(headers, 'webhook-timestamp'), signatures = header(headers, 'webhook-signature');
      if (!id || id.length > 512 || !fresh(timestamp) || !config.webhookSecret.startsWith('whsec_')) return false;
      const encoded = config.webhookSecret.slice(6);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
      const key = Buffer.from(encoded, 'base64');
      if (!key.length || key.toString('base64') !== encoded) return false;
      const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest('base64');
      return signatures.split(' ').some(signature => signature.startsWith('v1,') && equal(signature.slice(3), expected));
    },
    parse(body) {
      const message = config.provider === 'linq' ? parseLinq(body) : config.provider === 'sendblue' ? parseSendblue(body) : parseBlooio(body);
      return validateMessage(message, config);
    },
    async send(message, text, idempotencyKey) {
      if (message.provider !== config.provider || message.isGroup || message.recipient !== config.serviceNumber || !config.allowedSenders.includes(message.sender)) throw new ProviderSendError('Reply destination is not authorized', false);
      if (!text.trim() || text.length > Math.min(config.maxReplyChars, 10_000) || !idempotencyKey || idempotencyKey.length > 255) throw new ProviderSendError('Invalid reply size or idempotency key', false);
      let result: Obj, id: string;
      if (config.provider === 'linq') {
        result = await post(`https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(message.conversationId)}/messages`, { Authorization: `Bearer ${config.providerApiKey}` }, { message: { parts: [{ type: 'text', value: text }], idempotency_key: idempotencyKey } });
        id = identifier(record(result.message).id);
      } else if (config.provider === 'sendblue') {
        // Sendblue's documented endpoint has no idempotency key contract. Do not
        // add an invented header or retry ambiguous delivery automatically.
        result = await post('https://api.sendblue.co/api/send-message', { 'sb-api-key-id': config.providerApiKey, 'sb-api-secret-key': config.providerApiSecret! }, { number: message.sender, from_number: config.serviceNumber, content: text });
        id = identifier(result.message_handle);
      } else {
        // Use the documented v2 send endpoint with explicit sender and recipient;
        // v4 subscriptions still provide the normalized inbound envelope above.
        result = await post(`https://api.blooio.com/v2/api/chats/${encodeURIComponent(message.sender)}/messages`, { Authorization: `Bearer ${config.providerApiKey}`, 'Idempotency-Key': idempotencyKey }, { text, from_number: config.serviceNumber });
        id = identifier(result.message_id);
      }
      if (!id) throw new ProviderSendError('Provider accepted send but returned no recognized message ID', true);
      return { id };
    },
  };
}
