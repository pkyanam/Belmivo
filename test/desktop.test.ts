import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBackend, DesktopError, applyDesktopPatches, validateDesktopSocket, createdTaskFromTurn } from '../src/desktop.js';
import { AgentStoppedError, type BridgeConfig } from '../src/types.js';
import { getEventListeners } from 'node:events';

const thread = '11111111-1111-4111-8111-111111111111';
const freshThread = '22222222-2222-4222-8222-222222222222';
type Options = { provisionalStatus?: 'inProgress' | 'completed'; onStart?: () => void; lateStartId?: boolean; stopStatus?: string; stopReceiptOnly?: boolean; stopDisconnect?: boolean; foreignStop?: boolean; terminalStatus?: string; mediated?: boolean; mediatedMissingTool?: boolean; version?: number; revisionGap?: boolean; disconnect?: boolean; busy?: boolean; slow?: boolean; malformed?: boolean; fresh?: boolean; freshRunning?: boolean; createDisconnect?: boolean; schemaMismatch?: boolean; fullAccess?: boolean; sourceProfileId?: string | null; freshFullAccess?: boolean; rejectSelection?: boolean; ownerUnavailable?: boolean; ownerProtocolMismatch?: boolean; noSnapshot?: boolean; freshNoSnapshot?: boolean; freshExtraTurn?: boolean; onCreate?: () => void };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-imessage-desktop-'));
  const path = join(dir, 'ipc.sock');
  const requests: any[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const toolsPath = join(dir, 'tools.sock');
  let selectedBuiltinForCreation = false;
  const sourceProfileId = options.sourceProfileId === undefined ? ':danger-full-access' : options.sourceProfileId;
  const toolRequests: any[] = [];
  const toolsServer = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32LE(0) + 4) return;
      const request = JSON.parse(buffer.subarray(4, buffer.readUInt32LE(0) + 4).toString()); toolRequests.push(request);
      if (request.method === 'tools/call') options.onCreate?.();
      if (options.createDisconnect && request.method === 'tools/call') { socket.destroy(); return; }
      const result = request.method === 'tools/list' ? { tools: options.schemaMismatch ? [] : [{ namespace: 'codex_app', name: 'create_thread', inputSchema: {
        type: 'object', required: ['prompt', 'target'], properties: { prompt: { type: 'string' }, target: { anyOf: [{ properties: { type: { enum: ['projectless'] } } }] } },
      } }] } : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ hostId: 'local', threadId: freshThread }) }] };
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
    });
  });
  await new Promise<void>(resolve => toolsServer.listen(toolsPath, resolve)); await chmod(toolsPath, 0o600);
  const server = createServer(socket => {
    let selectedThread = thread;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const send = (message: any) => {
      const data = Buffer.from(JSON.stringify(message)), frame = Buffer.alloc(4 + data.length);
      frame.writeUInt32LE(data.length); data.copy(frame, 4);
      // Split the header to exercise partial reads.
      socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2));
    };
    const broadcast = (change: any, version = options.version ?? 11, conversationId = selectedThread) => send({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', targetClientIds: ['bridge'], version, params: { hostId: 'local', conversationId, change } });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
        requests.push(request);
        const reply = (result: any, owner = 'owner') => send({ type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, handledByClientId: owner, result });
        if (request.method === 'initialize') reply({ clientId: 'bridge' }, 'router');
        if (request.method === 'thread-owner-discovery') {
          selectedThread = request.params.conversationId;
          if (options.ownerUnavailable) send({ type: 'response', requestId: request.requestId, resultType: 'error', method: request.method, error: 'no-client-found: private fixture details must not escape' });
          else reply({ supportsUntrustedAppInput: !options.ownerProtocolMismatch });
        }
        if (request.method === 'thread-stream-following-changed' && request.params.following) {
          if (options.noSnapshot || (options.freshNoSnapshot && selectedThread === freshThread)) continue;
          if (options.malformed) { socket.write(Buffer.alloc(4)); continue; }
          const first = { turnId: 'first-created-turn', status: options.freshRunning ? 'inProgress' : 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'FRESH_DESKTOP_OK' }] };
          const entitiesByKey = options.fresh && selectedThread === freshThread ? { first, ...(options.freshExtraTurn ? { unexpected: { ...first, turnId: 'extra' } } : {}) } : {};
          const child = selectedThread === freshThread;
          // Model the app's cross-workspace inheritance: a named or absent source
          // profile needs explicit selection before the create_thread tool runs.
          const fullAccess = child ? (options.freshFullAccess ?? (!options.mediated || sourceProfileId === ':danger-full-access' || selectedBuiltinForCreation)) : options.fullAccess !== false;
          const profileId = child ? (fullAccess ? ':danger-full-access' : ':workspace') : sourceProfileId;
          broadcast({ type: 'snapshot', revision: 0, conversationState: { id: selectedThread, hostId: 'local', turns: [], threadRuntimeStatus: { type: options.busy ? 'active' : 'idle' }, currentPermissions: { approvalPolicy: fullAccess ? 'never' : 'on-request', sandboxPolicy: { type: fullAccess ? 'dangerFullAccess' : 'workspaceWrite' }, ...(profileId ? { activePermissionProfile: { id: profileId, extends: null } } : {}) }, turnHistory: { kind: 'canonical', history: { entitiesByKey } } } });
          if (options.freshRunning && selectedThread === freshThread) timers.add(setTimeout(() => broadcast({ type: 'patches', baseRevision: 0, revision: 1, patches: [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'first', 'status'], value: 'completed' }] }), 20));
        }
        if (request.method === 'thread-follower-start-turn') {
          if (options.disconnect) { socket.destroy(); continue; }
          const params = request.params.turnStart.request;
          if (options.rejectSelection) { send({ type: 'response', requestId: request.requestId, resultType: 'error', method: request.method, handledByClientId: 'owner', error: 'fixture profile rejected' }); continue; }
          if (params.permissions === ':danger-full-access' && params.approvalPolicy === 'never') selectedBuiltinForCreation = true;
          options.onStart?.();
          if (options.provisionalStatus) broadcast({ type: 'snapshot', revision: 0, conversationState: {
            id: selectedThread, hostId: 'local', threadRuntimeStatus: { type: 'active' },
            currentPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
            turnHistory: { kind: 'canonical', history: { entitiesByKey: { provisional: { params, status: options.provisionalStatus, items: [{ type: 'agentMessage', phase: 'final_answer', text: 'UNCONFIRMED_PLACEHOLDER' }] } } } },
          } });
          const startReply = () => reply({ result: { turn: { id: 'our-turn', status: 'inProgress' } } });
          if (options.lateStartId) { timers.add(setTimeout(startReply, 20)); continue; }
          startReply();
          broadcast({ type: 'snapshot', revision: -100 }, 999, 'unrelated-private-task');
          broadcast({ type: 'patches', baseRevision: options.revisionGap ? 99 : 0, revision: options.revisionGap ? 100 : 1, patches: [{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'ours'], value: { turnId: 'our-turn', params, status: 'inProgress', items: [] } }] });
          if (options.revisionGap || options.stopStatus || options.stopReceiptOnly || options.stopDisconnect || options.foreignStop) continue;
          const timer = setTimeout(() => broadcast({ type: 'patches', baseRevision: 1, revision: 2, patches: [
            { op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey', 'ours', 'status'], value: options.terminalStatus ?? 'completed' },
            { op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'ours', 'items', 0], value: { type: 'agentMessage', id: 'comment', phase: 'commentary', text: 'working' } },
            { op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'ours', 'items', 1], value: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'DESKTOP_OK' } },
            ...(options.mediated && !options.mediatedMissingTool ? [{ op: 'add', path: ['turnHistory', 'history', 'entitiesByKey', 'ours', 'items', 2], value: {
              type: 'dynamicToolCall', namespace: 'codex_app', tool: 'create_thread', status: 'completed', success: true,
              arguments: JSON.parse(params.input[0].text.split('\n\n').at(-1)),
              contentItems: [{ type: 'inputText', text: JSON.stringify({ hostId: 'local', threadId: freshThread }) }],
            } }] : []),
          ] }), options.slow ? 1000 : 5); timers.add(timer);
        }
        if (request.method === 'thread-follower-interrupt-turn') {
          reply({ ok: true, interruptedTurnId: 'our-turn' });
          if (options.stopDisconnect) { socket.destroy(); continue; }
          const terminal = (status: string, id = 'our-turn', source = 'owner', revision = 5) => send({
            type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: source, targetClientIds: ['bridge'], version: 11,
            params: { hostId: 'local', conversationId: selectedThread, change: { type: 'snapshot', revision, conversationState: {
              id: selectedThread, hostId: 'local', threadRuntimeStatus: { type: 'idle' }, turns: [{ turnId: id, status, items: [] }],
              currentPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
            } } },
          });
          if (options.foreignStop) { terminal('interrupted', 'other-turn'); terminal('interrupted', 'our-turn', 'untrusted-owner'); }
          if (options.stopStatus) timers.add(setTimeout(() => terminal(options.stopStatus!, 'our-turn', 'owner', 6), 30));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  const config = { backend: 'desktop', desktopSocket: path, desktopThreadId: thread, desktopToolsSocket: toolsPath, desktopToolsNode: process.execPath, fullAccess: true, maxTextChars: 1000, turnTimeoutMs: 3000 } as BridgeConfig;
  if (options.mediated) delete config.desktopToolsSocket;
  const backend = new DesktopBackend(config);
  t.after(async () => { await backend.close(); for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.destroy(); await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => toolsServer.close(() => resolve()))]); await rm(dir, { recursive: true, force: true }); });
  return { backend, config, requests, toolRequests, dir, path, toolsPath, sockets };
}

