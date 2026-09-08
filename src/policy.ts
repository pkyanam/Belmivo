import { timingSafeEqual } from 'node:crypto';
import { e164 } from './config.js';
import type { BridgeConfig, InboundMessage } from './types.js';

export function authorize(m: InboundMessage, config: Pick<BridgeConfig, 'allowedSenders'|'serviceNumber'|'maxTextChars'|'allowSharedSandbox'>): string | null {
  const shared=m.provider==='photon' && config.allowSharedSandbox===true && config.serviceNumber==='shared' && m.recipient==='shared';
  if (!e164.test(m.sender) || (!e164.test(m.recipient) && !shared)) return 'invalid-address';
  if (!config.allowedSenders.includes(m.sender)) return 'unauthorized-sender';
  if (m.recipient !== config.serviceNumber) return 'wrong-service-number';
  if (m.isGroup !== false) return 'group-not-allowed';
  if (!m.messageId || m.messageId.length > 256 || !m.conversationId || m.conversationId.length > 512) return 'invalid-identity';
  if (typeof m.text !== 'string' || m.text.length > config.maxTextChars) return 'text-limit';
  if (!Array.isArray(m.attachments) || m.attachments.length > 10) return 'attachment-limit';
  if (m.attachments.some(a=>typeof a.url !== 'string' || a.url.length>2048 || (a.name?.length ?? 0)>512 || (a.mimeType?.length ?? 0)>256)) return 'attachment-metadata-limit';
  if (!m.text.trim() && !m.attachments.length) return 'empty-message';
  return null;
}

export function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}

export function splitReply(text: string, maxChars = 1800): string[] {
  const chars = Array.from(text);
  if (!chars.length) return ['Task completed without a text response. Check the Mac for artifacts.'];
  const result: string[] = [];
  for (let i=0; i<chars.length; i+=maxChars) result.push(chars.slice(i,i+maxChars).join(''));
  return result.length > 1 ? result.map((part,i)=>`(${i+1}/${result.length}) ${part}`) : result;
}
