#!/usr/bin/env node
import { existsSync, mkdirSync, readSync, lstatSync, openSync, closeSync, fstatSync, writeFileSync, fsyncSync, renameSync, unlinkSync, constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { defaultConfigPath, defaultCodexBinary, readConfig, parseConfig, writePrivateConfig } from './config.js';
import { createAgent } from './agent.js';
import { createProvider } from './providers.js';
import { Bridge } from './bridge.js';
import { Store } from './store.js';
import { acquireLock } from './lock.js';
import { inspectStorage } from './storage.js';
import { fileURLToPath } from 'node:url';

const args=process.argv.slice(2);
const command=args[0] ?? 'help';
function option(name:string):string|undefined { const i=args.indexOf(name);return i<0?undefined:args[i+1]; }
const configPath=resolve(option('--config') ?? process.env.CODEX_IMESSAGE_CONFIG ?? defaultConfigPath);
const shellQuote=(value:string)=>`'${value.replaceAll("'", "'\\''")}'`;
const localCommand=(command:string)=>[process.execPath,fileURLToPath(import.meta.url),command,'--config',configPath].map(shellQuote).join(' ');

function privateObject(path:string,label:string) {
  let fd:number;
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);} catch {throw new Error(`${label} must be an available private regular file.`);}
  try {
    const info=fstatSync(fd);
    if(!info.isFile() || info.nlink!==1 || (info.mode & 0o077)!==0 || info.uid!==process.getuid?.() || info.size>65536)throw new Error(`${label} must be an owner-only regular file (mode 0600), without links, up to 64 KiB.`);
    const bytes=Buffer.alloc(65537);let length=0;
    while(length<bytes.length) {const count=readSync(fd,bytes,length,bytes.length-length,null);if(!count)break;length+=count;}
    if(length>65536)throw new Error(`${label} exceeds the private configuration size limit.`);
    const raw=bytes.subarray(0,length).toString('utf8');
    let draft:Record<string,unknown>;
    try {draft=JSON.parse(raw);} catch {throw new Error(`${label} must contain valid JSON. Contents were not printed.`);}
    if(!draft || typeof draft!=='object' || Array.isArray(draft))throw new Error(`${label} must contain a JSON object.`);
    return {raw,draft,info};
  } finally {closeSync(fd);}
}

