import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constants, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createPhotonTimingRecorder, logPhotonTiming, type PhotonTimingObserver, type PhotonTimingPhase, type PhotonOperationKind } from './photon-timing.js';
export type { PhotonTiming, PhotonTimingObserver } from './photon-timing.js';
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BridgeConfig, InboundMessage, ProviderAdapter, ReactionKind } from './types.js';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const id = (value: unknown, max = 512): string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : '';
const phone = (value: unknown): string => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value) ? value : '';
const platform = (value: unknown): boolean => value === 'iMessage' || value === 'imessage';
const header = (headers: Record<string, string | string[] | undefined>, key: string): string => {
  const matches = Object.entries(headers).filter(([name]) => name.toLowerCase() === key);
  return matches.length === 1 && typeof matches[0]![1] === 'string' ? matches[0]![1] : '';
};

export class PhotonSendError extends Error {
  constructor(message: string, public readonly ambiguous: boolean) { super(message); this.name = 'PhotonSendError'; }
}

export interface PhotonSendInput {
  projectId: string;
  projectSecret: string;
  conversationId: string;
  line: string;
  text: string;
  media?: { base64: string; name: string; mimeType: string; id: string };
}
export interface PhotonScopedSendInput extends PhotonSendInput { sender: string; inboundMessageId: string }
export type PhotonScopedSend = (input: PhotonScopedSendInput, signal: AbortSignal, onTiming?: PhotonTimingObserver | null) => Promise<{id:string}>;
export type PhotonSend = (input: PhotonSendInput, onTiming?: PhotonTimingObserver | null) => Promise<{ id: string }>;
export interface PhotonFetchInput { projectId: string; projectSecret: string; line: string; attachmentId: string }
export type PhotonFetch = (input: PhotonFetchInput, onTiming?: PhotonTimingObserver | null, signal?: AbortSignal) => Promise<Buffer>;
export type PhotonReaction = ReactionKind;
export const PHOTON_REACTIONS = { working: '‼️', done: '👍', failed: '❓', like: '👍', love: '❤️', laugh: '😂', emphasize: '‼️', question: '❓', dislike: '👎' } as const;
export interface PhotonRichInput {
  projectId: string;
  projectSecret: string;
  conversationId: string;
  line: string;
  sender: string;
  messageId: string;
  effect: { type: 'typing'; active: boolean } | { type: 'reaction'; reaction: PhotonReaction };
}
export type PhotonRich = (input: PhotonRichInput, signal?: AbortSignal, onTiming?: PhotonTimingObserver | null) => Promise<void>;
type SdkOperation = 'send' | 'scoped-send' | 'fetch' | 'rich';
export const PHOTON_FILE_LIMIT = 20 * 1024 * 1024;
const ATTACHMENT_SCHEME = 'photon-attachment:';
const MIME_BY_EXTENSION: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4' };

function attachmentContent(content: RecordValue): InboundMessage['attachments'][number] | null {
  const attachmentId = id(content.id, 256);
  if (!attachmentId || typeof content.name !== 'string' || !content.name || content.name.length > 512 || typeof content.mimeType !== 'string' || !content.mimeType || content.mimeType.length > 256) return null;
  if (content.size !== undefined && (typeof content.size !== 'number' || !Number.isSafeInteger(content.size) || content.size < 0 || content.size > PHOTON_FILE_LIMIT)) return null;
  return { url: `${ATTACHMENT_SCHEME}${encodeURIComponent(attachmentId)}`, name: content.name, mimeType: content.mimeType };
}

