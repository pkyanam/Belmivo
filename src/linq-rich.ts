import type { BridgeConfig, InboundMessage, ReactionKind } from './types.js';

export type LinqReactionPhase = Extract<ReactionKind, 'working' | 'done' | 'failed'>;
type RichConfig = Pick<BridgeConfig, 'provider' | 'providerApiKey' | 'serviceNumber' | 'allowedSenders'>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phone = /^\+[1-9]\d{7,14}$/;
const reactions = { working: 'emphasize', done: 'like', failed: 'question', like: 'like', love: 'love', laugh: 'laugh', emphasize: 'emphasize', question: 'question', dislike: 'dislike' } as const;
const base = 'https://api.linqapp.com/api/partner/v3';

/** Optional UI signals only. The bridge must catch failures separately from job delivery. */
export class LinqRichError extends Error {
  constructor() { super('Linq optional message indicator could not be confirmed'); this.name = 'LinqRichError'; }
}

export function createLinqRich(config: RichConfig, options: { fetch?: Fetcher; timeoutMs?: number } = {}) {
  if (config.provider !== 'linq' || !config.providerApiKey || !phone.test(config.serviceNumber)) throw new LinqRichError();
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new LinqRichError();

  function authorize(message: InboundMessage): void {
    if (message.provider !== 'linq' || message.isGroup !== false || message.recipient !== config.serviceNumber
      || !phone.test(message.sender) || !config.allowedSenders.includes(message.sender)
      || !uuid.test(message.conversationId) || !uuid.test(message.messageId)) throw new LinqRichError();
  }

  async function request(path: string, method: 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new LinqRichError();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const operation = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw new LinqRichError();
      const response = await fetcher(base + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${config.providerApiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Response bodies can contain private provider diagnostics. Never read or log them.
      if (response.body) void response.body.cancel().catch(() => {});
      if (!response.ok) throw new LinqRichError();
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new LinqRichError()); }, timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { controller.abort(); reject(new LinqRichError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try { await Promise.race([operation, timeout, cancelled]); }
    catch { throw new LinqRichError(); }
    finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); }
  }

  return {
    async setTyping(message: InboundMessage, active: boolean, signal?: AbortSignal): Promise<void> {
      authorize(message);
      if (typeof active !== 'boolean') throw new LinqRichError();
      // Linq's native iMessage indicator lasts ~85–90s; refresh no faster than 60s.
      // https://docs.linqapp.com/channel/imessage/guides/chats/typing-indicators/
      await request(`/chats/${message.conversationId}/typing`, active ? 'POST' : 'DELETE', undefined, signal);
    },
    async react(message: InboundMessage, phase: ReactionKind, signal?: AbortSignal): Promise<void> {
      authorize(message);
      if (!Object.hasOwn(reactions, phase)) throw new LinqRichError();
      // React to the original inbound message, not its webhook event ID.
      // No documented persistent idempotency contract: never retry an unknown outcome.
      // https://docs.linqapp.com/channel/imessage/guides/messaging/reactions/
      await request(`/messages/${message.messageId}/reactions`, 'POST', { operation: 'add', type: reactions[phase], part_index: 0 }, signal);
    },
  };
}
