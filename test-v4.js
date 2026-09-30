'use strict';
const assert=require('assert');
const {AuthoritativeSimulation}=require('./simulation-v4');

function run(sim,seconds){for(let i=0;i<Math.ceil(seconds*60);i++)sim.step(1/60);}
const players=[
  {playerId:'p1',name:'Host apenas do lobby',skinId:'default'},
  {playerId:'p2',name:'P2',skinId:'gullit'},
  {playerId:'p3',name:'P3',skinId:'midas'}
];
const sim=new AuthoritativeSimulation(players,{random:()=>0.37});

run(sim,4.5);
assert.equal(sim.state,'play','transição deve terminar no servidor');

sim.setInput(0,{mx:-1,my:0,ax:1,ay:0,fire:true},1);
sim.setInput(1,{mx:1,my:0,ax:-1,ay:0,fire:true},1);
sim.setInput(2,{mx:0,my:-1,ax:0,ay:-1,fire:true},1);
const before=sim.players.map(p=>({x:p.entity.x,y:p.entity.y}));
run(sim,1);
assert(sim.players[0].entity.x<before[0].x,'P1 deve mover à esquerda');
assert(sim.players[1].entity.x>before[1].x,'P2 deve mover à direita');
assert(sim.players[2].entity.y<before[2].y,'P3 deve mover para cima');
assert(sim.shots.some(s=>s.ownerId===0&&s.team==='player'),'tiro P1 deve ser explicitamente aliado');
assert(sim.shots.some(s=>s.ownerId===1&&s.team==='player'),'tiro P2 deve ser explicitamente aliado');
assert(sim.shots.some(s=>s.ownerId===2&&s.team==='player'),'tiro P3 deve ser explicitamente aliado');

const p2x=sim.players[1].entity.x;
sim.setConnected(0,false);
run(sim,.75);
assert.equal(sim.players[0].connected,false,'P1 pode sair sem parar a simulação');
assert(sim.elapsed>0,'servidor deve continuar simulando sem o criador da sala');
assert(sim.players[1].entity.x!==p2x,'P2 continua sendo simulado quando P1 sai');

const hpBefore=sim.players[0].entity.hp,xBefore=sim.players[0].entity.x;
sim.setConnected(0,true);
assert.equal(sim.players[0].entity.hp,hpBefore,'reconexão preserva HP');
assert.equal(sim.players[0].entity.x,xBefore,'reconexão preserva posição');

const snap=sim.snapshot(true);
assert.equal(snap.v,2);
assert.equal(snap.authoritativeV4,true);
assert.equal(snap.players.length,3);
assert(Number.isFinite(snap.players[1].lastProcessedInput));
assert(snap.shots.every(s=>s.team==='player'),'snapshot não pode transformar tiro de jogador em tiro inimigo');

// Navio comum destruído deve permanecer tempo suficiente para animação de naufrágio.
const deathSim=new AuthoritativeSimulation(players,{random:()=>0.37});run(deathSim,4.5);
deathSim.enemies=[];deathSim.waveRemainingToSpawn=0;
deathSim.spawnEnemy();const victim=deathSim.enemies[0];victim.hp=1;
deathSim.shots.push({__netId:'test-kill',team:'player',ownerId:0,x:victim.x,y:victim.y,prevX:victim.x,prevY:victim.y,vx:0,vy:0,life:1,damage:2,radius:8});
deathSim.resolveCollisions();
assert(victim.destroyed&&victim.sinking>0,'inimigo destruído deve entrar em sinking');
assert(deathSim.enemies.includes(victim),'inimigo não pode sumir no mesmo tick da morte');
run(deathSim,.8);assert(deathSim.enemies.includes(victim),'naufrágio comum deve continuar visível durante a animação');
run(deathSim,1.1);assert(!deathSim.enemies.includes(victim),'naufrágio comum deve ser removido após a animação');

sim.wave=14;sim.enemies=[];sim.waveRemainingToSpawn=0;sim.nextWave();
assert.equal(sim.wave,15);
assert(sim.bossFight&&sim.enemies.some(e=>e.isBoss),'onda 15 deve nascer no servidor');
const boss=sim.enemies.find(e=>e.isBoss);
sim.bossFight.intro=0;boss.y=165;boss.hp=100;
const hpBeforeSail=boss.hp;
sim.shots.push({__netId:'sail-miss',team:'player',ownerId:0,x:boss.x,y:boss.y-145,prevX:boss.x,prevY:boss.y-145,vx:0,vy:0,life:1,damage:10,radius:8});
sim.resolveCollisions();
assert.equal(boss.hp,hpBeforeSail,'topo da vela não deve ser o centro da hitbox do boss');
sim.shots.push({__netId:'hull-hit',team:'player',ownerId:0,x:boss.x,y:boss.y+66,prevX:boss.x,prevY:boss.y+66,vx:0,vy:0,life:1,damage:10,radius:8});
sim.resolveCollisions();
assert(boss.hp<hpBeforeSail,'casco do boss deve receber tiro');

