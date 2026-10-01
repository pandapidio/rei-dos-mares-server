'use strict';
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const GAME_DIR=path.join(__dirname,'shared-game');
const SCRIPTS=['polish.js','seascape.js','identity.js','chronicle.js','encounters.js','admirals.js','voyage.js','builds.js','refinement.js','game.js','endgame.js','multiplayer-local-v4.js'];
const compiled=SCRIPTS.map(name=>new vm.Script(fs.readFileSync(path.join(GAME_DIR,name),'utf8'),{filename:name}));
const html=fs.readFileSync(path.join(GAME_DIR,'index.html'),'utf8');
function drawingContext(){return new Proxy({measureText:t=>({width:String(t).length*8}),getImageData:()=>({data:new Uint8ClampedArray(4)}),createRadialGradient:()=>({addColorStop(){}}),createLinearGradient:()=>({addColorStop(){}})},{get(o,k){return k in o?o[k]:(()=>{});},set(o,k,v){o[k]=v;return true;}});}
class FullSimulation{
 constructor(metas,opts={}){
  this.dom=new JSDOM(html,{url:'http://localhost:3000/game/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=this.dom.window;this.window=w;this.context=this.dom.getInternalVMContext();this.acc=0;this.seq=0;this.shopRevision=0;this.lastShop=null;this.awardSeq=0;this.knownSkins=new Set(['default']);this.paused=false;this.lastInputs=new Map();this.inputAge=new Map();this.lastInputSeq=new Map();this.pendingAwards=[];this.events=[];this.sounds=[];this.soundSeq=0;this.metrics={ticks:0};
  w.requestAnimationFrame=()=>0;w.cancelAnimationFrame=()=>{};w.setInterval=()=>0;w.clearInterval=()=>{};w.setTimeout=()=>0;w.clearTimeout=()=>{};
  w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
  w.HTMLCanvasElement.prototype.getContext=()=>drawingContext();
  w.Audio=class{constructor(){this.paused=true;}play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}addEventListener(){}cloneNode(){return new w.Audio();}};
  w.Image=class{constructor(){this.complete=false;this.width=0;this.height=0;this.naturalWidth=0;this.naturalHeight=0;}set src(v){this._src=v;}get src(){return this._src||'';}addEventListener(){}};
  w.fetch=()=>Promise.resolve({ok:false,json:()=>Promise.resolve({})});w.confirm=()=>true;w.alert=()=>{};
  if(opts.random)w.Math.random=opts.random;
  w.localStorage.setItem('reiDosMaresTutorialSeen','1');w.localStorage.setItem('reiDosMaresTutorialCompleted','1');
  w.RDMOnline={authoritative:true,serverSimulation:true,state:{started:true},awardLoot:(slot,award)=>{this.pendingAwards.push({slot,...award});return true;},awardDiamonds:(slot,diamonds,reason)=>{this.pendingAwards.push({slot,diamonds,reason});return true;},sendMilestone:(type,data)=>this.events.push({type,data})};
  for(const script of compiled)script.runInContext(this.context);
  w.__metas=metas;
  vm.runInContext(`ReiMultiplayerLocal.startOnline(__metas,{host:true,localSlot:-1,localInput:()=>window.__input0||{mx:0,my:0,ax:0,ay:-1,fire:false}});voyage.tutorial.active=false;audioState.unlocked=false;`,this.context);
  delete w.__metas;
  w.__recordSound=(name,volume,cooldown)=>{if(['thunder','barrage-launch','barrage-impact','ghost-impact','charge','heal','victory'].includes(name))this.sounds.push({id:++this.soundSeq,name,volume,cooldown,at:Date.now()});};
  vm.runInContext('sfx=(name,volume=1,cooldown=0)=>window.__recordSound(name,volume,cooldown);addParticle=()=>{};burst=()=>{};addLootText=()=>{};updateParticles=()=>{};updateBeamEffects=()=>{};particles=[];lootTexts=[];',this.context);

 }
 get state(){return vm.runInContext('state',this.context);}
 set state(v){this.window.__state=v;vm.runInContext('state=__state',this.context);}
 get wave(){return vm.runInContext('wave',this.context);}
 get players(){return this.window.ReiMultiplayerLocal.players;}
 get enemies(){return vm.runInContext('enemies',this.context);}
 set enemies(v){this.window.__enemies=v;vm.runInContext('enemies=__enemies',this.context);}
 get shots(){return vm.runInContext('shots',this.context);}
 get enemyShots(){return vm.runInContext('enemyShots',this.context);}
 get shop(){return this.window.ReiMultiplayerLocal.shop;}
 setInput(slot,raw,seq){
  const p=this.players[Number(slot)];if(!p||!p.connected)return false;
  const last=this.lastInputSeq.get(Number(slot))||0;if(!Number.isSafeInteger(Number(seq))||Number(seq)<=last)return false;
  const num=v=>Math.max(-1,Math.min(1,Number(v)||0));const input={mx:num(raw.mx),my:num(raw.my),ax:num(raw.ax),ay:num(raw.ay),fire:!!raw.fire};
  this.lastInputSeq.set(Number(slot),Number(seq));this.lastInputs.set(Number(slot),input);this.inputAge.set(Number(slot),0);
  this.window.ReiMultiplayerLocal.setRemoteInput(Number(slot),input);if(Number(slot)===0)this.window.__input0=input;
  return true;
 }
 clearInput(slot){slot=Number(slot);this.lastInputs.delete(slot);this.inputAge.delete(slot);this.window.ReiMultiplayerLocal.setRemoteInput(slot,{mx:0,my:0,ax:0,ay:-1,fire:false});}
 setConnected(slot,yes){this.clearInput(slot);const p=this.players[Number(slot)];if(!p)return false;if(yes){p.connected=true;p.resumeExpired=false;this.window.ReiMultiplayerLocal.restorePlayerFromNet(Number(slot),null);}else this.window.ReiMultiplayerLocal.handlePlayerLeft(Number(slot),true);return true;}
 expirePlayer(slot){this.clearInput(slot);return this.window.ReiMultiplayerLocal.handlePlayerLeft(Number(slot),false);}
 setPaused(yes){this.paused=!!yes;}
 grantGold(amount){for(const p of this.players)p.gold=amount;vm.runInContext('ReiMultiplayerLocal.renderShop();',this.context);}
 defeatCurrentBoss(){vm.runInContext(`{const e=enemies.find(e=>e.isBoss);if(!e)throw new Error('No boss');bossFight.intro=0;bossFight.phaseBarrier=0;bossFight.barriersUsed={2:true,3:true};defeatBoss(e);}`,this.context);}
 step(dt){this.acc+=Math.min(.25,Math.max(0,Number(dt)||0));let guard=0;while(this.acc>=1/60&&guard++<20){this.acc-=1/60;if(!this.paused)this.tick(1/60);}}
 tick(dt){
  for(const [slot,age]of this.inputAge){const next=age+dt;if(next>.6)this.clearInput(slot);else this.inputAge.set(slot,next);}
  this.metrics.ticks++;this.window.__dt=dt;const primary=this.players.find(p=>p.connected&&p.alive)||this.players.find(p=>p.connected);this.window.__input0=this.lastInputs.get(primary?.id)||{mx:0,my:0,ax:0,ay:-1,fire:false};vm.runInContext(`{keys.clear();const a=window.__input0||{};if(a.mx>.1)keys.add('d');if(a.mx<-.1)keys.add('a');if(a.my>.1)keys.add('s');if(a.my<-.1)keys.add('w');mouse.x=player.x+(a.ax||0)*1000;mouse.y=player.y+(a.ay??-1)*1000;mouse.down=!!a.fire;update(__dt);if(a.fire)shoot();}`,this.context);}
 snapshot(full=false){
  const mp=this.window.ReiMultiplayerLocal;
  const snap=mp.makeSnapshot({lite:!full,richPlayers:true});
  const extra=vm.runInContext(`({infiniteMode,bossReward:bossReward?{...bossReward,dialogue:bossRewardText.textContent}:null,pendingBlackbeardLine,
    campaignPresentation:{damageFlash:campaign.damageFlash,damageDirection:campaign.damageDirection,events:campaign.events,mods:campaign.mods,fog:campaign.fog,bossMist:campaign.bossMist,giantVortex:campaign.giantVortex,bossDeath:campaign.bossDeath,interlude:campaign.interlude},
    voyagePresentation:{eventTime:voyage.eventTime,flash:voyage.flash,formation:voyage.formation,notice:voyage.notice,queue:voyage.queue}})`,this.context);
  Object.assign(snap,JSON.parse(JSON.stringify(extra)));
  if(mp.shop!==this.lastShop){this.lastShop=mp.shop;if(mp.shop)this.shopRevision++;}
  snap.shop=this.state==='upgrade'&&mp.shop?{...JSON.parse(JSON.stringify(snap.shop||mp.shop)),open:true,revision:this.shopRevision,wave:this.wave}:null;
  this.sounds=this.sounds.filter(e=>Date.now()-e.at<2000);snap.soundEvents=this.sounds;
  snap.authoritativeV4=true;snap.fullGameplay=true;snap.seq=++this.seq;snap.serverTime=Date.now();
  for(const p of snap.players)p.lastProcessedInput=this.lastInputSeq.get(p.id)||0;
  return snap;
 }
 performAction(slot,action,payload){
  if(!this.players[Number(slot)]?.connected)return {ok:false,error:'Capitão indisponível.'};
  if(action==='boss-continue'&&this.state==='bossreward'){
    vm.runInContext(`if(bossReward?.kind==='blackbeard'&&pendingBlackbeardLine&&bossRewardText.textContent.includes('morte te aguarda'))pendingBlackbeardLine=false;continueAfterBossReward();`,this.context);return {ok:true};
  }
  if(action==='victory-continue'&&this.state==='victory'){
    vm.runInContext(`victoryScreen.classList.add('hidden');bossHpWrap.classList.add('hidden');enemies=[];enemyShots=[];shots=[];infiniteMode=true;state='play';bossReward=null;openUpgradeScreen();`,this.context);return {ok:true};
  }
  if(this.state!=='upgrade')return {ok:false,error:'O estaleiro não está aberto.'};
  const ok=!!this.window.ReiMultiplayerLocal.performAction(Number(slot),action,payload||{});
  if(ok&&action==='ready'&&this.shop?.phase==='normal'&&this.players.filter(p=>p.connected).every(p=>p.ready))this.window.ReiMultiplayerLocal.performAction(Number(slot),'continue',{});
  return {ok,error:ok?undefined:'Esta escolha não está disponível.'};
 }
 collectAwards(){
  const skins=vm.runInContext('[...ownedSkins]',this.context);
  for(const skinId of skins)if(!this.knownSkins.has(skinId)){this.knownSkins.add(skinId);for(const p of this.players)if(!p.resumeExpired)this.pendingAwards.push({slot:p.id,skinId});}
  return this.pendingAwards.splice(0).map(a=>({...a,id:++this.awardSeq}));
 }
 forceWave(w){this.window.__testWave=w;vm.runInContext(`{enemies=[];shots=[];enemyShots=[];chests=[];bossFight=null;bossReward=null;ReiMultiplayerLocal.shop=null;state='play';wave=__testWave-1;beginNextWave();}`,this.context);}
 forceWaveComplete(w){this.forceWave(w);vm.runInContext(`enemies=[];shots=[];enemyShots=[];bossFight=null;waveRemainingToSpawn=0;waveCompleteTimer=-1;openUpgradeScreen();`,this.context);}
 forceGameover(){vm.runInContext(`for(const p of ReiMultiplayerLocal.players){p.alive=false;p.entity.hp=0;p.entity.vx=0;p.entity.vy=0;}ReiMultiplayerLocal.wipe=true;state='gameover';`,this.context);this.paused=false;}
 dispose(){this.dom.window.close();}
}
module.exports={FullSimulation};
