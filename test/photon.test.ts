import test, { type TestContext } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPhotonTimingRecorder, type PhotonTiming } from '../src/photon-timing.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Bridge } from '../src/bridge.js';
import { applyPhotonRich, createPhotonProvider, PHOTON_FILE_LIMIT, PHOTON_REACTIONS, PhotonSendError, richPhotonViaSdk, sendPhotonViaSdk, type PhotonRichInput, type PhotonSendInput } from '../src/photon.js';
import type { BridgeConfig } from '../src/types.js';

const owner = '+12025559876', line = '+12025551234';
const config = (changes: Partial<BridgeConfig> = {}): BridgeConfig => ({ provider: 'photon', providerApiKey: 'test-project', providerApiSecret: 'test-project-secret', webhookSecret: 'test-webhook-signing-secret', serviceNumber: line, allowedSenders: [owner], dataDir: '/tmp/unused', cwd: '/tmp/unused', port: 0, backend: 'app-server', codexBinary: 'unused', fullAccess: true, maxTextChars: 10000, maxReplyChars: 10000, maxPending: 10, turnTimeoutMs: 1000, ...changes });
// Synthetic structural fixture from https://photon.codes/docs/webhooks/events .
const fixture = (phone = line, spelling = 'iMessage') => {
  const space = { id: `any;-;${owner}`, platform: spelling, type: 'dm', phone };
  return { event: 'messages', space, message: { id: 'spc-msg-test-1', platform: spelling, direction: 'inbound', timestamp: '2026-09-07T00:00:00Z', sender: { id: owner, platform: spelling }, space: { ...space }, content: { type: 'text', text: 'test task' } } };
};
const headers = (raw: Buffer, timestamp = String(Math.floor(Date.now() / 1000))) => ({
  'x-spectrum-timestamp': timestamp,
  'x-spectrum-signature': `v0=${createHmac('sha256', config().webhookSecret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`,
});

test('Photon v0 signature authenticates raw bytes and timestamp, rejects stale, duplicated and malformed headers', () => {
  const adapter = createPhotonProvider(config()), raw = Buffer.from(JSON.stringify(fixture()));
  const signed = headers(raw);
  assert.equal(adapter.verify(raw, signed), true);
  assert.equal(adapter.verify(Buffer.concat([raw, Buffer.from(' ')]), signed), false);
  for (const offset of [-301, 301]) assert.equal(adapter.verify(raw, headers(raw, String(Math.floor(Date.now() / 1000) + offset))), false);
  assert.equal(adapter.verify(raw, { ...signed, 'X-Spectrum-Timestamp': signed['x-spectrum-timestamp'] }), false);
  assert.equal(adapter.verify(raw, { ...signed, 'x-spectrum-signature': [signed['x-spectrum-signature']] }), false);
  assert.equal(adapter.verify(raw, { ...signed, 'x-spectrum-signature': 'v0=bogus' }), false);
  assert.equal(adapter.verify(raw, { ...signed, 'x-spectrum-timestamp': `${signed['x-spectrum-timestamp']}.0` }), false);
  assert.equal(adapter.verify(raw, {}), false);
});

test('Photon parser preserves provider conversation and dedicated line across documented platform spellings', () => {
  const adapter = createPhotonProvider(config());
  for (const spelling of ['iMessage', 'imessage']) {
    const message = adapter.parse(fixture(line, spelling));
    assert.equal(message?.provider, 'photon'); assert.equal(message?.recipient, line);
    assert.equal(message?.sender, owner); assert.equal(message?.conversationId, `any;-;${owner}`);
    assert.equal(message?.eventId, message?.messageId); assert.equal(message?.isGroup, false);
  }
});

test('Photon shared sandbox requires explicit opt-in and retains the honest shared identity', () => {
  assert.throws(() => createPhotonProvider(config({ serviceNumber: 'shared' })), /explicit shared sandbox/);
  const shared = createPhotonProvider(config({ serviceNumber: 'shared', allowSharedSandbox: true }));
  assert.equal(shared.parse(fixture('shared'))?.recipient, 'shared');
  assert.equal(shared.parse(fixture(line)), null);
  assert.equal(createPhotonProvider(config()).parse(fixture('shared')), null);
});

test('Photon parser fails closed on groups, inconsistent routing, echoes, unsupported content and SMS', () => {
  const adapter = createPhotonProvider(config()), value = fixture();
  for (const body of [
    { ...value, event: 'typing' },
    { ...value, space: { ...value.space, type: 'group' } },
    { ...value, space: { ...value.space, type: undefined } },
    { ...value, space: { ...value.space, platform: 'whatsapp' } },
    { ...value, space: { ...value.space, phone: '+12025550000' } },
    { ...value, message: { ...value.message, direction: 'outbound' } },
    { ...value, message: { ...value.message, space: { ...value.space, id: 'different-conversation' } } },
    { ...value, message: { ...value.message, sender: { ...value.message.sender, id: 'person@example.com' } } },
    { ...value, message: { ...value.message, sender: { ...value.message.sender, service: 'SMS' } } },
    { ...value, message: { ...value.message, content: { type: 'reaction', emoji: '👍' } } },
    { ...value, message: { ...value.message, content: { type: 'attachment', id: '', name: 'file.pdf', mimeType: 'application/pdf' } } },
    { ...value, message: { ...value.message, content: { type: 'text', text: 'x'.repeat(10001) } } },
    null, {}, [], false,
  ]) assert.equal(adapter.parse(body), null);
});

