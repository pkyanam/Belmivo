import test from 'node:test';
import assert from 'node:assert/strict';
import { RichActivity } from '../src/rich.js';
import type { InboundMessage,ProviderAdapter } from '../src/types.js';
const message:InboundMessage={provider:'test',eventId:'event',messageId:'message',conversationId:'conversation',sender:'+12025550123',recipient:'+12025550456',text:'task',isGroup:false,attachments:[]};
const pause=(ms=5)=>new Promise<void>(r=>setTimeout(r,ms));
const provider=(hooks:Partial<ProviderAdapter>):ProviderAdapter=>({name:'test',verify:()=>true,parse:()=>null,send:async()=>({id:'reply'}),...hooks});

test('typing refresh is serialized; stop cancels pending start and is the final signal',async()=>{
  const calls:string[]=[];
  const p=provider({setTyping:async(_m,on,signal)=>{
    if(on){calls.push('start');await new Promise<void>((resolve)=>signal!.addEventListener('abort',()=>{calls.push('start-cancelled');resolve();},{once:true}));}
    else calls.push('stop');
  }});
  const a=new RichActivity(p,{statusReactions:false},message,()=>{}, {timeoutMs:100,refreshMs:5});
  a.start();await pause(18);assert.deepEqual(calls,['start']);
  await a.stopTyping();await a.stopTyping();await pause(15);
  assert.deepEqual(calls,['start','start-cancelled','stop']);
});

test('working reaction settles before final phase, including a fast completed task',async()=>{
  const calls:string[]=[];let release:()=>void=()=>{};
  const p=provider({react:async(_m,phase)=>{calls.push(phase);if(phase==='working')await new Promise<void>(r=>{release=r;});}});
  const a=new RichActivity(p,{typingIndicators:false,statusReactions:true},message,()=>{}, {timeoutMs:100});
  a.start();await pause();const finished=a.finish('done');await pause();assert.deepEqual(calls,['working']);
  release();await finished;await a.finish('failed');assert.deepEqual(calls,['working','done']);
});

test('unresponsive optional calls time out, cancel and cannot strand cleanup',async()=>{
  let aborted=0;const warnings:string[]=[];
  const hang=async(signal?:AbortSignal)=>{signal!.addEventListener('abort',()=>aborted++,{once:true});await new Promise<void>(()=>{});};
  const p=provider({setTyping:async(_m,_on,s)=>hang(s),react:async(_m,_phase,s)=>hang(s)});
  const a=new RichActivity(p,{statusReactions:true},message,name=>warnings.push(name),{timeoutMs:10,refreshMs:5});
  a.start();await pause(20);await a.finish('failed');await a.close();
  assert.ok(aborted>=3);assert.ok(warnings.includes('typing-start'));assert.ok(warnings.includes('reaction-final'));
});

test('disabled indicators and unsupported providers perform no optional operations',async()=>{
  let calls=0;
  const a=new RichActivity(provider({setTyping:async()=>{calls++;},react:async()=>{calls++;}}),{typingIndicators:false,statusReactions:false,conversationalReactions:false},message);
  a.start();await a.finish('done','laugh');await a.close();assert.equal(calls,0);
  const unsupported=new RichActivity(provider({}),{},message);unsupported.start();await unsupported.close();
});

test('failed refresh is not hammered and shutdown leaves no in-flight reaction',async()=>{
  let typing=0,reactionFinished=false;
  const p=provider({setTyping:async()=>{typing++;throw Error('optional');},react:async()=>{await pause(20);reactionFinished=true;}});
  const a=new RichActivity(p,{statusReactions:true},message,()=>{}, {timeoutMs:100,refreshMs:5});
  a.start();await pause(12);assert.equal(typing,1);await a.close();
  assert.equal(typing,2);assert.equal(reactionFinished,true);await pause(10);assert.equal(typing,2);
});

test('recovered outbox completion never emits a new working reaction or typing indicator',async()=>{
  const calls:string[]=[];
  const a=new RichActivity(provider({setTyping:async()=>{calls.push('typing');},react:async(_m,phase)=>{calls.push(phase);}}),{statusReactions:true},message);
  await a.finish('done');assert.deepEqual(calls,['done']);
  const b=new RichActivity(provider({react:async(_m,phase)=>{calls.push(phase);}}),{statusReactions:true},message);b.needsAttention=true;
  await b.finish('done');assert.deepEqual(calls,['done','failed']);
});

test('default activity keeps typing but emits no automatic working or completion reactions',async()=>{
  const calls:string[]=[];
  const a=new RichActivity(provider({setTyping:async(_m,on)=>{calls.push(on?'typing-start':'typing-stop');},react:async(_m,reaction)=>{calls.push(reaction);}}),{},message,()=>{}, {timeoutMs:100,refreshMs:1000});
  a.start();a.start();await pause();
  assert.deepEqual(calls,['typing-start']);
  await a.finish('done');await a.close();
  assert.deepEqual(calls,['typing-start','typing-stop']);
});

test('one chosen conversational reaction follows typing stop without automatic phase tapbacks',async()=>{
  const calls:string[]=[];
  const a=new RichActivity(provider({setTyping:async(_m,on)=>{calls.push(on?'typing-start':'typing-stop');},react:async(_m,reaction)=>{calls.push(reaction);}}),{},message,()=>{}, {timeoutMs:100,refreshMs:1000});
  a.start();await pause();
  await a.finish('done','laugh');await a.finish('done','love');await a.finish('failed','question');await a.close();
  assert.deepEqual(calls,['typing-start','typing-stop','laugh']);
});

test('disabled conversational reactions, unsuccessful tasks and attention suppress the selected reaction',async()=>{
  for(const scenario of [
    {config:{conversationalReactions:false},phase:'done' as const,attention:false},
    {config:{},phase:'failed' as const,attention:false},
    {config:{},phase:'done' as const,attention:true},
  ]) {
    const reactions:string[]=[];
    const a=new RichActivity(provider({react:async(_m,reaction)=>{reactions.push(reaction);}}),scenario.config,message);
    a.needsAttention=scenario.attention;a.start();
    await a.finish(scenario.phase,'love');await a.close();
    assert.deepEqual(reactions,[]);
  }
});

test('explicit legacy opt-in retains attention signaling while preventing a positive selected reaction',async()=>{
  const reactions:string[]=[];
  const a=new RichActivity(provider({react:async(_m,reaction)=>{reactions.push(reaction);}}),{statusReactions:true},message);
  a.start();a.needsAttention=true;
  await a.finish('done','love');await a.close();
  assert.deepEqual(reactions,['working','failed']);
});

test('a failed conversational reaction warns once without retries or blocking cleanup',async()=>{
  const reactions:string[]=[],warnings:string[]=[];
  const a=new RichActivity(provider({react:async(_m,reaction)=>{reactions.push(reaction);throw new Error('optional reaction failure');}}),{},message,operation=>warnings.push(operation));
  a.start();await a.finish('done','laugh');await a.finish('done','laugh');await a.close();
  assert.deepEqual(reactions,['laugh']);assert.deepEqual(warnings,['reaction-conversation']);
});

test('recovered outbox may emit its chosen conversational reaction without restarting activity',async()=>{
  const calls:string[]=[];
  const a=new RichActivity(provider({setTyping:async()=>{calls.push('typing');},react:async(_m,reaction)=>{calls.push(reaction);}}),{},message);
  await a.finish('done','like');await a.close();
  assert.deepEqual(calls,['like']);
});