test('desktop follows only dedicated task and applies versioned stream patches', async t => {
  const { backend, requests } = await fixture(t);
  const turns: string[] = [], threads: string[] = [];
  const result = await backend.run({ text: 'hello desktop', onThread: id => threads.push(id), onTurn: id => turns.push(id) });
  assert.deepEqual(result, { threadId: thread, text: 'DESKTOP_OK' });
  assert.deepEqual(turns, ['our-turn']); assert.deepEqual(threads, [thread]);
  const start = requests.find(request => request.method === 'thread-follower-start-turn');
  assert.equal(start.version, 2); assert.equal(start.targetClientId, 'owner');
  assert.equal(start.params.turnStart.request.threadId, thread);
  assert.equal(start.params.turnStart.request.permissions, undefined);
  assert.equal(start.params.turnStart.request.approvalPolicy, undefined);
  assert.deepEqual(start.params.turnStart.context, { inheritThreadSettings: true });
});

test('desktop rejects a malformed task ID before opening the socket', async t => {
  const { backend, requests } = await fixture(t);
  await assert.rejects(backend.run({ threadId: 'other-task', text: 'hello', onThread: () => {} }), /ID is invalid/);
  assert.equal(requests.length, 0);
});

test('desktop protocol version mismatch fails before turn submission', async t => {
  const { backend, requests } = await fixture(t, { version: 12 });
  await assert.rejects(backend.run({ text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && !error.outcomeUnknown && /protocol version changed/.test(error.message));
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('desktop revision gap after submission is an uncertain outcome', async t => {
  const { backend } = await fixture(t, { revisionGap: true });
  await assert.rejects(backend.run({ text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && error.outcomeUnknown);
});

test('desktop disconnect after submission does not trigger replay', async t => {
  const { backend, requests } = await fixture(t, { disconnect: true });
  await assert.rejects(backend.run({ text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && error.outcomeUnknown);
  assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

test('desktop refuses a busy app task without steering its existing turn', async t => {
  const { backend, requests } = await fixture(t, { busy: true });
  await assert.rejects(backend.run({ text: 'hello', onThread: () => {} }), /task is busy/);
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('desktop rejects insecure and symlink sockets', async t => {
  const { path, dir } = await fixture(t);
  await chmod(path, 0o666); await assert.rejects(validateDesktopSocket(path), /private socket/);
  await chmod(path, 0o600);
  const linked = join(dir, 'linked.sock'); await symlink(path, linked);
  await assert.rejects(validateDesktopSocket(linked), /private socket/);
  const plain = join(dir, 'plain'); await writeFile(plain, 'not a socket', { mode: 0o600 });
  await assert.rejects(validateDesktopSocket(plain), /private socket/);
});

test('desktop patches reject prototype pollution and invalid paths', () => {
  assert.throws(() => applyDesktopPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]), /Unsafe/);
  assert.throws(() => applyDesktopPatches({ items: [] }, [{ op: 'replace', path: ['items', 7], value: 'bad' }]), /Invalid desktop array/);
  assert.throws(() => applyDesktopPatches({}, [{ op: 'replace', path: ['missing'], value: 1 }]), /target is missing/);
  assert.equal(({} as any).polluted, undefined);
});


test('desktop rejects zero-length protocol frames before submitting a turn', async t => {
  const { backend, requests } = await fixture(t, { malformed: true });
  await assert.rejects(backend.run({ text: 'hello', onThread: () => {} }), /frame size/);
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('desktop cancellation targets only its confirmed turn ID', async t => {
  const { backend, requests } = await fixture(t, { slow: true });
  const abort = new AbortController();
  await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: () => abort.abort() }), error => error instanceof DesktopError && error.outcomeUnknown);
  const stop = requests.find(request => request.method === 'thread-follower-interrupt-turn');
  assert.equal(stop.version, 4);
  assert.equal(stop.params.expectedTurnId, 'our-turn');
  assert.equal(stop.params.conversationId, thread);
});

test('desktop new task uses app tool once, persists ID, and captures its already-submitted first turn', async t => {
  const { backend, requests, toolRequests } = await fixture(t, { fresh: true });
  const persisted: string[] = [], turns: string[] = [];
  const result = await backend.run({ newThread: true, threadId: thread, title: 'Fresh iMessage task', threadInstructions: 'Initial owner instructions.', text: 'Say hello.', onThread: id => persisted.push(id), onTurn: id => turns.push(id) });
  assert.deepEqual(result, { threadId: freshThread, text: 'FRESH_DESKTOP_OK' });
  assert.deepEqual(persisted, [freshThread]); assert.deepEqual(turns, ['first-created-turn']);
  const calls = toolRequests.filter(request => request.method === 'tools/call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.threadId, thread);
  assert.deepEqual(calls[0].params.arguments, { prompt: 'Initial owner instructions.\n\nSay hello.', title: 'Fresh iMessage task', target: { type: 'projectless' } });
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('desktop accepts a trusted registry-selected task after backend restart', async t => {
  const { backend, config, requests } = await fixture(t);
  await backend.close();
  const restarted = new DesktopBackend(config); t.after(() => restarted.close());
  const result = await restarted.run({ threadId: freshThread, threadInstructions: 'Initial instructions for the selected task.', text: 'continue', onThread: () => {} });
  assert.equal(result.threadId, freshThread);
  assert.equal(requests.find(request => request.method === 'thread-follower-start-turn').params.conversationId, freshThread);
  assert.equal(requests.find(request => request.method === 'thread-follower-start-turn').params.turnStart.request.input[0].text, 'Initial instructions for the selected task.\n\ncontinue');
});

test('desktop new task fails closed on changed tools schema and source permissions', async t => {
  const mismatch = await fixture(t, { schemaMismatch: true });
  await assert.rejects(mismatch.backend.run({ newThread: true, text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && !error.outcomeUnknown);
  assert.equal(mismatch.toolRequests.some(request => request.method === 'tools/call'), false);
  const permissions = await fixture(t, { fullAccess: false });
  await assert.rejects(permissions.backend.run({ newThread: true, text: 'hello', onThread: () => {} }), /Full Access/);
  assert.equal(permissions.toolRequests.length, 0);
});

test('desktop creation disconnect is uncertain and not retried', async t => {
  const { backend, toolRequests } = await fixture(t, { createDisconnect: true });
  await assert.rejects(backend.run({ newThread: true, text: 'hello', onThread: () => assert.fail('no ID returned') }), error => error instanceof DesktopError && error.outcomeUnknown);
  assert.equal(toolRequests.filter(request => request.method === 'tools/call').length, 1);
});

test('new desktop task persistence failure remains uncertain without an extra submission', async t => {
  const { backend, requests } = await fixture(t, { fresh: true });
  await assert.rejects(backend.run({ newThread: true, text: 'hello', onThread: () => { throw Error('disk failed'); } }), error => error instanceof DesktopError && error.outcomeUnknown);
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('new desktop task refuses unexpected history instead of capturing another turn', async t => {
  const { backend } = await fixture(t, { fresh: true, freshExtraTurn: true });
  await assert.rejects(backend.run({ newThread: true, text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && error.outcomeUnknown && /additional turns/.test(error.message));
});

test('desktop new task rejects unsafe app-tools socket without calling a tool', async t => {
  const { backend, toolsPath, toolRequests } = await fixture(t);
  await chmod(toolsPath, 0o666);
  await assert.rejects(backend.run({ newThread: true, text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && !error.outcomeUnknown);
  assert.equal(toolRequests.length, 0);
});

test('new desktop task waits for its first running turn without submitting another', async t => {
  const { backend, requests } = await fixture(t, { fresh: true, freshRunning: true, busy: true });
  assert.equal((await backend.run({ newThread: true, text: 'hello', onThread: () => {} })).text, 'FRESH_DESKTOP_OK');
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('cancellation during desktop creation is uncertain and cleans up its worker', async t => {
  const abort = new AbortController();
  const { backend, toolRequests } = await fixture(t, { onCreate: () => abort.abort() });
  await assert.rejects(backend.run({ newThread: true, text: 'hello', signal: abort.signal, onThread: () => {} }), error => error instanceof DesktopError && error.outcomeUnknown);
  await backend.close();
  assert.equal(toolRequests.filter(request => request.method === 'tools/call').length, 1);
});

test('background desktop creation uses authenticated app agent and captures only child reply', async t => {
  const { backend, toolRequests, requests } = await fixture(t, { mediated: true, fresh: true });
  const persisted: string[] = [], turns: string[] = [];
  const result = await backend.run({ newThread: true, title: 'Owner task', threadInstructions: 'Be concise.', text: 'Hello.', onThread: id => persisted.push(id), onTurn: id => turns.push(id) });
  assert.deepEqual(result, { threadId: freshThread, text: 'FRESH_DESKTOP_OK' });
  assert.deepEqual(persisted, [freshThread]); assert.deepEqual(turns, ['first-created-turn']);
  assert.equal(toolRequests.length, 0);
  const starts = requests.filter(request => request.method === 'thread-follower-start-turn');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.conversationId, thread);
  assert.equal(starts[0].params.turnStart.request.permissions, ':danger-full-access');
  assert.equal(starts[0].params.turnStart.request.approvalPolicy, 'never');
  assert.equal(starts[0].params.turnStart.request.sandboxPolicy, undefined);
  assert.match(starts[0].params.turnStart.request.input[0].text, /explicitly requested a NEW/);
});

for (const sourceProfileId of ['owner-named-profile', null]) test(`app-mediated creation selects built-in Full Access from ${sourceProfileId ?? 'missing profile'} before child inheritance`, async t => {
  const f = await fixture(t, { mediated: true, fresh: true, sourceProfileId });
  const ids: string[] = [];
  assert.equal((await f.backend.run({ newThread: true, text: 'Greet only.', onThread: id => ids.push(id) })).text, 'FRESH_DESKTOP_OK');
  assert.deepEqual(ids, [freshThread]);
  const starts = f.requests.filter(request => request.method === 'thread-follower-start-turn');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.conversationId, thread);
  assert.equal(starts[0].params.turnStart.request.permissions, ':danger-full-access');
  assert.equal(starts[0].params.turnStart.request.approvalPolicy, 'never');
  assert.equal(f.toolRequests.length, 0);
});

test('ordinary turn on a named Full Access profile keeps inheriting without selecting another profile', async t => {
  const f = await fixture(t, { sourceProfileId: 'owner-named-profile' });
  assert.equal((await f.backend.run({ text: 'Continue this task.', onThread: () => {} })).text, 'DESKTOP_OK');
  const starts = f.requests.filter(request => request.method === 'thread-follower-start-turn');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.turnStart.request.permissions, undefined);
  assert.equal(starts[0].params.turnStart.request.approvalPolicy, undefined);
  assert.deepEqual(starts[0].params.turnStart.context, { inheritThreadSettings: true });
  assert.equal(f.toolRequests.length, 0);
});

test('native creation rejects unproven profile inheritance before launching its worker', async t => {
  for (const sourceProfileId of ['owner-named-profile', null]) {
    const f = await fixture(t, { sourceProfileId });
    const marker = join(f.dir, 'worker-launched'), executable = join(f.dir, 'unexpected-worker.mjs');
    await writeFile(executable, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'launched'); process.stdout.write(JSON.stringify({event:'error',stage:'input'})+'\\n');\n`, { mode: 0o700 });
    f.config.desktopToolsNode = executable;
    await assert.rejects(f.backend.run({ newThread: true, text: 'Greet only.', onThread: () => assert.fail('No child should exist') }),
      error => error instanceof DesktopError && !error.outcomeUnknown && error.code === 'desktop-create-inheritance' && /Select Full Access in the app/.test(error.message));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(f.toolRequests.length, 0);
    assert.equal(f.requests.some(request => request.method === 'thread-follower-start-turn'), false);
  }
});

test('app-mediated selection still requires configured and effective source Full Access before submission', async t => {
  for (const disabled of ['configuration', 'effective']) {
    const f = await fixture(t, { mediated: true, sourceProfileId: 'owner-named-profile', fullAccess: disabled !== 'effective' });
    if (disabled === 'configuration') f.config.fullAccess = false;
    await assert.rejects(f.backend.run({ newThread: true, text: 'Greet only.', onThread: () => assert.fail('No child') }),
      error => error instanceof DesktopError && !error.outcomeUnknown && /Full Access/.test(error.message));
    assert.equal(f.requests.some(request => request.method === 'thread-follower-start-turn'), false);
    assert.equal(f.toolRequests.length, 0);
  }
});

for (const failure of ['rejected', 'disconnect']) test(`app-mediated selection ${failure} after submission is held without retry or fallback`, async t => {
  const f = await fixture(t, { mediated: true, sourceProfileId: 'owner-named-profile', rejectSelection: failure === 'rejected', disconnect: failure === 'disconnect' });
  await assert.rejects(f.backend.run({ newThread: true, text: 'Greet only.', onThread: () => assert.fail('No confirmed child') }),
    error => error instanceof DesktopError && error.outcomeUnknown);
  const starts = f.requests.filter(request => request.method === 'thread-follower-start-turn');
  assert.equal(starts.length, 1); assert.equal(starts[0].params.turnStart.request.permissions, ':danger-full-access');
  assert.equal(f.toolRequests.length, 0);
  assert.equal(f.requests.some(request => request.method === 'thread-owner-discovery' && request.params.conversationId === freshThread), false);
});

test('child permission mismatch remains uncertain and never submits a second child turn', async t => {
  for (const mediated of [true, false]) {
    const f = await fixture(t, { mediated, fresh: true, freshFullAccess: false });
    const ids: string[] = [];
    await assert.rejects(f.backend.run({ newThread: true, text: 'Greet only.', onThread: id => ids.push(id) }),
      error => error instanceof DesktopError && error.outcomeUnknown && /Full Access/.test(error.message));
    assert.deepEqual(ids, [freshThread]);
    const starts = f.requests.filter(request => request.method === 'thread-follower-start-turn');
    assert.equal(starts.length, mediated ? 1 : 0);
    assert.equal(starts.some(request => request.params.conversationId === freshThread), false);
  }
});

test('background creation cannot accept a model acknowledgment without a real app tool result', async t => {
  const { backend, requests } = await fixture(t, { mediated: true, mediatedMissingTool: true });
  await assert.rejects(backend.run({ newThread: true, text: 'hello', onThread: () => assert.fail('unverified task') }), error => error instanceof DesktopError && error.outcomeUnknown && error.code === 'desktop-create-tool-count');
  assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

test('task creation verifier rejects forged final IDs, duplicates, drift, failures and remote identities', () => {
  const expected = { prompt: 'Owner request', title: 'Title' };
  const call = { type: 'dynamicToolCall', namespace: 'codex_app', tool: 'create_thread', status: 'completed', success: true, arguments: { ...expected, target: { type: 'projectless' } }, contentItems: [{ type: 'inputText', text: JSON.stringify({ hostId: 'local', threadId: freshThread }) }] };
  assert.equal(createdTaskFromTurn({ items: [call] }, expected, thread), freshThread);
  for (const items of [
    [{ type: 'agentMessage', text: freshThread }], [call, call], [{ ...call, success: false }],
    [{ ...call, arguments: { ...call.arguments, prompt: 'Different prompt' } }],
    [{ ...call, arguments: { ...call.arguments, model: 'changed' } }],
    [{ ...call, contentItems: [{ type: 'inputText', text: JSON.stringify({ hostId: 'remote', threadId: freshThread }) }] }],
    [{ ...call, contentItems: [{ type: 'inputText', text: JSON.stringify({ hostId: 'local', threadId: thread }) }] }],
  ]) assert.throws(() => createdTaskFromTurn({ items }, expected, thread), error => error instanceof DesktopError && error.outcomeUnknown);
  const mcp = { ...call, type: 'mcpToolCall', namespace: undefined, server: 'codex_app', result: { content: [{ type: 'text', text: call.contentItems[0]!.text }] } };
  assert.equal(createdTaskFromTurn({ items: [mcp] }, expected, thread), freshThread);
  assert.throws(() => createdTaskFromTurn({ items: [{ ...mcp, result: { ...mcp.result, isError: true } }] }, expected, thread), /not confirmed/);
});

test('background creation leaves a busy anchor alone and does not mark unsubmitted work uncertain', async t => {
  const { backend, requests } = await fixture(t, { mediated: true, busy: true });
  await assert.rejects(backend.run({ newThread: true, text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && !error.outcomeUnknown && error.code === 'desktop-busy' && /busy/.test(error.message));
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('unloaded owner and unsupported owner protocol have distinct static pre-submission diagnostics', async t => {
  for (const option of ['ownerUnavailable', 'ownerProtocolMismatch'] as const) {
    const f = await fixture(t, { mediated: true, [option]: true });
    await assert.rejects(f.backend.run({ newThread: true, text: 'Greet only.', onThread: () => assert.fail('No child') }),
      error => error instanceof DesktopError && !error.outcomeUnknown &&
        error.code === (option === 'ownerUnavailable' ? 'desktop-owner-unavailable' : 'desktop-owner-protocol') && !error.message.includes('private fixture'));
    assert.equal(f.requests.some(request => request.method === 'thread-follower-start-turn'), false);
    assert.equal(f.toolRequests.length, 0);
  }
});

test('missing desktop socket has a static availability diagnostic without submitting work', async t => {
  const f = await fixture(t);f.config.desktopSocket = join(f.dir, 'absent.sock');
  await assert.rejects(f.backend.run({ text: 'hello', onThread: () => assert.fail('No task') }),
    error => error instanceof DesktopError && !error.outcomeUnknown && error.code === 'desktop-unavailable');
  assert.equal(f.requests.length, 0);
});

test('missing snapshot expires with a distinct pre-submission diagnostic', { timeout: 15000 }, async t => {
  const f = await fixture(t, { mediated: true, noSnapshot: true });
  await assert.rejects(f.backend.run({ newThread: true, text: 'hello', onThread: () => assert.fail('No child') }),
    error => error instanceof DesktopError && !error.outcomeUnknown && error.code === 'desktop-snapshot-timeout');
  assert.equal(f.requests.some(request => request.method === 'thread-follower-start-turn'), false);
  assert.equal(f.toolRequests.length, 0);
});

test('connection diagnostic after turn submission preserves uncertain outcome', async t => {
  const f = await fixture(t, { mediated: true, disconnect: true });
  await assert.rejects(f.backend.run({ newThread: true, text: 'hello', onThread: () => assert.fail('No confirmed child') }),
    error => error instanceof DesktopError && error.outcomeUnknown && error.code === 'desktop-unavailable');
  assert.equal(f.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

async function eventually(check: () => boolean, timeoutMs = 2500): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= end) assert.fail('Timed out waiting for bounded desktop fixture state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const follows = (requests: any[], following = true) => requests.filter(request => request.method === 'thread-stream-following-changed' && request.params.following === following);
function sendResidentEvent(socket: Socket, params: any, sourceClientId = 'owner', version = 1): void {
  const body = Buffer.from(JSON.stringify({ type: 'broadcast', method: 'thread-stream-following-status-requested', version, sourceClientId, targetClientIds: ['bridge'], params }));
  const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4); socket.write(frame);
}

test('desktop residency retains only anchor and selected task, evicts prior selection, and never starts work', async t => {
  const { backend, requests, sockets, toolRequests } = await fixture(t);
  backend.maintainThread(freshThread);
  await eventually(() => follows(requests).length === 2);
  assert.equal(sockets.size, 2);
  assert.deepEqual(new Set(follows(requests).map(request => request.params.conversationId)), new Set([thread, freshThread]));
  const third = '33333333-3333-4333-8333-333333333333';
  backend.maintainThread(third);
  await eventually(() => follows(requests).some(request => request.params.conversationId === third) && sockets.size === 2);
  await eventually(() => follows(requests, false).some(request => request.params.conversationId === freshThread));
  backend.maintainThread();
  await eventually(() => sockets.size === 1);
  assert.equal(requests.filter(request => request.method === 'initialize').every(request => request.params.clientType === 'codex-imessage'), true);
  assert.equal(requests.some(request => request.method.startsWith('thread-follower-')), false);
  assert.equal(toolRequests.length, 0);
  await backend.close(); await eventually(() => sockets.size === 0);
});

test('desktop residency is opt-in, repeated/invalid selection does not add followers, and normal run still works', async t => {
  const { backend, requests, sockets } = await fixture(t);
  assert.equal(requests.length, 0);
  backend.maintainThread('invalid'); assert.equal(requests.length, 0);
  backend.maintainThread(thread); await eventually(() => follows(requests).length === 1);
  backend.maintainThread(thread); backend.maintainThread('invalid');
  assert.deepEqual(await backend.run({ text: 'ordinary', onThread: () => {} }), { threadId: thread, text: 'DESKTOP_OK' });
  await eventually(() => sockets.size === 1);
  assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
  assert.equal(follows(requests).length, 2); // one persistent and one per-turn follower
});

test('desktop residency reconnects read-only after disconnect and close cancels pending retry', async t => {
  const { backend, requests, sockets } = await fixture(t);
  backend.maintainThread(); await eventually(() => follows(requests).length === 1);
  for (const socket of sockets) socket.destroy();
  await eventually(() => follows(requests).length === 2);
  assert.equal(requests.some(request => request.method.startsWith('thread-follower-')), false);
  for (const socket of sockets) socket.destroy();
  await eventually(() => sockets.size === 0);
  await backend.close(); const count = requests.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(requests.length, count);
  backend.maintainThread(freshThread); assert.equal(requests.length, count);
});

test('desktop residency unavailable owner uses backoff and can recover without a turn', async t => {
  const options: Options = { ownerUnavailable: true };
  const { backend, requests } = await fixture(t, options);
  backend.maintainThread();
  await eventually(() => requests.filter(request => request.method === 'thread-owner-discovery').length === 2);
  assert.equal(follows(requests).length, 0);
  const count = requests.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(requests.length, count); // second failure waits 2s, rather than busy-looping
  options.ownerUnavailable = false;
  await eventually(() => follows(requests).length === 1);
  assert.equal(requests.some(request => request.method.startsWith('thread-follower-')), false);
});

test('desktop residency closes connections rejected by Full Access or protocol checks', async t => {
  for (const options of [{ fullAccess: false }, { version: 12 }]) {
    const { backend, requests, sockets } = await fixture(t, options);
    backend.maintainThread();
    await eventually(() => follows(requests).length === 1 && sockets.size === 0);
    assert.equal(requests.some(request => request.method.startsWith('thread-follower-')), false);
    await backend.close();
  }
});

test('desktop residency close cancels in-progress snapshot wait without a later reconnect', async t => {
  const { backend, requests, sockets } = await fixture(t, { noSnapshot: true });
  backend.maintainThread(freshThread);
  await eventually(() => follows(requests).length === 2);
  await backend.close(); await eventually(() => sockets.size === 0);
  const count = requests.length;
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(requests.length, count);
});

test('desktop residency reasserts following only for exact scoped current-owner status request', async t => {
  const { backend, requests, sockets } = await fixture(t);
  backend.maintainThread(); await eventually(() => follows(requests).length === 1);
  const socket = [...sockets][0]!;
  sendResidentEvent(socket, { hostId: 'local', conversationId: freshThread }, 'owner', 999);
  sendResidentEvent(socket, { hostId: 'local', conversationId: thread }, 'untrusted-owner');
  sendResidentEvent(socket, { hostId: 'elsewhere', conversationId: thread });
  sendResidentEvent(socket, { hostId: 'local', conversationId: thread });
  await eventually(() => follows(requests).length === 2);
  assert.equal(requests.filter(request => request.method === 'initialize').length, 1);
  assert.equal(requests.some(request => request.method.startsWith('thread-follower-')), false);
});


test('desktop residency rapid valid-snapshot flaps back off to30s; stable uptime resets to1s', async t => {
  const { backend, requests, sockets } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  t.after(() => t.mock.timers.reset());
  const resident = () => (backend as any).residents.get(thread);
  const spin = async (check: () => boolean) => {
    for (let count = 0; count < 20_000 && !check(); count++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(check(), true, 'Fixture IPC did not settle');
  };
  backend.maintainThread();
  await spin(() => resident()?.connectedAt !== undefined);
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
    for (const socket of sockets) socket.destroy();
    await spin(() => resident()?.retry !== undefined);
    const count = follows(requests).length;
    t.mock.timers.tick(delay - 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(follows(requests).length, count);
    t.mock.timers.tick(1);
    await spin(() => resident()?.connectedAt !== undefined);
    assert.equal(follows(requests).length, count + 1);
  }
  t.mock.timers.tick(30_000); // connected long enough to reset only on the next failure
  for (const socket of sockets) socket.destroy();
  await spin(() => resident()?.retry !== undefined);
  const count = follows(requests).length;
  t.mock.timers.tick(999);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(follows(requests).length, count);
  t.mock.timers.tick(1);
  await spin(() => resident()?.connectedAt !== undefined);
  assert.equal(follows(requests).length, count + 1);
  await backend.close(); await spin(() => sockets.size === 0);
  t.mock.timers.tick(60_000);
  assert.equal(follows(requests).length, count + 1);
});

test('desktop residency releases an owner whose effective Full Access changes', async t => {
  const options: Options = {};
  const { backend, requests, sockets } = await fixture(t, options);
  backend.maintainThread(); await eventually(() => follows(requests).length === 1);
  options.fullAccess = false;
  sendResidentEvent([...sockets][0]!, { hostId: 'local', conversationId: thread });
  await eventually(() => follows(requests).length === 2 && sockets.size === 0);
  assert.equal(requests.some(request => request.method.startsWith('thread-follower-')), false);
  await backend.close();
});


test('desktop connection status is a content-free cached snapshot with no probe side effects', async t => {
  const { backend, requests } = await fixture(t);
  assert.deepEqual(backend.connectionStatus(), { expected: 0, connected: 0, diagnostic: 'connecting' });
  const returned = backend.connectionStatus(); returned.expected = 2;
  for (let index = 0; index < 100; index++) assert.deepEqual(backend.connectionStatus(), { expected: 0, connected: 0, diagnostic: 'connecting' });
  assert.equal(requests.length, 0);
  backend.maintainThread(freshThread);
  assert.deepEqual(backend.connectionStatus(), { expected: 2, connected: 0, diagnostic: 'connecting' });
  await eventually(() => backend.connectionStatus().connected === 2);
  assert.deepEqual(backend.connectionStatus(), { expected: 2, connected: 2 });
  const count = requests.length;
  for (let index = 0; index < 100; index++) assert.deepEqual(backend.connectionStatus(), { expected: 2, connected: 2 });
  assert.equal(requests.length, count);
  await backend.close();
  assert.deepEqual(backend.connectionStatus(), { expected: 0, connected: 0, diagnostic: 'closed' });
});

test('desktop connection status reports partial validated residency until selection eviction', async t => {
  const { backend } = await fixture(t, { freshNoSnapshot: true });
  backend.maintainThread(freshThread);
  await eventually(() => backend.connectionStatus().connected === 1);
  assert.deepEqual(backend.connectionStatus(), { expected: 2, connected: 1, diagnostic: 'connecting' });
  backend.maintainThread();
  assert.deepEqual(backend.connectionStatus(), { expected: 1, connected: 1 });
});

test('desktop connection status never treats rejected permissions or unavailable owners as ready', async t => {
  for (const options of [{ fullAccess: false }, { ownerUnavailable: true }]) {
    const { backend, requests, sockets } = await fixture(t, options);
    backend.maintainThread();
    await eventually(() => requests.some(request => request.method === 'thread-owner-discovery') && sockets.size === 0);
    assert.deepEqual(backend.connectionStatus(), { expected: 1, connected: 0, diagnostic: 'connecting' });
    await backend.close();
  }
});

test('desktop connection status loses readiness on disconnect and recovers only after a validated snapshot', async t => {
  const { backend, sockets } = await fixture(t);
  backend.maintainThread(); await eventually(() => backend.connectionStatus().connected === 1);
  for (const socket of sockets) socket.destroy();
  await eventually(() => backend.connectionStatus().connected === 0);
  assert.deepEqual(backend.connectionStatus(), { expected: 1, connected: 0, diagnostic: 'connecting' });
  await eventually(() => backend.connectionStatus().connected === 1);
  assert.deepEqual(backend.connectionStatus(), { expected: 1, connected: 1 });
});

for (const status of ['interrupted', 'completed', 'failed'] as const) {
  test(`desktop user cancellation requires verified matching ${status} terminal state`, async t => {
    const abort = new AbortController();
    const { backend, requests, sockets } = await fixture(t, { stopStatus: status });
    let finished = false;
    const result = backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: () => abort.abort('user-cancel') });
    void result.then(() => { finished = true; }, () => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(finished, false, 'interrupt receipt alone must not settle the turn');
    await assert.rejects(result, error => error instanceof AgentStoppedError && error.outcome === status && !error.outcomeUnknown);
    assert.equal(requests.filter(request => request.method === 'thread-follower-interrupt-turn').length, 1);
    assert.equal(requests.find(request => request.method === 'thread-follower-interrupt-turn').params.expectedTurnId, 'our-turn');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    for (let attempt = 0; sockets.size && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(sockets.size, 0, 'completed stop must close its temporary IPC connection');
  });
}

test('desktop user cancel before a late start-ID reply waits and interrupts only that ID', async t => {
  const abort = new AbortController();
  const { backend, requests } = await fixture(t, { onStart: () => abort.abort('user-cancel'), lateStartId: true, stopStatus: 'interrupted' });
  const turns: string[] = [];
  await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: id => { turns.push(id); } }), error => error instanceof AgentStoppedError && error.outcome === 'interrupted');
  assert.deepEqual(turns, ['our-turn']);
  assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
  assert.equal(requests.filter(request => request.method === 'thread-follower-interrupt-turn').length, 1);
});

test('desktop user cancellation ignores another turn and an untrusted owner terminal event', async t => {
  const abort = new AbortController();
  const { backend } = await fixture(t, { foreignStop: true, stopStatus: 'interrupted' });
  let finished = false;
  const result = backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: () => abort.abort('user-cancel') });
  void result.catch(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(finished, false);
  await assert.rejects(result, error => error instanceof AgentStoppedError && error.outcome === 'interrupted');
});

test('desktop user cancellation with only an interrupt receipt expires uncertain and cleans its listener', { timeout: 13000 }, async t => {
  const abort = new AbortController();
  const { backend, requests, config } = await fixture(t, { stopReceiptOnly: true });
  config.turnTimeoutMs = 20; // Once cancellation begins, the independent stop deadline owns confirmation.
  const started = Date.now();
  await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: () => abort.abort('user-cancel') }), error => error instanceof DesktopError && error.outcomeUnknown);
  assert.ok(Date.now() - started >= 9900);
  assert.equal(requests.filter(request => request.method === 'thread-follower-interrupt-turn').length, 1);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

for (const options of [{ stopDisconnect: true }, { stopStatus: 'unrecognized' }]) {
  test(`desktop user cancellation stays uncertain after ${options.stopDisconnect ? 'disconnect' : 'unknown terminal status'}`, async t => {
    const abort = new AbortController(); const { backend } = await fixture(t, options);
    await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: () => abort.abort('user-cancel') }), error => error instanceof DesktopError && error.outcomeUnknown);
  });
}

test('desktop pre-aborted user request has no submission and no socket', async t => {
  const abort = new AbortController(); abort.abort('user-cancel');
  const { backend, requests } = await fixture(t);
  await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => {} }), error => error instanceof AgentStoppedError && error.outcome === 'not-started');
  assert.deepEqual(requests, []);
});

test('desktop user cancellation while awaiting initial snapshot is confirmed not started', async t => {
  const abort = new AbortController(); const { backend, requests } = await fixture(t, { noSnapshot: true });
  const result = backend.run({ text: 'hello', signal: abort.signal, onThread: () => {} });
  void result.catch(() => {});
  while (!requests.some(request => request.method === 'thread-stream-following-changed')) await new Promise(resolve => setTimeout(resolve, 2));
  abort.abort('user-cancel');
  await assert.rejects(result, error => error instanceof AgentStoppedError && error.outcome === 'not-started');
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('desktop user cancellation from onThread occurs before submission', async t => {
  const abort = new AbortController(); const { backend, requests } = await fixture(t);
  await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => abort.abort('user-cancel') }), error => error instanceof AgentStoppedError && error.outcome === 'not-started');
  assert.equal(requests.some(request => request.method === 'thread-follower-start-turn'), false);
});

test('external interruption without owner cancellation is not reported as an owner-confirmed stop', async t => {
  const { backend } = await fixture(t, { terminalStatus: 'interrupted' });
  await assert.rejects(backend.run({ text: 'hello', onThread: () => {} }), error => error instanceof DesktopError && !(error instanceof AgentStoppedError));
});

test('desktop completed response wins before a later user cancel without an interrupt', async t => {
  const abort = new AbortController(); const { backend, requests } = await fixture(t);
  const result = await backend.run({ text: 'hello', signal: abort.signal, onThread: () => {} });
  abort.abort('user-cancel');
  assert.equal(result.text, 'DESKTOP_OK');
  assert.equal(requests.some(request => request.method === 'thread-follower-interrupt-turn'), false);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('desktop creation cancellation remains uncertain because stopping orchestration cannot rule out a child', async t => {
  const abort = new AbortController();
  const { backend, requests } = await fixture(t, { mediated: true, fresh: true, onStart: () => abort.abort('user-cancel'), stopStatus: 'interrupted' });
  await assert.rejects(backend.run({ text: 'hello', newThread: true, signal: abort.signal, onThread: () => {} }), error => error instanceof DesktopError && error.outcomeUnknown);
  assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

// Exercise the creation boundary directly: this guard must distinguish a typed
// pre-submission result from an orchestration turn that could create a child.
test('desktop creation preserves only proven pre-orchestration user cancellation', async t => {
  const { backend } = await fixture(t, { mediated: true });
  for (const started of [false, true]) {
    const anchor = { run: async (input: { onTurn: (id: string) => void }) => {
      if (started) input.onTurn('already-submitted');
      throw new AgentStoppedError('not-started');
    } };
    await assert.rejects((backend as any).createThroughAgent(anchor, { text: 'hello', onThread: () => {} }),
      (error: unknown) => started ? error instanceof DesktopError && error.outcomeUnknown : error instanceof AgentStoppedError && error.outcome === 'not-started');
  }
});

test('desktop native cancellation during runtime lookup starts no creation worker', async t => {
  const abort = new AbortController(); const { backend, toolRequests } = await fixture(t);
  const result = (backend as any).createThread({ text: 'hello', signal: abort.signal, onThread: () => {} });
  abort.abort('user-cancel');
  await assert.rejects(result, (error: unknown) => error instanceof AgentStoppedError && error.outcome === 'not-started');
  assert.equal(toolRequests.length, 0);
  assert.equal((backend as any).creation, undefined);
});

for (const provisionalStatus of ['inProgress', 'completed'] as const) {
  test(`desktop defers provisional ${provisionalStatus} client-message turn until its canonical ID arrives`, async t => {
    const { backend, requests } = await fixture(t, { provisionalStatus });
    const ids: string[] = [];
    const result = await backend.run({ text: 'hello', onThread: () => {}, onTurn: id => { ids.push(id); } });
    assert.equal(result.text, 'DESKTOP_OK');
    assert.deepEqual(ids, ['our-turn']);
    assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
  });
}

test('desktop user cancellation defers provisional terminal before canonical ID without premature confirmation', async t => {
  const abort = new AbortController();
  const { backend, requests } = await fixture(t, { provisionalStatus: 'completed', onStart: () => abort.abort('user-cancel'), lateStartId: true, stopStatus: 'interrupted' });
  const ids: string[] = [];
  await assert.rejects(backend.run({ text: 'hello', signal: abort.signal, onThread: () => {}, onTurn: id => { ids.push(id); } }), error => error instanceof AgentStoppedError && error.outcome === 'interrupted');
  assert.deepEqual(ids, ['our-turn']);
  assert.equal(requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
  assert.equal(requests.filter(request => request.method === 'thread-follower-interrupt-turn').length, 1);
  assert.equal(requests.find(request => request.method === 'thread-follower-interrupt-turn').params.expectedTurnId, 'our-turn');
});
