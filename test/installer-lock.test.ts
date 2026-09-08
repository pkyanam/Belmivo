import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { acquireLock } from '../src/lock.js';

function fixture(t: test.TestContext, options: { missing?: boolean; custom?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'belmivo-installer-lock-')), repo = join(base, 'repo'), config = join(base, 'private.json');
  const data = join(base, options.custom ? 'custom-data' : 'data'), npm = join(base, 'npm.mjs');
  mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'src'));
  copyFileSync(resolve('scripts/install.sh'), join(repo, 'scripts/install.sh'));
  copyFileSync(resolve('scripts/build-source.mjs'), join(repo, 'scripts/build-source.mjs'));
  copyFileSync(resolve('src/lock.ts'), join(repo, 'src/lock.ts'));
  if (!options.missing) writeFileSync(config, JSON.stringify(options.custom ? { dataDir: data } : {}), { mode: 0o600 });
  const phaseCode = `
    import {existsSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const phase=PHASE, mode=process.env.FIXTURE_MODE;
    if(mode==='ignore-signals')process.on('SIGTERM',()=>{});
    writeFileSync(join(process.env.FIXTURE_BASE,phase+'.started'),String(process.pid),{mode:0o600});
    if(mode==='fail-'+phase)process.exit(7);
    if(mode==='wait-'+phase || mode==='ignore-signals')setInterval(()=>{if(existsSync(join(process.env.FIXTURE_BASE,'continue')))process.exit(0);},10);
  `;
  const compiler = phaseCode.replace('PHASE', JSON.stringify('compiler'));
  writeFileSync(npm, `
    import {mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import assert from 'node:assert/strict';
    assert.deepEqual(process.argv.slice(2),['ci','--ignore-scripts']);
    const target=join(process.cwd(),'node_modules/typescript/bin');
    mkdirSync(target,{recursive:true});writeFileSync(join(target,'tsc'),${JSON.stringify(compiler)});
    await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(phaseCode.replace('PHASE', JSON.stringify('npm'))))});
  `);
  // A package declaration also makes the synthetic compiler's extensionless file ESM.
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  const env = { ...process.env, FIXTURE_BASE: base };
  const args = ['--experimental-strip-types', join(repo, 'scripts/build-source.mjs'), config, npm];
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => child.once('close', () => resolve()));
    }
    rmSync(base, { recursive: true, force: true });
  });
  const start = (mode: string, installer = false) => {
    const bin = join(base, 'bin');
    if (installer) { mkdirSync(bin); writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o700 }); }
    const child = spawn(installer ? 'bash' : process.execPath, installer ? [join(repo, 'scripts/install.sh'), '--node', process.execPath, '--no-setup', '--config', config] : args, { env: { ...env, FIXTURE_MODE: mode, ...(installer ? { PATH: `${bin}:${process.env.PATH}`, NPM_CLI_PATH: npm } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += String(bytes); });
    const result = new Promise<{ code: number | null; stderr: string }>(resolve => child.once('close', code => resolve({ code, stderr })));
    return { child, result };
  };
  return { base, repo, config, data, npm, env, args, start, run: (mode = '', extra: string[] = []) => spawnSync(process.execPath, [...args, ...extra], { env: { ...env, FIXTURE_MODE: mode }, encoding: 'utf8', timeout: 5000 }) };
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!existsSync(path)) { if (Date.now() > deadline) throw Error('Synthetic build did not reach expected phase'); await pause(10); }
}

test('installer guard blocks an active foreground receiver before dependency changes for default and custom data directories', t => {
  for (const custom of [false, true]) {
    const f = fixture(t, { custom }); mkdirSync(f.data, { mode: 0o700 });
    const release = acquireLock(f.data);
    try {
      const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /Cannot rebuild/);
      assert.equal(result.stderr.includes(f.base), false);
      assert.equal(existsSync(join(f.base, 'npm.started')), false);
      assert.equal(existsSync(join(f.repo, 'node_modules')), false);
    } finally { release(); }
  }
});

test('installer holds receiver ownership throughout npm and compilation, then releases after success', async t => {
  for (const phase of ['npm', 'compiler']) {
    const f = fixture(t), running = f.start(`wait-${phase}`);
    await waitFor(join(f.base, `${phase}.started`));
    assert.throws(() => acquireLock(f.data), /already using/);
    writeFileSync(join(f.base, 'continue'), '');
    assert.deepEqual(await running.result, { code: 0, stderr: '' });
    acquireLock(f.data)();
    assert.equal(existsSync(join(f.base, 'compiler.started')), true);
  }
});

