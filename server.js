'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { FullSimulation } = require('./full-simulation');

const app = express();
// Railway forwards HTTPS and the client IP through its edge proxy.
if(process.env.RAILWAY_ENVIRONMENT_ID)app.set('trust proxy',1);
const {installAccounts}=require('./accounts/service');
const {Pool}=require('pg');
const httpServer = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;
const VERSION = '4.3.0-full-gameplay';
const REJOIN_MS = Math.max(10_000, Number(process.env.REJOIN_MS) || 30_000);
const MAX_PLAYERS = 3;
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const DEFAULT_ORIGINS = [
  'https://pandapidio.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];
const ALLOWED_ORIGINS = new Set(
  String(process.env.FRONTEND_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',').map(x=>x.trim()).filter(Boolean)
);

const io = new Server(httpServer, {
  cors: {
    origin(origin, cb){
      if(!origin || ALLOWED_ORIGINS.has(origin)) return cb(null,true);
      cb(new Error('Origem não permitida pelo Rei dos Mares v4.'));
    },
    methods:['GET','POST']
  },
  transports:['websocket','polling'],
  perMessageDeflate:{threshold:512},
  httpCompression:true,
  maxHttpBufferSize:1e6
});

function rid(prefix=''){return prefix+crypto.randomBytes(12).toString('hex');}
function cleanText(v,fallback,max=32){
  const s=String(v??'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,max);
  return s||fallback;
}
function cleanToken(v){
  const s=String(v||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,96);
  return s.length>=12?s:rid('r_');
}
function cleanProfile(raw={}){
  return {
    name:cleanText(raw.name,'Capitão',18),
    skinId:cleanText(raw.skinId,'default',48),
    portrait:cleanText(raw.portrait,'assets/portraits/pirate.svg',180),
    title:cleanText(raw.title,'Capitão',48)
  };
}
function roomCode(){
  for(let tries=0;tries<80;tries++){
    let code='';for(let i=0;i<6;i++)code+=CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)];
    if(!rooms.has(code))return code;
  }
  throw new Error('Não foi possível criar código de sala.');
}
function sorted(room){return [...room.players.values()].sort((a,b)=>a.slot-b.slot);}
function connected(room){return sorted(room).filter(p=>p.connected&&p.socketId);}
function bySocket(room,sid){return sorted(room).find(p=>p.socketId===sid)||null;}
function byToken(room,token){return room.players.get(token)||null;}
function findRoom(socket){return rooms.get(socket.data.roomCode)||null;}
function lobbyLeader(room){return room.players.get(room.lobbyLeaderToken)||null;}
function isLobbyLeader(room,socket){const p=lobbyLeader(room);return !!p&&p.connected&&p.socketId===socket.id;}

function roomSnapshot(room,full=false){
  const snap=room.sim?.snapshot(!!full)||null;
  if(!snap)return null;
  snap.runId=room.runId;
  snap.roomPaused=!!room.paused;
  snap.pauseRevision=Number(room.pauseRevision)||0;
  return snap;
}
function roomPayload(room){
  const leader=lobbyLeader(room);
  return {
    code:room.code,
    runId:room.runId,
    started:room.started,
    paused:room.paused,
    pauseRevision:Number(room.pauseRevision)||0,
    restartRevision:Number(room.restartRevision)||0,
    authoritative:true,
    fullGameplay:true,
    protocol:'rdm-v4',
    maxPlayers:MAX_PLAYERS,
    hostId:leader?.socketId||null,
    hostPlayerId:leader?.playerId||null,
    lobbyLeaderPlayerId:leader?.playerId||null,
    players:sorted(room).map(p=>({
      playerId:p.playerId,socketId:p.socketId||null,slot:p.slot,
      isHost:p.token===room.lobbyLeaderToken,isLobbyLeader:p.token===room.lobbyLeaderToken,
      connected:!!p.connected,reconnectUntil:p.reconnectUntil||0,expired:!!p.expired,
      name:p.profile.name,skinId:p.profile.skinId,portrait:p.profile.portrait,title:p.profile.title
    }))
  };
}
function emitRoom(room){io.to(room.code).emit('room:state',roomPayload(room));}
function attach(socket,room,p){
  p.socketId=socket.id;p.connected=true;p.expired=false;p.reconnectUntil=0;
  socket.join(room.code);socket.data.roomCode=room.code;socket.data.resumeToken=p.token;
  room.sim?.setConnected(p.slot,true);
  if(room.started&&room.autoPausedNoPlayers){
    room.autoPausedNoPlayers=false;
    room.sim?.setPaused(!!room.paused);
    io.to(room.code).emit('game:pause-state',{paused:!!room.paused,by:p.slot,authoritative:true,reason:'players-returned',revision:Number(room.pauseRevision)||0});
  }
}
function detach(socket,room){
  try{socket.leave(room.code);}catch(_){}
  socket.data.roomCode=null;socket.data.resumeToken=null;
}
function promoteLobbyLeader(room){
  const next=connected(room)[0]||null;
  room.lobbyLeaderToken=next?.token||null;
  return next;
}
function playerMeta(p){return {playerId:p.playerId,...p.profile};}