/** Only signed provider envelopes belong here; Bridge verifies before parsing. */
export function parsePhoton(body: unknown, config: Pick<BridgeConfig, 'allowSharedSandbox' | 'serviceNumber' | 'maxTextChars'>): InboundMessage | null {
  const event = object(body), space = object(event.space), message = object(event.message);
  const nested = object(message.space), sender = object(message.sender), content = object(message.content);
  if (event.event !== 'messages' || message.direction !== 'inbound') return null;
  if (![space.platform, nested.platform, message.platform, sender.platform].every(platform)) return null;
  if (space.type !== 'dm' || nested.type !== 'dm') return null;
  const conversationId = id(space.id), messageId = id(message.id, 256), from = phone(sender.id);
  if (!conversationId || !messageId || !from || nested.id !== conversationId || nested.phone !== space.phone) return null;
  const line = space.phone === 'shared' && config.allowSharedSandbox === true ? 'shared' : phone(space.phone);
  if (!line || line !== config.serviceNumber || from === line) return null;
  // Platform routes can support SMS/RCS fallback. Never admit an explicit non-iMessage classification.
  if (sender.service !== undefined && sender.service !== 'iMessage') return null;
  let text = '';
  const attachments: InboundMessage['attachments'] = [];
  if (content.type === 'text') {
    if (typeof content.text !== 'string' || !content.text.trim() || content.text.length > config.maxTextChars) return null;
    text = content.text;
  } else if (content.type === 'attachment') {
    const attachment = attachmentContent(content); if (!attachment) return null; attachments.push(attachment);
  } else if (content.type === 'group') {
    // Spectrum's content.group is a multipart message, not a multi-person chat.
    // A PDF/image with a caption has attachment and text children in order.
    if (!Array.isArray(content.items) || !content.items.length || content.items.length > 10) return null;
    const captions: string[] = []; let textLength = 0;
    for (const raw of content.items) {
      const item = object(raw), childSender = object(item.sender), childContent = object(item.content);
      if (item.direction !== 'inbound' || !platform(item.platform) || !platform(childSender.platform) || childSender.id !== from || !id(item.id, 256)) return null;
      if (childSender.service !== undefined && childSender.service !== 'iMessage') return null;
      if (childContent.type === 'attachment') {
        const attachment = attachmentContent(childContent); if (!attachment) return null; attachments.push(attachment);
      } else if (childContent.type === 'text') {
        if (typeof childContent.text !== 'string' || !childContent.text.trim()) return null;
        textLength += childContent.text.length + (captions.length ? 1 : 0);
        if (textLength > config.maxTextChars) return null;
        captions.push(childContent.text);
      } else return null;
    }
    // Text-only groups have not been verified against the provider contract.
    if (!attachments.length) return null;
    text = captions.join('\n');
  } else return null;
  return { provider: 'photon', eventId: messageId, messageId, conversationId, sender: from, recipient: line, isGroup: false, text, attachments };
}