test('Photon sends through the SDK with original conversation and explicit line, without inventing REST/idempotency fields', async () => {
  const requests: PhotonSendInput[] = [];
  const adapter = createPhotonProvider(config(), async request => { requests.push(request); return { id: 'out-1' }; });
  const message = adapter.parse(fixture())!;
  assert.deepEqual(await adapter.send(message, 'reply', 'job-1:0'), { id: 'out-1' });
  assert.deepEqual(requests[0], { projectId: 'test-project', projectSecret: 'test-project-secret', conversationId: message.conversationId, line, text: 'reply' });
  for (const mutation of [{ sender: '+12025550000' }, { recipient: '+12025550000' }, { isGroup: true }]) {
    await assert.rejects(adapter.send({ ...message, ...mutation }, 'reply', 'job-1:0'), error => error instanceof PhotonSendError && !error.ambiguous);
  }
  assert.equal(requests.length, 1);
});

test('Photon missing send acceptance ID is ambiguous; isolated worker sanitizes pre-send validation errors', async () => {
  const adapter = createPhotonProvider(config(), async () => ({ id: '' }));
  await assert.rejects(adapter.send(adapter.parse(fixture())!, 'reply', 'job-1:0'), error => error instanceof PhotonSendError && error.ambiguous);
  await assert.rejects(sendPhotonViaSdk({ projectId: '', projectSecret: 'private-test-marker', conversationId: 'chat', line, text: 'reply' }), error => error instanceof PhotonSendError && !error.ambiguous && !error.message.includes('private-test-marker'));
});

test('Photon signed HTTP shared-sandbox round trip and restart suppress duplicates and unauthorized senders', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-'));
  const c = config({ serviceNumber: 'shared', allowSharedSandbox: true, dataDir: join(directory, 'data'), cwd: join(directory, 'workspace') });
  const requests: PhotonSendInput[] = []; let invocations = 0;
  const provider = createPhotonProvider(c, async input => { requests.push(input); return { id: 'out-1' }; }, undefined, async () => {});
  const make = () => new Bridge({ config: c, provider, log: () => {}, agent: { close: async () => {}, run: async input => { invocations++; input.onThread('thread-1'); return { threadId: 'thread-1', text: 'test reply' }; } } });
  let bridge = make(); await bridge.start();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async (body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    const result = await fetch(`http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}/webhooks/photon`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(raw) }, body: raw });
    return { status: result.status, body: await result.json() };
  };
  assert.deepEqual(await post(fixture('shared')), { status: 200, body: { status: 'queued' } });
  const deadline = Date.now() + 3000;
  while (bridge.store.stats().sent !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bridge.store.stats().sent, 1); assert.equal(invocations, 1); assert.equal(requests[0]?.line, 'shared');
  await bridge.close(); bridge = make(); await bridge.start();
  assert.deepEqual(await post(fixture('shared')), { status: 200, body: { status: 'duplicate' } });
  const unauthorized = fixture('shared'); unauthorized.message.sender.id = '+12025550000'; unauthorized.message.id = 'new-message';
  assert.deepEqual(await post(unauthorized), { status: 200, body: { status: 'ignored' } });
  assert.equal(invocations, 1); assert.equal(requests.length, 1);
});

const mediaFixture = () => {
  const value = fixture();
  return { ...value, message: { ...value.message, content: { type: 'attachment', id: 'provider-file-1', name: 'document.pdf', mimeType: 'application/pdf', size: 4 } } };
};

test('Photon parses attachment references and album children without inventing download URLs', () => {
  const provider = createPhotonProvider(config()), value = mediaFixture();
  const parsed = provider.parse(value)!;
  assert.equal(parsed.text, '');
  assert.deepEqual(parsed.attachments, [{ url: 'photon-attachment:provider-file-1', name: 'document.pdf', mimeType: 'application/pdf' }]);
  const album = { ...value, message: { ...value.message, content: { type: 'group', items: [value.message, { ...value.message, id: 'child-2' }] } } };
  assert.equal(provider.parse(album)?.attachments.length, 2);
  assert.equal(provider.parse({ ...album, message: { ...album.message, content: { ...album.message.content, items: [{ ...value.message, sender: { id: '+12025550000', platform: 'iMessage' } }] } } }), null);
  assert.equal(provider.parse({ ...value, message: { ...value.message, content: { ...value.message.content, size: PHOTON_FILE_LIMIT + 1 } } }), null);
});

