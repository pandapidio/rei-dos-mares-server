'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm');
const {FullSimulation}=require('./full-simulation');
const metas=Array.from({length:3},(_,i)=>({name:'P'+i,skinId:'default'}));
const run=(s,code)=>vm.runInContext(code,s.context);
const advance=(s,seconds)=>{for(let i=0;i<seconds*60;i++)s.step(1/60);};
const s=new FullSimulation(metas);
try{
 assert.equal(s.players.length,3);advance(s,5);assert.equal(s.state,'play');
 // Primary and extra captains must all fire on the authoritative server.
 for(let slot=0;slot<3;slot++)s.setInput(slot,{ax:1,ay:0,fire:true},1);
 advance(s,.3);assert.deepEqual([...new Set(s.shots.map(q=>q.ownerId))].sort(),[0,1,2]);
 for(let slot=0;slot<3;slot++)s.setInput(slot,{fire:false},2);
 // Difficulty/config are identical for one, two and three connected players.
 const tuning=JSON.stringify(run(s,'({normal:difficulty(27),boss:admiralConfig("blackbeard")})'));
 s.setConnected(2,false);s.setConnected(1,false);
 assert.equal(JSON.stringify(run(s,'({normal:difficulty(27),boss:admiralConfig("blackbeard")})')),tuning);
 s.setConnected(1,true);s.setConnected(2,true);
 const roles=new Set(),events=new Set();
 for(const wave of [1,6,8,12,18,21,24,27,28,33,35,42,51,57,63,69]){
  s.forceWave(wave);for(const p of s.players){p.entity.hp=p.entity.maxHp;p.entity.inv=9999;}
  advance(s,7);for(const e of s.enemies)roles.add(e.role);
  if(s.snapshot().voyage.event)events.add(s.snapshot().voyage.event);
  assert.equal(s.wave,wave);assert.equal(s.state,'play');
 }
 assert(roles.size>=10,'full campaign enemy variety: '+[...roles]);assert(events.size>=8,'full campaign event variety: '+[...events]);
 for(const [wave,kind,height]of [[15,'marine',325],[25,'blackbeard',300],[50,'ghostKing',330]]){
  s.forceWave(wave);const e=s.enemies.find(e=>e.isBoss);assert.equal(e.bossKind,kind);
  const cfg=run(s,`admiralConfig('${kind}')`);assert.equal(e.hp,cfg.hp);assert.equal(e.max,cfg.hp);
  assert.equal(run(s,`bossFight.cfg.h`),height);
  advance(s,8);assert(s.snapshot(true).bossFight.kind===kind);s.defeatCurrentBoss();advance(s,5);
  assert.equal(s.state,wave===50?'victory':'bossreward');
  assert(s.collectAwards().some(a=>a.skinId),'boss cosmetic award reaches clients');
  if(wave===50){assert(s.performAction(0,'victory-continue',{}).ok);assert.equal(s.snapshot().infiniteMode,true);}
  else{assert(s.performAction(0,'boss-continue',{}).ok);if(kind==='blackbeard'&&s.state==='bossreward')assert(s.performAction(1,'boss-continue',{}).ok);}
  assert.equal(s.state,'upgrade');
 }
 // All original upgrades are applied through the same validated shop action.
 s.forceWaveComplete(10);s.shop.phase='normal';
 const ids=new Set();for(const [slot,path]of ['marine','pirate','undead'].entries()){
  s.players[slot].build.path=path;s.players[slot].gold=100000;
  run(s,`{const p=ReiMultiplayerLocal.players[${slot}];p.shopChoices=UPGRADES.filter(u=>u.path==='neutral'||u.path==='${path}');}`);
  for(const u of s.players[slot].shopChoices){assert(s.performAction(slot,'buy',{id:u.id}).ok,'apply '+u.id);ids.add(u.id);}
 }
 assert.equal(ids.size,33);
 for(const p of s.players){assert.equal(p.entity.maxHp,120);assert(p.entity.damageMult>1.3&&p.entity.speedMult>1&&p.entity.fireRateMult>1);}
 assert(s.players[0].entity.piercing);assert(s.players[1].entity.flame&&s.players[1].entity.explosive);assert(s.players[2].upgrades.has('ectoplasm'));
 for(let slot=0;slot<3;slot++)s.performAction(slot,'ready',{ready:true});assert.equal(s.state,'play');
 for(const p of s.players){p.entity.hp=50;p.entity.inv=9999;}
 for(let slot=0;slot<3;slot++)s.setInput(slot,{ax:1,ay:0,fire:true},3);
 for(let i=0;i<8.5*60;i++){if(i%10===0)for(let slot=0;slot<3;slot++)s.setInput(slot,{ax:1,ay:0,fire:true},4+i);s.step(1/60);}
 assert(s.players.every(p=>p.entity.hp>=58),'carpenter heals every captain');
 const snap=s.snapshot();assert(snap.players.every(p=>p.build.path&&p.build.metrics&&p.stats));
 assert(s.shots.some(q=>q.ownerId===0&&q.piercing));assert(s.shots.some(q=>q.ownerId===1&&q.explosive));
 assert(s.shots.some(q=>q.ownerId===2&&q.spectral));
 const oldTicks=s.metrics.ticks;s.setPaused(true);advance(s,1);assert.equal(s.metrics.ticks,oldTicks);s.setPaused(false);
 s.setConnected(0,false);s.setInput(1,{ax:1,fire:true},1000);s.players[1].entity.shot=0;advance(s,.1);assert(s.shots.some(q=>q.ownerId===1));s.setConnected(0,true);
 s.forceWave(60);s.defeatCurrentBoss();assert.equal(s.collectAwards().filter(a=>a.reason==='endlessBoss'&&a.diamonds===2).length,3);
 s.forceWaveComplete(70);assert.equal(s.shop.phase,'spec');
 for(let slot=0;slot<3;slot++){const id=s.players[slot].specChoices[0].id;assert(s.performAction(slot,'spec',{id}).ok);assert(s.players[slot].build.specializations.has(id));}
 assert.equal(s.shop.phase,'normal');s.players[2].alive=false;s.players[2].entity.hp=0;
 s.forceWaveComplete(75);s.grantGold(5000);s.players[0].entity.hp=50;
 assert(s.performAction(0,'repair',{}).ok);assert.equal(s.players[0].entity.hp,80);assert(!s.performAction(0,'repair',{}).ok);
 const recipient=s.players[1].gold;assert(s.performAction(0,'donate',{target:1,amount:100}).ok);assert.equal(s.players[1].gold,recipient+100);
 assert(s.performAction(0,'revive',{target:2,amount:'rest'}).ok);assert(s.players[2].alive);assert.equal(s.players[2].entity.hp,84);assert(s.players[2].upgrades.has('ectoplasm'));
 assert(s.performAction(1,'reroll',{}).ok);assert(!s.performAction(1,'reroll',{}).ok);
 console.log(JSON.stringify({ok:true,enemies:[...roles],events:[...events],upgrades:ids.size,bosses:3,allCaptainsFire:true,allCaptainsHeal:true,soloDifficulty:true,specializations:true,repairDonationRevive:true}));
}finally{s.dispose();}

