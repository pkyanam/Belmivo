import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient, decodeRelayEvent, validateRelayConfig } from '../src/relay-client.js';

const config={url:'https://relay.example',deviceId:'d'.repeat(32),token:'t'.repeat(40)};
const frame=(changes:Record<string,unknown>={})=>JSON.stringify({v:1,type:'event',id:'a'.repeat(64),eventId:'message-1',receivedAt:Date.now()-600000,expiresAt:Date.now()+600000,bodyBase64:Buffer.from('{"event":"messages"}').toString('base64'),...changes});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class FakeSocket extends EventTarget {
  readyState=0;sent:string[]=[];closed=false;
  send(data:string){this.sent.push(data);}
  close(){if(this.closed)return;this.closed=true;this.readyState=3;this.dispatchEvent(new Event('close'));}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  receive(data:string){this.dispatchEvent(new MessageEvent('message',{data}));}
}

test('relay configuration requires a TLS origin and never embeds auth in URL',()=>{
  validateRelayConfig(config);
  for(const url of ['http://relay.example','wss://relay.example','https://user:pass@relay.example','https://relay.example/path','https://relay.example?token=x'])assert.throws(()=>validateRelayConfig({...config,url}));
  assert.throws(()=>validateRelayConfig({...config,token:'short'}));
});

test('relay credentials share the worker 32 to 128 character boundary',()=>{
  for(const key of ['deviceId','token'] as const) {
    for(const length of [32,128])validateRelayConfig({...config,[key]:'x'.repeat(length)});
    for(const length of [0,31,129,256])assert.throws(()=>validateRelayConfig({...config,[key]:'x'.repeat(length)}));
  }
});

test('relay accepts authenticated offline envelope timing without weakening provider signature verification',()=>{
  assert.equal(decodeRelayEvent(frame()).raw.toString(),'{"event":"messages"}');
  for(const change of [{expiresAt:Date.now()-1},{receivedAt:Date.now()+60000},{expiresAt:Date.now()+90000000},{bodyBase64:'bad-base64'},{bodyBase64:Buffer.alloc(262145).toString('base64')},{id:'other'},{eventId:''},{v:2}])assert.throws(()=>decodeRelayEvent(frame(change)));
});

test('relay acknowledges only after durable local acceptance and stops without stale reconnects',async()=>{
  const socket=new FakeSocket();let release!:(value:boolean)=>void;let called=0;const statuses:string[]=[];
  const client=new RelayClient(config,async()=>{called++;return new Promise<boolean>(resolve=>{release=resolve;});},s=>statuses.push(s),(url,protocols)=>{
    assert.equal(url,'wss://relay.example/v1/devices/'+config.deviceId+'/socket');
    assert.equal(url.includes(config.token),false);assert.deepEqual(protocols,['codex-imessage-relay','auth.'+config.token]);
    return socket as unknown as WebSocket;
  });
  client.start();socket.open();socket.receive(frame());await settle();
  assert.equal(called,1);assert.deepEqual(socket.sent,[]);
  release(true);await settle();
  assert.deepEqual(socket.sent.map(x=>JSON.parse(x)),[{v:1,type:'ack',id:'a'.repeat(64)}]);
  await client.close();assert.equal(socket.closed,true);assert.equal(JSON.stringify(statuses).includes(config.token),false);
});

test('queue saturation or malformed frames close without acknowledging or executing later buffered events',async()=>{
  for(const invalid of [false,true]) {
    const socket=new FakeSocket();let calls=0;
    const client=new RelayClient(config,()=>{calls++;return false;},()=>{},()=>socket as unknown as WebSocket);
    client.start();socket.open();socket.receive(invalid?'{}':frame());socket.receive(frame());await settle();
    assert.equal(socket.closed,true);assert.deepEqual(socket.sent,[]);assert.equal(calls,invalid?0:1);
    await client.close();
  }
});

