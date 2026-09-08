import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/client-worker-proof.mjs', import.meta.url));
const certificateConfig = `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=localhost
[ext]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage=serverAuth
`;

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function removeGroup(pid) {
  if (!groupExists(pid)) return;
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (groupExists(pid) && Date.now() < deadline) await pause(20);
  if (groupExists(pid)) signalGroup(pid, 'SIGKILL');
  const killedDeadline = Date.now() + 2000;
  while (groupExists(pid) && Date.now() < killedDeadline) await pause(20);
  assert.equal(groupExists(pid), false, 'Owned integration process group did not exit');
}

test('production relay client commits before ACK and deduplicates across client and workerd restart', { timeout: 120000 }, async t => {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'Integration fixture requires macOS or Linux process groups');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
  const directory = await mkdtemp(join(tmpdir(), 'belmivo-relay-integration-'));
  await chmod(directory, 0o700);
  let child, closed;
  t.after(async () => {
    if (child?.pid) await removeGroup(child.pid);
    if (closed) await closed.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  const build = join(directory, 'build');
  await mkdir(build);
  await writeFile(join(build, 'package.json'), '{"type":"module"}', { mode: 0o600 });
  // Compile only into this fixture. Never replace a running receiver's dist.
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(root, 'tsconfig.json'), '--outDir', build, '--declaration', 'false'], { cwd: root, timeout: 30000, maxBuffer: 1024 * 1024, stdio: 'pipe' });
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem'), config = join(directory, 'openssl.cnf');
  await writeFile(config, certificateConfig, { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config], { timeout: 10000, maxBuffer: 65536, stdio: 'pipe' });
  await chmod(key, 0o600);
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
  // Trust this fixture CA only in the child. No TLS bypass or inherited preload.
  delete env.NODE_TLS_REJECT_UNAUTHORIZED; delete env.NODE_OPTIONS;
  child = spawn(process.execPath, [fixture, directory, build], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '', bytes = 0, overflow = false, timedOut = false;
  const collect = target => chunk => {
    bytes += chunk.length;
    if (bytes > 65536) { overflow = true; if (child.pid) signalGroup(child.pid, 'SIGTERM'); return; }
    if (target === 'stdout') output += chunk; else stderr += chunk;
  };
  child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
  closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let forced;
  const deadline = setTimeout(() => {
    timedOut = true;
    if (child.pid) signalGroup(child.pid, 'SIGTERM');
    forced = setTimeout(() => { if (child.pid) signalGroup(child.pid, 'SIGKILL'); }, 2000);
  }, 45000);
  let result;
  try { result = await closed; }
  finally { clearTimeout(deadline); clearTimeout(forced); }
  assert.equal(timedOut, false, 'Fixture exceeded its execution deadline');
  assert.equal(overflow, false, 'Fixture output exceeded its bound');
  assert.equal(result.code, 0, stderr || output || `Fixture exited by ${result.signal}`);
  const summary = JSON.parse(output.trim());
  assert.deepEqual(summary, { passed: true, durableJobs: 2, queued: 2, duplicates: 1, droppedAcks: 1, committedAckChecks: 3, workerRestarts: 1, tlsVerified: true, providerCalls: 0, agentCalls: 0 });
  assert.equal(groupExists(child.pid), false, 'Successful fixture left owned child processes running');
});
