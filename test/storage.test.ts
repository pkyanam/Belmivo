import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectStorage } from '../src/storage.js';
import { acquireLock } from '../src/lock.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'belmivo-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'), config = join(root, 'config.json');
  await mkdir(data, { mode: 0o700 });
  return { root, data, config };
}
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('storage counts only fixed metadata scopes without opening or changing file contents', async t => {
  const f = await fixture(t), inbound = join(f.data, 'attachments', 'inbound-abcdef'), logs = join(f.root, 'logs');
  await mkdir(inbound, { recursive: true, mode: 0o700 }); await mkdir(logs, { mode: 0o700 });
  const file = join(f.data, 'bridge.sqlite');
  await writeFile(file, 'not a SQLite database', { mode: 0o600 });
  await writeFile(join(f.data, 'unrelated-secret.txt'), 'unrelated'.repeat(100));
  await writeFile(join(inbound, 'personal-document-name.pdf'), 'private-file');
  await writeFile(join(logs, 'bridge.stdout.log'), 'private-log');
  await writeFile(join(logs, 'unrelated.log'), 'outside scope'.repeat(100));
  const before = await stat(file), report = await inspectStorage(f.data, f.config);
  assert.equal(report.journal.logicalBytes, Buffer.byteLength('not a SQLite database'));
  assert.equal(report.attachments.logicalBytes, Buffer.byteLength('private-file'));
  assert.equal(report.logs.logicalBytes, Buffer.byteLength('private-log'));
  assert.equal(report.totalLogicalBytes, report.journal.logicalBytes + report.attachments.logicalBytes + report.logs.logicalBytes);
  assert.equal(report.totalIsLowerBound, false);
  const serialized = JSON.stringify(report);
  for (const privateValue of [f.root, 'personal-document-name', 'private-file', 'private-log', 'unrelated-secret']) assert.equal(serialized.includes(privateValue), false);
  assert.equal(await readFile(file, 'utf8'), 'not a SQLite database');
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

test('storage never follows symbolic links or counts hard-linked files', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'), attachments = join(f.data, 'attachments');
  await mkdir(outside, { mode: 0o700 }); await mkdir(attachments, { mode: 0o700 });
  await writeFile(join(outside, 'secret'), 'external bytes');
  await symlink(outside, join(attachments, 'inbound-linked'));
  await symlink(join(outside, 'secret'), join(f.data, 'bridge.sqlite'));
  await link(join(outside, 'secret'), join(f.data, 'bridge.sqlite-wal'));
  const report = await inspectStorage(f.data, f.config);
  assert.equal(report.totalLogicalBytes, 0);
  assert.equal(report.totalIsLowerBound, true);
  assert.equal(report.journal.skippedEntries, 2);
  assert.equal(report.attachments.state, 'unsafe');
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'external bytes');
});

test('storage skips unknown entries and never descends beyond immediate inbound files', async t => {
  const f = await fixture(t), base = join(f.data, 'attachments'), inbound = join(base, 'inbound-known');
  await mkdir(join(inbound, 'nested'), { recursive: true, mode: 0o700 });
  await mkdir(join(base, 'unindexed'), { mode: 0o700 });
  await writeFile(join(inbound, 'kept.txt'), '123');
  await writeFile(join(inbound, 'nested', 'ignored.txt'), 'not counted');
  await writeFile(join(base, 'unindexed', 'ignored.txt'), 'not counted');
  const report = await inspectStorage(f.data, f.config);
  assert.equal(report.attachments.logicalBytes, 3);
  assert.equal(report.attachments.regularFiles, 1);
  assert.equal(report.attachments.skippedEntries, 2);
  assert.equal(report.totalIsLowerBound, true);
});

test('storage entry budget returns a marked lower bound instead of scanning the whole cache', async t => {
  const f = await fixture(t), inbound = join(f.data, 'attachments', 'inbound-many');
  await mkdir(inbound, { recursive: true, mode: 0o700 });
  await Promise.all(Array.from({ length: 80 }, (_, i) => writeFile(join(inbound, `${i}.txt`), '1234567890')));
  const report = await inspectStorage(f.data, f.config, { maxEntries: 20 });
  assert.ok(report.entriesExamined <= 20);
  assert.ok(report.attachments.logicalBytes < 800);
  assert.equal(report.attachments.state, 'partial');
  assert.equal(report.totalIsLowerBound, true);
});