const r=new FullSimulation(metas);
try{
 advance(r,5);
 r.setInput(0,{ax:1,fire:true},20);advance(r,.8);
 assert(!r.lastInputs.has(0),'stale shooting commands expire');
 assert(!r.window.ReiMultiplayerLocal.remoteInputs.get(0).fire);
 assert(!r.setInput(0,{fire:true},NaN));assert(!r.setInput(0,{fire:true},Infinity));
 r.setInput(1,{fire:true},50);r.setConnected(1,false);r.setConnected(1,true);
 assert(!r.lastInputs.has(1),'reconnect must release stale fire');
 assert(r.setInput(1,{fire:false},51),'resume uses acknowledged sequence');
 run(r,`{
   const mp=ReiMultiplayerLocal,p=mp.players[1];
   player=p.entity;gold=p.gold;acquiredUpgrades=p.upgrades;buildRun=p.build;
   const enemy=()=>({hp:1,max:100,type:'light',role:'scout',x:300,y:300,sinking:0,destroyed:false,spawnShield:0});
   const e=enemy();enemies=[e];applyEnemyDamage(e,999,'shot');destroyEnemy(e);
   const blast=enemy();enemies=[blast];explodeShot({damage:999,life:1},300,300,blast);
   const burn=enemy();burn.burn={ownerId:1,time:10,acc:1,age:0};enemies=[burn];updateEnemyBurns(.1);
 }`);
 assert.equal(r.players[1].gold,30,'shot, explosion and burn award the killer once');
 assert.equal(r.players[0].gold,0);assert.equal(r.players[2].gold,0);
 assert.equal(r.players[1].stats.kills,3);
 r.forceWave(15);
 const bossReward=run(r,'bossFight.cfg.gold');
 const goldBefore=r.players.map(p=>p.gold);
 run(r,`{const p=ReiMultiplayerLocal.players[1];player=p.entity;gold=p.gold;acquiredUpgrades=p.upgrades;buildRun=p.build;const e=enemies.find(e=>e.isBoss);bossFight.intro=0;defeatBoss(e);defeatBoss(e);}`);
 assert.equal(r.players[1].gold-goldBefore[1],Math.floor(bossReward/3)+(bossReward%3>1?1:0)+10,'boss killer gets shared prize plus bonus');
 assert.equal(r.players[0].gold-goldBefore[0],Math.floor(bossReward/3)+(bossReward%3>0?1:0));
 assert.notEqual(r.players[0].entity,r.players[1].entity,'boss rewards preserve captain identity');
 r.forceWave(1);r.state='play';
 const mp=r.window.ReiMultiplayerLocal;
 mp.localSlot=1;mp.setOnlineRole(false,1);mp.online.authoritative=true;mp.online.localInput=()=>mp.localInput();
 r.window.RDMOnline.socket={connected:false};r.window.RDMOnline.state={started:true,lastSnapshotAt:r.window.performance.now()};
 run(r,'mouse.down=true;player.shot=0;shots=[];update(.02);shoot();');
 assert.equal(r.shots.length,0,'disconnected client must not manufacture harmless shots');
 r.window.RDMOnline.socket.connected=true;
 r.window.RDMOnline.state.lastSnapshotAt=r.window.performance.now()-2000;
 run(r,'player.shot=0;update(.02);shoot();');assert.equal(r.shots.length,0,'stalled snapshots stop visual firing');
 r.window.RDMOnline.state.lastSnapshotAt=r.window.performance.now();
 run(r,'player.shot=0;update(.02);');assert(r.shots.length>0,'fresh connection permits prediction');
 r.window.dispatchEvent(new r.window.Event('blur'));
 assert.equal(r.window.ReiMultiplayerLocal.localInput().fire,false);
 console.log('Input expiry, reconnect, killer gold and boss identity regressions passed');
}finally{r.dispose();}

