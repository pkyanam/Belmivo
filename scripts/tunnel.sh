#!/bin/bash
# Named Cloudflare Tunnel and independent user LaunchAgent; credentials stay in files.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node_candidate="${NODE_BINARY:-node}"
forward=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) [[ $# -ge 2 ]] || { echo 'Missing --node path' >&2; exit 2; }; node_candidate="$2"; shift 2 ;;
    *) forward+=("$1"); shift ;;
  esac
done
command -v "$node_candidate" >/dev/null 2>&1 || { echo 'Node.js 24+ required; pass --node.' >&2; exit 1; }
exec "$node_candidate" --input-type=module - "$script_dir" "${forward[@]:-help}" <<'NODE'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const usage = `Usage: bash scripts/tunnel.sh COMMAND [options]
  setup      Create a named tunnel, route a new DNS hostname, and install its LaunchAgent
  prepare    Use existing tunnel credentials to write local config; no DNS or service changes
  install    Install the prepared tunnel LaunchAgent; no provider or DNS changes
  status     Show local LaunchAgent state
  uninstall  Remove LaunchAgent; retain Cloudflare tunnel, DNS, and private files
Options:
  --node PATH           Node.js 24+ binary
  --config PATH         Bridge config (default ~/.config/codex-imessage/config.json)
  --cloudflared PATH    Existing cloudflared binary (default cloudflared on PATH)
  --hostname HOST       Your new hostname on a Cloudflare-managed domain (setup/prepare)
  --name NAME           A new tunnel name (setup)
  --tunnel-id UUID      Existing locally managed tunnel UUID (prepare)
  --credentials PATH   Existing tunnel credentials JSON (prepare)
  --origincert PATH     Account certificate (setup; defaults to ~/.cloudflared/cert.pem)
  --tunnel-dir PATH     Private tunnel directory (default tunnel/ beside bridge config)
Existing config, credential, DNS, and LaunchAgent files are never overwritten.`;
try {
  const [scriptDir,...argv] = process.argv.slice(2);
  const command = argv.shift() ?? 'help';
  if (['help','--help','-h'].includes(command)) { console.log(usage); process.exit(0); }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required; pass --node.');
  if (!['setup','prepare','install','status','uninstall'].includes(command)) throw new Error('Unknown command. Run scripts/tunnel.sh help.');
  const options = {};
  const allowed = new Set(['config','cloudflared','hostname','name','tunnel-id','credentials','origincert','tunnel-dir']);
  while (argv.length) {
    const flag = argv.shift(); const key = flag?.slice(2); const value = argv.shift();
    if (!flag?.startsWith('--') || !allowed.has(key) || !value || value.startsWith('--') || Object.hasOwn(options,key)) throw new Error('Invalid or repeated option. Run scripts/tunnel.sh help.');
    options[key] = value;
  }
  const label = 'com.codex-imessage.tunnel';
  const service = `gui/${process.getuid()}/${label}`;
  const plist = join(homedir(),'Library','LaunchAgents',`${label}.plist`);
  const launchctl = '/bin/launchctl';
  function invoke(binary, args, { allowFailure = false } = {}) {
    // Account-wide or token environment overrides must not replace these explicit credentials.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_') && !['NO_TLS_VERIFY','TUNNEL_LOGLEVEL'].includes(key)));
    const result = spawnSync(binary,args,{encoding:'utf8',env,timeout:120000,maxBuffer:1024*1024});
    if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${binary.split('/').at(-1)} ${args[0] ?? ''} failed${result.status === null ? '' : ` (exit ${result.status})`}. Private command output was not printed. Inspect your local Cloudflare account/configuration before retrying.`);
    return result;
  }
  if (['setup','install','status','uninstall'].includes(command) && process.platform !== 'darwin') throw new Error('Tunnel LaunchAgent commands require macOS.');
  if (command === 'status') {
    const result = invoke(launchctl,['print',service],{allowFailure:true});
    console.log(result.stdout || result.stderr || 'LaunchAgent is not loaded.');
    process.exit(result.status ?? 1);
  }
  if (command === 'uninstall') {
    if (existsSync(plist)) {
      const stat=lstatSync(plist);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Refusing to remove a LaunchAgent not owned by this user.');
      const declaredLabel=invoke('/usr/bin/plutil',['-extract','Label','raw','-o','-',plist]).stdout.trim();
      if (declaredLabel!==label) throw new Error('Tunnel LaunchAgent label does not match this installer.');
      invoke('/bin/bash',[join(scriptDir,'launchd-bootout.sh'),service]);
      unlinkSync(plist);
    } else if (invoke(launchctl,['print',service],{allowFailure:true}).status===0) {
      throw new Error('Refusing to stop a loaded tunnel without its owned plist.');
    }
    console.log('Tunnel LaunchAgent removed. Cloudflare tunnel, DNS route, credentials, and logs remain.');
    process.exit(0);
  }
  const bridgeConfig=resolve(options.config ?? join(homedir(),'.config','codex-imessage','config.json'));
  const tunnelDir=resolve(options['tunnel-dir'] ?? join(dirname(bridgeConfig),'tunnel'));
  const tunnelConfig=join(tunnelDir,'config.yml');
  const credentialPath=join(tunnelDir,'credentials.json');
  const metadataPath=join(tunnelDir,'metadata.json');
  const cloudflaredCandidate=options.cloudflared ?? 'cloudflared';
  let cloudflared;
  if (cloudflaredCandidate.includes('/')) cloudflared=realpathSync(resolve(cloudflaredCandidate));
  else {
    const found=(process.env.PATH ?? '').split(':').map(dir=>join(dir,cloudflaredCandidate)).find(path=>existsSync(path));
    if (!found) throw new Error('Install cloudflared first or pass --cloudflared with its path.');
    cloudflared=realpathSync(found);
  }
  invoke(cloudflared,['--version']);
  function privateDirectory(path) {
    mkdirSync(path,{recursive:true,mode:0o700});
    const stat=lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode & 0o077)!==0) throw new Error('Tunnel directory must be a user-owned real directory with mode 0700.');
  }
  function privateFile(path) {
    const stat=lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode & 0o077)!==0) throw new Error('Tunnel/config files must be user-owned regular files with mode 0600.');
  }
  function createFile(path, text) { writeFileSync(path,text,{encoding:'utf8',flag:'wx',mode:0o600}); }
  function readJson(path) {
    try { return JSON.parse(readFileSync(path,'utf8')); }
    catch { throw new Error('A private configuration or credentials file is not valid JSON. Contents were not printed.'); }
  }
  const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let metadata;
  if (command==='setup' || command==='prepare') {
    privateFile(bridgeConfig);
    const bridge=readJson(bridgeConfig);
    const provider=bridge.provider;
    const port=bridge.port ?? 8787;
    if (!['linq','sendblue','blooio','photon'].includes(provider) || !Number.isInteger(port) || port<1024 || port>65535) throw new Error('Bridge config must select a supported provider and local port.');
    const hostname=options.hostname?.toLowerCase();
    if (!hostname || hostname.length>253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new Error('Provide --hostname with a specific DNS name in your Cloudflare-managed domain.');
    if (command==='setup' && (!options.name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(options.name))) throw new Error('Provide a new --name using letters, digits, hyphens, or underscores.');
    if (command==='prepare' && (!uuidPattern.test(options['tunnel-id'] ?? '') || !options.credentials)) throw new Error('prepare requires --tunnel-id UUID and --credentials PATH.');
    privateDirectory(tunnelDir);
    for (const path of [tunnelConfig,credentialPath,metadataPath,...(command==='setup'?[plist]:[])]) if (existsSync(path)) throw new Error('Existing tunnel/configuration files were found. Use install for prepared files, or a new --tunnel-dir. Nothing was overwritten.');
    if (command==='setup') {
      const cert=resolve(options.origincert ?? join(homedir(),'.cloudflared','cert.pem'));
      if (!existsSync(cert)) throw new Error('Run cloudflared tunnel login first; an account certificate is required.');
      console.log('Creating a new Cloudflare tunnel. This modifies the selected Cloudflare account.');
      invoke(cloudflared,['tunnel','--origincert',cert,'create','--credentials-file',credentialPath,options.name]);
      chmodSync(credentialPath,0o600);
    } else {
      const source=resolve(options.credentials);
      const stat=lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid()) throw new Error('Credentials must be a regular file owned by this user.');
      copyFileSync(source,credentialPath,constants.COPYFILE_EXCL);
      chmodSync(credentialPath,0o600);
    }
    privateFile(credentialPath);
    const credentials=readJson(credentialPath);
    const id=credentials.TunnelID;
    if (!uuidPattern.test(id ?? '') || typeof credentials.TunnelSecret!=='string' || !credentials.TunnelSecret || typeof credentials.AccountTag!=='string' || !credentials.AccountTag) throw new Error('The tunnel credentials file has an unsupported schema. It was retained privately for inspection.');
    if (command==='prepare' && id.toLowerCase()!==options['tunnel-id'].toLowerCase()) throw new Error('Provided tunnel ID does not match the credentials file. No DNS or service was changed.');
    // JSON scalar quoting is also valid YAML and prevents path/hostname injection.
    const q=JSON.stringify;
    createFile(tunnelConfig,`tunnel: ${q(id)}\ncredentials-file: ${q(credentialPath)}\ningress:\n  - hostname: ${q(hostname)}\n    path: ${q(`^/webhooks/${provider}$`)}\n    service: ${q(`http://127.0.0.1:${port}`)}\n  - service: http_status:404\n`);
    invoke(cloudflared,['tunnel','--config',tunnelConfig,'ingress','validate']);
    metadata={id,hostname,provider,port};
    createFile(metadataPath,JSON.stringify(metadata,null,2)+'\n');
    if (command==='prepare') {
      console.log(`Prepared private tunnel configuration. No DNS or service was changed.\nWebhook: https://${hostname}/webhooks/${provider}\nNext: run scripts/tunnel.sh install with the same --config and --tunnel-dir options.`);
      process.exit(0);
    }
    const cert=resolve(options.origincert ?? join(homedir(),'.cloudflared','cert.pem'));
    // No --overwrite-dns: an existing hostname belongs to its current service.
    invoke(cloudflared,['tunnel','--origincert',cert,'route','dns',id,hostname]);
  } else {
    privateDirectory(tunnelDir);
    [tunnelConfig,credentialPath,metadataPath].forEach(privateFile);
    metadata=readJson(metadataPath);
    if (!uuidPattern.test(metadata.id ?? '')) throw new Error('Invalid prepared tunnel metadata.');
    invoke(cloudflared,['tunnel','--config',tunnelConfig,'ingress','validate']);
  }
  if (existsSync(plist)) throw new Error('Tunnel LaunchAgent already exists. Inspect it; uninstall it before reinstalling.');
  const logs=join(tunnelDir,'logs');
  privateDirectory(logs);
  mkdirSync(dirname(plist),{recursive:true});
  const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
  const string=value=>`<string>${xml(value)}</string>`;
  const args=[cloudflared,'tunnel','--no-autoupdate','--config',tunnelConfig,'--loglevel','warn','--metrics','127.0.0.1:0','run',metadata.id];
  createFile(plist,`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${args.map(string).join('')}</array>
<key>WorkingDirectory</key>${string(tunnelDir)}
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key>${string(join(logs,'tunnel.stdout.log'))}
<key>StandardErrorPath</key>${string(join(logs,'tunnel.stderr.log'))}
</dict></plist>\n`);
  invoke('/usr/bin/plutil',['-lint',plist]);
  invoke(launchctl,['bootstrap',`gui/${process.getuid()}`,plist]);
  console.log(`Tunnel LaunchAgent installed.\nWebhook: https://${metadata.hostname}/webhooks/${metadata.provider}\nOnly this webhook path is forwarded. The bridge must also be running.`);
} catch(error) {
  console.error(`codex-imessage tunnel: ${error instanceof Error?error.message:'Failed'}`);
  process.exitCode=1;
}
NODE