function deleteRoomIfEmpty(room){
  if(!connected(room).length && sorted(room).every(p=>p.expired||!p.connected)){
    room.destroyed=true;room.sim?.dispose();rooms.delete(room.code);
  }
}
function scheduleExpiry(room,p){
  clearTimeout(p.expireTimer);
  const token=p.token,until=p.reconnectUntil;
  p.expireTimer=setTimeout(()=>{
    const live=rooms.get(room.code),q=live?.players.get(token);
    if(!live||!q||q.connected||q.reconnectUntil!==until)return;
    q.expired=true;q.reconnectUntil=0;q.expireTimer=null;
    if(!live.started){
      live.players.delete(q.token);sorted(live).forEach((p,i)=>p.slot=i);
      emitRoom(live);deleteRoomIfEmpty(live);return;
    }
    live.sim?.expirePlayer(q.slot);
    io.to(live.code).emit('game:player-expired',{slot:q.slot,playerId:q.playerId,name:q.profile.name});
    emitRoom(live);deleteRoomIfEmpty(live);
  },Math.max(10,until-Date.now()+40));
}
function leaveBeforeStart(socket,room,p){
  room.players.delete(p.token);detach(socket,room);
  if(!room.players.size){rooms.delete(room.code);return {reconnectUntil:0};}
  const list=sorted(room);list.forEach((x,i)=>x.slot=i);
  if(p.token===room.lobbyLeaderToken)promoteLobbyLeader(room);
  emitRoom(room);return {reconnectUntil:0};
}
function suspendStarted(socket,room,p){
  if(!p.connected)return {reconnectUntil:p.reconnectUntil||0};
  p.connected=false;p.socketId=null;p.expired=false;p.reconnectUntil=Date.now()+REJOIN_MS;
  room.sim?.setConnected(p.slot,false);
  detach(socket,room);
  io.to(room.code).emit('game:player-left',{
    slot:p.slot,playerId:p.playerId,name:p.profile.name,temporary:true,reconnectUntil:p.reconnectUntil,
    wasHost:false,authoritative:true
  });
  if(p.token===room.lobbyLeaderToken)promoteLobbyLeader(room);
  if(!connected(room).length){room.autoPausedNoPlayers=true;room.sim?.setPaused(true);}
  scheduleExpiry(room,p);emitRoom(room);return {reconnectUntil:p.reconnectUntil};
}
function expireStarted(socket,room,p){
  clearTimeout(p.expireTimer);p.expireTimer=null;p.connected=false;p.socketId=null;p.expired=true;p.reconnectUntil=0;
  room.sim?.expirePlayer(p.slot);detach(socket,room);
  io.to(room.code).emit('game:player-expired',{slot:p.slot,playerId:p.playerId,name:p.profile.name});
  if(p.token===room.lobbyLeaderToken)promoteLobbyLeader(room);
  emitRoom(room);deleteRoomIfEmpty(room);return {reconnectUntil:0};
}
function leaveCurrent(socket,permanent=false){
  const room=findRoom(socket);if(!room)return {reconnectUntil:0};
  const p=bySocket(room,socket.id);if(!p){detach(socket,room);return {reconnectUntil:0};}
  if(!room.started)return leaveBeforeStart(socket,room,p);
  return permanent?expireStarted(socket,room,p):suspendStarted(socket,room,p);
}

