'use strict';
const assert=require('assert');
const {spawn}=require('child_process');
const {io}=require('socket.io-client');

const PORT=Number(process.env.RDM_TEST_PORT)||3456,URL=`http://127.0.0.1:${PORT}`;
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
  const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(PORT),FRONTEND_ORIGINS:'http://127.0.0.1:3456',RDM_TESTING:'1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const sockets=[];
  try{
    const health=await waitServer();
    assert.equal(health.fullGameplay,true);assert.equal(health.authoritative,true);assert.equal(health.snapshotHz,30);

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
    // A reload may connect before the old transport has timed out.
    const replacementEvent=waitEvent(c2b,'session:replaced');
    const replacement=await connect();sockets.push(replacement);
    const takeover=await ack(replacement,'room:resume',{code,resumeToken:t2});
    assert(takeover.ok&&takeover.playerId===r2.playerId);await replacementEvent;
    assert(!(await ack(c2b,'game:pause-request',{paused:false})).ok,'old transport loses control');
    const returnEvent=waitEvent(replacement,'session:replaced');
    assert((await ack(c2b,'room:resume',{code,resumeToken:t2})).ok);await returnEvent;
    replacement.disconnect();
    assert(!(await ack(c3,'room:resume',{code,resumeToken:'invalid_token_12345678'})).ok);
    const leaveAck=await ack(c2b,'room:leave',{permanent:false});assert(leaveAck.ok);
    assert((await ack(c2b,'room:resume',{code,resumeToken:t2})).ok,'leave and immediate return on same socket');

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

    // Onda 5 precisa abrir o estaleiro para todos, sem pular para a 6.
    const shopEvents=Promise.all([
      waitEvent(c1b,'game:snapshot',x=>x?.state==='upgrade'&&x?.shop?.open,3500),
      waitEvent(c2b,'game:snapshot',x=>x?.state==='upgrade'&&x?.shop?.open,3500),
      waitEvent(c3,'game:snapshot',x=>x?.state==='upgrade'&&x?.shop?.open,3500)
    ]);
    const forcedShop=await ack(c3,'test:force-wave-complete',{wave:5});assert(forcedShop.ok);
    const shopSnaps=await shopEvents;
    assert(shopSnaps.every(x=>x.wave===5),'todos os clientes devem parar na onda 5 para o estaleiro');

    const activeRun=rrb.room.runId;let actionId=0;
    const action=(socket,action,payload={},requestId)=>ack(socket,'game:action',{runId:activeRun,requestId:requestId||'test-'+(++actionId),action,payload});
    const classClients=[c1b,c2b,c3];
    for(const [i,c]of classClients.entries())assert((await action(c,'class',{path:['marine','pirate','undead'][i]})).ok);
    for(const [i,c]of classClients.entries()){
      const snap=(await action(c,'first',{id:(await ack(c,'game:action',{runId:activeRun,requestId:'peek-'+i,action:'invalid'})).snapshot.players[i].shopChoices[0].id})).snapshot;
      assert.equal(snap.players[i].build.path,['marine','pirate','undead'][i]);
    }
    assert((await action(c3,'continue')).ok);
    const forcedNormal=await ack(c3,'test:force-wave-complete',{wave:10});assert(forcedNormal.ok);
    await ack(c3,'test:grant-gold',{gold:5000});
    const peek=await action(c2b,'invalid');assert.equal(peek.snapshot.shop.phase,'normal');
    const offered=peek.snapshot.players[1].shopChoices[0].id;
    const firstBuy=await action(c2b,'buy',{id:offered},'duplicate-buy');assert(firstBuy.ok);
    const secondBuy=await action(c2b,'buy',{id:offered},'duplicate-buy');assert(secondBuy.ok);
    assert.equal(secondBuy.snapshot.players[1].gold,firstBuy.snapshot.players[1].gold,'retry must never charge twice');
    assert(!(await ack(c1b,'game:action',{runId:'old-run',requestId:'stale',action:'ready',payload:{ready:true}})).ok);
    const wave11=waitEvent(c3,'game:snapshot',x=>x?.state==='play'&&x?.wave===11,3500);
    for(const c of classClients)assert((await action(c,'ready',{ready:true})).ok);await wave11;

    // Reproduce death -> immediate snapshot -> pooled revive -> leave shop on the wire.
    const killed=await ack(c3,'test:kill-player',{slot:0});assert(killed.ok&&!killed.snapshot.players[0].alive);
    assert.notDeepEqual(killed.snapshot.players[0].entity,killed.snapshot.players[1].entity,'death snapshot must not share ships');
    assert((await ack(c3,'test:force-wave-complete',{wave:20})).ok);
    assert((await ack(c3,'test:grant-gold',{gold:5000})).ok);
    assert((await action(c2b,'revive',{target:0,amount:500})).ok);
    const revival=await action(c3,'revive',{target:0,amount:'rest'},'revive-primary');assert(revival.ok);
    const retry=await action(c3,'revive',{target:0,amount:'rest'},'revive-primary');assert(retry.ok);
    assert.equal(retry.snapshot.players[2].gold,revival.snapshot.players[2].gold,'revive retry must not charge twice');
    assert(revival.snapshot.players[0].alive);
    assert.notDeepEqual(revival.snapshot.players[0].entity,revival.snapshot.players[1].entity);
    for(const c of classClients)assert((await action(c,'ready',{ready:true})).ok);
    const sailing=await waitEvent(c3,'game:snapshot',x=>x.state==='play'&&x.wave===21);
    const captainX=sailing.players.map(p=>p.entity.x);
    c1b.emit('game:input',{seq:2001,input:{mx:1,ax:0,ay:-1,fire:true}});
    c2b.emit('game:input',{seq:2001,input:{mx:-1,ax:0,ay:-1,fire:true}});
    const moved=await waitEvent(c3,'game:snapshot',x=>x.players[0].entity.x>captainX[0]+8&&x.players[1].entity.x<captainX[1]-8);
    assert(moved.players[0].entity.x!==moved.players[1].entity.x,'revived captains move independently');
    const activeSockets=[c1b,c2b,c3];
    const ids=rrb.room.players.map(p=>p.playerId);
    const earlyLobby=await ack(c2b,'room:return-lobby',{});
    assert(!earlyLobby.ok,'não é possível encerrar a viagem em andamento pelo retorno da derrota');
    const forced=await ack(c3,'test:force-gameover',{});assert(forced.ok);
    await waitEvent(c3,'game:snapshot',x=>x?.state==='gameover',2500);
    const oldRestart=await ack(c2b,'game:restart-request',{});
    assert(!oldRestart.ok,'recomeço direto na derrota deve estar removido');
    const lobbyEvents=Promise.all(activeSockets.map(s=>waitEvent(s,'game:lobby',x=>x?.room?.code===code)));
    const lobbyAck=await ack(c2b,'room:return-lobby',{});assert(lobbyAck.ok);
    const lobbies=await lobbyEvents;
    for(const ev of lobbies){
      assert.equal(ev.room.started,false);
      assert.equal(ev.room.code,code,'código da party deve continuar igual');
      assert.deepEqual(ev.room.players.map(p=>p.playerId),ids,'todos devem manter a identidade na party');
      assert(ev.room.players.every(p=>p.connected));
    }
    const duplicateReturn=await ack(c3,'room:return-lobby',{});
    assert(duplicateReturn.ok,'cliques simultâneos de retorno devem ser idempotentes');
    const streamsBefore=[...count];await sleep(150);
    assert(count.every((n,i)=>n===streamsBefore[i]),'a partida antiga deve parar de enviar snapshots');
    const leaderId=lobbyAck.room.lobbyLeaderPlayerId;
    const leaderSocket=activeSockets[lobbyAck.room.players.findIndex(p=>p.playerId===leaderId)];
    const starts=Promise.all(activeSockets.map(s=>waitEvent(s,'game:start',x=>x?.code===code)));
    assert((await ack(leaderSocket,'room:start',{})).ok);await starts;
    const fresh=await waitEvent(c3,'game:snapshot',x=>x?.wave===1&&x.state==='transition');
    assert(fresh.players.every(p=>p.alive&&p.gold===0&&p.entity.hp===100&&p.lastProcessedInput===0),'nova viagem deve começar com estado limpo');
    assert(!fresh.shop&&fresh.enemies.length===0&&fresh.shots.length===0);
    const finalOver=waitEvent(c3,'game:snapshot',x=>x?.state==='gameover');
    await ack(c3,'test:force-gameover',{});await finalOver;
    const offlineEvent=waitEvent(c3,'game:player-left',x=>x?.slot===0);
    c1b.disconnect();await offlineEvent;
    const returnWithOffline=await ack(c2b,'room:return-lobby',{});assert(returnWithOffline.ok);
    const c1c=await connect();sockets.push(c1c);
    const resumeLobby=await ack(c1c,'room:resume',{code,resumeToken:t1});
    assert(resumeLobby.ok&&!resumeLobby.room.started&&resumeLobby.snapshot===null,'capitão desconectado também deve retomar a mesma party no menu');
    assert.equal(resumeLobby.playerId,r1.playerId);
    const dbg={ok:true,snapshots:count,pausedRevision:ur.revision,p2ResumeSeq:ackSeq,p3Movement:Math.round(p3After-p3Before),partyPreserved:true,newRunClean:true,shopWave:shopSnaps[0].wave,room:code};
    console.log(JSON.stringify(dbg,null,2));
  }finally{
    for(const s of sockets)try{s.disconnect();}catch(_){}
    child.kill('SIGTERM');await sleep(100);
    if(child.exitCode===null)child.kill('SIGKILL');
    if(process.exitCode)console.error(logs);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
