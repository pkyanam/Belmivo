import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { validateRelayConfig } from './relay-client.js';
import { validateExternalHandoff } from './external-handoff.js';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { BridgeConfig } from './types.js';

export const defaultConfigPath = join(homedir(), '.config', 'codex-imessage', 'config.json');
export const e164 = /^\+[1-9]\d{7,14}$/;
export function defaultCodexBinary(): string {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
  return existsSync(bundled) ? bundled : 'codex';
}
export function readConfig(path = process.env.CODEX_IMESSAGE_CONFIG ?? defaultConfigPath): BridgeConfig {
  if (!existsSync(path)) throw new Error(`No configuration at ${path}. Run belmivo setup.`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`Configuration must be private: chmod 600 '${path}'`);
  const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return parseConfig(file, path);
}
export function parseConfig(file: Record<string, unknown>, path = defaultConfigPath): BridgeConfig {
  const config = {
    port: 8787, backend: 'app-server', codexBinary: defaultCodexBinary(),
    dataDir: join(dirname(resolve(path)), 'data'), cwd: join(dirname(resolve(path)), 'workspace'),
    fullAccess: false, typingIndicators: true, statusReactions: false, conversationalReactions: true, maxPending: 20, maxTextChars: 16000, maxReplyChars: 12000,
    turnTimeoutMs: 20 * 60 * 1000, ...file,
    providerApiKey: process.env.IMESSAGE_API_KEY ?? file.providerApiKey,
    providerApiSecret: process.env.IMESSAGE_API_SECRET ?? file.providerApiSecret,
    webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET ?? file.webhookSecret,
  } as BridgeConfig;
  validateConfig(config);
  return config;
}
export function validateConfig(c: BridgeConfig): void {
  if(c.relay!==undefined){if(c.provider!=='photon')throw new Error('The relay currently supports Photon only.');validateRelayConfig(c.relay);}
  if (!['linq','sendblue','blooio','photon'].includes(c.provider)) throw new Error('Choose linq, sendblue, blooio, or photon.');
  if (!Array.isArray(c.allowedSenders) || !c.allowedSenders.length || c.allowedSenders.some(n => typeof n !== 'string' || !e164.test(n))) throw new Error('allowedSenders must contain explicit international phone numbers.');
  const shared=c.provider==='photon' && c.allowSharedSandbox===true && c.serviceNumber==='shared';
  if (typeof c.serviceNumber !== 'string' || (!e164.test(c.serviceNumber) && !shared)) throw new Error('serviceNumber must be your provider iMessage number; Photon shared testing requires explicit allowSharedSandbox:true.');
  if (!['app-server','desktop'].includes(c.backend)) throw new Error('Unknown backend.');
  if(c.backend==='desktop' && (!c.desktopThreadId || !/^[0-9a-f-]{36}$/i.test(c.desktopThreadId) || c.allowedSenders.length!==1 || !c.fullAccess)) throw new Error('Experimental desktop mode requires a dedicated task ID, one allowed sender, and fullAccess:true.');
  if (typeof c.fullAccess !== 'boolean') throw new Error('fullAccess must be explicitly true or false.');
  for(const key of ['typingIndicators','statusReactions','conversationalReactions'] as const) if(c[key]!==undefined && typeof c[key]!=='boolean') throw new Error(`${key} must be true or false.`);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) throw new Error('port must be 1024–65535.');
  for (const key of ['maxPending','maxTextChars','maxReplyChars','turnTimeoutMs'] as const) if (!Number.isSafeInteger(c[key]) || c[key] <= 0) throw new Error(`Invalid ${key}.`);
  if (c.maxPending > 1000 || c.maxTextChars > 100000 || c.maxReplyChars > 100000 || c.turnTimeoutMs > 3600000) throw new Error('Resource limits exceed supported maximums.');
  if(c.threadInstructions!==undefined && (typeof c.threadInstructions!=='string' || c.threadInstructions.length>16000)) throw new Error('threadInstructions must be text up to 16000 characters.');
  if(c.maxReplyChars < 100) throw new Error('maxReplyChars must be at least 100.');
  for (const key of ['dataDir','cwd'] as const) if (typeof c[key] !== 'string' || !isAbsolute(c[key])) throw new Error(`${key} must be an absolute path.`);
  for(const key of ['desktopToolsSocket','desktopToolsNode'] as const)if(c[key]!==undefined && (typeof c[key]!=='string' || !isAbsolute(c[key]!)))throw new Error(`${key} must be an absolute path.`);
  if(c.artifactsDir!==undefined && (typeof c.artifactsDir!=='string' || !isAbsolute(c.artifactsDir)))throw new Error('artifactsDir must be an absolute path.');
  if (typeof c.codexBinary !== 'string' || !c.codexBinary.trim()) throw new Error('codexBinary is required.');
  if (typeof c.providerApiKey !== 'string' || !c.providerApiKey.trim()) throw new Error('Set providerApiKey or IMESSAGE_API_KEY.');
  if (c.provider === 'sendblue' && !c.providerApiSecret) throw new Error('Sendblue requires providerApiSecret or IMESSAGE_API_SECRET.');
  if (c.provider === 'photon' && !c.providerApiSecret) throw new Error('Photon requires providerApiKey (project ID) and providerApiSecret (project secret).');
  if (typeof c.webhookSecret !== 'string' || c.webhookSecret.length < 16) throw new Error('Use a provider webhook secret of at least 16 characters.');
  if (c.externalHandoff !== undefined) c.externalHandoff = validateExternalHandoff(c.externalHandoff, c);
}
export function writePrivateConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), {recursive:true, mode:0o700});
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', {mode:0o600, flag:'wx'});
  chmodSync(path, 0o600);
}