test('installer releases ownership after npm or compiler failure without continuing failed stages', t => {
  for (const phase of ['npm', 'compiler']) {
    const f = fixture(t), result = f.run(`fail-${phase}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed\. Source build stopped/);
    acquireLock(f.data)();
    assert.equal(existsSync(join(f.base, 'compiler.started')), phase === 'compiler');
  }
});

test('installer interruption kills a TERM-ignoring owned child before releasing the lock', { timeout: 7000 }, async t => {
  const f = fixture(t), running = f.start('ignore-signals');
  await waitFor(join(f.base, 'npm.started'));
  const pid = Number(readFileSync(join(f.base, 'npm.started'), 'utf8'));
  running.child.kill('SIGTERM');
  await pause(100);
  assert.throws(() => acquireLock(f.data), /already using/);
  assert.equal((await running.result).code, 143);
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  acquireLock(f.data)();
  assert.equal(existsSync(join(f.base, 'compiler.started')), false);
});

test('targeted installer shell termination reaches the wrapper and its owned build child', { timeout: 7000 }, async t => {
  const f = fixture(t), running = f.start('ignore-signals', true);
  await waitFor(join(f.base, 'npm.started'));
  const pid = Number(readFileSync(join(f.base, 'npm.started'), 'utf8'));
  running.child.kill('SIGTERM');
  await pause(100);
  assert.throws(() => acquireLock(f.data), /already using/);
  assert.equal((await running.result).code, 143);
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
  acquireLock(f.data)();
  assert.equal(existsSync(join(f.base, 'compiler.started')), false);
});

test('source installer builds a clean first checkout without dist or existing dependencies', t => {
  const f = fixture(t, { missing: true }), bin = join(f.base, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o700 });
  assert.equal(existsSync(join(f.repo, 'dist')), false);
  assert.equal(existsSync(join(f.repo, 'node_modules')), false);
  const result = spawnSync('bash', [join(f.repo, 'scripts/install.sh'), '--node', process.execPath, '--no-setup'], { env: { ...f.env, PATH: `${bin}:${process.env.PATH}`, NPM_CLI_PATH: f.npm, CODEX_IMESSAGE_CONFIG: f.config, from_path: 'unselected-private-input' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Setup skipped/);
  assert.equal(existsSync(join(f.base, 'compiler.started')), true);
  assert.equal(existsSync(f.config), false);
  acquireLock(f.data)();
});

test('installer guard rejects unsafe or malformed private configuration without printing contents', t => {
  for (const shape of ['symlink', 'hardlink', 'public', 'oversized', 'invalid', 'array', 'relative']) {
    const f = fixture(t), original = join(f.base, 'original.json');
    if (shape === 'symlink' || shape === 'hardlink') {
      writeFileSync(original, '{}', { mode: 0o600 }); rmSync(f.config);
      if (shape === 'symlink') symlinkSync(original, f.config); else linkSync(original, f.config);
    } else if (shape === 'public') chmodSync(f.config, 0o644);
    else writeFileSync(f.config, shape === 'oversized' ? JSON.stringify({ value: 'private-marker'.repeat(6000) }) : shape === 'array' ? '[]' : shape === 'relative' ? '{"dataDir":"private-marker"}' : 'private-marker');
    const result = f.run(); assert.equal(result.status, 1);
    assert.equal(result.stderr.includes('private-marker'), false); assert.equal(result.stderr.includes(f.base), false);
    assert.equal(existsSync(join(f.base, 'npm.started')), false);
  }
});

test('installer resolves imported custom and default data directories relative to the selected destination', t => {
  for (const custom of [false, true]) {
    const f = fixture(t, { missing: true, custom }), imported = join(f.base, 'imported.json');
    writeFileSync(imported, JSON.stringify(custom ? { dataDir: f.data } : {}), { mode: 0o600 });
    mkdirSync(f.data, { mode: 0o700 }); const release = acquireLock(f.data);
    try { const result = f.run('', [imported]); assert.equal(result.status, 1); assert.match(result.stderr, /Cannot rebuild/); }
    finally { release(); }
    const result = f.run('', [imported]); assert.equal(result.status, 0, result.stderr); acquireLock(f.data)();
  }
});
