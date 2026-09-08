import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {Bridge} from '../src/bridge.js';
import {parsePhoton,verifyPhotonWebhook} from '../src/photon.js';
import {EXTERNAL_HANDOFF_REASON} from '../src/store.js';
import type {AgentBackend,AgentRun,BridgeConfig,ProviderAdapter} from '../src/types.js';

const owner='+12025550101',conversation='synthetic_handoff_conversation',secret='synthetic-handoff-signing-secret';
const digest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
function event(id:string,text:string,sender=owner){
 const space={id:conversation,type:'dm',phone:'shared',platform:'imessage'};
 return {event:'messages',space,message:{id,platform:'imessage',direction:'inbound',sender:{id:sender,platform:'imessage',service:'iMessage'},space,content:{type:'text',text}}};
}
async function until(check:()=>boolean){const end=Date.now()+4000;while(!check()){if(Date.now()>end)assert.fail('Synthetic handoff deadline');await new Promise(r=>setTimeout(r,5));}}
function read<T>(file:string,fn:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(file,{readOnly:true});try{return fn(db);}finally{db.close();}}
class RelaySocket extends EventTarget {
 readyState=0;acks:unknown[]=[];checkAck?:()=>void;
 open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
 send(raw:string){if(raw==='ping')return;this.checkAck?.();this.acks.push(JSON.parse(raw));}
 receive(body:ReturnType<typeof event>,changes:Record<string,unknown>={}){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({v:1,type:'event',id:digest(body.message.id),eventId:body.message.id,receivedAt:Date.now(),expiresAt:Date.now()+60000,bodyBase64:Buffer.from(JSON.stringify(body)).toString('base64'),...changes})}));}
 close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
async function fixture(t:TestContext,texts:string[],relay=false,maxPending=20){
 const dir=await mkdtemp(join(tmpdir(),'belmivo-handoff-http-')),dbFile=join(dir,'data','bridge.sqlite');
 const counters={agent:0,send:0,prepare:0,typing:0,reaction:0},logs:{event:string;details?:Record<string,unknown>}[]=[],sockets:RelaySocket[]=[];
 const relayConfig={url:'https://relay.example.test',deviceId:'d'.repeat(32),token:'t'.repeat(40)};
 if(relay)t.mock.method(globalThis,'WebSocket',function(url:string,protocols:string[]){
  // Synthetic transport boundary: verify credential placement before delivering
  // trusted frames. This does not claim to test TLS or the deployed Worker.
  assert.equal(url,`wss://relay.example.test/v1/devices/${relayConfig.deviceId}/socket`);
  assert.deepEqual(protocols,['codex-imessage-relay',`auth.${relayConfig.token}`]);
  const socket=new RelaySocket();sockets.push(socket);queueMicrotask(()=>socket.open());return socket;
 } as unknown as typeof WebSocket);
 const config:BridgeConfig={provider:'photon',providerApiKey:'synthetic-project',providerApiSecret:'synthetic-project-secret',webhookSecret:secret,allowedSenders:[owner],serviceNumber:'shared',allowSharedSandbox:true,dataDir:join(dir,'data'),cwd:join(dir,'workspace'),port:0,backend:'app-server',codexBinary:'synthetic-unused',fullAccess:true,maxPending,maxTextChars:16000,maxReplyChars:12000,turnTimeoutMs:3000,typingIndicators:true,statusReactions:true,conversationalReactions:true,...(relay?{relay:relayConfig}:{}),externalHandoff:{version:1,selectors:texts.map(text=>({provider:'photon',sender:owner,recipient:'shared',conversationId:conversation,textSha256:digest(text)}))}};
 let invoke:AgentBackend['run']=async input=>{input.onThread('synthetic-thread');input.onTurn?.('synthetic-turn');return{threadId:'synthetic-thread',text:'Synthetic answer'};};
 const provider:ProviderAdapter={name:'photon',verify:(raw,headers)=>verifyPhotonWebhook(raw,headers,secret),parse:body=>parsePhoton(body,config),async send(){counters.send++;return{id:'synthetic-reply'};},async prepareInbound(message){counters.prepare++;return message;},async setTyping(){counters.typing++;},async react(){counters.reaction++;}};
 const make=()=>new Bridge({config,provider,agent:{run:input=>{counters.agent++;return invoke(input);},close:async()=>{}},log:(event,details)=>logs.push({event,details})});
 let bridge=make();await bridge.start();
 t.after(async()=>{await bridge.close();await rm(dir,{recursive:true,force:true});});
 const post=async(body:ReturnType<typeof event>,valid=true)=>{const raw=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));const signature='v0='+createHmac('sha256',secret).update(`v0:${timestamp}:`).update(raw).digest('hex');const response=await fetch(`http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}/webhooks/photon`,{method:'POST',headers:{'content-type':'application/json','x-spectrum-timestamp':timestamp,'x-spectrum-signature':valid?signature:'v0='+'0'.repeat(64)},body:raw});return{status:response.status,body:await response.json()};};
 return{config,counters,logs,sockets,dbFile,provider,post,get bridge(){return bridge;},setRun(fn:AgentBackend['run']){invoke=fn;},async restartWithoutSelectors(){await bridge.close();delete config.externalHandoff;bridge=make();await bridge.start();},row(id:string){return read(dbFile,db=>db.prepare('SELECT * FROM jobs WHERE message_id=?').get(id));},noEffects(){assert.deepEqual(counters,{agent:0,send:0,prepare:0,typing:0,reaction:0});}};
}

