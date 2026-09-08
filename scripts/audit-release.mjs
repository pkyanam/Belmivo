#!/usr/bin/env node
// Offline release review. Reports locations/counts only, never matched values.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE = 16 * 1024 * 1024;
const git = (cwd, args, input) => execFileSync('git', args, {cwd, input, encoding:'utf8', maxBuffer:128*1024*1024, stdio:['pipe','pipe','pipe']});
const reservedEmail = value => /@(?:[^@.]+\.)*(?:example\.(?:com|org|net)|example|invalid|test|localhost)$/i.test(value);

export function privateValues(config, home = homedir()) {
  const values = new Set([home]);
  const visit = (value, key = '') => {
    if (Array.isArray(value)) { for (const child of value) visit(child, key); return; }
    if (value && typeof value === 'object') { for (const [name, child] of Object.entries(value)) visit(child, name); return; }
    if (typeof value !== 'string' || value.length < 8) return;
    if (/secret|token|api.?key|allowedSenders|serviceNumber|email|desktopThreadId|deviceId|^url$|cwd|dataDir|artifactsDir|socket/i.test(key)) {
      values.add(value);
      values.add(encodeURIComponent(value));
      values.add(JSON.stringify(value).slice(1,-1));
      if(key==='url') {try{values.add(new URL(value).hostname);}catch{}}
      if (/^\+[1-9]\d{7,14}$/.test(value)) values.add(value.slice(1));
    }
  };
  visit(config);
  return [...values].filter(value => value.length >= 8 && value !== '/Users/example' && value !== '/home/example');
}

export function scanText(text, values = []) {
  const counts = {};
  const add = (kind, count = 1) => { if(count) counts[kind] = (counts[kind] ?? 0) + count; };
  for (const value of new Set(values)) {
    let from = 0, count = 0;
    while ((from = text.indexOf(value, from)) !== -1) { count++; from += value.length; }
    add('private-config-value', count);
  }
  for (const match of text.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}(?![A-Z0-9-])/gi)) {
    if (!reservedEmail(match[0])) add('email-review');
  }
  for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9_.-]+)(?=\/|\b)/g)) {
    if (!/^(?:example|user|username|you|your[-_](?:user|name|username)|yourname|runner|node|app|nonroot|codex)$/i.test(match[1])) add('personal-path');
  }
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
    /\bAKIA[A-Z0-9]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/g,
  ];
  for(const pattern of patterns) add('secret-pattern', [...text.matchAll(pattern)].length);
  return counts;
}

function safePath(path, values) {
  for(const value of [...values].sort((a,b)=>b.length-a.length)) path=path.split(value).join('[private]');
  return path.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi,'[email]');
}
function configValues(path) {
  if(!existsSync(path)) throw new Error('private-config-unavailable');
  const stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077) || stat.uid!==process.getuid?.() || stat.size>MAX_FILE) throw new Error('private-config-not-private-regular-file');
  return privateValues(JSON.parse(readFileSync(path,'utf8')));
}
function argsOf(args) {
  const options={history:false,config:process.env.CODEX_IMESSAGE_CONFIG ?? join(homedir(),'.config','codex-imessage','config.json')};
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg==='--history')options.history=true;
    else if(arg==='--patterns-only')options.patternsOnly=true;
    else if(['--config','--snapshot','--repo'].includes(arg) && args[i+1] && !args[i+1].startsWith('--'))options[arg.slice(2)]=args[++i];
    else if(arg==='--help')options.help=true;
    else throw new Error('invalid-arguments');
  }
  return options;
}

