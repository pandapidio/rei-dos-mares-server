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
 advance(s,8.5);
 assert(s.players.every(p=>p.entity.hp>=58),'carpenter heals every captain');
 const snap=s.snapshot();assert(snap.players.every(p=>p.build.path&&p.build.metrics&&p.stats));
 assert(s.shots.some(q=>q.ownerId===0&&q.piercing));assert(s.shots.some(q=>q.ownerId===1&&q.explosive));
 assert(s.shots.some(q=>q.ownerId===2&&q.spectral));
 const oldTicks=s.metrics.ticks;s.setPaused(true);advance(s,1);assert.equal(s.metrics.ticks,oldTicks);s.setPaused(false);
 s.setConnected(0,false);s.players[1].entity.shot=0;advance(s,.1);assert(s.shots.some(q=>q.ownerId===1));s.setConnected(0,true);
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