test('signed Photon command handoff commits failed identities without commands or effects and survives selector removal',async t=>{
 const f=await fixture(t,['/help','/cancel']);
 for(const [id,text] of [['help','/help'],['cancel','/cancel']]){
  const body=event(id!,text!);assert.deepEqual(await f.post(body),{status:200,body:{status:'reserved'}});
  const row=f.row(id!)!;assert.equal(row.state,'failed');assert.equal(row.reason,EXTERNAL_HANDOFF_REASON);assert.equal(row.reply,null);
 }
 assert.deepEqual(await f.post(event('help','/help ')),{status:400,body:{error:'identity-conflict'}});
 assert.equal(read(f.dbFile,db=>db.prepare('SELECT COUNT(*) AS n FROM job_cancellations').get()!.n),0);
 assert.equal(read(f.dbFile,db=>db.prepare('SELECT COUNT(*) AS n FROM thread_sessions').get()!.n),0);
 await f.restartWithoutSelectors();
 for(const [id,text] of [['help','/help'],['cancel','/cancel']])assert.deepEqual(await f.post(event(id!,text!)),{status:200,body:{status:'duplicate'}});
 await new Promise(r=>setTimeout(r,1050));f.noEffects();assert.equal(f.bridge.store.stats().failed,2);
 for(const value of [owner,conversation,secret,digest('/help')])assert.equal(JSON.stringify(f.logs).includes(value),false);
});

test('signature and sender authorization precede handoff, while exact-text near miss keeps ordinary command behavior',async t=>{
 const f=await fixture(t,['/help']);
 assert.equal((await f.post(event('bad-signature','/help'),false)).status,401);
 assert.deepEqual(await f.post(event('wrong-sender','/help','+12025550199')),{status:200,body:{status:'ignored'}});
 assert.equal(f.bridge.store.stats().total,0);
 assert.deepEqual(await f.post(event('near-miss','/help ')),{status:200,body:{status:'queued'}});
 await until(()=>f.bridge.store.stats().sent===1);assert.equal(f.counters.send,1);assert.equal(f.counters.agent,0);
 assert.equal(f.row('near-miss')!.state,'sent');
});