function resume(socket,payload,cb){
  const code=String(payload?.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
  const token=cleanToken(payload?.resumeToken),room=rooms.get(code);
  if(!room)return cb({ok:false,error:'Esta viagem não está mais disponível.'});
  const p=byToken(room,token);if(!p)return cb({ok:false,error:'Sessão de retorno inválida.'});
  if(p.connected){
    if(p.socketId===socket.id)return cb({ok:true,room:roomPayload(room),yourSlot:p.slot,playerId:p.playerId,resumeToken:p.token,snapshot:roomSnapshot(room,true),alreadyConnected:true});
    return cb({ok:false,error:'Este capitão já está conectado em outra aba ou dispositivo.'});
  }
  if(p.expired||!p.reconnectUntil||Date.now()>p.reconnectUntil)return cb({ok:false,error:'O tempo de retorno terminou.'});
  leaveCurrent(socket,true);clearTimeout(p.expireTimer);p.expireTimer=null;attach(socket,room,p);
  if(room.started)io.to(room.code).emit('game:player-rejoined',{slot:p.slot,playerId:p.playerId,name:p.profile.name,authoritative:true});
  emitRoom(room);
  cb({ok:true,room:roomPayload(room),yourSlot:p.slot,playerId:p.playerId,resumeToken:p.token,snapshot:roomSnapshot(room,true),authoritative:true});
}

function createRoom(socket,payload,cb){
  leaveCurrent(socket,true);
  const code=roomCode(),token=cleanToken(payload?.resumeToken);
  const p={token,playerId:rid('p_'),socketId:socket.id,slot:0,connected:true,expired:false,reconnectUntil:0,expireTimer:null,profile:cleanProfile(payload?.profile)};
  const room={code,players:new Map([[token,p]]),lobbyLeaderToken:token,started:false,paused:false,pauseRevision:0,restartRevision:0,autoPausedNoPlayers:false,createdAt:Date.now(),sim:null,lastBroadcastAt:0,lastFullAt:0,destroyed:false};
  rooms.set(code,room);attach(socket,room,p);cb({ok:true,room:roomPayload(room),yourSlot:0,playerId:p.playerId,resumeToken:token,authoritative:true});emitRoom(room);
}
function joinRoom(socket,payload,cb){
  const code=String(payload?.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6),room=rooms.get(code);
  if(!room)return cb({ok:false,error:'Sala não encontrada.'});
  if(room.started)return cb({ok:false,error:'Esta viagem já começou. Use Retomar Multijogador se esta era sua viagem.'});
  if(sorted(room).length>=MAX_PLAYERS)return cb({ok:false,error:'A sala já está cheia.'});
  leaveCurrent(socket,true);
  const token=cleanToken(payload?.resumeToken);if(room.players.has(token))return cb({ok:false,error:'Identidade de sessão já em uso.'});
  const used=new Set(sorted(room).map(p=>p.slot)),slot=[0,1,2].find(x=>!used.has(x));
  const p={token,playerId:rid('p_'),socketId:socket.id,slot,connected:true,expired:false,reconnectUntil:0,expireTimer:null,profile:cleanProfile(payload?.profile)};
  room.players.set(token,p);attach(socket,room,p);cb({ok:true,room:roomPayload(room),yourSlot:slot,playerId:p.playerId,resumeToken:token,authoritative:true});emitRoom(room);
}
function startRoom(socket,cb){
  const room=findRoom(socket);if(!room)return cb({ok:false,error:'Você não está em uma sala.'});
  if(room.started)return cb({ok:false,error:'Esta viagem já foi iniciada.'});
  if(!isLobbyLeader(room,socket))return cb({ok:false,error:'Somente o líder da sala pode iniciar.'});
  if(connected(room).length<2)return cb({ok:false,error:'Aguarde pelo menos mais um capitão.'});
  room.runId=rid('run_');room.started=true;room.paused=false;room.pauseRevision=0;room.autoPausedNoPlayers=false;
  for(const p of sorted(room)){p.actionResults=new Map();p.pendingAwards=new Map();}
  room.sim=new FullSimulation(sorted(room).map(playerMeta));
  for(const p of sorted(room))room.sim.setConnected(p.slot,!!p.connected&&!p.expired);
  const payload=roomPayload(room);io.to(room.code).emit('game:start',payload);emitRoom(room);
  cb({ok:true,authoritative:true});
}

function returnToLobby(socket,cb){
  const room=findRoom(socket),requester=room?bySocket(room,socket.id):null;
  if(!room||!requester?.connected)return cb({ok:false,error:'Sala indisponível.'});
  if(!room.started)return cb({ok:true,room:roomPayload(room)});
  if(!['gameover','victory'].includes(room.sim?.state))return cb({ok:false,error:'A viagem ainda está em andamento.'});
  room.lastAwardAt=0;emitAwards(room);
  room.started=false;room.sim?.dispose();room.sim=null;room.paused=false;room.autoPausedNoPlayers=false;
  room.pauseRevision=0;
  // A sala e as identidades continuam existindo. Só a partida encerrada é descartada.
  for(const p of sorted(room))if(p.expired){clearTimeout(p.expireTimer);room.players.delete(p.token);}
  sorted(room).forEach((p,i)=>p.slot=i);
  if(!lobbyLeader(room)?.connected)promoteLobbyLeader(room);
  room.lastBroadcastAt=0;room.lastFullAt=0;
  const payload={room:roomPayload(room),authoritative:true};
  io.to(room.code).emit('game:lobby',payload);
  emitRoom(room);
  cb({ok:true,...payload});
}

io.on('connection',socket=>{
  socket.emit('server:hello',{id:socket.id,version:VERSION,protocol:'rdm-v4',authoritative:true,fullGameplay:true,reconnectSeconds:Math.round(REJOIN_MS/1000)});

  socket.on('room:create',(payload,cb=()=>{})=>{try{createRoom(socket,payload,cb);}catch(e){cb({ok:false,error:e.message||'Erro ao criar sala.'});}});
  socket.on('room:join',(payload,cb=()=>{})=>joinRoom(socket,payload,cb));
  socket.on('room:resume',(payload,cb=()=>{})=>resume(socket,payload,cb));
  socket.on('room:start',(_payload,cb=()=>{})=>startRoom(socket,cb));
  socket.on('room:leave',(payload,cb=()=>{})=>cb({ok:true,...leaveCurrent(socket,!!payload?.permanent)}));
  socket.on('room:return-lobby',(_payload,cb=()=>{})=>returnToLobby(socket,cb));
  socket.on('game:restart-request',(_payload,cb=()=>{})=>cb({ok:false,error:'Volte ao menu e inicie uma nova viagem com o mesmo grupo.'}));

  socket.on('game:input',payload=>{
    const room=findRoom(socket),p=room?bySocket(room,socket.id):null;
    if(!room?.started||!p?.connected||!room.sim)return;
    room.sim.setInput(p.slot,payload?.input||{},payload?.seq||0);
  });

  socket.on('game:action',(payload,cb=()=>{})=>{
    const room=findRoom(socket),p=room?bySocket(room,socket.id):null;
    if(!room?.started||!p?.connected||!room.sim)return cb({ok:false,error:'Partida indisponível.'});
    if(payload?.runId!==room.runId)return cb({ok:false,error:'Esta ação pertence a outra viagem.'});
    const requestId=String(payload?.requestId||'').slice(0,160);
    if(!requestId)return cb({ok:false,error:'Pedido sem identificação.'});
    p.actionResults ||= new Map();
    if(p.actionResults.has(requestId))return cb({...p.actionResults.get(requestId),snapshot:roomSnapshot(room,true)});
    const result=room.sim.performAction(p.slot,String(payload.action||''),payload.payload||{});
    p.actionResults.set(requestId,result);
    if(p.actionResults.size>128)p.actionResults.delete(p.actionResults.keys().next().value);
    const snapshot=roomSnapshot(room,true);
    io.to(room.code).emit('game:snapshot',snapshot);emitAwards(room);
    cb({...result,snapshot});
  });
  socket.on('game:award-ack',(payload)=>{const room=findRoom(socket),p=room?bySocket(room,socket.id):null;p?.pendingAwards?.delete(String(payload?.id||''));});
  socket.on('game:shop-profile',(_payload,cb=()=>{})=>cb({ok:false,error:'Atualize o jogo: as compras agora são processadas pelo servidor.'}));
  socket.on('game:shop-ready',(_payload,cb=()=>{})=>cb({ok:false,error:'Atualize o jogo: as escolhas agora são processadas pelo servidor.'}));

  socket.on('game:pause-request',(payload,cb=()=>{})=>{
    const room=findRoom(socket),p=room?bySocket(room,socket.id):null;
    if(!room?.started||!p||!room.sim)return cb({ok:false,error:'Partida indisponível.'});
    const desired=!!payload?.paused;
    if(room.paused!==desired){
      room.paused=desired;
      room.pauseRevision=(Number(room.pauseRevision)||0)+1;
    }
    room.sim.setPaused(room.paused||room.autoPausedNoPlayers);
    const state={ok:true,paused:room.paused,by:p.slot,authoritative:true,revision:Number(room.pauseRevision)||0};
    io.to(room.code).emit('game:pause-state',state);
    cb(state);
  });

  socket.on('net:ping',(payload,cb=()=>{})=>cb({clientTime:Number(payload?.clientTime)||0,serverTime:Date.now(),version:VERSION}));

  socket.on('game:resync-request',()=>{
    const room=findRoom(socket);if(!room?.started||!room.sim)return;
    socket.emit('game:snapshot',roomSnapshot(room,true));
  });

  if(process.env.RDM_TESTING==='1'){
    socket.on('test:force-gameover',(_payload,cb=()=>{})=>{
      const room=findRoom(socket);if(!room?.started||!room.sim)return cb({ok:false});
      room.sim.forceGameover();room.paused=false;
      io.to(room.code).emit('game:snapshot',roomSnapshot(room,true));
      cb({ok:true});
    });
    socket.on('test:defeat-boss',(_payload,cb=()=>{})=>{const room=findRoom(socket);if(!room?.sim)return cb({ok:false});room.sim.defeatCurrentBoss();io.to(room.code).emit('game:snapshot',roomSnapshot(room,true));cb({ok:true});});
    socket.on('test:force-wave',(payload,cb=()=>{})=>{
      const room=findRoom(socket);if(!room?.sim)return cb({ok:false});room.sim.forceWave(Math.max(1,Number(payload?.wave)||1));
      io.to(room.code).emit('game:snapshot',roomSnapshot(room,true));cb({ok:true});
    });
    socket.on('test:grant-gold',(payload,cb=()=>{})=>{
      const room=findRoom(socket);if(!room?.sim)return cb({ok:false});room.sim.grantGold(Number(payload?.gold)||1000);
      io.to(room.code).emit('game:snapshot',roomSnapshot(room,true));cb({ok:true});
    });
    socket.on('test:force-wave-complete',(payload,cb=()=>{})=>{
      const room=findRoom(socket);if(!room?.started||!room.sim)return cb({ok:false});
      const w=Math.max(1,Math.floor(Number(payload?.wave)||5));
      room.sim.forceWaveComplete(w);io.to(room.code).emit('game:snapshot',roomSnapshot(room,true));
      cb({ok:true,wave:w});
    });
  }

  socket.on('disconnect',()=>leaveCurrent(socket,false));
});

function emitAwards(room){
  for(const award of room.sim?.collectAwards()||[]){
    const p=sorted(room).find(p=>p.slot===award.slot);if(!p)continue;
    p.pendingAwards ||= new Map();const id=room.runId+':'+award.id;
    p.pendingAwards.set(id,{...award,runId:room.runId,id});
  }
  if(Date.now()-(room.lastAwardAt||0)<500)return;room.lastAwardAt=Date.now();
  for(const p of sorted(room))if(p.connected&&p.socketId)for(const award of p.pendingAwards?.values()||[])io.to(p.socketId).emit('game:meta-award',award);
}

let lastTick=process.hrtime.bigint();
setInterval(()=>{
  const now=process.hrtime.bigint(),dt=Math.min(.1,Number(now-lastTick)/1e9);lastTick=now;
  const ms=Date.now();
  for(const room of rooms.values()){
    if(room.destroyed)continue;emitAwards(room);
    if(!room.started||!room.sim)continue;
    try{room.sim.step(dt);}catch(e){console.error('[simulation]',room.code,e);room.sim.setPaused(true);io.to(room.code).emit('game:error',{error:'A viagem foi pausada por um erro de simulação.'});}
    const interval=['play','transition'].includes(room.sim.state)?33:500;
    if(ms-room.lastBroadcastAt>=interval){
      room.lastBroadcastAt=ms;
      const full=ms-room.lastFullAt>=2200;if(full)room.lastFullAt=ms;
      const snap=roomSnapshot(room,full);
      io.to(room.code).volatile.emit('game:snapshot',snap);
    }
  }
},1000/60);

app.get('/',(_req,res)=>res.json({ok:true,service:'Rei dos Mares Multiplayer v4',version:VERSION,protocol:'rdm-v4',authoritative:true}));
app.get('/health',(_req,res)=>{
  const active=[...rooms.values()].filter(r=>r.started&&r.sim).length;
  res.json({ok:true,version:VERSION,protocol:'rdm-v4',authoritative:true,fullGameplay:true,simulationHz:60,snapshotHz:30,rooms:rooms.size,activeMatches:active,connections:io.engine.clientsCount,now:Date.now()});
});

async function start(){
 const db=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL}):null;
 await installAccounts(app,{db,origins:ALLOWED_ORIGINS});
httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log('======================================');
  console.log(' REI DOS MARES V4 - AUTHORITATIVE TEST');
  console.log('======================================');
  console.log('Version:',VERSION);
  console.log('Port:',PORT);
  console.log('Origins:',[...ALLOWED_ORIGINS].join(', '));
});

}
start().catch(()=>{console.error('Falha ao inicializar o serviço de contas/banco.');process.exit(1);});
