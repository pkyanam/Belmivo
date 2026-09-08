import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const helper=fileURLToPath(new URL('./launchd-bootout.sh',import.meta.url));
const installer=fileURLToPath(new URL('./launchd.sh',import.meta.url));
const domain=`gui/${process.getuid()}`;
const target=`${domain}/com.codex-imessage.bridge`;
function fixture(t,{delay='2',refuse=false,state='loaded'}={}) {
  const directory=mkdtempSync(join(tmpdir(),'codex-imessage-launchd-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(join(directory,'state'),state);
  writeFileSync(join(directory,'calls'),'');
  writeFileSync(join(directory,'sleep'),'#!/bin/bash\nexit 0\n',{mode:0o700});
  writeFileSync(join(directory,'launchctl'),String.raw`#!/bin/bash
set -euo pipefail
printf '%s\n' "$1" >> "$CODEX_TEST_LAUNCHD_DIR/calls"
state="$(cat "$CODEX_TEST_LAUNCHD_DIR/state")"
case "$1" in
  print)
    if [[ "$state" == absent ]]; then exit 113; fi
    if [[ "$state" == unloading:* ]]; then
      left="$(printf '%s' "$state" | cut -d: -f2)"
      if [[ "$left" != forever ]]; then
        if [[ "$left" -eq 0 ]]; then printf absent > "$CODEX_TEST_LAUNCHD_DIR/state"; exit 113; fi
        printf 'unloading:%s' "$((left-1))" > "$CODEX_TEST_LAUNCHD_DIR/state"
      fi
    fi ;;
  bootout)
    [[ "$CODEX_TEST_LAUNCHD_REFUSE" == 0 ]] || exit 1
    printf 'unloading:%s' "$CODEX_TEST_LAUNCHD_DELAY" > "$CODEX_TEST_LAUNCHD_DIR/state" ;;
  bootstrap)
    if [[ "$state" != absent ]]; then echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi
    printf loaded > "$CODEX_TEST_LAUNCHD_DIR/state" ;;
  *) exit 2 ;;
esac
`,{mode:0o700});
  const env={...process.env,PATH:`${directory}:${process.env.PATH}`,CODEX_TEST_LAUNCHD_DIR:directory,CODEX_TEST_LAUNCHD_DELAY:delay,CODEX_TEST_LAUNCHD_REFUSE:refuse?'1':'0'};
  return {directory,env,calls:()=>readFileSync(join(directory,'calls'),'utf8').trim().split('\n').filter(Boolean)};
}
function replace(f,targetOverride=target) {
  return spawnSync('/bin/bash',['-c','bash "$1" "$2" && launchctl bootstrap "$3" "$4"','--',helper,targetOverride,domain,'unused-test.plist'],{env:f.env,encoding:'utf8',timeout:5000});
}

test('asynchronous removal reproduces bootstrap5; waiting permits one replacement',t=>{
  const f=fixture(t);
  const immediate=spawnSync('/bin/bash',['-c','launchctl bootout "$1" && launchctl bootstrap "$2" unused-test.plist','--',target,domain],{env:f.env,encoding:'utf8'});
  assert.equal(immediate.status,5);
  writeFileSync(join(f.directory,'state'),'loaded'); writeFileSync(join(f.directory,'calls'),'');
  const result=replace(f);
  assert.equal(result.status,0,result.stderr);
  assert.equal(f.calls().filter(x=>x==='bootout').length,1);
  assert.equal(f.calls().filter(x=>x==='bootstrap').length,1);
  assert.equal(readFileSync(join(f.directory,'state'),'utf8'),'loaded');
});

test('a service that never disappears times out without attempting bootstrap',t=>{
  const f=fixture(t,{delay:'forever'});
  const result=replace(f);
  assert.equal(result.status,1);
  assert.match(result.stderr,/still unloading/);
  assert.equal(f.calls().includes('bootstrap'),false);
  assert.equal(f.calls().filter(x=>x==='bootout').length,1);
  assert.ok(f.calls().filter(x=>x==='print').length<=41);
});

test('failed bootout does not wait or bootstrap another service',t=>{
  const f=fixture(t,{refuse:true});
  assert.equal(replace(f).status,1);
  assert.deepEqual(f.calls(),['print','bootout']);
});

test('unrelated labels are rejected before invoking launchctl',t=>{
  const f=fixture(t);
  assert.equal(replace(f,`${domain}/com.someone-else.agent`).status,2);
  assert.deepEqual(f.calls(),[]);
});

test('an absent service requires no removal or wait',t=>{
  const f=fixture(t,{state:'absent'});
  assert.equal(replace(f).status,0);
  assert.deepEqual(f.calls(),['print','bootstrap']);
});

function installerFixture(t,options={}) {
  const f=fixture(t,options),repo=join(f.directory,'checkout'),plist=join(f.directory,'bridge.plist');
  mkdirSync(join(repo,'scripts'),{recursive:true});mkdirSync(join(repo,'dist/src'),{recursive:true});
  copyFileSync(helper,join(repo,'scripts/launchd-bootout.sh'));
  // Redirect only the fixture's plist path. All ownership and lifecycle logic is
  // the production script, and HOME/the real LaunchAgents directory are untouched.
  const source=readFileSync(installer,'utf8');
  const assignment='plist_path="$HOME/Library/LaunchAgents/$label.plist"';
  assert.ok(source.includes(assignment));
  writeFileSync(join(repo,'scripts/launchd.sh'),source.replace(assignment,'plist_path="$CODEX_TEST_PLIST"'));
  writeFileSync(join(repo,'dist/src/cli.js'),'if(process.argv[2]!=="doctor")process.exit(1);\n');
  writeFileSync(join(f.directory,'uname'),'#!/bin/bash\necho Darwin\n',{mode:0o700});
  if(process.platform!=='darwin') {
    // Linux CI has no Apple plutil. This stand-in parses fixture XML metadata;
    // file ownership, same-file comparison, staging and renames still run for real.
    writeFileSync(join(f.directory,'plutil'),`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs');const args=process.argv.slice(2);const xml=fs.readFileSync(args.at(-1),'utf8');
if(args[0]==='-lint'){if(!xml.includes('<plist')||!xml.includes('</plist>'))process.exit(1);process.exit(0)}
const value=args[1]==='Label'?xml.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1]:[...((xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1])??'').matchAll(/<string>([^<]*)<\/string>/g)][1]?.[1];
if(value===undefined)process.exit(1);process.stdout.write(value);
`,{mode:0o700});
  }
  const env={...f.env,CODEX_TEST_PLIST:plist};
  const writePlist=cli=>writeFileSync(plist,`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.codex-imessage.bridge</string><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${cli}</string><string>start</string></array></dict></plist>`,{mode:0o600});
  writePlist(join(repo,'dist/src/cli.js'));
  const run=action=>spawnSync('/bin/bash',[join(repo,'scripts/launchd.sh'),action,'--node',process.execPath,'--config',join(f.directory,'config.json')],{env,encoding:'utf8',timeout:10000});
  return {...f,repo,plist,env,writePlist,run};
}

test('renamed checkout compatibility symlink is accepted by the actual uninstall path',t=>{
  const f=installerFixture(t),old=join(f.directory,'old-checkout');
  symlinkSync(f.repo,old,'dir');f.writePlist(join(old,'dist/src/cli.js'));
  const result=f.run('uninstall');assert.equal(result.status,0,result.stderr);
  assert.equal(f.calls().filter(call=>call==='bootout').length,1);
  assert.equal(existsSync(f.plist),false);
  assert.equal(readFileSync(join(f.directory,'state'),'utf8'),'absent');
});

test('a distinct checkout with identical CLI contents cannot stop or replace the owned service',t=>{
  const f=installerFixture(t),other=join(f.directory,'other-checkout');
  mkdirSync(join(other,'dist/src'),{recursive:true});copyFileSync(join(f.repo,'dist/src/cli.js'),join(other,'dist/src/cli.js'));
  const alias=join(f.directory,'old-checkout');symlinkSync(other,alias,'dir');f.writePlist(join(alias,'dist/src/cli.js'));
  const original=readFileSync(f.plist,'utf8');
  for(const action of ['uninstall','install']) {
    const result=f.run(action);assert.equal(result.status,1);assert.match(result.stderr,/different checkout/);
    assert.equal(readFileSync(f.plist,'utf8'),original);
  }
  assert.equal(f.calls().includes('bootout'),false);assert.equal(f.calls().includes('bootstrap'),false);
});

test('failed owned removal preserves the existing plist and cleans its staged replacement',t=>{
  const f=installerFixture(t,{refuse:true}),original=readFileSync(f.plist,'utf8');
  const result=f.run('install');assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/did not confirm removal/);
  assert.equal(readFileSync(f.plist,'utf8'),original);
  assert.equal(readdirSync(f.directory).some(name=>name.startsWith('bridge.plist.')),false);
  assert.equal(f.calls().includes('bootstrap'),false);
});

test('an unloading timeout leaves the original plist and no staged helper files or replacement service',t=>{
  const f=installerFixture(t,{delay:'forever'}),original=readFileSync(f.plist,'utf8');
  const result=f.run('install');assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/still unloading/);
  assert.equal(readFileSync(f.plist,'utf8'),original);
  assert.equal(readdirSync(f.directory).some(name=>name.startsWith('bridge.plist.')),false);
  assert.equal(f.calls().includes('bootstrap'),false);assert.equal(f.calls().filter(call=>call==='bootout').length,1);
});

test('successful owned replacement waits for removal and installs a bounded graceful exit timeout',t=>{
  const f=installerFixture(t);const result=f.run('install');assert.equal(result.status,0,result.stderr);
  const installed=readFileSync(f.plist,'utf8');assert.match(installed,/<key>ExitTimeOut<\/key><integer>30<\/integer>/);
  assert.equal(f.calls().filter(call=>call==='bootout').length,1);assert.equal(f.calls().filter(call=>call==='bootstrap').length,1);
  assert.equal(readdirSync(f.directory).some(name=>name.startsWith('bridge.plist.')),false);
  assert.equal(readFileSync(join(f.directory,'state'),'utf8'),'loaded');
});