test('repeated open then admission failure retains exponential reconnect backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  t.mock.method(Math,'random',()=>0.5);
  const sockets:FakeSocket[]=[];
  const client=new RelayClient(config,()=>false,()=>{},()=>{
    const socket=new FakeSocket();sockets.push(socket);return socket as unknown as WebSocket;
  });
  try {
    client.start();
    for(const delay of [500,1000,2000,4000,8000,16000,30000,30000]) {
      const socket=sockets.at(-1)!;socket.open();socket.receive(frame());await settle();
      assert.equal(socket.closed,true);assert.deepEqual(socket.sent,[]);
      const count=sockets.length;
      t.mock.timers.tick(delay-1);assert.equal(sockets.length,count);
      t.mock.timers.tick(1);assert.equal(sockets.length,count+1);
    }
  } finally {await client.close();}
  const count=sockets.length;t.mock.timers.tick(60000);assert.equal(sockets.length,count);
});

test('durable admission and successful ACK reset reconnect backoff',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  t.mock.method(Math,'random',()=>0.5);
  const sockets:FakeSocket[]=[];let accepted=false;
  const client=new RelayClient(config,()=>accepted,()=>{},()=>{
    const socket=new FakeSocket();sockets.push(socket);return socket as unknown as WebSocket;
  });
  try {
    client.start();sockets[0]!.open();sockets[0]!.receive(frame());await settle();
    t.mock.timers.tick(500);assert.equal(sockets.length,2);
    accepted=true;sockets[1]!.open();sockets[1]!.receive(frame());await settle();
    assert.equal(JSON.parse(sockets[1]!.sent[0]!).type,'ack');sockets[1]!.close();
    t.mock.timers.tick(499);assert.equal(sockets.length,2);
    t.mock.timers.tick(1);assert.equal(sockets.length,3);
  } finally {await client.close();}
});

test('a stable heartbeat connection resets backoff without requiring a new message',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});
  t.mock.method(Math,'random',()=>0.5);
  const sockets:FakeSocket[]=[];
  const client=new RelayClient(config,()=>false,()=>{},()=>{
    const socket=new FakeSocket();sockets.push(socket);return socket as unknown as WebSocket;
  });
  try {
    client.start();sockets[0]!.open();sockets[0]!.receive(frame());await settle();
    t.mock.timers.tick(500);assert.equal(sockets.length,2);sockets[1]!.open();
    t.mock.timers.tick(60000);sockets[1]!.receive('pong');sockets[1]!.close();
    t.mock.timers.tick(499);assert.equal(sockets.length,2);
    t.mock.timers.tick(1);assert.equal(sockets.length,3);
  } finally {await client.close();}
});

test('relay snapshots distinguish socket liveness from ACK and never expose private data',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1_000_000});
  const socket=new FakeSocket();let release!:(value:boolean)=>void;
  const client=new RelayClient(config,()=>new Promise<boolean>(resolve=>{release=resolve;}),()=>{},()=>socket as unknown as WebSocket);
  try {
    assert.deepEqual(client.snapshot,{state:'stopped',connected:false,reconnectAttempts:0});
    client.start();assert.equal(client.snapshot.state,'connecting');
    socket.open();assert.deepEqual(client.snapshot,{state:'connected',connected:true,connectedAt:1_000_000,reconnectAttempts:0});
    const detached=client.snapshot;detached.lastAckAt=123;assert.equal(client.snapshot.lastAckAt,undefined);
    socket.receive(frame());await settle();assert.equal(client.snapshot.lastAckAt,undefined);
    t.mock.timers.tick(123);release(true);await settle();
    assert.equal(client.snapshot.lastAckAt,1_000_123);
    socket.close();assert.deepEqual(client.snapshot,{state:'reconnecting',connected:false,lastAckAt:1_000_123,reconnectAttempts:1});
    const serialized=JSON.stringify(client.snapshot);
    for(const privateValue of [config.url,config.deviceId,config.token,'message-1','messages'])assert.equal(serialized.includes(privateValue),false);
  } finally {await client.close();}
  assert.deepEqual(client.snapshot,{state:'stopped',connected:false,lastAckAt:1_000_123,reconnectAttempts:1});
});

test('failed admission and failed ACK writes do not report durable acknowledgment',async()=>{
  for(const accepted of [false,true]) {
    const socket=new FakeSocket();socket.send=()=>{throw new Error('test send failure');};
    const client=new RelayClient(config,()=>accepted,()=>{},()=>socket as unknown as WebSocket);
    try {
      client.start();socket.open();socket.receive(frame());await settle();
      assert.equal(client.snapshot.lastAckAt,undefined);assert.equal(client.snapshot.connected,false);
    } finally {await client.close();}
  }
});
