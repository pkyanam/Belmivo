import { createHash } from 'node:crypto';
import type { ExternalHandoffConfig, ExternalHandoffSelector, InboundMessage, ProviderName } from './types.js';
export type { ExternalHandoffConfig, ExternalHandoffSelector } from './types.js';

const invalid = (): never => { throw new Error('Invalid external handoff configuration.'); };
const e164 = /^\+[1-9]\d{7,14}$/;

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
  // Private JSON has only data properties. Never execute a caller's getters.
  for (const key of keys) if (!Object.getOwnPropertyDescriptor(value, key)?.hasOwnProperty('value')) return invalid();
  return value as Record<string, unknown>;
}

/** Exact-message exceptions only; the caller must authenticate and authorize
 * normal admission before matching. No selectors or input values enter errors. */
export function validateExternalHandoff(value: unknown, scope: {
  provider: ProviderName; allowedSenders: readonly string[]; serviceNumber: string;
}): ExternalHandoffConfig {
  const file = exactRecord(value, ['version', 'selectors']);
  if (file.version !== 1 || !Array.isArray(file.selectors) || file.selectors.length > 2 || scope.provider !== 'photon') return invalid();
  const selectors: ExternalHandoffSelector[] = [];
  const seen = new Set<string>();
  for (const entry of file.selectors) {
    const row = exactRecord(entry, ['provider', 'sender', 'recipient', 'conversationId', 'textSha256']);
    if (row.provider !== 'photon' || typeof row.sender !== 'string' || !e164.test(row.sender)
      || !scope.allowedSenders.includes(row.sender) || typeof row.recipient !== 'string'
      || row.recipient !== scope.serviceNumber || (row.recipient !== 'shared' && !e164.test(row.recipient))
      || typeof row.conversationId !== 'string' || row.conversationId.length === 0 || row.conversationId.length > 512
      || /\p{Cc}/u.test(row.conversationId) || typeof row.textSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.textSha256)) return invalid();
    const selector: ExternalHandoffSelector = Object.freeze({provider: 'photon', sender: row.sender, recipient: row.recipient,
      conversationId: row.conversationId, textSha256: row.textSha256});
    const identity = JSON.stringify(selector);
    if (seen.has(identity)) return invalid();
    seen.add(identity); selectors.push(selector);
  }
  return Object.freeze({version: 1, selectors: Object.freeze(selectors)});
}

export function matchesExternalHandoff(config: ExternalHandoffConfig | undefined, message: InboundMessage): boolean {
  if (!config || message.isGroup !== false || !Array.isArray(message.attachments) || message.attachments.length !== 0
    || typeof message.text !== 'string') return false;
  const candidates = config.selectors.filter(selector => selector.provider === message.provider && selector.sender === message.sender
    && selector.recipient === message.recipient && selector.conversationId === message.conversationId);
  if (!candidates.length) return false;
  const digest = createHash('sha256').update(message.text, 'utf8').digest('hex');
  return candidates.some(selector => selector.textSha256 === digest);
}