// Death snapshots and shop revives must never transfer a ship/build between slots.
for(const deadSlot of [0,1,2]){
 const sim=new FullSimulation(metas),replicas=[];
 try{
  advance(sim,5);
  const mp=sim.window.ReiMultiplayerLocal;
  const entities=sim.players.map(p=>p.entity),builds=sim.players.map(p=>p.build),upgrades=sim.players.map(p=>p.upgrades);
  for(const [i,p]of sim.players.entries()){p.build.path=['marine','pirate','undead'][i];p.entity.speedMult=1+i*.1;p.upgrades.add(['gunnery','flame-shot','spectral-ammo'][i]);}
  for(let slot=0;slot<3;slot++){
   const client=new FullSimulation(metas);replicas.push(client);client.window.RDMOnline.serverSimulation=false;
   client.window.ReiMultiplayerLocal.setOnlineRole(false,slot);
   client.window.ReiMultiplayerLocal.applySnapshot(sim.snapshot(true),true);
  }
  mp.damagePlayer(deadSlot,10000);assert(!sim.players[deadSlot].alive);
  const death=sim.snapshot();
  for(const client of replicas)client.window.ReiMultiplayerLocal.applySnapshot(JSON.parse(JSON.stringify(death)),true);
  for(let slot=0;slot<3;slot++){assert.equal(sim.players[slot].entity,entities[slot]);assert.equal(sim.players[slot].build,builds[slot]);assert.equal(sim.players[slot].upgrades,upgrades[slot]);}
  sim.forceWaveComplete(10);sim.grantGold(5000);
  const donor=(deadSlot+1)%3,second=(deadSlot+2)%3;
  assert(sim.performAction(donor,'revive',{target:deadSlot,amount:500}).ok);
  assert(!sim.players[deadSlot].alive);
  assert(sim.performAction(second,'revive',{target:deadSlot,amount:'rest'}).ok);
  assert(sim.players[deadSlot].alive);assert.equal(sim.players[deadSlot].entity.hp,70);
  assert(!sim.performAction(donor,'revive',{target:deadSlot,amount:'rest'}).ok,'repeat revive does not charge');
  const revived=sim.snapshot(true);
  for(const client of replicas){client.window.ReiMultiplayerLocal.applySnapshot(JSON.parse(JSON.stringify(revived)),true);assert.equal(new Set(client.players.map(p=>p.entity)).size,3);}
  assert.equal(new Set(sim.players.map(p=>p.entity)).size,3);
  for(let slot=0;slot<3;slot++)assert(sim.performAction(slot,'ready',{ready:true}).ok);
  assert.equal(sim.state,'play');
  run(sim,'enemies=[];shots=[];enemyShots=[];waveRemainingToSpawn=999;');
  const before=sim.players.map(p=>({x:p.entity.x,y:p.entity.y}));
  for(let slot=0;slot<3;slot++)sim.setInput(slot,{mx:slot===deadSlot?1:slot===donor?-1:0,ax:0,ay:-1,fire:true},1);
  advance(sim,.3);
  assert(sim.players[deadSlot].entity.x>before[deadSlot].x+5);
  assert(sim.players[donor].entity.x<before[donor].x-5);
  assert.equal(sim.players[second].entity.x,before[second].x,'third captain is not moved by another controller');
  assert.deepEqual([...new Set(sim.shots.map(q=>q.ownerId))].sort(),[0,1,2]);
  for(let slot=0;slot<3;slot++){assert.equal(sim.players[slot].entity,entities[slot]);assert.equal(sim.players[slot].entity.speedMult,1+slot*.1);assert.equal(sim.players[slot].build,builds[slot]);}
  const sailing=sim.snapshot();
  for(const client of replicas){client.window.ReiMultiplayerLocal.applySnapshot(JSON.parse(JSON.stringify(sailing)),true);assert.equal(new Set(client.players.map(p=>p.entity)).size,3);}
 }finally{sim.dispose();for(const c of replicas)c.dispose();}
}
const stress=new FullSimulation(metas);
try{
 stress.forceWave(101);run(stress,`{for(let i=0;i<100;i++)spawnEnemy();const p=ReiMultiplayerLocal.players[2];p.build.path='undead';p.build.pools=[{x:300,y:300,radius:76,damage:1,life:2,age:0,inside:new Set(enemies)}];}`);
 const mp=stress.window.ReiMultiplayerLocal,original=mp.makeSnapshot;let calls=0;
 mp.makeSnapshot=(...args)=>{calls++;return original(...args);};
 const snap=stress.snapshot();assert.equal(calls,1,'one world serialization per snapshot');
 assert(!JSON.stringify(snap).includes('"inside"'),'wire must not duplicate enemy objects in pool collision sets');
 assert.equal(snap.enemies.length,stress.enemies.length);assert.equal(snap.players[2].build.pools.length,1);
 assert(stress.players[2].build.pools[0].inside instanceof stress.window.Set,'wire optimization does not mutate combat sets');
 stress.setConnected(2,false);stress.setConnected(2,true);
 assert(stress.players[2].build.pools[0].inside instanceof stress.window.Set,'resume preserves live collision sets');
 run(stress,'particles=[];lootTexts=[];for(let i=0;i<100;i++){addParticle(0,0,"white");addLootText(0,0,"test");}');
 assert.equal(run(stress,'particles.length+lootTexts.length'),0,'headless server does not simulate cosmetic particles');
 console.log('All captain revives, three replica clients, independent controls and high-wave serialization passed');
}finally{stress.dispose();}
