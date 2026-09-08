import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPhotonProvider, fetchPhotonViaSdk, PhotonSendError, type PhotonTiming } from '../src/photon.js';
import type { BridgeConfig, InboundMessage } from '../src/types.js';

const owner = '+12025559876', line = '+12025551234';
const config = (dataDir: string): BridgeConfig => ({ provider: 'photon', providerApiKey: 'test-project', providerApiSecret: 'test-project-secret', webhookSecret: 'test-webhook-signing-secret', serviceNumber: line, allowedSenders: [owner], dataDir, cwd: dataDir, port: 0, backend: 'app-server', codexBinary: 'unused', fullAccess: true, maxTextChars: 10000, maxReplyChars: 10000, maxPending: 10, turnTimeoutMs: 1000 });
const message = (count = 3): InboundMessage => ({ provider: 'photon', eventId: 'event', messageId: 'message', conversationId: 'conversation', sender: owner, recipient: line, text: '', isGroup: false, attachments: Array.from({ length: count }, (_, index) => ({ url: `photon-attachment:file-${index}`, name: `${index}.pdf`, mimeType: 'application/pdf' })) });

test('pre-aborted Photon preparation performs no fetch or filesystem allocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-photon-preabort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const provider = createPhotonProvider(config(directory), undefined, async () => { calls++; return Buffer.from('unused'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.prepareInbound!(message(), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('Photon abort between downloads removes the partial request but preserves successful earlier files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-photon-sequence-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = await createPhotonProvider(config(directory), undefined, async () => Buffer.from('previous-file')).prepareInbound!(message(1));
  const previousPath = previous.attachments[0]!.localPath!;
  const existing = await readdir(join(directory, 'attachments'));
  const controller = new AbortController();
  const calls: string[] = [];
  const onTiming = () => {};
  const provider = createPhotonProvider(config(directory), undefined, async (input, timing, signal) => {
    calls.push(input.attachmentId);
    assert.equal(timing, onTiming);
    assert.equal(signal, controller.signal);
    if (calls.length === 2) controller.abort();
    // A transport can complete concurrently with cancellation. Its bytes must not
    // become a successful prepared message or start the next file download.
    return Buffer.from('partial-file');
  }, undefined, onTiming);
  await assert.rejects(provider.prepareInbound!(message(), controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, ['file-0', 'file-1']);
  assert.deepEqual(await readdir(join(directory, 'attachments')), existing);
  assert.equal(await readFile(previousPath, 'utf8'), 'previous-file');
});

test('Photon abort of a pending fetch propagates promptly and cleans partial downloads', { timeout: 2000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-photon-pending-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  let calls = 0;
  let notifyWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { notifyWaiting = resolve; });
  const provider = createPhotonProvider(config(directory), undefined, async (_input, _timing, signal) => {
    calls++;
    if (calls === 1) return Buffer.from('partial-file');
    return new Promise<Buffer>((_resolve, reject) => {
      assert.ok(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      notifyWaiting();
    });
  });
  const prepared = provider.prepareInbound!(message(), controller.signal);
  const rejected = assert.rejects(prepared, { name: 'AbortError' });
  await waiting;
  controller.abort();
  await rejected;
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(join(directory, 'attachments')), []);
});

test('pre-aborted Photon SDK fetch is a definite failure with no worker operation', async () => {
  const controller = new AbortController(); controller.abort();
  const timings: PhotonTiming[] = [];
  await assert.rejects(fetchPhotonViaSdk({ projectId: 'synthetic', projectSecret: 'synthetic', line, attachmentId: 'synthetic' }, value => { timings.push(value); }, controller.signal), error => error instanceof PhotonSendError && !error.ambiguous && /cancelled before starting/.test(error.message));
  assert.equal(timings.length, 1);
  assert.equal(timings[0]!.operationKind, 'fetch');
  assert.equal(timings[0]!.outcome, 'failed');
});

test('cancelling a real Photon SDK worker during a fake download terminates that owned child', { timeout: 6000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-photon-worker-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loader = join(directory, 'loader.mjs'), runner = join(directory, 'runner.mjs');
  // Only SDK imports are replaced. The production worker spawn, abort listener,
  // stdin protocol and process termination execute unchanged, without networking.
  const fakeSdk = `
    import {writeFileSync} from 'node:fs';
    export async function Spectrum(){return {stop:async()=>{}};}
    export const attachment=()=>{};
    export function imessage(){return {getAttachment:async()=>{
      writeFileSync(process.env.FIXTURE_STARTED, String(process.pid), {mode:0o600});
      return new Promise(()=>setInterval(()=>{},1000));
    }};}
    imessage.config=()=>({});
  `;
  await writeFile(loader, `import {registerHooks} from 'node:module';
const replacement=${JSON.stringify('data:text/javascript,' + encodeURIComponent(fakeSdk))};
registerHooks({resolve(specifier,context,next){if(['@spectrum-ts/core','@spectrum-ts/imessage'].includes(specifier))return {url:replacement,shortCircuit:true};return next(specifier,context);}});
`);
  await writeFile(runner, `
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {setTimeout as pause} from 'node:timers/promises';
    import {fetchPhotonViaSdk,PhotonSendError} from ${JSON.stringify(new URL('../src/photon.js', import.meta.url).href)};
    const controller=new AbortController(),metrics=[];
    const pending=fetchPhotonViaSdk({projectId:'synthetic',projectSecret:'synthetic',line:'+12025551234',attachmentId:'synthetic'},value=>metrics.push(value),controller.signal);
    const rejected=assert.rejects(pending,error=>error instanceof PhotonSendError&&!error.ambiguous&&/cancelled/.test(error.message));
    let child;
    try {
      const deadline=Date.now()+2500;
      while(Date.now()<deadline) {
        try {child=Number(await readFile(process.env.FIXTURE_STARTED,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}
        await pause(10);
      }
      assert.ok(Number.isSafeInteger(child)&&child>1,'Worker did not reach synthetic download');
      controller.abort();await rejected;
      let exited=false;
      for(let i=0;i<100;i++) {
        try {process.kill(child,0);}catch(error){if(error.code==='ESRCH'){exited=true;break;}throw error;}
        await pause(10);
      }
      assert.equal(exited,true,'Cancelled worker remained alive');
      assert.equal(metrics.length,1);assert.equal(metrics[0].operationKind,'fetch');assert.equal(metrics[0].outcome,'failed');
      process.stdout.write(JSON.stringify({cancelled:true,workerExited:true}));
    } finally {controller.abort();await rejected;}
  `);
  const result = await promisify(execFile)(process.execPath, [runner], { env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(loader).href}`, FIXTURE_STARTED: join(directory, 'started') }, timeout: 5000, maxBuffer: 10000 });
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { cancelled: true, workerExited: true });
});
