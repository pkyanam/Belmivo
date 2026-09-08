import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {audit,privateValues,scanText} from './audit-release.mjs';
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']});
function fixture(t) {
  const base=mkdtempSync(join(tmpdir(),'belmivo-audit-fixture-')),repo=join(base,'repo'),config=join(base,'private.json');
  mkdirSync(repo);git(repo,['init','--initial-branch=main','--template=']);
  writeFileSync(config,JSON.stringify({allowedSenders:['+12025550123'],providerApiSecret:'private-test-value-123456789'}),{mode:0o600});
  writeFileSync(join(repo,'.gitignore'),'work/\n');git(repo,['add','.gitignore']);
  t.after(()=>rmSync(base,{recursive:true,force:true}));
  return {base,repo,config};
}
test('fixtures and package versions are accepted; ordinary email, path and tokens reviewed',()=>{
  assert.deepEqual(scanText('person@example.com person@example.test /Users/YOUR_NAME/project spectrum-ts@12.8.0'),{});
  assert.equal(scanText(['person','company.com'].join(String.fromCharCode(64)))['email-review'],1);
  assert.equal(scanText(join('/Users','not-a-placeholder','project'))['personal-path'],1);
  assert.equal(scanText('ghp_'+'x'.repeat(36))['secret-pattern'],1);
  assert.equal(scanText(['-----BEGIN','PRIVATE KEY-----'].join(' '))['secret-pattern'],1);
});
test('exact private config values, number without plus and serialized variants are detected',()=>{
  const values=privateValues({allowedSenders:['+12025550123'],relay:{token:'private-token-123456789',url:'https://private-host.test'}},join('/Users','not-a-placeholder'));
  for(const value of ['12025550123','private-token-123456789','private-host.test',join('/Users','not-a-placeholder')])assert.ok(scanText(value,values)['private-config-value']);
});
test('current worktree edits pass independently of sensitive historical blobs',t=>{
  const f=fixture(t),path=join(f.repo,'file.txt');
  writeFileSync(path,'private-test-value-123456789\n');git(f.repo,['add','.']);
  git(f.repo,['-c','user.name=Release Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);
  writeFileSync(path,'clean worktree\n');
  assert.deepEqual(audit(f).findings,[]);
  const result=audit({...f,history:true});
  assert.ok(result.findings.some(x=>x.scope==='history'&&x.path==='file.txt'));
  assert.equal(JSON.stringify(result).includes('private-test-value-123456789'),false);
});
test('snapshot uses audited worktree bytes without commits, remotes, or untracked files',t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'tracked.txt'),'first');git(f.repo,['add','.']);
  writeFileSync(join(f.repo,'tracked.txt'),'latest');writeFileSync(join(f.repo,'untracked.txt'),'private-test-value-123456789');
  const result=audit({...f,snapshot:'work/release'}),destination=join(f.repo,'work/release');
  assert.equal(readFileSync(join(destination,'tracked.txt'),'utf8'),'latest');
  assert.equal(git(destination,['remote']).trim(),'');
  assert.throws(()=>git(destination,['rev-parse','--verify','HEAD']));
  assert.equal(result.snapshot.files,2);assert.throws(()=>readFileSync(join(destination,'untracked.txt')));
  assert.throws(()=>audit({...f,snapshot:'work/release'}));
});
test('snapshot refuses current private findings and unsafe destination',t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'file.txt'),'private-test-value-123456789');git(f.repo,['add','.']);
  assert.throws(()=>audit({...f,snapshot:'work/release'}),/snapshot-blocked/);
  writeFileSync(join(f.repo,'file.txt'),'clean');
  assert.throws(()=>audit({...f,snapshot:'../outside'}));
  assert.throws(()=>audit({...f,snapshot:'work/nested/release'}));
});
test('private configuration permissions and symlinks fail closed',t=>{
  const f=fixture(t);chmodSync(f.config,0o644);assert.throws(()=>audit(f));chmodSync(f.config,0o600);
  const link=join(f.base,'config-link');symlinkSync(f.config,link);assert.throws(()=>audit({...f,config:link}));
});
test('tracked binary and symlink inputs require review',t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'binary.bin'),Buffer.from([0,1,2]));symlinkSync('../private.json',join(f.repo,'linked'));
  git(f.repo,['add','.']);const result=audit(f);
  assert.ok(result.findings.some(x=>x.path==='binary.bin'&&x.counts['binary-needs-review']));
  assert.ok(result.findings.some(x=>x.path==='linked'&&x.counts['unsupported-file-type']));
});


test('patterns-only audit works without access to a private configuration',t=>{
  const f=fixture(t);
  const result=audit({repo:f.repo,patternsOnly:true,config:join(f.base,'does-not-exist')});
  assert.deepEqual(result.findings,[]);
});
