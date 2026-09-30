'use strict';
const assert=require('assert');
const {spawn}=require('child_process');
const {io}=require('socket.io-client');

const PORT=3456,URL=`http://127.0.0.1:${PORT}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function connect(){
  return new Promise((resolve,reject)=>{
    const s=io(URL,{transports:['websocket'],forceNew:true,reconnection:false,timeout:4000});
    const t=setTimeout(()=>reject(new Error('timeout connect')),5000);
    s.once('connect',()=>{clearTimeout(t);resolve(s);});
    s.once('connect_error',e=>{clearTimeout(t);reject(e);});
  });
}
function ack(s,event,payload={}){
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error('timeout ack '+event)),4000);
    s.emit(event,payload,res=>{clearTimeout(t);resolve(res);});
  });
}
function waitEvent(s,event,filter=()=>true,timeout=4000){
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>{s.off(event,on);reject(new Error('timeout event '+event));},timeout);
    const on=data=>{if(!filter(data))return;clearTimeout(t);s.off(event,on);resolve(data);};
    s.on(event,on);
  });
}
async function waitServer(){
  for(let i=0;i<40;i++){
    try{const r=await fetch(URL+'/health');if(r.ok)return await r.json();}catch(_){}
    await sleep(100);
  }
  throw new Error('server did not boot');
}
async function main(){
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(PORT),FRONTEND_ORIGINS:'http://127.0.0.1:3456'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const sockets=[];
  try{
    const health=await waitServer();
    assert.equal(health.authoritative,true);assert.equal(health.snapshotHz,30);

    const c1=await connect(),c2=await connect(),c3=await connect();sockets.push(c1,c2,c3);
    const r1=await ack(c1,'room:create',{profile:{name:'P1'},resumeToken:'resume_token_player_1_123456'});
    assert(r1.ok);const code=r1.room.code,t1=r1.resumeToken;
    const r2=await ack(c2,'room:join',{code,profile:{name:'P2'},resumeToken:'resume_token_player_2_123456'});
    const r3=await ack(c3,'room:join',{code,profile:{name:'P3'},resumeToken:'resume_token_player_3_123456'});
    assert(r2.ok&&r3.ok);const t2=r2.resumeToken,t3=r3.resumeToken;

    let count=[0,0,0],latest=[null,null,null];
    [c1,c2,c3].forEach((s,i)=>s.on('game:snapshot',snap=>{count[i]++;latest[i]=snap;}));
    const started=Promise.all([waitEvent(c1,'game:start'),waitEvent(c2,'game:start'),waitEvent(c3,'game:start')]);
    const sr=await ack(c1,'room:start',{});assert(sr.ok);await started;
    await Promise.all([
      waitEvent(c1,'game:snapshot',x=>x?.state==='play',6500),
      waitEvent(c2,'game:snapshot',x=>x?.state==='play',6500),
      waitEvent(c3,'game:snapshot',x=>x?.state==='play',6500)
    ]);
    const baseline=[...count];await sleep(500);
    assert(count.every((n,i)=>n-baseline[i]>=10),'snapshot stream should stay near 30Hz for all clients');

    c1.emit('game:input',{seq:1,input:{mx:1,my:0,ax:1,ay:0,fire:false}});
    c2.emit('game:input',{seq:1,input:{mx:-1,my:0,ax:-1,ay:0,fire:false}});
    c3.emit('game:input',{seq:1,input:{mx:0,my:-1,ax:0,ay:-1,fire:false}});
    const x2a=latest[1].players[1].entity.x;
    await sleep(420);
    const x2b=latest[1].players[1].entity.x;
    assert(x2b<x2a-20,'P2 should move on authoritative server');

    const pauseEvent=waitEvent(c3,'game:pause-state',x=>x?.paused===true);
    const pr=await ack(c1,'game:pause-request',{paused:true});assert(pr.ok&&pr.paused===true);await pauseEvent;
    await sleep(100);const pausedA=latest[2].players[2].entity.y;
    await sleep(300);const pausedB=latest[2].players[2].entity.y;
    assert(Math.abs(pausedB-pausedA)<1.5,'world must stay frozen while paused');

    const leftEvent=waitEvent(c1,'game:player-left',x=>x?.slot===1);
    c2.disconnect();await leftEvent;
    await sleep(180);
    assert.equal(latest[0].roomPaused,true,'disconnect must not secretly unpause');

    const c2b=await connect();sockets.push(c2b);let latest2b=null;c2b.on('game:snapshot',x=>latest2b=x);
    const rr=await ack(c2b,'room:resume',{code,resumeToken:t2});
    assert(rr.ok);assert.equal(rr.room.paused,true);assert.equal(rr.snapshot.roomPaused,true);
    const ackSeq=Number(rr.snapshot.players[1].lastProcessedInput)||0;

    const unpauseEvent=waitEvent(c3,'game:pause-state',x=>x?.paused===false);
    const ur=await ack(c2b,'game:pause-request',{paused:false});assert(ur.ok&&!ur.paused);await unpauseEvent;
    c2b.emit('game:input',{seq:ackSeq+1,input:{mx:1,my:0,ax:1,ay:0,fire:false}});
    await sleep(350);
    assert(latest2b&&latest2b.roomPaused===false,'resumed client must receive unpaused state');

    const p3Before=latest[2].players[2].entity.y;
    const leftLeader=waitEvent(c3,'game:player-left',x=>x?.slot===0);
    c1.disconnect();await leftLeader;
    c3.emit('game:input',{seq:2,input:{mx:0,my:1,ax:0,ay:1,fire:false}});
    await sleep(450);
    const p3After=latest[2].players[2].entity.y;
    assert(p3After>p3Before+20,'simulation must continue after lobby leader leaves');

    const c1b=await connect();sockets.push(c1b);
    const rrb=await ack(c1b,'room:resume',{code,resumeToken:t1});
    assert(rrb.ok&&rrb.snapshot?.authoritativeV4,'leader must resume without host migration');

    const dbg={ok:true,snapshots:count,pausedRevision:ur.revision,p2ResumeSeq:ackSeq,p3Movement:Math.round(p3After-p3Before),room:code};
    console.log(JSON.stringify(dbg,null,2));
  }finally{
    for(const s of sockets)try{s.disconnect();}catch(_){}
    child.kill('SIGTERM');await sleep(100);
    if(child.exitCode===null)child.kill('SIGKILL');
    if(process.exitCode)console.error(logs);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
