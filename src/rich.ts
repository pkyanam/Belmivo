import type { BridgeConfig, InboundMessage, NativeReaction, ProviderAdapter } from './types.js';

type Phase='working'|'done'|'failed';
type Operation=(signal:AbortSignal)=>Promise<void>;
/** Cosmetic signals never determine durable task or delivery state. */
export class RichActivity {
  needsAttention=false;
  private started=false;
  private stopping=false;
  private typingStarted=false;
  private timer?:ReturnType<typeof setInterval>;
  private typingRequest?:{controller:AbortController;promise:Promise<boolean>};
  private stoppingPromise?:Promise<void>;
  private working:Promise<boolean>=Promise.resolve(true);
  private finishing?:Promise<void>;
  private readonly timeoutMs:number;
  constructor(private readonly provider:ProviderAdapter,private readonly config:Pick<BridgeConfig,'typingIndicators'|'statusReactions'|'conversationalReactions'>,private readonly message:InboundMessage,private readonly warn:(operation:string)=>void=()=>{},options:{timeoutMs?:number;refreshMs?:number}={}) {
    this.timeoutMs=options.timeoutMs??4000;
    this.refreshMs=options.refreshMs??provider.typingRefreshMs??20_000;
  }
  private readonly refreshMs:number;

  private async call(name:string,operation:Operation,controller=new AbortController()):Promise<boolean> {
    let timedOut=false;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    let onAbort:()=>void=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{
      onAbort=()=>reject(new Error('cancelled'));
      controller.signal.addEventListener('abort',onAbort,{once:true});
      timeout=setTimeout(()=>{timedOut=true;controller.abort();},this.timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return operation(controller.signal);}),cancelled]);
      return true;
    } catch { if(timedOut||!controller.signal.aborted)try{this.warn(name);}catch{} return false; }
    finally {clearTimeout(timeout);controller.signal.removeEventListener('abort',onAbort);}
  }

  start():void {
    if(this.started||this.stopping)return;
    this.started=true;
    if(this.provider.react && this.config.statusReactions===true) this.working=this.call('reaction-working',signal=>this.provider.react!(this.message,'working',signal));
    if(this.provider.setTyping && this.config.typingIndicators!==false) {
      this.typingStarted=true;
      this.refresh();
      this.timer=setInterval(()=>this.refresh(),this.refreshMs);
      this.timer.unref();
    }
  }

  private refresh():void {
    if(this.stopping||this.typingRequest)return;
    const controller=new AbortController();
    const promise=this.call('typing-start',signal=>this.provider.setTyping!(this.message,true,signal),controller);
    this.typingRequest={controller,promise};
    void promise.then(ok=>{
      if(this.typingRequest?.controller===controller)this.typingRequest=undefined;
      // Do not hammer a failing optional provider endpoint throughout a long task.
      if(!ok)clearInterval(this.timer);
    });
  }

  stopTyping():Promise<void> {
    if(this.stoppingPromise)return this.stoppingPromise;
    this.stopping=true;clearInterval(this.timer);
    this.stoppingPromise=(async()=>{
      const pending=this.typingRequest;
      pending?.controller.abort();
      if(pending)await pending.promise;
      if(this.typingStarted)await this.call('typing-stop',signal=>this.provider.setTyping!(this.message,false,signal));
    })();
    return this.stoppingPromise;
  }

  finish(phase:Exclude<Phase,'working'>,reaction?:NativeReaction):Promise<void> {
    if(this.finishing)return this.finishing;
    this.finishing=(async()=>{
      await this.stopTyping();
      // Serialize phases so a slow initial tapback cannot overwrite the final one.
      await this.working;
      if(this.provider.react && reaction && phase==='done' && !this.needsAttention && this.config.conversationalReactions!==false)await this.call('reaction-conversation',signal=>this.provider.react!(this.message,reaction,signal));
      else if(this.provider.react && this.config.statusReactions===true)await this.call('reaction-final',signal=>this.provider.react!(this.message,this.needsAttention?'failed':phase,signal));
    })();
    return this.finishing;
  }

  async close():Promise<void> {await this.stopTyping();await this.working;await this.finishing;}
}