boss.hp=1;
sim.shots.push({__netId:'test-boss-shot',team:'player',ownerId:0,x:boss.x,y:boss.y+66,prevX:boss.x,prevY:boss.y+66,vx:0,vy:0,life:1,damage:2,radius:8});
sim.resolveCollisions();
assert(boss.destroyed&&boss.sinking>0,'boss derrotado deve afundar em vez de desaparecer');
run(sim,1.5);assert(sim.enemies.includes(boss),'boss deve continuar visível durante o naufrágio');
run(sim,1.7);
assert.equal(sim.wave,15,'boss de onda múltipla de 5 não pode pular direto para a onda seguinte');
assert.equal(sim.state,'upgrade','após o boss da onda 15 o estaleiro deve abrir');
assert(sim.shop.open,'shop autoritativa deve estar aberta após boss');
sim.setShopReady(0,true);sim.setShopReady(1,true);const bossShopDone=sim.setShopReady(2,true);
assert(bossShopDone.continued,'último pronto deve liberar a viagem');
assert.equal(sim.wave,16,'onda 16 começa somente depois do estaleiro');
assert.equal(sim.state,'play');

const shopSim=new AuthoritativeSimulation(players,{random:()=>0.37});run(shopSim,4.5);
shopSim.wave=5;shopSim.enemies=[];shopSim.waveRemainingToSpawn=0;shopSim.completeWave();
assert.equal(shopSim.state,'upgrade','onda 5 deve abrir o estaleiro');
assert.equal(shopSim.wave,5,'abrir loja não pode incrementar a onda antes da hora');
assert(shopSim.snapshot(true).shop.open,'snapshot deve informar loja aberta');
shopSim.players[0].gold=500;
const prof=shopSim.applyShopProfile(0,{gold:320,maxHp:140,hp:120,speedMult:1.2,damageMult:1.35,fireRateMult:1.25,doubleShot:true,classPath:'marine'});
assert(prof.ok&&shopSim.players[0].gold===320,'perfil da loja deve sincronizar ouro gasto');
assert.equal(shopSim.players[0].entity.maxHp,140);
assert.equal(shopSim.players[0].entity.doubleShot,true);
shopSim.firePlayer(shopSim.players[0]);
assert.equal(shopSim.shots.length,2,'tiro duplo comprado deve existir na simulação autoritativa');
shopSim.setShopReady(0,true);shopSim.setShopReady(1,true);const readyFinal=shopSim.setShopReady(2,true);
assert(readyFinal.continued,'todos prontos devem fechar o estaleiro');
assert.equal(shopSim.wave,6);
assert.equal(shopSim.state,'play');

const fireSim=new AuthoritativeSimulation(players,{random:()=>0.37});run(fireSim,4.5);
fireSim.firePlayer(fireSim.players[0]);
const fs=fireSim.shots[0],speed=Math.hypot(fs.vx,fs.vy);
assert(Math.abs(speed-600)<.01,'velocidade autoritativa do tiro deve ser 600 como no cliente');
assert(Math.abs(fireSim.players[0].entity.shot-.70)<.001,'cooldown autoritativo deve coincidir com o cliente base');
assert(JSON.stringify(sim.snapshot(false)).length<25000,'snapshot deve permanecer compacto');

// Paridade de resistência e dano, com 1, 2 e 3 capitães.
for(const wave of [1,5,10,11,12,25,50,75,100]){
  const sims=[1,2,3].map(count=>new AuthoritativeSimulation(players.slice(0,count),{random:()=>.99}));
  for(const sim of sims){
    sim.wave=wave;sim.spawnEnemy();
    const e=sim.enemies[0],d=require('./simulation-v4').difficulty(wave);
    assert.equal(e.max,1+d.hp+(wave>50?d.endlessHp:0));
    sim.players[0].aim=0;sim.firePlayer(sim.players[0]);
    const shot=sim.shots[0];assert.equal(shot.damage,1);
    shot.x=e.x;shot.y=e.y;sim.resolveCollisions();
    assert.equal(e.destroyed,wave<12,'básicos iniciais devem morrer com um tiro');
    sim.fireEnemy(e,sim.players[0]);
    assert.equal(sim.enemyShots[0].damage,d.damage);
    assert.equal(Math.round(Math.hypot(sim.enemyShots[0].vx,sim.enemyShots[0].vy)),Math.round(d.bullet));
  }
  assert(sims.every(sim=>sim.enemies[0].max===sims[0].enemies[0].max),'quantidade de capitães não pode aumentar vida');
}
console.log(JSON.stringify({
  ok:true,
  tests:39,
  ticks:sim.metrics.ticks,
  wave:sim.wave,
  players:sim.players.map(p=>({id:p.id,connected:p.connected,hp:p.entity.hp})),
  shots:sim.metrics.shots,
  enemyShots:sim.metrics.enemyShots
},null,2));