/** Verify the provider's exact raw envelope before any normalization. */
export function verifyPhotonWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>, secret: string, now = Date.now()): boolean {
  const timestamp = header(headers, 'x-spectrum-timestamp'), signature = header(headers, 'x-spectrum-signature');
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** SDK is isolated because Spectrum installs process-wide signal handlers. */
function runSdkWorker(operation: SdkOperation, input: PhotonSendInput | PhotonFetchInput | PhotonRichInput | PhotonScopedSendInput, signal?: AbortSignal, onTiming: PhotonTimingObserver | null = logPhotonTiming): Promise<RecordValue> { return new Promise((resolve, reject) => {
  const effect = 'effect' in input ? input.effect : undefined;
  const kind: PhotonOperationKind = operation === 'fetch' ? 'fetch' : (operation === 'send' || operation === 'scoped-send') ? ('media' in input && input.media ? 'media' : 'text') : effect?.type === 'typing' ? (effect.active ? 'typing-start' : 'typing-stop') : effect?.type === 'reaction' ? 'reaction' : 'rich';
  const timing = createPhotonTimingRecorder(kind, onTiming ?? undefined);
  if (signal?.aborted) { timing.finish('failed'); reject(new PhotonSendError('Photon SDK operation cancelled before starting', false)); return; }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--sdk-${operation}`], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  child.stdio[3]?.on('data', (chunk: Buffer) => timing.accept(chunk));
  child.stdio[3]?.on('error', () => {});
  let output = '', settled = false, exited = false, closed = false;
  let afterClose: (() => void) | undefined, exitCode: number | null | undefined;
  const scoped = operation === 'scoped-send';
  const finish = (error?: Error, result?: RecordValue) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    const complete = () => {
      timing.finish(error ? error instanceof PhotonSendError && error.ambiguous ? 'uncertain' : 'failed' : 'success');
      if (error) reject(error); else resolve(result!);
    };
    if (scoped) {
      // The operator executor retains its slot/ownership until this exact child
      // and its owned pipes close. Failed OS termination cannot imply cleanup.
      afterClose = complete;
      if (!exited && !child.killed) { try { child.kill('SIGKILL'); } catch { /* Keep ownership until observed close. */ } }
      if (closed) complete();
    } else {
      if (!child.killed) child.kill('SIGKILL');
      complete();
    }
  };
  const cancel = () => finish(new PhotonSendError('Photon SDK operation cancelled', operation !== 'fetch'));
  const timer = setTimeout(() => finish(new PhotonSendError('Photon SDK operation timed out', operation !== 'fetch')), scoped ? 9_000 : operation === 'rich' ? 10_000 : 60_000);
  signal?.addEventListener('abort', cancel, { once: true });
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    if (scoped && settled) return;
    output += chunk.toString('utf8');
    if (output.length > (operation === 'fetch' ? Math.ceil(PHOTON_FILE_LIMIT / 3) * 4 + 65536 : 65536)) finish(new PhotonSendError('Photon SDK returned excessive output', operation === 'send' || scoped));
  });
  child.once('error', () => finish(new PhotonSendError('Photon SDK worker could not start', false)));
  child.stdin.on('error', () => finish(new PhotonSendError('Photon SDK worker disconnected; delivery outcome is unknown', true)));
  if (scoped) child.stdout.on('error', () => finish(new PhotonSendError('Photon SDK output disconnected; delivery outcome is unknown', true)));
  const readResult = (code: number | null) => {
    if (settled) return;
    try {
      const result = object(JSON.parse(output));
      if (code === 0 && (operation === 'fetch' ? typeof result.base64 === 'string' : operation === 'rich' ? result.ok === true : id(result.id, 256))) finish(undefined, result);
      else finish(new PhotonSendError('Photon SDK could not confirm reply acceptance', result.ambiguous !== false));
    } catch { finish(new PhotonSendError('Photon SDK returned an invalid result; delivery outcome is unknown', true)); }
  };
  child.once('close', code => {
    closed = true;
    if (scoped && !settled) readResult(exitCode === undefined ? code : exitCode);
    else afterClose?.();
  });
  child.once('exit', code => {
    exited = true; exitCode = code;
    if (!scoped) readResult(code);
  });
  // Credentials never appear in argv, the environment, service logs, or reply text.
  child.stdin.end(JSON.stringify(input));
}); }

export const sendPhotonViaSdk: PhotonSend = async (input, onTiming) => {
  const result = await runSdkWorker('send', input, undefined, onTiming);
  return { id: String(result.id) };
};
export const sendScopedPhotonViaSdk: PhotonScopedSend = async (input, signal, onTiming = null) => {
  if (!(signal instanceof AbortSignal) || !input || !id(input.projectId, 128) || !id(input.projectSecret, 8192) || !id(input.conversationId, 256)
    || (!phone(input.line) && input.line !== 'shared') || !phone(input.sender) || !id(input.inboundMessageId, 256) || input.media
    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000) throw new PhotonSendError('Invalid scoped reply input', false);
  const result = await runSdkWorker('scoped-send', input, signal, onTiming);
  return {id:String(result.id)};
};
export const fetchPhotonViaSdk: PhotonFetch = async (input, onTiming, signal) => {
  const result = await runSdkWorker('fetch', input, signal, onTiming), encoded = String(result.base64);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > PHOTON_FILE_LIMIT || bytes.toString('base64') !== encoded) throw new Error('Invalid Photon attachment bytes');
  return bytes;
};
export const richPhotonViaSdk: PhotonRich = async (input, signal, onTiming) => { await runSdkWorker('rich', input, signal, onTiming); };

interface PhotonNativeSpace {
  id: string;
  type: string;
  phone: string;
  startTyping(): Promise<void>;
  stopTyping(): Promise<void>;
  getMessage(messageId: string): Promise<unknown>;
}

/** Uses an actual SDK Message rather than reconstructing native reaction metadata. */
export async function applyPhotonRich(space: PhotonNativeSpace, input: Pick<PhotonRichInput, 'conversationId' | 'line' | 'sender' | 'messageId' | 'effect'>, beforeEffect: () => void = () => {}): Promise<void> {
  if (space.id !== input.conversationId || space.type !== 'dm' || space.phone !== input.line) throw new PhotonSendError('Rich-message conversation did not match', false);
  if (input.effect.type === 'typing') {
    if (typeof input.effect.active !== 'boolean') throw new PhotonSendError('Invalid typing state', false);
    beforeEffect();
    if (input.effect.active) await space.startTyping(); else await space.stopTyping();
    return;
  }
  if (input.effect.type !== 'reaction' || !Object.hasOwn(PHOTON_REACTIONS, input.effect.reaction)) throw new PhotonSendError('Unsupported reaction state', false);
  const target = object(await space.getMessage(input.messageId)), sender = object(target.sender), targetSpace = object(target.space);
  if (target.id !== input.messageId || target.direction !== 'inbound' || sender.id !== input.sender || !platform(target.platform) || object(target.content).type === 'reaction' || typeof target.react !== 'function') throw new PhotonSendError('Reaction target unavailable or mismatched', false);
  if (sender.service !== undefined && sender.service !== 'iMessage') throw new PhotonSendError('Reaction target is not iMessage', false);
  if (targetSpace.id !== input.conversationId || targetSpace.phone !== input.line || targetSpace.type !== 'dm') throw new PhotonSendError('Reaction target conversation did not match', false);
  beforeEffect();
  const result = object(await target.react.call(target, PHOTON_REACTIONS[input.effect.reaction]));
  if (!id(result.id, 256)) throw new PhotonSendError('Reaction is unsupported or not confirmed', true);
}

function authorizedDestination(message: InboundMessage, config: BridgeConfig): boolean {
  return message.provider === 'photon' && message.isGroup === false && message.recipient === config.serviceNumber && config.allowedSenders.includes(message.sender) && !!phone(message.sender) && !!id(message.conversationId);
}

async function privateAttachmentDirectory(dataDir: string): Promise<string> {
  const parent = await lstat(dataDir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Photon data directory must be private and real');
  const directory = join(dataDir, 'attachments');
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function readArtifact(config: BridgeConfig, file: { path: string; name?: string; mimeType?: string }): Promise<{ bytes: Buffer; name: string; mimeType: string }> {
  if (!config.artifactsDir || !isAbsolute(config.artifactsDir) || !isAbsolute(file.path)) throw new PhotonSendError('Configure an explicit artifacts directory before sending files', false);
  const root = resolve(config.artifactsDir), path = resolve(file.path), inside = relative(root, path);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new PhotonSendError('File is outside the configured artifacts directory', false);
  if (inside.split(sep).some(part => part.startsWith('.'))) throw new PhotonSendError('Hidden artifacts cannot be sent automatically', false);
  let current = root;
  for (const part of ['', ...inside.split(sep).slice(0, -1)]) {
    if (part) current = join(current, part);
    const directory = await lstat(current);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new PhotonSendError('Artifact directories must not be symbolic links', false);
  }
  const fileInfo = await lstat(path);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1 || fileInfo.size > PHOTON_FILE_LIMIT) throw new PhotonSendError('Artifact must be a bounded regular file with no extra links', false);
  const extension = extname(path).toLowerCase(), mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType || (file.mimeType && file.mimeType !== mimeType)) throw new PhotonSendError('Unsupported artifact file type', false);
  const name = file.name ?? basename(path);
  if (basename(name) !== name || !id(name, 255) || name.startsWith('.') || extname(name).toLowerCase() !== extension) throw new PhotonSendError('Invalid artifact filename', false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== fileInfo.ino || opened.dev !== fileInfo.dev) throw new PhotonSendError('Artifact changed before reading', false);
    const chunks: Buffer[] = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(65536), read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > PHOTON_FILE_LIMIT) throw new PhotonSendError('Artifact exceeds the file size limit', false);
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    return { bytes: Buffer.concat(chunks), name, mimeType };
  } finally { await handle.close(); }
}

export function createPhotonProvider(config: BridgeConfig, send: PhotonSend = sendPhotonViaSdk, fetchAttachment: PhotonFetch = fetchPhotonViaSdk, rich: PhotonRich = richPhotonViaSdk, onTiming: PhotonTimingObserver | null = logPhotonTiming): ProviderAdapter {
  if (config.provider !== 'photon' || !config.providerApiKey || !config.providerApiSecret || config.webhookSecret.length < 16) throw new Error('Photon requires project ID, project secret and webhook signing secret');
  if (!phone(config.serviceNumber) && !(config.serviceNumber === 'shared' && config.allowSharedSandbox === true)) throw new Error('Photon requires a dedicated phone number or explicit shared sandbox configuration');
  return {
    name: 'photon',
    typingRefreshMs: 20_000,
    verify(raw, headers) {
      return verifyPhotonWebhook(raw, headers, config.webhookSecret);
    },
    parse: body => parsePhoton(body, config),
    async setTyping(message, active, signal) {
      if (!authorizedDestination(message, config) || !id(message.messageId, 256) || typeof active !== 'boolean') throw new PhotonSendError('Photon typing destination or state is not authorized', false);
      await rich({ projectId: config.providerApiKey, projectSecret: config.providerApiSecret!, conversationId: message.conversationId, line: message.recipient, sender: message.sender, messageId: message.messageId, effect: { type: 'typing', active } }, signal, onTiming);
    },
    async react(message, reaction, signal) {
      if (!authorizedDestination(message, config) || !id(message.messageId, 256) || !Object.hasOwn(PHOTON_REACTIONS, reaction)) throw new PhotonSendError('Photon reaction destination or state is not authorized', false);
      await rich({ projectId: config.providerApiKey, projectSecret: config.providerApiSecret!, conversationId: message.conversationId, line: message.recipient, sender: message.sender, messageId: message.messageId, effect: { type: 'reaction', reaction } }, signal, onTiming);
    },
    async prepareInbound(message, signal) {
      if (!authorizedDestination(message, config)) throw new Error('Photon attachment sender is not authorized');
      signal?.throwIfAborted();
      if (!message.attachments.length) return message;
      if (message.attachments.length > 10) throw new Error('Too many Photon attachments');
      let directory: string;
      try { directory = await privateAttachmentDirectory(config.dataDir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        directory = join(config.dataDir, 'attachments');
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Attachment directory must be private and real');
      }
      const requestDirectory = await mkdtemp(join(directory, 'inbound-'));
      try {
        const attachments: InboundMessage['attachments'] = []; let total = 0;
        for (const [index, item] of message.attachments.entries()) {
          signal?.throwIfAborted();
          if (!item.url.startsWith(ATTACHMENT_SCHEME)) throw new Error('Unknown Photon attachment reference');
          const attachmentId = decodeURIComponent(item.url.slice(ATTACHMENT_SCHEME.length));
          if (!id(attachmentId, 256)) throw new Error('Invalid Photon attachment identifier');
          const bytes = await fetchAttachment({ projectId: config.providerApiKey, projectSecret: config.providerApiSecret!, line: message.recipient, attachmentId }, onTiming, signal);
          signal?.throwIfAborted();
          if (!Buffer.isBuffer(bytes) || bytes.length > PHOTON_FILE_LIMIT || (total += bytes.length) > 2 * PHOTON_FILE_LIMIT) throw new Error('Photon attachment size limit exceeded');
          const suffix = extname(item.name ?? '').toLowerCase();
          const safeSuffix = /^\.[a-z0-9]{1,10}$/.test(suffix) ? suffix : '.bin';
          const path = join(requestDirectory, `${index}${safeSuffix}`);
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
          attachments.push({ ...item, localPath: path });
        }
        signal?.throwIfAborted();
        return { ...message, attachments };
      } catch (error) { await rm(requestDirectory, { recursive: true, force: true }); throw error; }
    },
    async send(message, text, idempotencyKey) {
      if (!authorizedDestination(message, config)) throw new PhotonSendError('Photon reply destination is not authorized', false);
      if (!text.trim() || text.length > Math.min(config.maxReplyChars, 10000) || !id(idempotencyKey, 255)) throw new PhotonSendError('Invalid Photon reply size or idempotency key', false);
      // Spectrum generates per-call gRPC idempotency internally. It does not expose a
      // persisted bridge key here, so the bridge must never automatically replay an ambiguous send.
      const result = await send({ projectId: config.providerApiKey, projectSecret: config.providerApiSecret!, conversationId: message.conversationId, line: message.recipient, text }, onTiming);
      if (!id(result.id, 256)) throw new PhotonSendError('Photon accepted a reply without a recognized message ID', true);
      return result;
    },
    async sendMedia(message, file, idempotencyKey) {
      if (!authorizedDestination(message, config) || !id(idempotencyKey, 255)) throw new PhotonSendError('Photon media destination is not authorized', false);
      const artifact = await readArtifact(config, file);
      const result = await send({ projectId: config.providerApiKey, projectSecret: config.providerApiSecret!, conversationId: message.conversationId, line: message.recipient, text: '', media: { base64: artifact.bytes.toString('base64'), name: artifact.name, mimeType: artifact.mimeType, id: idempotencyKey } }, onTiming);
      if (!id(result.id, 256)) throw new PhotonSendError('Photon accepted media without a recognized message ID', true);
      return result;
    },
  };
}

async function sdkSendWorker(operation: SdkOperation): Promise<void> {
  let raw = '', submitted = false;
  const timed = async <T>(phase: PhotonTimingPhase, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    try { return await operation(); }
    finally {
      // fd 3 is a bounded metrics-only pipe. SDK stderr remains discarded by the parent.
      try { writeSync(3, JSON.stringify({ phase, durationMs: Math.min(120_000, Math.max(0, Math.round(performance.now() - started))) }) + '\n'); } catch { /* Optional metrics must never alter a provider outcome. */ }
    }
  };
  try {
    for await (const chunk of process.stdin) { raw += String(chunk); if (raw.length > (operation === 'scoped-send' ? 131072 : operation === 'rich' ? 32768 : Math.ceil(PHOTON_FILE_LIMIT / 3) * 4 + 32768)) throw new Error('Input too large'); }
    const input = JSON.parse(raw) as PhotonSendInput & PhotonFetchInput & PhotonRichInput & PhotonScopedSendInput;
    if (!id(input.projectId) || !id(input.projectSecret, 8192) || (!phone(input.line) && input.line !== 'shared')) throw new Error('Invalid input');
    if (operation === 'fetch' && !id(input.attachmentId, 256)) throw new Error('Invalid attachment input');
    if (operation !== 'fetch' && !id(input.conversationId)) throw new Error('Invalid conversation input');
    if ((operation === 'send' || operation === 'scoped-send') && (typeof input.text !== 'string' || (!input.text.trim() && !input.media) || input.text.length > 10000)) throw new Error('Invalid send input');
    if (operation === 'scoped-send' && (!phone(input.sender) || !id(input.inboundMessageId, 256) || input.media)) throw new Error('Invalid scoped reply input');
    if (operation === 'rich') {
      if (!phone(input.sender) || !id(input.messageId, 256) || !input.effect || (input.effect.type === 'typing' ? typeof input.effect.active !== 'boolean' : input.effect.type !== 'reaction' || !Object.hasOwn(PHOTON_REACTIONS, input.effect.reaction))) throw new Error('Invalid rich operation input');
    }
    let mediaBytes: Buffer | undefined;
    if (input.media) {
      if (operation !== 'send' || typeof input.media.base64 !== 'string' || !id(input.media.name, 255) || !id(input.media.mimeType, 256) || !id(input.media.id, 255)) throw new Error('Invalid media input');
      mediaBytes = Buffer.from(input.media.base64, 'base64');
      if (mediaBytes.length > PHOTON_FILE_LIMIT || mediaBytes.toString('base64') !== input.media.base64) throw new Error('Invalid media bytes');
    }
    const [{ Spectrum, attachment }, { imessage }] = await timed('sdkImportMs', () => Promise.all([import('@spectrum-ts/core'), import('@spectrum-ts/imessage')]));
    const app = await timed('initMs', () => Spectrum({ projectId: input.projectId, projectSecret: input.projectSecret, providers: [imessage.config()], telemetry: false, options: { logLevel: 'silent' } }));
    try {
      const im = imessage(app);
      if (operation === 'fetch') {
        await timed('operationMs', async () => {
          const file = await im.getAttachment(input.attachmentId, input.line);
          if (!file || (file.size !== undefined && file.size > PHOTON_FILE_LIMIT)) throw new Error('Attachment unavailable or too large');
          const reader = (await file.stream()).getReader(), chunks: Buffer[] = []; let size = 0;
          try {
            for (;;) {
              const item = await reader.read(); if (item.done) break;
              if (!(item.value instanceof Uint8Array)) throw new Error('Invalid attachment stream');
              size += item.value.byteLength;
              if (size > PHOTON_FILE_LIMIT) throw new Error('Attachment stream too large');
              chunks.push(Buffer.from(item.value));
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          process.stdout.write(JSON.stringify({ base64: Buffer.concat(chunks).toString('base64') }));
        });
        return;
      }
      const space = await timed('spaceLookupMs', () => im.space.get(input.conversationId, { phone: input.line }));
      if (space.id !== input.conversationId || space.type !== 'dm' || space.phone !== input.line) throw new Error('Reply space did not match');
      if (operation === 'rich') {
        await timed('operationMs', () => applyPhotonRich(space, input, () => { submitted = true; }));
        process.stdout.write(JSON.stringify({ ok: true }));
        return;
      }
      if (operation === 'scoped-send') {
        const target = object(await space.getMessage(input.inboundMessageId)), sender = object(target.sender), targetSpace = object(target.space);
        if (target.id !== input.inboundMessageId || target.direction !== 'inbound' || sender.id !== input.sender || !platform(target.platform)
          || sender.service !== undefined && sender.service !== 'iMessage' || object(target.content).type === 'reaction'
          || targetSpace.id !== input.conversationId || targetSpace.phone !== input.line || targetSpace.type !== 'dm') throw new Error('Scoped reply anchor did not match');
      }
      submitted = true;
      const result = await timed('operationMs', () => space.send(mediaBytes ? attachment(mediaBytes, { name: input.media!.name, mimeType: input.media!.mimeType, id: input.media!.id }) : input.text));
      if (!result || !id(result.id, 256)) throw new Error('No recognized message ID');
      process.stdout.write(JSON.stringify({ id: result.id }));
    } finally { await timed('shutdownMs', () => app.stop()); }
  } catch {
    process.stdout.write(JSON.stringify({ ambiguous: submitted }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && ['--sdk-send', '--sdk-scoped-send', '--sdk-fetch', '--sdk-rich'].includes(process.argv[2] ?? '')) await sdkSendWorker(process.argv[2] === '--sdk-fetch' ? 'fetch' : process.argv[2] === '--sdk-rich' ? 'rich' : process.argv[2] === '--sdk-scoped-send' ? 'scoped-send' : 'send');