test('Photon fetches authorized attachment bytes to private local files while preserving persisted references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-media-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const requests: string[] = [], bytes = Buffer.from('%PDF-test');
  const provider = createPhotonProvider(config({ dataDir: directory }), async () => ({ id: 'unused' }), async input => { requests.push(input.attachmentId); assert.equal(input.line, line); return bytes; });
  const original = provider.parse(mediaFixture())!;
  const prepared = await provider.prepareInbound!(original);
  assert.deepEqual(requests, ['provider-file-1']);
  assert.equal(original.attachments[0]?.localPath, undefined);
  assert.equal(prepared.attachments[0]?.url, original.attachments[0]?.url);
  const path = prepared.attachments[0]!.localPath!;
  assert.ok(path.startsWith(join(directory, 'attachments') + '/'));
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(path, '..'))).mode & 0o777, 0o700);
  await assert.rejects(provider.prepareInbound!({ ...original, sender: '+12025550000' }), /not authorized/);
  assert.equal(requests.length, 1);
});

test('Photon cleans partial downloads after byte-budget failures and rejects linked attachment directories', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-limits-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const provider = createPhotonProvider(config({ dataDir: directory }), async () => ({ id: 'unused' }), async () => Buffer.alloc(PHOTON_FILE_LIMIT + 1));
  await assert.rejects(provider.prepareInbound!(provider.parse(mediaFixture())!), /size limit/);
  assert.deepEqual(await readdir(join(directory, 'attachments')), []);
  await rm(join(directory, 'attachments'), { recursive: true });
  const elsewhere = join(directory, 'other'); await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, join(directory, 'attachments'));
  await assert.rejects(provider.prepareInbound!(provider.parse(mediaFixture())!), /private and real/);
  assert.deepEqual(await readdir(elsewhere), []);
});

test('Photon sends only bounded artifacts inside explicit directory and passes bytes to SDK', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-output-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const artifacts = join(directory, 'artifacts'); await mkdir(artifacts, { mode: 0o700 });
  const path = join(artifacts, 'report.pdf'), bytes = Buffer.from('%PDF-test'); await writeFile(path, bytes);
  const requests: PhotonSendInput[] = [];
  const provider = createPhotonProvider(config({ artifactsDir: artifacts }), async input => { requests.push(input); return { id: 'media-out-1' }; });
  const message = provider.parse(fixture())!;
  assert.deepEqual(await provider.sendMedia!(message, { path }, 'job:file:0'), { id: 'media-out-1' });
  assert.equal(requests[0]?.conversationId, message.conversationId); assert.equal(requests[0]?.line, line);
  assert.deepEqual(requests[0]?.media, { base64: bytes.toString('base64'), name: 'report.pdf', mimeType: 'application/pdf', id: 'job:file:0' });
  assert.equal(JSON.stringify(requests[0]).includes(path), false);
  await assert.rejects(provider.sendMedia!({ ...message, sender: '+12025550000' }, { path }, 'job:file:1'), /not authorized/);
  await assert.rejects(provider.sendMedia!(message, { path, name: '../secret.pdf' }, 'job:file:1'), /filename/);
  await assert.rejects(provider.sendMedia!(message, { path, mimeType: 'text/plain' }, 'job:file:1'), /file type/);
  assert.equal(requests.length, 1);
});

test('Photon media rejects outside files, symlinks, hardlinks, hidden files and unsupported extensions before SDK', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-paths-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const artifacts = join(directory, 'artifacts'); await mkdir(artifacts, { mode: 0o700 });
  const outside = join(directory, 'secret.pdf'); await writeFile(outside, 'private test content');
  await symlink(outside, join(artifacts, 'linked.pdf')); await link(outside, join(artifacts, 'hardlink.pdf'));
  await symlink(directory, join(artifacts, 'linked-directory'));
  await writeFile(join(artifacts, '.hidden.pdf'), 'private test content');
  await mkdir(join(artifacts, '.private')); await writeFile(join(artifacts, '.private', 'nested.pdf'), 'private test content');
  await writeFile(join(artifacts, 'execute.sh'), 'test shell');
  let sends = 0;
  const provider = createPhotonProvider(config({ artifactsDir: artifacts }), async () => { sends++; return { id: 'unused' }; });
  const message = provider.parse(fixture())!;
  for (const path of [outside, join(artifacts, 'linked.pdf'), join(artifacts, 'hardlink.pdf'), join(artifacts, 'linked-directory', 'secret.pdf'), join(artifacts, '.hidden.pdf'), join(artifacts, '.private', 'nested.pdf'), join(artifacts, 'execute.sh')]) await assert.rejects(provider.sendMedia!(message, { path }, 'job:file:0'));
  await assert.rejects(createPhotonProvider(config()).sendMedia!(message, { path: outside }, 'job:file:0'), /explicit artifacts/);
  assert.equal(sends, 0);
});

