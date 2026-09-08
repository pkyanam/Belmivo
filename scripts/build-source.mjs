// Invoked by install.sh with its already selected Node 24+ runtime.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const PRIVATE_LIMIT = 65536;

function privateObject(path) {
  let fd;
  try {
    // Nonblocking open also prevents a malformed FIFO from hanging installation.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > PRIVATE_LIMIT) throw Error();
    const bytes = Buffer.alloc(PRIVATE_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > PRIVATE_LIMIT) throw Error();
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw Error('Build guard requires a valid private configuration object: owner-only regular file, no links, at most 64 KiB. Contents were not printed.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function selectedDataDirectory(config, from) {
  let present = true;
  try { lstatSync(config); } catch (error) { if (error.code === 'ENOENT') present = false; else throw Error('Build guard could not inspect the selected configuration.'); }
  // Imported defaults are relative to the selected destination, as in setup.
  const value = present ? privateObject(config) : from ? privateObject(from) : {};
  if (value.dataDir !== undefined && (typeof value.dataDir !== 'string' || !isAbsolute(value.dataDir) || value.dataDir.includes('\0'))) throw Error('Build guard requires an absolute data directory in the selected configuration.');
  return value.dataDir ?? join(dirname(config), 'data');
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24+ is required for the source build guard.');
  const [config, npm, from = '', ...extra] = process.argv.slice(2);
  if (!config || !npm || extra.length || ![config, npm, ...(from ? [from] : [])].every(value => isAbsolute(value) && !value.includes('\0'))) throw Error('Build guard requires absolute configuration and npm paths.');
  // No compiled build or third-party dependencies are needed for this import.
  const { acquireLock } = await import('../src/lock.ts');
  const data = selectedDataDirectory(config, from);
  let release;
  try {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    release = acquireLock(data);
  } catch {
    throw Error('Cannot rebuild while the selected receiver is running or its private data directory is unsafe. Wait for idle, stop that owned receiver, then retry.');
  }
  let active, timer, interrupted;
  const interrupt = signal => {
    if (interrupted) return;
    interrupted = signal;
    if (active && active.exitCode === null && active.signalCode === null) {
      active.kill(signal);
      const child = active;
      // npm runs with lifecycle scripts disabled; both direct build children are
      // owned by this wrapper. Keep the lock until their close event is observed.
      timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    }
  };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const run = (args, label) => new Promise((resolve, reject) => {
    if (interrupted) { reject(Error('Source build interrupted.')); return; }
    const child = spawn(process.execPath, args, { cwd: repository, stdio: 'inherit' });
    active = child;
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      if (active === child) active = undefined;
      clearTimeout(timer); timer = undefined;
      if (interrupted) reject(Error('Source build interrupted.'));
      else if (failed || code !== 0) reject(Error(`${label} failed. Source build stopped.`));
      else resolve();
    });
  });
  try {
    await run([npm, 'ci', '--ignore-scripts'], 'Dependency installation');
    await run([join(repository, 'node_modules/typescript/bin/tsc')], 'Compilation');
  } finally {
    clearTimeout(timer);
    release();
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
  }
}

try { await main(); }
catch (error) {
  // Only deliberate messages above are safe; unexpected runtime errors may contain paths.
  const safe = error instanceof Error && /^(Build guard |Node\.js 24\+ is required for the source build guard\.|Cannot rebuild |Source build interrupted\.|Dependency installation failed\.|Compilation failed\.)/.test(error.message);
  console.error(safe ? error.message : 'Source build guard failed. Inspect the selected private configuration and installation locally.');
  process.exitCode ||= 1;
}
