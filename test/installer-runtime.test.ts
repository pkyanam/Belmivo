import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const bundledPath = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t: test.TestContext) {
  const base = mkdtempSync(join(tmpdir(), 'belmivo-installer-runtime-'));
  const repo = join(base, 'repo'), bin = join(base, 'bin'), trace = join(base, 'runtime.log');
  const bundled = join(base, 'Fixture App.app/Contents/Resources/cua_node/bin/node');
  mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'src')); mkdirSync(bin);
  const installer = readFileSync(resolve('scripts/install.sh'), 'utf8');
  // Redirect only the bundle location in this isolated copy; never modify /Applications
  // or add a production test hook. Exercise the actual shell and source build guard.
  assert.equal(installer.split(bundledPath).length - 1, 2);
  writeFileSync(join(repo, 'scripts/install.sh'), installer.replaceAll(bundledPath, quote(bundled)));
  copyFileSync(resolve('scripts/build-source.mjs'), join(repo, 'scripts/build-source.mjs'));
  copyFileSync(resolve('src/lock.ts'), join(repo, 'src/lock.ts'));
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  symlinkSync('/usr/bin/dirname', join(bin, 'dirname'));
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o700 });
  // No external package installation. This npm verifies that the chosen runtime
  // executes it directly, even though its shebang cannot resolve on this PATH.
  writeFileSync(join(bin, 'npm'), `#!/nonexistent/runtime\n
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2),['ci','--ignore-scripts']);
    assert.equal(process.execPath,${JSON.stringify(process.execPath)});
    const target=path.join(process.cwd(),'node_modules/typescript/bin');
    fs.mkdirSync(target,{recursive:true});
    fs.writeFileSync(path.join(target,'tsc'),'');
    fs.writeFileSync(${JSON.stringify(join(base, 'npm-ran'))},'yes');
  `, { mode: 0o700 });
  const runtime = (path: string, label: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/bash\nprintf '%s\\n' ${quote(label)} >> ${quote(trace)}\nif [[ "$1" == -p && "$2" == process.execPath ]]; then printf '%s\\n' ${quote(path)}; exit 0; fi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
    return path;
  };
  const oldPathNode = () => writeFileSync(join(bin, 'node'), `#!/bin/sh\necho old-path >> ${quote(trace)}\nexit 42\n`, { mode: 0o700 });
  const bundleNpm = () => {
    const npmCli = join(dirname(bundled), '../lib/node_modules/npm/bin/npm-cli.js');
    mkdirSync(dirname(npmCli), { recursive: true });
    copyFileSync(join(bin, 'npm'), npmCli);
    // The actual app archive packages bin/npm as sh, not an upstream symlink.
    writeFileSync(join(dirname(bundled), 'npm'), '#!/bin/sh\n# Fixture app wrapper must never be parsed as JavaScript.\nexit 91\n', { mode: 0o700 });
    return npmCli;
  };
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    const cleanEnv = { ...process.env };
    for (const name of ['NODE_BINARY', 'NPM_CLI_PATH', 'CODEX_IMESSAGE_CONFIG', 'NODE_OPTIONS', 'NODE_PATH']) delete cleanEnv[name];
    const result = spawnSync('/bin/bash', [join(repo, 'scripts/install.sh'), '--no-setup', '--config', join(base, 'private.json'), ...args], {
      env: { ...cleanEnv, PATH: bin, ...env }, encoding: 'utf8', timeout: 5000,
    });
    return result;
  };
  const assertBuiltWith = (result: ReturnType<typeof run>, label: string) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(base, 'npm-ran'), 'utf8'), 'yes');
    assert.deepEqual(new Set(readFileSync(trace, 'utf8').trim().split('\n')), new Set([label]));
    assert.match(result.stdout, /Setup skipped/);
  };
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, bin, bundled, runtime, oldPathNode, bundleNpm, run, assertBuiltWith };
}

test('installer discovers the bundled runtime when PATH Node is missing or unusable', t => {
  for (const old of [false, true]) {
    const f = fixture(t); f.runtime(f.bundled, 'bundle');
    if (old) f.oldPathNode();
    f.assertBuiltWith(f.run(), 'bundle');
  }
});

test('installer NODE_BINARY overrides bundled and PATH runtimes', t => {
  const f = fixture(t); f.runtime(f.bundled, 'bundle'); f.oldPathNode();
  const explicit = f.runtime(join(f.base, 'env-node'), 'environment');
  f.assertBuiltWith(f.run([], { NODE_BINARY: explicit }), 'environment');
});

test('installer --node overrides NODE_BINARY and bundled discovery', t => {
  const f = fixture(t); f.runtime(f.bundled, 'bundle'); f.oldPathNode();
  const environment = f.runtime(join(f.base, 'env-node'), 'environment');
  const explicit = f.runtime(join(f.base, 'flag-node'), 'flag');
  f.assertBuiltWith(f.run(['--node', explicit], { NODE_BINARY: environment }), 'flag');
});

test('installer retains Linux PATH fallback when no app bundle exists', t => {
  const f = fixture(t); f.runtime(join(f.bin, 'node'), 'path');
  f.assertBuiltWith(f.run(), 'path');
});

test('installer fails without a usable runtime instead of running package installation', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install Node.js 24\+ first/);
  assert.equal(existsSync(join(f.base, 'npm-ran')), false);
});

test('installer does not silently replace an unavailable explicit runtime with the bundle', t => {
  const f = fixture(t); f.runtime(f.bundled, 'bundle');
  const result = f.run([], { NODE_BINARY: join(f.base, 'missing-override') });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install Node.js 24\+ first/);
  assert.equal(existsSync(join(f.base, 'npm-ran')), false);
});

test('installer selects the actual npm JavaScript CLI when the app bundles a shell wrapper', t => {
  const f = fixture(t); f.runtime(f.bundled, 'bundle'); f.bundleNpm(); f.oldPathNode();
  f.assertBuiltWith(f.run(), 'bundle');
});

test('explicit NPM_CLI_PATH overrides the discovered app npm CLI', t => {
  const f = fixture(t); f.runtime(f.bundled, 'bundle');
  writeFileSync(f.bundleNpm(), 'throw Error("Bundled npm must not run when explicitly overridden");');
  f.assertBuiltWith(f.run([], { NPM_CLI_PATH: join(f.bin, 'npm') }), 'bundle');
});
