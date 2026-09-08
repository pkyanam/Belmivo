import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireLock } from '../src/lock.js';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const credential='setup-secret-must-never-appear-in-output';
function fixture(t:test.TestContext) {
  const directory=mkdtempSync(join(tmpdir(),'imessage-setup-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const source=join(directory,'draft.json'),target=join(directory,'config.json');
  const draft={provider:'photon',allowedSenders:['+12025550123'],serviceNumber:'shared',allowSharedSandbox:true,backend:'app-server',fullAccess:true,providerApiKey:'test-project',providerApiSecret:credential,webhookSecret:credential};
  writeFileSync(source,JSON.stringify(draft),{mode:0o600});
  const run=(input=source)=>spawnSync(process.execPath,[cli,'setup','--from',input,'--config',target],{encoding:'utf8',timeout:5000});
  return {source,target,draft,run};
}
test('guided private setup imports without questions, hides secrets and safely reuses configuration',t=>{
  const f=fixture(t),result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.equal((statSync(f.target).mode & 0o077),0);
  assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),f.draft);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credential));
  const saved=readFileSync(f.target,'utf8');
  writeFileSync(f.source,JSON.stringify({...f.draft,allowedSenders:['+12025550456']}));
  const again=f.run();assert.equal(again.status,0);assert.match(again.stdout,/existing private configuration/);
  assert.equal(readFileSync(f.target,'utf8'),saved);
});
test('setup prints an executable source-checkout next step with safely quoted paths and no global CLI',t=>{
  const f=fixture(t),directory=dirname(f.target),sourceDir=join(directory,"source folder's $name");
  cpSync(dirname(cli),sourceDir,{recursive:true});
  writeFileSync(join(directory,'package.json'),'{"type":"module"}');
  const copiedCli=join(sourceDir,'cli.js'),target=join(directory,"config '$(touch SHOULD_NOT_EXIST)'.json");
  writeFileSync(f.source,JSON.stringify({...f.draft,codexBinary:process.execPath}));
  const result=spawnSync(process.execPath,[copiedCli,'setup','--from',f.source,'--config',target],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr);
  const command=/^Next: (.+)$/m.exec(result.stdout)?.[1];assert.ok(command);
  const next=spawnSync('/bin/bash',['-c',command],{cwd:directory,env:{...process.env,PATH:'/nonexistent'},encoding:'utf8',timeout:5000});
  assert.equal(next.status,0,next.stderr);assert.match(next.stdout,/"configReadable": true/);
  assert.equal(existsSync(join(directory,'SHOULD_NOT_EXIST')),false);
  assert.equal(`${result.stdout}${result.stderr}${next.stdout}${next.stderr}`.includes(credential),false);
});
test('setup rejects exposed or linked secret input before creating configuration',t=>{
  const f=fixture(t);chmodSync(f.source,0o644);
  assert.equal(f.run().status,1);assert.equal(existsSync(f.target),false);
  chmodSync(f.source,0o600);const link=f.source+'.link';symlinkSync(f.source,link);
  assert.equal(f.run(link).status,1);assert.equal(existsSync(f.target),false);
});
test('invalid setup never leaves a half-written destination or leaks malformed input',t=>{
  const f=fixture(t);writeFileSync(f.source,JSON.stringify({...f.draft,allowedSenders:[]}));
  assert.equal(f.run().status,1);assert.equal(existsSync(f.target),false);
  writeFileSync(f.source,credential);const result=f.run();
  assert.equal(result.status,1);assert.equal(existsSync(f.target),false);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(credential));
});

test('setup import refuses hardlinks and oversized private input before writing',t=>{
  const f=fixture(t),linked=f.source+'.hardlink';linkSync(f.source,linked);
  assert.equal(f.run().status,1);assert.equal(existsSync(f.target),false);rmSync(linked);
  writeFileSync(f.source,JSON.stringify({...f.draft,extra:'x'.repeat(65536)}));
  assert.equal(f.run().status,1);assert.equal(existsSync(f.target),false);
});

test('malformed existing private config never prints JSON excerpts during setup or doctor',t=>{
  const f=fixture(t),marker='S3cr3t42';writeFileSync(f.target,marker,{mode:0o600});
  for(const command of ['setup','doctor']) {
    const result=spawnSync(process.execPath,[cli,command,'--config',f.target],{encoding:'utf8',timeout:5000});
    assert.equal(result.status,1);assert.equal(`${result.stdout}${result.stderr}`.includes(marker),false);
    assert.match(result.stderr,/Contents were not printed|contents were not printed/);
  }
  assert.equal(readFileSync(f.target,'utf8'),marker);
});