test('actual Spectrum12 attachment builder preserves binary bytes, MIME, name and stable attachment ID offline', async () => {
  const { attachment, resolveContents } = await import('@spectrum-ts/core');
  const bytes = Buffer.from([0, 1, 2, 255]);
  const [content] = await resolveContents([attachment(bytes, { name: 'report.pdf', mimeType: 'application/pdf', id: 'job:file:0' })]);
  assert.equal(content?.type, 'attachment');
  if (content?.type !== 'attachment') assert.fail('Expected attachment content');
  assert.equal(content.name, 'report.pdf'); assert.equal(content.mimeType, 'application/pdf'); assert.equal(content.id, 'job:file:0');
  assert.deepEqual(await content.read(), bytes);
  const reader = (await content.stream()).getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value as Uint8Array), bytes);
  await reader.cancel(); reader.releaseLock();
});

test('Photon aggregate attachment budget cleans all files after exceeding 40 MiB', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-total-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(PHOTON_FILE_LIMIT);
  const provider = createPhotonProvider(config({ dataDir: directory }), async () => ({ id: 'unused' }), async () => bytes);
  const message = provider.parse(mediaFixture())!;
  message.attachments = [message.attachments[0]!, message.attachments[0]!, message.attachments[0]!];
  await assert.rejects(provider.prepareInbound!(message), /size limit/);
  assert.deepEqual(await readdir(join(directory, 'attachments')), []);
});

test('Photon HTTP attachment reaches agent as a local file and final artifact is delivered once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-imessage-photon-flow-'));
  const artifactsDir = join(directory, 'artifacts'); await mkdir(artifactsDir, { mode: 0o700 });
  const c = config({ artifactsDir, dataDir: join(directory, 'data'), cwd: join(directory, 'workspace') });
  const incomingBytes = Buffer.from('%PDF synthetic inbound'), outgoingBytes = Buffer.from('synthetic generated image');
  let downloads = 0, invocations = 0; const sends: PhotonSendInput[] = [];
  const provider = createPhotonProvider(c, async input => { sends.push(input); return { id: `out-${sends.length}` }; }, async () => { downloads++; return incomingBytes; }, async () => {});
  const bridge = new Bridge({ config: c, provider, log: () => {}, agent: { close: async () => {}, run: async input => {
    invocations++;
    const path = /"localPath":"([^"]+)"/.exec(input.text)?.[1];
    assert.ok(path, 'prepared local path must be in agent input');
    assert.deepEqual(await readFile(path), incomingBytes);
    const generated = join(artifactsDir, 'result.png'); await writeFile(generated, outgoingBytes);
    input.onThread('thread-media');
    return { threadId: 'thread-media', text: `Result: ![generated image](${generated})` };
  } } });
  await bridge.start();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const post = async () => {
    const raw = Buffer.from(JSON.stringify(mediaFixture()));
    const result = await fetch(`http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}/webhooks/photon`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(raw) }, body: raw });
    return result.json();
  };
  assert.deepEqual(await post(), { status: 'queued' });
  const deadline = Date.now() + 3000;
  while (bridge.store.stats().sent !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bridge.store.stats().sent, 1);
  assert.equal(invocations, 1); assert.equal(downloads, 1); assert.equal(sends.length, 2);
  assert.equal(sends[0]?.media, undefined);
  assert.equal(sends[1]?.media?.base64, outgoingBytes.toString('base64'));
  assert.equal(sends[1]?.media?.mimeType, 'image/png');
  assert.deepEqual(await post(), { status: 'duplicate' });
  assert.equal(downloads, 1); assert.equal(invocations, 1); assert.equal(sends.length, 2);
});

const richInput = (effect: PhotonRichInput['effect']): PhotonRichInput => ({ projectId: 'test-project', projectSecret: 'private-test-marker', conversationId: `any;-;${owner}`, line, sender: owner, messageId: 'p:1/native-GUID-preserved', effect });

test('Photon rich hooks retain approved original target and forward cancellation without sending ordinary messages', async () => {
  const requests: PhotonRichInput[] = [], signals: (AbortSignal | undefined)[] = [];
  const controller = new AbortController(); let sends = 0;
  const provider = createPhotonProvider(config(), async () => { sends++; return { id: 'unused' }; }, undefined, async (input, signal) => { requests.push(input); signals.push(signal); });
  const message = provider.parse(fixture())!;
  await provider.setTyping!(message, true, controller.signal);
  await provider.setTyping!(message, false, controller.signal);
  for (const status of ['working', 'done', 'failed'] as const) await provider.react!(message, status, controller.signal);
  assert.equal(provider.typingRefreshMs, 20000);
  assert.deepEqual(requests.map(input => input.effect), [{ type: 'typing', active: true }, { type: 'typing', active: false }, { type: 'reaction', reaction: 'working' }, { type: 'reaction', reaction: 'done' }, { type: 'reaction', reaction: 'failed' }]);
  assert.ok(requests.every(input => input.messageId === message.messageId && input.conversationId === message.conversationId && input.line === line && input.sender === owner));
  assert.ok(signals.every(signal => signal === controller.signal)); assert.equal(sends, 0);
});

