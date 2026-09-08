import type { NativeReaction } from './types.js';
const kinds=new Set<NativeReaction>(['like','love','laugh','emphasize','question','dislike']);

/** A final response may nominate one optional conversational reaction, never a task-status signal. */
export function extractReaction(raw:string):{text:string;reaction?:NativeReaction;hadDirective:boolean} {
  const lines=raw.split(/\r?\n/),controls:number[]=[];
  let fence:{character:string;length:number}|undefined;
  let choice:NativeReaction|undefined;
  let lastNonblank=-1;
  for(let i=0;i<lines.length;i++)if(lines[i]!.trim())lastNonblank=i;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i]!;
    const delimiter=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fence) {
      if(delimiter && delimiter[1]![0]===fence.character && delimiter[1]!.length>=fence.length && !delimiter[2]!.trim())fence=undefined;
      continue;
    }
    if(delimiter){fence={character:delimiter[1]![0]!,length:delimiter[1]!.length};continue;}
    // Four-space indentation, quotes, escapes, and inline examples are ordinary content.
    const control=line.match(/^ {0,3}\[\[imessage-reaction:([^\]\r\n]{0,64})\]\][ \t]*$/);
    if(!control)continue;
    controls.push(i);
    if(i===lastNonblank && kinds.has(control[1] as NativeReaction))choice=control[1] as NativeReaction;
  }
  if(controls.length!==1)choice=undefined;
  const removed=new Set(controls);
  return {text:lines.filter((_,i)=>!removed.has(i)).join('\n'),...(choice?{reaction:choice}:{}),hadDirective:controls.length>0};
}
