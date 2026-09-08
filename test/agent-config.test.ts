import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, AppServerBackend } from '../src/agent.js';
import { DesktopBackend } from '../src/desktop.js';
import type { AgentConfig } from '../src/types.js';

// These are real AgentConfig objects, without BridgeConfig casts, dummy provider
// identities, webhook credentials, sender lists or private receiver directories.
test('minimal execution-only config drives factory app-server start and resume',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'belmivo-agent-config-'));
  let agent:ReturnType<typeof createAgent>|undefined;
  t.after(async()=>{try{await agent?.close();}finally{await rm(directory,{recursive:true,force:true});}});
  const executable=join(directory,'synthetic-codex');
  await writeFile(executable,`#!${process.execPath}
const fs=require('node:fs');
const readline=require('node:readline');
let turn=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialized')return;
 if(message.method==='initialize')return send({id:message.id,result:{}});
 if(message.method==='thread/start'||message.method==='thread/resume'){
  const p=message.params;
  if(fs.realpathSync(p.cwd)!==process.cwd()||p.approvalPolicy!=='never'||p.sandbox!=='danger-full-access'||p.model!=='synthetic-model')return send({id:message.id,error:{code:-32602}});
  fs.appendFileSync('observed.jsonl',JSON.stringify({method:message.method,settings:{approvalPolicy:p.approvalPolicy,sandbox:p.sandbox,model:p.model},resumed:p.threadId??null})+'\\n');
  return send({id:message.id,result:{thread:{id:p.threadId??'synthetic_task_0000000001'}}});
 }
 if(message.method==='turn/start'){
  const id='synthetic_turn_'+(++turn),threadId=message.params.threadId,text=message.params.input[0].text;
  send({id:message.id,result:{turn:{id,status:'inProgress'}}});
  return setImmediate(()=>{
   send({method:'item/completed',params:{threadId,turnId:id,item:{id:'answer-'+id,type:'agentMessage',phase:'final_answer',text:'Synthetic reply: '+text}}});
   send({method:'turn/completed',params:{threadId,turn:{id,status:'completed'}}});
  });
 }
 send({id:message.id,error:{code:-32601}});
});
`,{mode:0o700});
  const config={backend:'app-server',codexBinary:executable,cwd:directory,fullAccess:true,maxTextChars:1000,turnTimeoutMs:2000,model:'synthetic-model'} satisfies AgentConfig;
  agent=createAgent(config);assert.ok(agent instanceof AppServerBackend);
  const saved:string[]=[],turns:string[]=[];
  const first=await agent.run({text:'first',onThread:id=>saved.push(id),onTurn:id=>turns.push(id)});
  const second=await agent.run({threadId:first.threadId,text:'second',onThread:id=>saved.push(id),onTurn:id=>turns.push(id)});
  assert.equal(first.text,'Synthetic reply: first');assert.equal(second.text,'Synthetic reply: second');
  assert.deepEqual(saved,[first.threadId,first.threadId]);assert.equal(new Set(turns).size,2);
  const rows=(await readFile(join(directory,'observed.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(rows.map(row=>row.method),['thread/start','thread/resume']);assert.equal(rows[1].resumed,first.threadId);
});

test('execution-only desktop factory requires an explicit task and has an inert lifecycle before connection',async()=>{
  const config={backend:'desktop',codexBinary:process.execPath,cwd:tmpdir(),fullAccess:true,maxTextChars:1000,turnTimeoutMs:2000} satisfies AgentConfig;
  assert.throws(()=>createAgent(config),/explicitly bound dedicated task ID/);
  const desktop=createAgent({...config,desktopThreadId:'00000000-0000-4000-8000-000000000001'});
  assert.ok(desktop instanceof DesktopBackend);
  // No run/maintain call is made: no app socket is discovered or contacted.
  assert.deepEqual(desktop.connectionStatus?.(),{expected:0,connected:0,diagnostic:'connecting'});
  await desktop.close();assert.deepEqual(desktop.connectionStatus?.(),{expected:0,connected:0,diagnostic:'closed'});
});