test('Photon optional effects reject unauthorized senders, groups, routing and unknown status before SDK', async () => {
  let effects = 0;
  const provider = createPhotonProvider(config(), undefined, undefined, async () => { effects++; });
  const original = provider.parse(fixture())!;
  for (const change of [{ sender: '+12025550000' }, { recipient: '+12025550000' }, { isGroup: true }, { messageId: '' }, { conversationId: '' }]) {
    await assert.rejects(provider.setTyping!({ ...original, ...change }, true), /not authorized/);
    await assert.rejects(provider.react!({ ...original, ...change }, 'working'), /not authorized/);
  }
  await assert.rejects(provider.react!(original, '__proto__' as 'working'), /not authorized/);
  await assert.rejects(provider.setTyping!(original, 'true' as unknown as boolean), /not authorized/);
  assert.equal(effects, 0);
});

test('Photon native rich actions use documented typing methods and preserve full reaction target metadata', async () => {
  const actions: string[] = [], lookups: string[] = [], input = richInput({ type: 'reaction', reaction: 'working' });
  const space = { id: input.conversationId, type: 'dm', phone: line, startTyping: async () => { actions.push('start'); }, stopTyping: async () => { actions.push('stop'); }, getMessage: async (id: string) => { lookups.push(id); return target; } };
  const target = { id: input.messageId, parentId: 'native-GUID-preserved', partIndex: 1, platform: 'imessage', direction: 'inbound', sender: { id: owner, service: 'iMessage' }, content: { type: 'attachment' }, space,
    async react(this: unknown, emoji: string) { assert.equal(this, target); assert.equal(target.parentId, 'native-GUID-preserved'); assert.equal(target.partIndex, 1); actions.push(emoji); return { id: 'reaction-accepted' }; },
  };
  await applyPhotonRich(space, { ...input, effect: { type: 'typing', active: true } });
  await applyPhotonRich(space, { ...input, effect: { type: 'typing', active: false } });
  assert.deepEqual(lookups, []);
  for (const reaction of ['working', 'done', 'failed'] as const) await applyPhotonRich(space, { ...input, effect: { type: 'reaction', reaction } });
  assert.deepEqual(actions, ['start', 'stop', '‼️', '👍', '❓']);
  assert.deepEqual(lookups, [input.messageId, input.messageId, input.messageId]);
});

test('Photon reaction lookup fails closed on absent/mismatched targets and never reacts to a reaction', async () => {
  let effects = 0;
  const input = richInput({ type: 'reaction', reaction: 'done' });
  const base = { id: input.messageId, platform: 'imessage', direction: 'inbound', sender: { id: owner, service: 'iMessage' }, space: { id: input.conversationId, phone: line, type: 'dm' }, content: { type: 'text' }, react: async () => { effects++; return { id: 'accepted' }; } };
  const invalid: unknown[] = [undefined, { ...base, id: 'another' }, { ...base, direction: 'outbound' }, { ...base, sender: { id: '+12025550000' } }, { ...base, sender: { id: owner, service: 'SMS' } }, { ...base, platform: 'whatsapp' }, { ...base, content: { type: 'reaction' } }, { ...base, space: { ...base.space, type: 'group' } }, { ...base, space: { ...base.space, phone: '+12025550000' } }, { ...base, space: { ...base.space, id: 'another' } }, { ...base, react: undefined }];
  for (const target of invalid) {
    const space = { ...base.space, startTyping: async () => { effects++; }, stopTyping: async () => { effects++; }, getMessage: async () => target };
    await assert.rejects(applyPhotonRich(space, input, () => { effects++; }), /target/);
  }
  assert.equal(effects, 0);
});

test('Photon unsupported reaction result is not guessed successful or retried', async () => {
  let calls = 0;
  const input = richInput({ type: 'reaction', reaction: 'working' });
  const space = { id: input.conversationId, type: 'dm', phone: line, startTyping: async () => {}, stopTyping: async () => {}, getMessage: async () => ({ id: input.messageId, platform: 'imessage', direction: 'inbound', sender: { id: owner }, space: { id: input.conversationId, type: 'dm', phone: line }, content: { type: 'text' }, react: async () => { calls++; return undefined; } }) };
  await assert.rejects(applyPhotonRich(space, input), error => error instanceof PhotonSendError && error.ambiguous);
  assert.equal(calls, 1);
});

test('Photon native aliases and typing content match installed Spectrum12 offline builders', async () => {
  const { Emoji, typing, resolveContents } = await import('@spectrum-ts/core');
  assert.deepEqual(PHOTON_REACTIONS, { working: Emoji.emphasize, done: Emoji.like, failed: Emoji.question, like: Emoji.like, love: Emoji.love, laugh: Emoji.laugh, emphasize: Emoji.emphasize, question: Emoji.question, dislike: Emoji.dislike });
  const contents = await resolveContents([typing(), typing('stop')]);
  assert.deepEqual(contents.map(content => content.type === 'typing' ? content.state : 'wrong'), ['start', 'stop']);
});

