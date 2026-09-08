export type ProviderName = 'linq' | 'sendblue' | 'blooio' | 'photon' | 'test';
export type NativeReaction='like'|'love'|'laugh'|'emphasize'|'question'|'dislike';
export type ReactionKind=NativeReaction|'working'|'done'|'failed';

export interface Attachment {
  url: string;
  name?: string;
  mimeType?: string;
  localPath?: string;
}

export interface InboundMessage {
  provider: ProviderName;
  eventId: string;
  messageId: string;
  conversationId: string;
  sender: string;
  recipient: string;
  text: string;
  isGroup: boolean;
  attachments: Attachment[];
}

export interface ProviderAdapter {
  name: ProviderName;
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parse(body: unknown): InboundMessage | null;
  send(message: InboundMessage, text: string, idempotencyKey: string): Promise<{ id: string }>;
  prepareInbound?(message: InboundMessage, signal?: AbortSignal): Promise<InboundMessage>;
  sendMedia?(message: InboundMessage, file: {path:string;name?:string;mimeType?:string}, idempotencyKey:string): Promise<{id:string}>;
  typingRefreshMs?: number;
  setTyping?(message: InboundMessage, active: boolean, signal?: AbortSignal): Promise<void>;
  react?(message: InboundMessage, reaction: ReactionKind, signal?: AbortSignal): Promise<void>;
}

export interface AgentRun {
  newThread?: boolean;
  title?: string;
  threadInstructions?: string;
  threadId?: string;
  text: string;
  onThread: (threadId: string) => void;
  onTurn?: (turnId: string) => void;
  signal?: AbortSignal;
}

/** Evidence of a terminal turn or of cancellation before any submission.
 * An interrupt request acknowledgment alone must never produce this error.
 */
export class AgentStoppedError extends Error {
  readonly outcomeUnknown = false;
  constructor(readonly outcome: 'interrupted' | 'completed' | 'failed' | 'not-started') {
    super('User-requested stop confirmed.');
    this.name = 'AgentStoppedError';
  }
}

export interface AgentConnectionStatus {
  expected: number;
  connected: number;
  diagnostic?: 'connecting' | 'unavailable' | 'closed';
}

export interface AgentBackend {
  run(input: AgentRun): Promise<{ threadId: string; text: string }>;
  /** Best-effort read-only residency for the anchor and current selected task. */
  maintainThread?(threadId?: string): void | Promise<void>;
  /** Cached, content-free connection state; never performs I/O or starts work. */
  connectionStatus?(): AgentConnectionStatus;
  close(): Promise<void>;
}

/** Execution settings only. Provider credentials and bridge routing are not
 * required here; this type does not change inherited process environments. */
export interface AgentConfig {
  backend: 'app-server' | 'desktop';
  codexBinary: string;
  desktopSocket?: string;
  desktopToolsSocket?: string;
  desktopToolsNode?: string;
  appServerSocket?: string;
  desktopThreadId?: string;
  cwd: string;
  fullAccess: boolean;
  model?: string;
  maxTextChars: number;
  turnTimeoutMs: number;
}

export interface ExternalHandoffSelector {
  readonly provider: 'photon';
  readonly sender: string;
  readonly recipient: string;
  readonly conversationId: string;
  readonly textSha256: string;
}

export interface ExternalHandoffConfig {
  readonly version: 1;
  readonly selectors: readonly ExternalHandoffSelector[];
}

export interface BridgeConfig extends AgentConfig {
  externalHandoff?: ExternalHandoffConfig;
  relay?: {url:string;deviceId:string;token:string};
  provider: Exclude<ProviderName, 'test'>;
  allowedSenders: string[];
  serviceNumber: string;
  allowSharedSandbox?: boolean;
  dataDir: string;
  port: number;
  artifactsDir?: string;
  typingIndicators?: boolean;
  statusReactions?: boolean;
  conversationalReactions?: boolean;
  threadInstructions?: string;
  maxPending: number;
  maxReplyChars: number;
  providerApiKey: string;
  providerApiSecret?: string;
  webhookSecret: string;
}