test('trusted relay handoff ACK follows independently visible commit, and restart without selectors cannot rerun it',async t=>{
 const f=await fixture(t,['/help'],true);await until(()=>f.sockets[0]?.readyState===1);const socket=f.sockets[0]!;
 socket.checkAck=()=>{const row=f.row('relay-handoff')!;assert.equal(row.state,'failed');assert.equal(row.reason,EXTERNAL_HANDOFF_REASON);};
 const body=event('relay-handoff','/help');socket.receive(body);await until(()=>socket.acks.length===1);
 assert.deepEqual(socket.acks,[{v:1,type:'ack',id:digest(body.message.id)}]);f.noEffects();
 await f.restartWithoutSelectors();await until(()=>f.sockets[1]?.readyState===1);f.sockets[1]!.receive(body);await until(()=>f.sockets[1]!.acks.length===1);
 assert.equal(f.bridge.store.stats().failed,1);f.noEffects();
});

test('actual SQLite insert failure rolls back HTTP and relay reservations without ACK or side effects',async t=>{
 const f=await fixture(t,['/help'],true);const writer=new DatabaseSync(f.dbFile);
 try{writer.exec("CREATE TRIGGER synthetic_deny_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'synthetic private storage failure'); END");
  assert.deepEqual(await f.post(event('http-failed','/help')),{status:503,body:{error:'storage-unavailable'}});
  await until(()=>f.sockets[0]?.readyState===1);f.sockets[0]!.receive(event('relay-failed','/help'));await until(()=>f.sockets[0]!.readyState===3);
  assert.deepEqual(f.sockets[0]!.acks,[]);assert.equal(f.bridge.store.stats().total,0);
  assert.equal(read(f.dbFile,db=>db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n),0);f.noEffects();
  assert.equal(JSON.stringify(f.logs).includes('synthetic private storage failure'),false);
  writer.exec('DROP TRIGGER synthetic_deny_event');
  assert.deepEqual(await f.post(event('http-failed','/help')),{status:200,body:{status:'reserved'}});f.noEffects();
 }finally{writer.close();}
});

test('an already uncertain job is not rewritten or labeled reserved; new handoff respects occupied capacity',async t=>{
 const f=await fixture(t,['/help'],true,1),body=event('prior','/help'),message=f.provider.parse(body)!;
 f.bridge.store.enqueue(message,1);const pending=f.bridge.store.next()!;f.bridge.store.start(pending.id);f.bridge.store.uncertain(pending.id,'Synthetic prior uncertainty');
 const before=f.row('prior');assert.deepEqual(await f.post(body),{status:200,body:{status:'duplicate'}});assert.deepEqual(f.row('prior'),before);
 assert.ok(f.logs.some(x=>x.event==='handoff-not-applied'&&x.details?.reason==='already-admitted'));
 assert.deepEqual(await f.post(event('new-full','/help')),{status:503,body:{status:'full'}});
 await until(()=>f.sockets[0]?.readyState===1);f.sockets[0]!.receive(event('relay-full','/help'));await until(()=>f.sockets[0]!.readyState===3);assert.deepEqual(f.sockets[0]!.acks,[]);
 assert.equal(f.row('new-full'),undefined);assert.equal(f.row('relay-full'),undefined);assert.deepEqual(f.row('prior'),before);f.noEffects();
});

test('handoff cancel cannot abort the active personal turn or create its acknowledgment',async t=>{
 const f=await fixture(t,['/cancel']);let active:AgentRun|undefined,finish!:(value:{threadId:string;text:string})=>void;
 f.setRun(input=>{active=input;return new Promise(resolve=>{finish=resolve;});});
 assert.equal((await f.post(event('ordinary','Ordinary synthetic task'))).status,200);await until(()=>!!active);
 try{const counts={...f.counters};assert.deepEqual(await f.post(event('external-cancel','/cancel')),{status:200,body:{status:'reserved'}});
 assert.equal(active!.signal?.aborted,false);assert.deepEqual(f.counters,counts);
 assert.equal(read(f.dbFile,db=>db.prepare('SELECT COUNT(*) AS n FROM job_cancellations').get()!.n),0);
 }finally{finish({threadId:'synthetic-thread',text:'Synthetic completed task'});}await until(()=>f.bridge.store.stats().sent===1);assert.equal(f.counters.agent,1);assert.equal(f.counters.send,1);assert.equal(f.row('external-cancel')!.state,'failed');
});