function relayConfigure():void {
  const seen=new Set<string>();
  for(let i=2;i<args.length;i++) {
    const flag=args[i]!;
    if(!['--from','--config','--replace'].includes(flag)||seen.has(flag))throw new Error('Unsupported or repeated relay option. Use relay configure --from FILE [--replace] [--config PATH].');
    seen.add(flag);
    if(flag!=='--replace' && (!args[++i] || args[i]!.startsWith('--')))throw new Error('Relay file options require a path.');
  }
  const from=option('--from');
  if(args[1]!=='configure' || !from || from.startsWith('--'))throw new Error('Usage: relay configure --from PRIVATE_CONNECTION_JSON [--replace] [--config PATH]');
  const connection=privateObject(resolve(from),'Relay input').draft;
  const keys=Object.keys(connection).sort();
  if(keys.join(',')!=='deviceId,token,url' || keys.some(key=>typeof connection[key]!=='string'))throw new Error('Relay input must contain only url, deviceId, and token strings. Secrets are not accepted as flags.');
  const original=privateObject(configPath,'Existing configuration');
  const parent=lstatSync(dirname(configPath));
  if(!parent.isDirectory() || parent.isSymbolicLink() || parent.uid!==process.getuid?.() || (parent.mode & 0o077)!==0)throw new Error('Configuration directory must be owned by this user, private (mode 0700), and not a symbolic link.');
  if(original.draft.provider!=='photon')throw new Error('Relay configuration currently supports Photon only.');
  const updated={...original.draft,relay:connection};
  try {parseConfig(original.draft,configPath);parseConfig(updated,configPath);} catch {throw new Error('Relay input or existing bridge configuration is invalid. Check HTTPS origin, device credentials, and bridge settings privately.');}
  const previous=original.draft.relay as Record<string,unknown>|undefined;
  if(previous && keys.every(key=>previous[key]===connection[key])) {
    console.log('Relay configuration already matches. No files or services changed.');
    return;
  }
  if(previous && !args.includes('--replace'))throw new Error('A different relay is already configured. Use --replace only when you intend to replace that connection.');
  const temporary=join(dirname(configPath),`.relay-${randomUUID()}.tmp`);
  let fd:number|undefined;
  let created=false;
  try {
    fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=true;
    writeFileSync(fd,JSON.stringify(updated,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    const current=privateObject(configPath,'Existing configuration');
    if(current.raw!==original.raw || current.info.ino!==original.info.ino || current.info.dev!==original.info.dev || current.info.ctimeMs!==original.info.ctimeMs)throw new Error('Configuration changed during import. No update was applied; inspect it and retry.');
    renameSync(temporary,configPath);
  } finally {
    if(fd!==undefined)closeSync(fd);
    if(created)try {unlinkSync(temporary);} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  console.log('Private relay configuration saved. Other settings were preserved. No service was restarted.');
  console.log('Next: check status and the app task; wait until work is idle, then restart the owned bridge service. This does not enroll a device or change provider webhooks.');
}

async function setup():Promise<void> {
  if(existsSync(configPath)) {
    const existing=parseConfig(privateObject(configPath,'Existing configuration').draft,configPath);
    console.log(`Using existing private configuration (${existing.provider}, ${existing.backend}). No settings or services changed. Run doctor or status to inspect it.`);
    return;
  }
  const from=option('--from');
  if(from) {
    const draft=privateObject(resolve(from),'Setup input').draft;
    parseConfig(draft,configPath);
    writePrivateConfig(configPath,draft);
    console.log(`Saved private configuration.\nNext: ${localCommand('doctor')}`);
    return;
  }
  let muted=false;
  const output=new Writable({write(chunk,_encoding,done){if(!muted)process.stdout.write(chunk);done();}});
  const rl=createInterface({input:process.stdin,output,terminal:process.stdin.isTTY===true});
  try {
    console.log('Belmivo — personal Mac setup\nPhoton is the recommended free evaluation; Linq is the first alternative. Provider accounts and dedicated numbers have separate terms.\nSecrets are hidden while typing. Full Access lets your approved sender use the agent’s available tools.');
    const ask=async(q:string,def='')=>(await rl.question(`${q}${def?` [${def}]`:''}: `)).trim()||def;
    const secret=async(q:string)=>{const pending=rl.question(`${q}: `);muted=true;try{return(await pending).trim();}finally{muted=false;process.stdout.write('\n');}};
    const provider=option('--provider')??await ask('Provider (photon/linq/sendblue/blooio)','photon');
    if(!['photon','linq','sendblue','blooio'].includes(provider))throw new Error('Choose photon, linq, sendblue, or blooio.');
    const allowedSenders=(option('--sender')??await ask('Your phone number (+country code)')).split(',').map(n=>n.trim());
    const serviceNumber=option('--service-number')??(provider==='photon'?'shared':await ask('Provider iMessage phone number'));
    if(serviceNumber==='shared')console.log('Using Photon’s free shared line for evaluation. A dedicated number is a separate step.');
    const backend=option('--backend')??'desktop';
    const desktopThreadId=backend==='desktop'?(option('--thread')??await ask('Dedicated iMessage Agent task ID from the app')):undefined;
    const fullAccess=args.includes('--full-access') || (await ask('Enable Full Access for approved senders? (yes/no)','yes'))==='yes';
    const cwd=resolve(option('--cwd')??join(homedir(),'Code','iMessage-Agent'));
    const artifactsDir=resolve(option('--artifacts-dir')??join(cwd,'outputs'));
    const providerApiKey=provider==='photon'?await ask('Photon project ID'):await secret('Provider API key');
    const providerApiSecret=['sendblue','photon'].includes(provider)?await secret('Provider API/project secret'):undefined;
    const webhookSecret=await secret('Webhook signing secret (from provider registration)');
    const draft={provider,allowedSenders,serviceNumber,allowSharedSandbox:provider==='photon' && serviceNumber==='shared',providerApiKey,providerApiSecret,webhookSecret,fullAccess,cwd,artifactsDir,backend,desktopThreadId,codexBinary:defaultCodexBinary()};
    parseConfig(draft,configPath);
    writePrivateConfig(configPath,draft);
    console.log(`\nSaved ${configPath}\nNext: ${localCommand('doctor')}\nThen: ${localCommand('start')}\nWebhook path: /webhooks/${provider}\nConnect with an enrolled outbound relay using relay configure --from PRIVATE_FILE, or use scripts/tunnel.sh for a durable webhook tunnel. For guided setup, use docs/AGENT-SETUP-PROMPT.md.`);
  } finally {rl.close();output.end();}
}

async function doctor():Promise<void> {
  const c=readConfig(configPath);
  const version=spawnSync(c.codexBinary,['--version'],{encoding:'utf8',timeout:10000});
  const binaryOkay=version.status===0;
  const report={node:process.version,nodeSupported:Number(process.versions.node.split('.')[0])>=24,platform:process.platform,configReadable:true,provider:c.provider,allowlistCount:c.allowedSenders.length,fullAccess:c.fullAccess,backend:c.backend,relayConfigured:c.relay!==undefined,connection:c.relay?'outbound-relay':'direct-webhook',codex:binaryOkay?version.stdout.trim():'not available',dataDirectory:c.dataDir,desktopParity:c.backend==='desktop'?'experimental; requires dedicated task validation':'not claimed: standalone Codex tools may differ from desktop'};
  console.log(JSON.stringify(report,null,2));
  if(!binaryOkay) throw new Error('Codex binary is unavailable. Install/open ChatGPT/Codex or configure codexBinary.');
  if(args.includes('--live')) {
    await withExclusiveAgent(c,async agent=>{
      const result=await agent.run({text:'Reply with exactly CODEX_IMESSAGE_OK. Do not use tools.',onThread:()=>{}});
      console.log(JSON.stringify({liveAgent:result.text.trim()==='CODEX_IMESSAGE_OK'?'passed':'unexpected response',threadId:result.threadId}));
      if(result.text.trim()!=='CODEX_IMESSAGE_OK') process.exitCode=1;
    });
  } else {
    console.log(`If the receiver is already running, inspect it with ${localCommand('status')}.`);
    console.log(`For a new setup, ${c.backend==='desktop'?'open the configured app task, then ':''}run ${localCommand('start')} and verify one authorized phone exchange.`);
    console.log(`Optional troubleshooting only: ${localCommand('doctor')} --live consumes account allowance and requires the receiver to be stopped.`);
  }
}

async function withExclusiveAgent(config:ReturnType<typeof readConfig>,action:(agent:ReturnType<typeof createAgent>)=>Promise<void>):Promise<void> {
  let release:()=>void;
  try {mkdirSync(config.dataDir,{recursive:true,mode:0o700});release=acquireLock(config.dataDir);}
  catch(error) {
    if(error instanceof Error && error.message.includes('already using'))throw new Error('The bridge or another live CLI command is already running. Use ordinary doctor/status, or safely stop the owned bridge while idle before running a live CLI turn.');
    throw new Error('Could not obtain exclusive agent ownership. Check that the configured data directory is private and owned by you.');
  }
  try {
    mkdirSync(config.cwd,{recursive:true,mode:0o700});
    const agent=createAgent(config);
    try {await action(agent);} finally {await agent.close();}
  } finally {release();}
}

async function main():Promise<void> {
  if(Number(process.versions.node.split('.')[0])<24) throw new Error('Node.js 24+ is required (including launchd service).');
  if(command==='setup') return setup();
  if(command==='relay') return relayConfigure();
  if(command==='doctor') return doctor();
  if(command==='storage') {
    const c=parseConfig(privateObject(configPath,'Existing configuration').draft,configPath);
    console.log(JSON.stringify(await inspectStorage(c.dataDir,configPath),null,2));
    return;
  }
  if(command==='start') {
    const c=readConfig(configPath);
    const bridge=new Bridge({config:c,provider:createProvider(c),agent:createAgent(c)});
    await bridge.start();
    let closing=false;
    const close=()=>{if(closing)return;closing=true;void bridge.close().then(()=>{process.exitCode=0;}).catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',close);process.once('SIGTERM',close);
    return;
  }
  if(command==='status') {
    const c=readConfig(configPath); const db=join(c.dataDir,'bridge.sqlite');
    if(!existsSync(db)) {console.log('No bridge database yet.');return;}
    const store=new Store(db,{readOnly:true});
    try {console.log(JSON.stringify(store.stats(),null,2));} finally {store.close();}
    return;
  }
  if(command==='review' || command==='resolve') {
    const c=readConfig(configPath); const store=new Store(join(c.dataDir,'bridge.sqlite'),{readOnly:command==='review'});
    try {
      if(command==='review') console.log(JSON.stringify(store.listUncertain().map(j=>({id:j.id,threadId:store.getThread(j.conversationKey),turnId:j.turnId,reason:j.reason,hasReply:j.reply!==undefined})),null,2));
      else {
        const id=option('--job'),action=option('--action');
        if(!id || !['abandon','delivered'].includes(action ?? '') || !args.includes('--reviewed')) throw new Error('Inspect the Mac task and provider first. Usage: resolve --job ID --action abandon|delivered --reviewed');
        store.resolveUncertain(id,action as 'abandon'|'delivered');
        console.log('Job reconciled; no task or reply was replayed. Queued work can continue.');
      }
    } finally {store.close();}
    return;
  }
  if(command==='ask') {
    const c=readConfig(configPath);
    const prompt=option('--text');
    if(!prompt) throw new Error('Usage: codex-imessage ask --text "Your task" [--thread ID]');
    await withExclusiveAgent(c,async agent=>{const result=await agent.run({text:prompt,threadId:option('--thread'),onThread:id=>console.error(`Task: ${id}`)});console.log(result.text);});
    return;
  }
  console.log(`Belmivo — text your Mac's agent\n\nCommands:\n  setup [--from FILE]    Reuse existing config or create it privately\n  relay configure --from FILE [--replace]\n                        Import your own relay connection\n  doctor [--live]        Check runtime; optionally test an agent turn\n  start                 Run the authenticated webhook bridge\n  status                Show durable queue counts\n  storage               Inspect local storage metadata\n  review                List held jobs without message contents\n  resolve --job ID --action abandon|delivered --reviewed\n                        Reconcile after checking task and delivery\n  ask --text TEXT [--thread ID]\n                        Test the agent locally without an iMessage\n\nOptions:\n  --config PATH         Private configuration file\n\nSetup: --provider photon|linq|sendblue|blooio, --sender +NUMBER,\n  --service-number +NUMBER|shared, --backend desktop|app-server,\n  --thread ID, --cwd PATH, --artifacts-dir PATH, --full-access.\n  --from FILE imports a complete private configuration.\n  Secrets are never accepted as command-line flags.\n\nSee README.md for setup and operating requirements.`);
}

main().catch(error=>{console.error(`belmivo: ${error instanceof SyntaxError?'Invalid JSON. Private contents were not printed.':error instanceof Error?error.message:'Failed'}`);process.exitCode=1;});