for (const disappearing of ['directory', 'file']) test(`storage marks an enumerated disappearing ${disappearing} partial while retaining other measured bytes`, async t => {
  const f = await fixture(t), base = join(f.data, 'attachments'), kept = join(base, 'inbound-kept');
  await mkdir(kept, { recursive: true, mode: 0o700 });
  await writeFile(join(kept, 'kept.txt'), '12345');
  const vanished = disappearing === 'directory' ? join(base, 'inbound-vanished') : join(kept, 'vanished.txt');
  if (disappearing === 'directory') await mkdir(vanished, { mode: 0o700 });
  else await writeFile(vanished, 'uncounted');
  const original = filesystem.lstat;
  let vanishedInspections = 0;
  // opendir sees a real fixture entry; its subsequent metadata lookup reliably
  // models ENOENT without depending on a filesystem timing race or entry order.
  const mocked = t.mock.method(filesystem, 'lstat', (async (...args: Parameters<typeof filesystem.lstat>) => {
    if (String(args[0]) === vanished) {
      vanishedInspections++;
      throw Object.assign(new Error('Synthetic vanished entry'), { code: 'ENOENT' });
    }
    return original(...args);
  }) as typeof filesystem.lstat);
  syncBuiltinESMExports();
  try {
    const report = await inspectStorage(f.data, f.config);
    assert.equal(vanishedInspections, 1);
    assert.equal(report.attachments.state, 'partial');
    assert.equal(report.attachments.logicalBytes, 5);
    assert.equal(report.attachments.regularFiles, 1);
    assert.equal(report.attachments.skippedEntries, 1);
    assert.equal(report.totalLogicalBytes, 5);
    assert.equal(report.totalIsLowerBound, true);
    assert.equal(report.journal.state, 'complete', 'Optional absent SQLite files are not partial');
    assert.equal(report.logs.state, 'missing', 'An initially absent fixed log directory remains missing');
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('storage reports unsafe and missing directories without creating anything', async t => {
  const f = await fixture(t);
  await chmod(f.data, 0o755);
  await writeFile(join(f.data, 'bridge.sqlite'), 'do not inspect');
  const unsafe = await inspectStorage(f.data, f.config);
  assert.equal(unsafe.journal.state, 'unsafe'); assert.equal(unsafe.attachments.state, 'unsafe');
  assert.equal(unsafe.totalLogicalBytes, 0);
  const missing = join(f.root, 'missing');
  const before = await readdir(f.root);
  const report = await inspectStorage(missing, join(missing, 'config.json'));
  assert.equal(report.journal.state, 'missing'); assert.equal(report.attachments.state, 'missing'); assert.equal(report.logs.state, 'missing');
  assert.deepEqual(await readdir(f.root), before);
});

test('storage CLI is read-only while the receiver lock is held and does not require an agent binary', async t => {
  const f = await fixture(t), database = join(f.data, 'bridge.sqlite');
  await writeFile(database, 'synthetic non-database bytes', { mode: 0o600 });
  await writeFile(f.config, JSON.stringify({ provider: 'linq', allowedSenders: ['+12025550123'], serviceNumber: '+12025550124', providerApiKey: 'private-key', webhookSecret: 'private-webhook-secret', codexBinary: '/absent-agent-binary', dataDir: f.data }), { mode: 0o600 });
  const release = acquireLock(f.data); t.after(release);
  const before = await stat(database);
  const result = spawnSync(process.execPath, [cli, 'storage', '--config', f.config], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readOnly, true); assert.ok(report.journal.logicalBytes > 0);
  for (const secret of [f.root, 'private-key', 'private-webhook-secret']) assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  assert.equal(await readFile(database, 'utf8'), 'synthetic non-database bytes');
  assert.equal((await stat(database)).mtimeMs, before.mtimeMs);
});

test('private CLI input rejects a FIFO promptly instead of waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), fifo = join(f.root, 'pipe');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  for (const args of [['storage', '--config', fifo], ['setup', '--from', fifo, '--config', f.config]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 1500 });
    assert.equal(result.status, 1, String(result.error ?? result.stderr));
    assert.equal(result.error, undefined);
    assert.equal(result.stderr.includes(f.root), false);
  }
});