test('Photon rich worker cancellation aborts before credentials or actions and sanitizes invalid input', { timeout: 1500 }, async () => {
  const pre = new AbortController(); pre.abort();
  await assert.rejects(richPhotonViaSdk(richInput({ type: 'typing', active: true }), pre.signal), error => error instanceof PhotonSendError && !error.ambiguous && !error.message.includes('private-test-marker'));
  const controller = new AbortController();
  // Abort synchronously after spawn, before the child can import the SDK or connect.
  const active = richPhotonViaSdk(richInput({ type: 'typing', active: true }), controller.signal);
  controller.abort();
  await assert.rejects(active, error => error instanceof PhotonSendError && /cancelled/.test(error.message) && !error.message.includes('private-test-marker'));
  await assert.rejects(richPhotonViaSdk({ ...richInput({ type: 'reaction', reaction: 'done' }), projectId: '' }), error => error instanceof PhotonSendError && !error.ambiguous && !error.message.includes('private-test-marker'));
});

test('Photon conversational native reactions are optional explicit scoped calls with no automatic phase emissions', async () => {
  const requests: PhotonRichInput[] = [];
  const provider = createPhotonProvider(config(), async () => ({ id: 'ordinary-reply' }), undefined, async input => { requests.push(input); });
  const message = provider.parse(fixture())!;
  await provider.send(message, 'Ordinary reply without a reaction', 'job:0');
  assert.equal(requests.length, 0);
  for (const reaction of ['like', 'love', 'laugh', 'emphasize', 'question', 'dislike'] as const) await provider.react!(message, reaction);
  assert.deepEqual(requests.map(input => input.effect), ['like', 'love', 'laugh', 'emphasize', 'question', 'dislike'].map(reaction => ({ type: 'reaction', reaction })));
  assert.ok(requests.every(input => input.messageId === message.messageId && input.sender === owner && input.line === line && input.conversationId === message.conversationId));
  for (const unsupported of ['😀', 'heart', 'LAUGH', '__proto__']) await assert.rejects(provider.react!(message, unsupported as 'laugh'), /not authorized/);
  assert.equal(requests.length, 6);
});

test('Photon conversational reaction kinds call exactly their native aliases on the original SDK target', async () => {
  const emojis: string[] = [], input = richInput({ type: 'reaction', reaction: 'laugh' });
  const space = { id: input.conversationId, type: 'dm', phone: line, startTyping: async () => {}, stopTyping: async () => {}, getMessage: async () => ({ id: input.messageId, platform: 'imessage', direction: 'inbound', sender: { id: owner }, space: { id: input.conversationId, type: 'dm', phone: line }, content: { type: 'text' }, react: async (emoji: string) => { emojis.push(emoji); return { id: 'reaction-accepted' }; } }) };
  for (const reaction of ['like', 'love', 'laugh', 'emphasize', 'question', 'dislike'] as const) await applyPhotonRich(space, { ...input, effect: { type: 'reaction', reaction } });
  assert.deepEqual(emojis, ['👍', '❤️', '😂', '‼️', '❓', '👎']);
});

// Anonymized shape of a live SDK message: one attachment plus a caption,
// represented as two inbound children under a single parent message ID.
function captionAlbum(): any {
  const event = fixture();
  const child = (part: number, content: unknown) => ({ ...event.message, id: `p:${part}/synthetic-parent`, content });
  return { ...event, message: { ...event.message, content: { type: 'group', items: [
    child(0, { type: 'attachment', id: 'synthetic-pdf', name: 'sample.pdf', mimeType: 'application/pdf', size: 1367 }),
    child(1, { type: 'text', text: 'Read this PDF.' }),
  ] } } };
}

test('Photon accepts mixed PDF/caption multipart messages and collects caption text in order', () => {
  const event = captionAlbum(), adapter = createPhotonProvider(config());
  event.message.content.items.unshift({ ...event.message.content.items[1], id: 'p:2/synthetic-parent', content: { type: 'text', text: 'First instruction.' } });
  const parsed = adapter.parse(event)!;
  assert.equal(parsed.messageId, event.message.id);
  assert.equal(parsed.text, 'First instruction.\nRead this PDF.');
  assert.deepEqual(parsed.attachments, [{ url: 'photon-attachment:synthetic-pdf', name: 'sample.pdf', mimeType: 'application/pdf' }]);
});

