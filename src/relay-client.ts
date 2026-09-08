export interface RelayConfig { url:string; deviceId:string; token:string }
export interface RelayEvent { id:string; eventId:string; receivedAt:number; expiresAt:number; raw:Buffer }
export type RelayState = 'stopped'|'connecting'|'connected'|'reconnecting'|'input-limit'|'delivery-paused';
export interface RelaySnapshot {
  state:RelayState;
  connected:boolean;
  connectedAt?:number;
  /** Runtime ACK-write timestamp after local admission policy; may include deliberate rejection. Not edge receipt or task completion. */
  lastAckAt?:number;
  reconnectAttempts:number;
}
type SocketLike=Pick<WebSocket,'readyState'|'send'|'close'|'addEventListener'>;

export function validateRelayConfig(config:RelayConfig):void {
  const url=new URL(config.url);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || (url.pathname!=='/' && url.pathname!==''))throw new Error('relay.url must be an HTTPS origin without credentials, path or query.');
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(config.deviceId)||!/^[A-Za-z0-9_-]{32,128}$/.test(config.token))throw new Error('Relay device ID and token must be private URL-safe values between 32 and 128 characters.');
}

/** The relay authenticated Photon at receipt; its TLS-authenticated inbox is a separate trust boundary. */
export function decodeRelayEvent(data:unknown,now=Date.now()):RelayEvent {
  if(typeof data!=='string'||Buffer.byteLength(data)>400_000)throw new Error('Invalid relay frame');
  const frame=JSON.parse(data) as Record<string,unknown>;
  if(frame.v!==1 || frame.type!=='event' || typeof frame.id!=='string' || !/^[a-f0-9]{64}$/.test(frame.id) || typeof frame.eventId!=='string' || !frame.eventId || frame.eventId.length>2048)throw new Error('Invalid relay event identity');
  if(typeof frame.receivedAt!=='number' || typeof frame.expiresAt!=='number' || !Number.isSafeInteger(frame.receivedAt) || !Number.isSafeInteger(frame.expiresAt) || frame.receivedAt>now+30_000 || frame.expiresAt<=now || frame.expiresAt-frame.receivedAt>86_400_000 || frame.expiresAt<=frame.receivedAt)throw new Error('Relay event expired or has invalid timing');
  if(typeof frame.bodyBase64!=='string')throw new Error('Missing relay body');
  const raw=Buffer.from(frame.bodyBase64,'base64');
  if(!raw.length || raw.length>262144 || raw.toString('base64')!==frame.bodyBase64)throw new Error('Invalid relay body');
  return {id:frame.id,eventId:frame.eventId,receivedAt:frame.receivedAt,expiresAt:frame.expiresAt,raw};
}

/** One outbound connection, bounded processing, durable acceptance before acknowledgment, no public Mac ingress. */
export class RelayClient {
  private socket?:SocketLike;
  private stopped=true;
  private retry?:ReturnType<typeof setTimeout>;
  private heartbeat?:ReturnType<typeof setInterval>;
  private connecting?:ReturnType<typeof setTimeout>;
  private attempts=0;
  private pending=Promise.resolve();
  private buffered=0;
  private lastSeen=0;
  private state:RelayState='stopped';
  private connectedAt?:number;
  private lastAckAt?:number;
  constructor(private readonly config:RelayConfig,private readonly accept:(event:RelayEvent)=>Promise<boolean>|boolean,private readonly status:(state:string)=>void=()=>{},private readonly factory:(url:string,protocols:string[])=>SocketLike=(url,protocols)=>new WebSocket(url,protocols)) {validateRelayConfig(config);}
  start():void {if(!this.stopped)return;this.stopped=false;this.connect();}
  get snapshot():RelaySnapshot {
    return {state:this.state,connected:!this.stopped && this.socket?.readyState===1,
      ...(this.connectedAt===undefined?{}:{connectedAt:this.connectedAt}),
      ...(this.lastAckAt===undefined?{}:{lastAckAt:this.lastAckAt}),reconnectAttempts:this.attempts};
  }
  private report(state:RelayState):void {this.state=state;try{this.status(state);}catch{}}
  private connect():void {
    if(this.stopped)return;
    this.report('connecting');
    const url=new URL(this.config.url);url.protocol='wss:';url.pathname=`/v1/devices/${this.config.deviceId}/socket`;
    let socket:SocketLike;
    try{socket=this.factory(url.toString(),['codex-imessage-relay',`auth.${this.config.token}`]);}catch{this.schedule();return;}
    this.socket=socket;
    let ended=false;
    let connectedAt=0;
    const end=()=>{
      if(ended)return;ended=true;
      clearTimeout(this.connecting);clearInterval(this.heartbeat);
      if(this.socket===socket){this.socket=undefined;this.connectedAt=undefined;}
      try{socket.close();}catch{}
      if(!this.stopped)this.schedule();
    };
    this.connecting=setTimeout(end,10_000);this.connecting.unref();
    socket.addEventListener('open',()=>{
      if(ended||this.stopped)return end();
      clearTimeout(this.connecting);this.connectedAt=connectedAt=this.lastSeen=Date.now();this.report('connected');
      this.heartbeat=setInterval(()=>{
        if(Date.now()-this.lastSeen>75_000)return end();
        try{socket.send('ping');}catch{end();}
      },25_000);this.heartbeat.unref();
    });
    socket.addEventListener('message',event=>{
      if(ended||this.stopped)return;
      this.lastSeen=Date.now();
      const data=(event as MessageEvent).data as unknown;
      if(data==='pong') {
        // Opening alone is not recovery: a full local queue can immediately reject replay.
        if(Date.now()-connectedAt>=60_000)this.attempts=0;
        return;
      }
      const bytes=typeof data==='string'?Buffer.byteLength(data):400001;
      if(bytes>400000 || this.buffered+bytes>8*1024*1024){this.report('input-limit');return end();}
      this.buffered+=bytes;
      this.pending=this.pending.then(async()=>{
        if(this.stopped||ended)return;
        const delivery=decodeRelayEvent(data);
        if(!await this.accept(delivery))throw new Error('Local queue not ready');
        if(!ended && socket.readyState===1) {
          socket.send(JSON.stringify({v:1,type:'ack',id:delivery.id}));
          this.lastAckAt=Date.now();
          this.attempts=0;
        }
      }).catch(()=>{this.report('delivery-paused');end();}).finally(()=>{this.buffered-=bytes;});
    });
    socket.addEventListener('close',end);socket.addEventListener('error',end);
  }
  private schedule():void {
    if(this.stopped||this.retry)return;
    this.report('reconnecting');
    const delay=Math.min(30_000,500*2**Math.min(this.attempts++,6))*(0.8+Math.random()*0.4);
    this.retry=setTimeout(()=>{this.retry=undefined;this.connect();},delay);this.retry.unref();
  }
  async close():Promise<void> {
    this.stopped=true;clearTimeout(this.retry);this.retry=undefined;clearTimeout(this.connecting);clearInterval(this.heartbeat);
    try{this.socket?.close(1000,'Bridge stopped');}catch{}this.socket=undefined;
    this.connectedAt=undefined;this.report('stopped');
    await this.pending;
  }
}