export function audit(options) {
  const root=realpathSync(git(resolve(options.repo??process.cwd()),['rev-parse','--show-toplevel']).trim());
  const values=options.patternsOnly?[]:configValues(resolve(options.config));
  const findings=[], files=[];
  const record=(scope,path,counts)=>{if(Object.keys(counts).length)findings.push({scope,path:safePath(path,values),counts});};
  const entries=git(root,['ls-files','--stage','-z']).split('\0').filter(Boolean);
  const seen=new Set();
  for(const entry of entries) {
    const tab=entry.indexOf('\t'), [mode,,stage]=entry.slice(0,tab).split(' '), path=entry.slice(tab+1);
    if(stage!=='0') {record('current',path,{'unmerged-index':1});continue;}
    if(seen.has(path))continue;seen.add(path);
    const absolute=resolve(root,path);
    if(!absolute.startsWith(root+sep))throw new Error('invalid-tracked-path');
    if(!existsSync(absolute))continue; // A worktree deletion is absent from the snapshot.
    const stat=lstatSync(absolute);
    if(!stat.isFile() || stat.isSymbolicLink() || mode==='160000') {record('current',path,{'unsupported-file-type':1});continue;}
    if(stat.size>MAX_FILE) {record('current',path,{'unscanned-large-file':1});continue;}
    const real=realpathSync(absolute);
    if(!real.startsWith(root+sep)) {record('current',path,{'external-file':1});continue;}
    const bytes=readFileSync(absolute);
    record('current',path,scanText(path+'\n'+bytes.toString('utf8'),values));
    if(bytes.includes(0))record('current',path,{'binary-needs-review':1});
    files.push({path,bytes,executable:!!(stat.mode&0o111)});
  }
  let historyObjects=0;
  if(options.history) {
    const objects=git(root,['rev-list','--objects','--all']).trim().split('\n').filter(Boolean);
    const names=new Map(objects.map(line=>{const space=line.indexOf(' ');return space<0?[line,'(git metadata)']:[line.slice(0,space),line.slice(space+1)];}));
    const batch=git(root,['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],[...names.keys()].join('\n')+'\n');
    for(const line of batch.trim().split('\n')) {
      const [id,type,size]=line.split(' ');
      if(!['blob','commit','tag'].includes(type))continue;
      historyObjects++;
      const path=type==='blob'?names.get(id):`(git ${type} metadata)`;
      if(Number(size)>MAX_FILE) {record('history',path,{'unscanned-large-object':1});continue;}
      const body=git(root,['cat-file',type,id]);
      record('history',path,scanText(path+'\n'+body,values));
      if(body.includes('\0'))record('history',path,{'binary-needs-review':1});
    }
  }
  const report={currentFiles:files.length,historyScanned:!!options.history,historyObjects,findings};
  if(options.snapshot) {
    if(findings.some(finding=>finding.scope==='current'))throw Object.assign(new Error('snapshot-blocked-current-findings'),{report});
    const work=join(root,'work');
    if(existsSync(work) && (lstatSync(work).isSymbolicLink() || !lstatSync(work).isDirectory()))throw new Error('unsafe-work-directory');
    mkdirSync(work,{recursive:true,mode:0o700});
    const destination=resolve(root,options.snapshot);
    if(!destination.startsWith(work+sep) || existsSync(destination) || relative(work,destination).includes(sep))throw new Error('snapshot-requires-new-direct-child-of-work');
    git(root,['check-ignore',relative(root,destination)]);
    mkdirSync(destination,{mode:0o700});
    for(const file of files) {
      const target=join(destination,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o755});
      writeFileSync(target,file.bytes,{flag:'wx',mode:file.executable?0o755:0o644});
    }
    git(destination,['init','--initial-branch=main','--template=']);
    report.snapshot={path:relative(root,destination),files:files.length,commits:0,remotes:0};
  }
  return report;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const options=argsOf(process.argv.slice(2));
    if(options.help) console.log('Usage: node scripts/audit-release.mjs [--config PRIVATE_FILE | --patterns-only] [--history] [--snapshot work/NEW_NAME] [--repo PATH]\nPatterns-only mode uses generic detectors and requires no private configuration. Offline; scans tracked worktree bytes and optionally reachable Git history/metadata. Findings are review candidates. No values, excerpts, network, commits or remotes. Snapshot includes only audited tracked files; stage intended new files first. A clean scan is not a guarantee; compressed/binary content requires separate review.');
    else {const report=audit(options);console.log(JSON.stringify(report,null,2));if(report.findings.length)process.exitCode=1;}
  } catch(error) {
    if(error?.report)console.log(JSON.stringify(error.report,null,2));
    // Do not emit raw filesystem, JSON or git errors: those can include private input.
    console.error(JSON.stringify({error:['snapshot-blocked-current-findings','private-config-unavailable','private-config-not-private-regular-file','invalid-arguments','invalid-tracked-path','unsafe-work-directory','snapshot-requires-new-direct-child-of-work'].includes(error?.message)?error.message:'audit-failed'}));
    process.exitCode=2;
  }
}