function relayFixture(t:test.TestContext) {
  const f=fixture(t);
  Object.assign(f.draft,{codexBinary:process.execPath,threadInstructions:'Keep the exact existing instructions.',customSetting:{retained:true}});
  writeFileSync(f.source,JSON.stringify(f.draft));assert.equal(f.run().status,0);
  const connection={url:'https://relay.example.com',deviceId:'d'.repeat(40),token:'t'.repeat(48)};
  const file=join(dirname(f.target),'connection.json');writeFileSync(file,JSON.stringify(connection),{mode:0o600});
  const run=(flags:string[]=[])=>spawnSync(process.execPath,[cli,'relay','configure','--from',file,'--config',f.target,...flags],{encoding:'utf8',timeout:5000});
  return {...f,connection,file,configure:run};
}
test('relay import atomically preserves raw settings and is byte-for-byte idempotent without secret output',t=>{
  const f=relayFixture(t),oldInode=statSync(f.target).ino,result=f.configure();
  assert.equal(result.status,0,result.stderr);
  const saved=readFileSync(f.target,'utf8');assert.deepEqual(JSON.parse(saved),{...f.draft,relay:f.connection});
  assert.notEqual(statSync(f.target).ino,oldInode);assert.equal(statSync(f.target).mode&0o777,0o600);
  assert.equal(`${result.stdout}${result.stderr}`.includes(f.connection.token),false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(credential),false);
  const inode=statSync(f.target).ino,again=f.configure();assert.equal(again.status,0);assert.match(again.stdout,/already matches/);
  assert.equal(readFileSync(f.target,'utf8'),saved);assert.equal(statSync(f.target).ino,inode);
  assert.equal(readdirSync(dirname(f.target)).some(name=>name.startsWith('.relay-')),false);
});
test('changing relay requires explicit replace and never accepts secret CLI flags',t=>{
  const f=relayFixture(t);assert.equal(f.configure().status,0);const saved=readFileSync(f.target,'utf8');
  const next={...f.connection,token:'n'.repeat(48)};writeFileSync(f.file,JSON.stringify(next));
  assert.equal(f.configure().status,1);assert.equal(readFileSync(f.target,'utf8'),saved);
  const flag=f.configure(['--token',credential]);assert.equal(flag.status,1);assert.equal(`${flag.stdout}${flag.stderr}`.includes(credential),false);
  assert.equal(f.configure(['--replace']).status,0);
  assert.deepEqual(JSON.parse(readFileSync(f.target,'utf8')),{...f.draft,relay:next});
});
test('relay import rejects malformed, unsafe, unrelated and unsupported configuration without changing the destination',t=>{
  const f=relayFixture(t),saved=readFileSync(f.target,'utf8');
  const inputs=[credential,JSON.stringify({...f.connection,url:'http://relay.example.com'}),JSON.stringify({...f.connection,allowedSenders:[]}),JSON.stringify({...f.connection,token:'short'}),'null'];
  for(const input of inputs){writeFileSync(f.file,input);const result=f.configure();assert.equal(result.status,1);assert.equal(readFileSync(f.target,'utf8'),saved);assert.equal(`${result.stdout}${result.stderr}`.includes(credential),false);}
  writeFileSync(f.file,JSON.stringify(f.connection));chmodSync(f.file,0o644);assert.equal(f.configure().status,1);chmodSync(f.file,0o600);
  const hardlink=f.file+'.hardlink';linkSync(f.file,hardlink);assert.equal(f.configure().status,1);rmSync(hardlink);
  const original=f.file+'.original';writeFileSync(original,JSON.stringify(f.connection),{mode:0o600});rmSync(f.file);symlinkSync(original,f.file);assert.equal(f.configure().status,1);
  rmSync(f.file);writeFileSync(f.file,JSON.stringify(f.connection),{mode:0o600});
  writeFileSync(f.target,JSON.stringify({...f.draft,provider:'linq',serviceNumber:'+12025550124'}));const unsupported=readFileSync(f.target,'utf8');
  assert.equal(f.configure().status,1);assert.equal(readFileSync(f.target,'utf8'),unsupported);
  assert.equal(readdirSync(dirname(f.target)).some(name=>name.startsWith('.relay-')),false);
});
test('relay import refuses linked targets and nonprivate configuration directories',t=>{
  const f=relayFixture(t),saved=readFileSync(f.target,'utf8'),original=f.target+'.original';
  writeFileSync(original,saved,{mode:0o600});rmSync(f.target);symlinkSync(original,f.target);
  assert.equal(f.configure().status,1);assert.equal(readFileSync(original,'utf8'),saved);
  rmSync(f.target);writeFileSync(f.target,saved,{mode:0o600});chmodSync(dirname(f.target),0o755);
  assert.equal(f.configure().status,1);assert.equal(readFileSync(f.target,'utf8'),saved);
  chmodSync(dirname(f.target),0o700);
});
test('doctor reports relay presence without credentials and installer reuse chooses the correct connection guidance',t=>{
  const f=relayFixture(t);assert.equal(f.configure().status,0);
  const doctor=spawnSync(process.execPath,[cli,'doctor','--config',f.target],{encoding:'utf8',timeout:5000});
  assert.equal(doctor.status,0,doctor.stderr);assert.match(doctor.stdout,/"relayConfigured": true/);assert.equal(doctor.stdout.includes(f.connection.token),false);assert.equal(doctor.stdout.includes(f.connection.deviceId),false);
  const repo=join(dirname(f.target),'installer');mkdirSync(join(repo,'scripts'),{recursive:true});
  copyFileSync(resolve('scripts/install.sh'),join(repo,'scripts/install.sh'));
  symlinkSync(resolve(dirname(cli),'..'),join(repo,'dist'),'dir');
  const install=()=>spawnSync('bash',[join(repo,'scripts/install.sh'),'--node',process.execPath,'--config',f.target],{encoding:'utf8',timeout:5000});
  const relay=install();assert.equal(relay.status,0,relay.stderr);assert.match(relay.stdout,/outbound relay is configured/);assert.doesNotMatch(relay.stdout,/configure a matching provider webhook/);
  writeFileSync(f.target,JSON.stringify(f.draft));const direct=install();assert.equal(direct.status,0,direct.stderr);assert.match(direct.stdout,/configure a matching provider webhook/);
});