test('Photon captions enforce aggregate text length including separators and original album bounds', () => {
  const adapter = createPhotonProvider(config({ maxTextChars: 8 }));
  const event = captionAlbum();event.message.content.items[1].content.text = '1234';
  event.message.content.items.push({ ...event.message.content.items[1], id: 'p:2/synthetic-parent', content: { type: 'text', text: '567' } });
  assert.equal(adapter.parse(event)?.text, '1234\n567');
  event.message.content.items[2].content.text = '5678';assert.equal(adapter.parse(event), null);
  const tooMany = captionAlbum();tooMany.message.content.items = Array.from({ length: 11 }, () => tooMany.message.content.items[0]);assert.equal(adapter.parse(tooMany), null);
  const oversizedFile = captionAlbum();oversizedFile.message.content.items[0].content.size = PHOTON_FILE_LIMIT + 1;assert.equal(adapter.parse(oversizedFile), null);
});

test('Photon mixed albums reject unsupported or untrusted children and unverified text-only groups', () => {
  const adapter = createPhotonProvider(config());
  const changes: ((event: any) => void)[] = [
    e => e.message.content.items[1].sender = { id: '+12025550000', platform: 'iMessage' },
    e => e.message.content.items[1].platform = 'SMS',
    e => e.message.content.items[1].sender = { id: owner, platform: 'whatsapp' },
    e => e.message.content.items[1].sender = { id: owner, platform: 'iMessage', service: 'SMS' },
    e => e.message.content.items[1].direction = 'outbound',
    e => e.message.content.items[1].id = '',
    e => e.message.content.items[1].content = { type: 'reaction', emoji: '👍' },
    e => e.message.content.items[1].content = { type: 'group', items: [] },
    e => e.message.content.items[1].content = { type: 'text', text: '   ' },
    e => e.message.content.items.shift(),
  ];
  for (const change of changes) { const event = captionAlbum();change(event);assert.equal(adapter.parse(event), null); }
});


// This preload replaces only the two SDK imports. Synthetic operations never open a provider session.
async function timingHarness(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-photon-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loader = join(directory, 'loader.mjs'), runner = join(directory, 'runner.mjs');
  const fakeSdk = `
    import { writeSync } from 'node:fs';
    const pause=()=>new Promise(resolve=>setTimeout(resolve,5));
    const mode=process.env.FIXTURE_MODE;
    const marker='private-sdk-content-token-path-marker';
    export async function Spectrum(options) {
      if(options.telemetry!==false || options.options.logLevel!=='silent')throw Error(marker);
      console.error(marker);
      if(mode==='malformed')writeSync(3,JSON.stringify({phase:'initMs',durationMs:12,secret:marker})+'\\n');
      if(mode==='oversized')writeSync(3,marker.repeat(200));
      await pause();
      return {stop:async()=>{await pause();if(mode==='shutdownfail')throw Error(marker);}};
    }
    export const attachment=(bytes,metadata)=>({bytes,metadata});
    export function imessage() { return {
      getAttachment:async()=>{await pause();return {size:3,stream:async()=>new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}})};},
      space:{get:async(id,options)=>{
        await pause();if(mode==='lookupfail')throw Error(marker);
        const space={id,type:'dm',phone:options.phone,
          send:async()=>{await pause();if(mode==='uncertain')throw Error(marker);return {id:'fixture-accepted'};},
          startTyping:pause,stopTyping:pause,
          getMessage:async messageId=>({id:messageId,direction:'inbound',platform:'iMessage',sender:{id:'+12025559876'},content:{type:'text'},space,
            react:async()=>{await pause();return {id:'fixture-reaction'};}})};
        return space;
      }}
    };}
    imessage.config=()=>({});
  `;
  await writeFile(loader, `import {registerHooks} from 'node:module';
const replacement=${JSON.stringify('data:text/javascript,' + encodeURIComponent(fakeSdk))};
registerHooks({resolve(specifier,context,next){if(['@spectrum-ts/core','@spectrum-ts/imessage'].includes(specifier))return {url:replacement,shortCircuit:true};return next(specifier,context);}});
`);
  const source = new URL('../src/photon.js', import.meta.url).href;
  await writeFile(runner, `
    import {sendPhotonViaSdk,fetchPhotonViaSdk,richPhotonViaSdk} from ${JSON.stringify(source)};
    const mode=process.env.FIXTURE_MODE,metrics=[];
    const observe=mode==='disabled'?null:value=>{metrics.push(value);if(mode==='throwcallback')throw Error('private-callback-error');if(mode==='asynccallback')return Promise.reject(Error('private-async-callback-error'));};
    const input={projectId:'private-project-marker',projectSecret:'private-secret-marker',conversationId:'private-conversation-marker',line:'+12025551234',text:'private-body-marker'};
    try {
      if(mode==='fetch')await fetchPhotonViaSdk({...input,attachmentId:'private-file-marker'},observe);
      else if(['typing-start','typing-stop','reaction'].includes(mode))await richPhotonViaSdk({...input,sender:'+12025559876',messageId:'private-message-marker',effect:mode==='reaction'?{type:'reaction',reaction:'like'}:{type:'typing',active:mode==='typing-start'}},undefined,observe);
      else await sendPhotonViaSdk({...input,...(mode==='media'?{text:'',media:{base64:'AQID',name:'private-file.png',mimeType:'image/png',id:'private-media-marker'}}:{})},observe);
      process.stdout.write(JSON.stringify({ok:true,metrics}));
    } catch(error) {process.stdout.write(JSON.stringify({ok:false,ambiguous:error.ambiguous,metrics}));}
  `);
  return async (mode: string) => {
    const result = await promisify(execFile)(process.execPath, [runner], { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(loader).href}`, FIXTURE_MODE: mode }, timeout: 5000, maxBuffer: 10000 });
    assert.equal(result.stderr, '');
    assert.equal(/private-|1202555|fixture-accepted/.test(result.stdout), false);
    return JSON.parse(result.stdout) as { ok: boolean; ambiguous?: boolean; metrics: PhotonTiming[] };
  };
}

test('Photon timings measure isolated phases and operation kinds without changing acceptance or leaking SDK data', async t => {
  const run = await timingHarness(t);
  for (const mode of ['text', 'media', 'fetch', 'typing-start', 'typing-stop', 'reaction']) {
    const result = await run(mode);
    assert.equal(result.ok, true);assert.equal(result.metrics.length, 1);
    const metric = result.metrics[0]!;
    assert.equal(metric.operationKind, mode);assert.equal(metric.outcome, 'success');
    assert.deepEqual(Object.keys(metric).sort(), ['operationKind','outcome','totalMs','sdkImportMs','initMs','operationMs','shutdownMs',...(mode==='fetch'?[]:['spaceLookupMs'])].sort());
    for (const [key,value] of Object.entries(metric)) if(key.endsWith('Ms'))assert.ok(Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=120000);
    assert.ok(metric.initMs! >= 1);assert.ok(metric.operationMs! >= 1);assert.ok(metric.shutdownMs! >= 1);
  }
});

test('disabled, throwing and malformed Photon metrics never change a provider result or stdout protocol', async t => {
  const run = await timingHarness(t);
  for (const mode of ['disabled','throwcallback','asynccallback','malformed','oversized']) {
    const result = await run(mode);assert.equal(result.ok,true);
    assert.equal(result.metrics.length,mode==='disabled'?0:1);
    if(mode!=='disabled')assert.equal(result.metrics[0]!.outcome,'success');
  }
  for (const [mode,ambiguous] of [['lookupfail',false],['uncertain',true],['shutdownfail',true]] as const) {
    const result=await run(mode);assert.equal(result.ok,false);assert.equal(result.ambiguous,ambiguous);
    assert.equal(result.metrics[0]!.outcome,ambiguous?'uncertain':'failed');
  }
});

test('Photon timing parser bounds frames and only reports finite allowlisted phase durations', () => {
  const metrics: PhotonTiming[]=[];
  const recorder=createPhotonTimingRecorder('text',value=>{metrics.push(value);});
  recorder.accept(Buffer.from('{"phase":"sdkImportMs","durationMs":1.6}\n{"phase":"initMs","durationMs":-1}\n{"phase":"operationMs","durationMs":1e999}\n{"phase":"shutdownMs","durationMs":3,"secret":"private-marker"}\n{"phase":"spaceLookupMs","durationMs":120001}\n'));
  recorder.accept(Buffer.from('{"phase":"operationMs","durationMs":4}\n'));
  recorder.finish('success');recorder.finish('uncertain');
  assert.equal(metrics.length,1);assert.equal(metrics[0]!.sdkImportMs,2);
  assert.deepEqual(Object.keys(metrics[0]!).sort(),['operationKind','outcome','sdkImportMs','totalMs']);
  const oversized=createPhotonTimingRecorder('fetch',value=>{metrics.push(value);});
  oversized.accept(Buffer.alloc(2049,65));oversized.accept(Buffer.from('{"phase":"initMs","durationMs":4}\n'));oversized.finish('failed');
  assert.deepEqual(Object.keys(metrics[1]!).sort(),['operationKind','outcome','totalMs']);
  assert.equal(JSON.stringify(metrics).includes('private-marker'),false);
});

test('Photon timing cancellation preserves preflight failure and in-flight uncertainty', async () => {
  const pre=new AbortController();pre.abort();const metrics: PhotonTiming[]=[];
  await assert.rejects(richPhotonViaSdk(richInput({type:'typing',active:true}),pre.signal,value=>{metrics.push(value);}),error=>error instanceof PhotonSendError&&!error.ambiguous);
  assert.equal(metrics[0]!.outcome,'failed');
  const active=new AbortController();
  const pending=richPhotonViaSdk(richInput({type:'typing',active:false}),active.signal,value=>{metrics.push(value);throw Error('private-callback-error');});active.abort();
  await assert.rejects(pending,error=>error instanceof PhotonSendError&&error.ambiguous);
  assert.equal(metrics[1]!.outcome,'uncertain');assert.equal(metrics[1]!.operationKind,'typing-stop');
});