function liveCliFixture(t:test.TestContext) {
  const f=fixture(t),directory=dirname(f.target),dataDir=join(directory,'data'),invocations=join(directory,'invocations.jsonl'),binary=join(directory,'fake-codex.mjs');
  mkdirSync(dataDir,{mode:0o700});
  writeFileSync(binary,`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(invocations)},JSON.stringify(process.argv.slice(2))+'\\n');\nif(process.argv[2]==='--version'){console.log('codex fixture');process.exit(0);}\nprocess.exit(1);\n`,{mode:0o700});
  Object.assign(f.draft,{dataDir,cwd:join(directory,'workspace'),codexBinary:binary});writeFileSync(f.source,JSON.stringify(f.draft));assert.equal(f.run().status,0);
  const run=(args:string[])=>spawnSync(process.execPath,[cli,...args,'--config',f.target],{encoding:'utf8',timeout:5000});
  return {...f,dataDir,invocations,command:run};
}

test('live CLI commands refuse shared worker ownership before invoking an agent; ordinary diagnostics remain available',t=>{
  const f=liveCliFixture(t),release=acquireLock(f.dataDir);
  try {
    for(const args of [['doctor','--live'],['ask','--text','fixture prompt']]) {
      const result=f.command(args);assert.equal(result.status,1);assert.match(result.stderr,/already running/);assert.match(result.stderr,/ordinary doctor\/status/);
      assert.equal(result.stderr.includes(f.dataDir),false);assert.doesNotMatch(result.stderr,/worker-lock\.sqlite/);
    }
    assert.equal(f.command(['doctor']).status,0);assert.equal(f.command(['status']).status,0);
    const invocations=readFileSync(f.invocations,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(invocations,[['--version'],['--version']]);
    assert.throws(()=>acquireLock(f.dataDir),/already using/);
  } finally {release();}
});

test('failed live CLI turns release ownership for the next worker',t=>{
  const f=liveCliFixture(t);
  for(const args of [['doctor','--live'],['ask','--text','fixture prompt']]) {
    const result=f.command(args);assert.equal(result.status,1);assert.doesNotMatch(result.stderr,/already running/);
    acquireLock(f.dataDir)();
  }
  const invocations=readFileSync(f.invocations,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(invocations.filter(args=>args[0]==='app-server').length,2);
});
