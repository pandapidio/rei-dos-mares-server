'use strict';

const W = 1280;
const H = 720;
const FIXED_DT = 1 / 60;
const PLAYER_SPEED = 360;
const PLAYER_FIRE_CD = 0.58;
const PLAYER_SHOT_SPEED = 760;
const PLAYER_DAMAGE = 34;
const PLAYER_RADIUS = 28;
const ENEMY_RADIUS = 34;

function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function norm(x,y){ const l=Math.hypot(x,y)||1; return {x:x/l,y:y/l}; }
function dist2(a,b){ const dx=a.x-b.x,dy=a.y-b.y; return dx*dx+dy*dy; }
function id(prefix, state){ state.netId=(state.netId||1)+1; return prefix + state.netId; }

function spawnPoint(slot,count){
  const xs=count===2?[W*.38,W*.62]:[W*.30,W*.50,W*.70];
  return {x:xs[slot] ?? W*.5,y:H*.66};
}
function safeInput(raw={}){
  const mx=clamp(Number(raw.mx)||0,-1,1),my=clamp(Number(raw.my)||0,-1,1);
  let ax=clamp(Number(raw.ax)||0,-1,1),ay=clamp(Number(raw.ay)||0,-1,1);
  const a=norm(ax,ay); ax=a.x; ay=a.y;
  return {mx,my,ax,ay,fire:!!raw.fire};
}
function makePlayer(meta,slot,count){
  const p=spawnPoint(slot,count);
  return {
    id:slot,playerId:meta.playerId,name:meta.name,skinId:meta.skinId||'default',
    portrait:meta.portrait||'assets/portraits/pirate.svg',title:meta.title||'Capitão',
    connected:true,alive:true,gold:0,ready:false,aim:-Math.PI/2,input:safeInput(),lastInputSeq:0,
    stats:{kills:0,deaths:0,damageDealt:0,damageTaken:0,goldCollected:0},
    entity:{x:p.x,y:p.y,prevX:p.x,prevY:p.y,vx:0,vy:0,hp:100,maxHp:100,shot:0,inv:1.6,phase:slot*.9,cannonAngle:-Math.PI/2,skinId:meta.skinId||'default',facingX:1,speedMult:1,damageMult:1,incomingDamageMult:1,fireRateMult:1}
  };
}

class AuthoritativeSimulation {
  constructor(playerMetas, opts={}){
    this.W=W; this.H=H; this.netId=1; this.seq=0; this.state='transition'; this.transition=0;
    this.wave=1; this.score=0; this.elapsed=0; this.waveTimer=0; this.waveSpawnClock=.65;
    this.waveRemainingToSpawn=3; this.waveTotal=3; this.waveCompleteTimer=-1;
    this.players=playerMetas.map((m,i)=>makePlayer(m,i,playerMetas.length));
    this.enemies=[]; this.shots=[]; this.enemyShots=[]; this.chests=[]; this.bossFight=null;
    this.paused=false; this.acc=0; this.rng=opts.random||Math.random; this.lastEvent=null;
    this.metrics={ticks:0,shots:0,enemyShots:0,corrections:0};
  }

  setConnected(slot,connected){
    const p=this.players[Number(slot)]; if(!p)return false;
    p.connected=!!connected; if(!connected){p.input=safeInput();p.entity.vx=0;p.entity.vy=0;}
    return true;
  }
  setInput(slot,raw,seq=0){
    const p=this.players[Number(slot)];
    if(!p||!p.connected)return false;
    seq=Number(seq)||0; if(seq&&seq<=p.lastInputSeq)return false;
    p.lastInputSeq=seq||p.lastInputSeq+1; p.input=safeInput(raw); return true;
  }
  setPaused(v){this.paused=!!v;}
  step(realDt){
    this.acc+=Math.min(.25,Math.max(0,Number(realDt)||0));
    let guard=0;
    while(this.acc>=FIXED_DT && guard++<20){ this.acc-=FIXED_DT; this.tick(FIXED_DT); }
  }
  tick(dt){
    this.metrics.ticks++;
    if(this.paused||this.state==='gameover')return;
    if(this.state==='transition'){
      this.transition+=dt; if(this.transition>=4.25){this.transition=4.25;this.state='play';}
      return;
    }
    this.elapsed+=dt; this.waveTimer+=dt;
    this.updatePlayers(dt); this.updateEnemies(dt); this.updateProjectiles(dt); this.resolveCollisions();
    this.updateWaves(dt);
  }

  updatePlayers(dt){
    for(const p of this.players){
      const e=p.entity; e.prevX=e.x;e.prevY=e.y;e.inv=Math.max(0,(e.inv||0)-dt);e.shot=Math.max(0,(e.shot||0)-dt);
      if(!p.connected||!p.alive){e.vx=0;e.vy=0;continue;}
      const a=p.input,aim=norm(a.ax,a.ay); p.aim=Math.atan2(aim.y,aim.x); e.cannonAngle=p.aim;
      let mx=a.mx,my=a.my,l=Math.hypot(mx,my); if(l>1){mx/=l;my/=l;}
      const sp=PLAYER_SPEED*(e.speedMult||1);
      e.vx+=(mx*sp-e.vx)*Math.min(1,dt*4.2); e.vy+=(my*sp-e.vy)*Math.min(1,dt*4.2);
      e.vx*=Math.pow(.90,dt*60); e.vy*=Math.pow(.90,dt*60);
      if(Math.abs(e.vx)>12)e.facingX=e.vx<0?-1:1;
      e.x=clamp(e.x+e.vx*dt,55,W-55); e.y=clamp(e.y+e.vy*dt,95,H-55);
      if(a.fire&&e.shot<=0)this.firePlayer(p);
    }
  }
  firePlayer(p){
    const e=p.entity,a=p.aim,c=Math.cos(a),s=Math.sin(a);
    const shot={__netId:id('ps_',this),team:'player',ownerId:p.id,x:e.x+c*36,y:e.y+s*36+28,prevX:e.x,prevY:e.y+28,vx:c*PLAYER_SHOT_SPEED,vy:s*PLAYER_SHOT_SPEED,life:1.8,damage:PLAYER_DAMAGE*(e.damageMult||1),radius:8,hitIds:[],cosmeticProjectile:this.cosmeticFor(p.skinId)};
    this.shots.push(shot); e.shot=PLAYER_FIRE_CD/Math.max(.35,e.fireRateMult||1); this.metrics.shots++;
  }
  cosmeticFor(skin){return skin==='gullit'?'gullit':skin==='midas'?'gold':skin==='rei-dos-mares'?'king':null;}

  spawnEnemy(){
    const edge=Math.floor(this.rng()*3),along=.18+this.rng()*.64;
    let x,y;if(edge===0){x=-75;y=120+along*(H-210);}else if(edge===1){x=W+75;y=120+along*(H-210);}else{x=120+along*(W-240);y=-75;}
    const heavy=this.wave>=9&&this.rng()<Math.min(.32,this.wave*.012);
    const max=Math.round((heavy?125:72)*(1+(this.wave-1)*.075));
    this.enemies.push({__netId:id('e_',this),x,y,prevX:x,prevY:y,vx:0,vy:0,r:heavy?42:ENEMY_RADIUS,hp:max,max,type:heavy?'heavy':'basic',role:'basic',variant:heavy?'white2':'white',phase:this.rng()*Math.PI*2,sinking:0,cannonAngle:Math.PI/2,shot:.7+this.rng()*1.2,destroyed:false});
  }
  startBoss(){
    const max=Math.round(1500*(1+(this.wave-15)*.04));
    const e={__netId:id('boss_',this),x:W*.5,y:-145,prevX:W*.5,prevY:-145,vx:0,vy:38,r:92,hp:max,max,type:'boss',role:'flagship',variant:'boss',isBoss:true,bossKind:'marine',phase:0,sinking:0,cannonAngle:Math.PI/2,shot:1.25,destroyed:false};
    this.enemies=[e];this.enemyShots=[];this.bossFight={kind:'marine',defeated:false,intro:2.8,introMax:2.8,cfg:{name:'ALMIRANTE DA MARINHA',hp:max}};
  }
  targetFor(enemy){
    let best=null,bd=Infinity;for(const p of this.players){if(!p.connected||!p.alive)continue;const d=dist2(enemy,p.entity);if(d<bd){bd=d;best=p;}}return best;
  }
  updateEnemies(dt){
    for(const e of this.enemies){
      e.prevX=e.x;e.prevY=e.y;if(e.destroyed)continue;
      const target=this.targetFor(e);if(!target)continue;
      if(e.isBoss&&this.bossFight?.intro>0){
        this.bossFight.intro=Math.max(0,this.bossFight.intro-dt);
        e.y=Math.min(155,e.y+48*dt); e.vy=48;continue;
      }
      const te=target.entity,a=Math.atan2(te.y-e.y,te.x-e.x);e.cannonAngle=a;e.shot-=dt;
      const sp=e.isBoss?54:(e.type==='heavy'?45:62)+Math.min(22,this.wave*.8);
      e.vx+=(Math.cos(a)*sp-e.vx)*Math.min(1,dt*1.35);e.vy+=(Math.sin(a)*sp-e.vy)*Math.min(1,dt*1.35);
      e.x+=e.vx*dt;e.y+=e.vy*dt;
      const d=Math.hypot(te.x-e.x,te.y-e.y);
      if(e.shot<=0&&d<760){this.fireEnemy(e,target);e.shot=e.isBoss?.72+this.rng()*.35:Math.max(1.25,2.65-this.wave*.025)+this.rng()*.55;}
      if(d<(e.r||34)+PLAYER_RADIUS*.72)this.damagePlayer(target,e.isBoss?20:11);
    }
  }
  fireEnemy(e,target){
    const a=Math.atan2(target.entity.y-e.y,target.entity.x-e.x),speed=e.isBoss?385:315,c=Math.cos(a),s=Math.sin(a);
    this.enemyShots.push({__netId:id('es_',this),team:'enemy',x:e.x+c*34,y:e.y+s*34,prevX:e.x,prevY:e.y,vx:c*speed,vy:s*speed,life:2.7,damage:e.isBoss?17:12,radius:e.isBoss?9:7,boss:!!e.isBoss,bossKind:e.bossKind||null});
    this.metrics.enemyShots++;
  }
  updateProjectiles(dt){
    for(const s of this.shots){s.prevX=s.x;s.prevY=s.y;s.x+=s.vx*dt;s.y+=s.vy*dt;s.life-=dt;}
    for(const s of this.enemyShots){s.prevX=s.x;s.prevY=s.y;s.x+=s.vx*dt;s.y+=s.vy*dt;s.life-=dt;}
    this.shots=this.shots.filter(s=>s.life>0&&s.x>-120&&s.x<W+120&&s.y>-120&&s.y<H+120);
    this.enemyShots=this.enemyShots.filter(s=>s.life>0&&s.x>-160&&s.x<W+160&&s.y>-160&&s.y<H+160);
  }
  resolveCollisions(){
    for(const s of this.shots){
      if(s.life<=0)continue;
      for(const e of this.enemies){
        if(e.destroyed||e.hp<=0)continue;
        const rr=(e.r||ENEMY_RADIUS)+(s.radius||8);if(dist2(s,e)>rr*rr)continue;
        e.hp-=s.damage;s.life=0;const owner=this.players[s.ownerId];if(owner)owner.stats.damageDealt+=s.damage;
        if(e.hp<=0)this.destroyEnemy(e,owner);break;
      }
    }
    for(const s of this.enemyShots){
      if(s.life<=0)continue;
      for(const p of this.players){
        if(!p.connected||!p.alive||p.entity.inv>0)continue;
        const rr=PLAYER_RADIUS+(s.radius||7);if(dist2(s,p.entity)>rr*rr)continue;
        s.life=0;this.damagePlayer(p,s.damage||12);break;
      }
    }
    this.shots=this.shots.filter(s=>s.life>0);this.enemyShots=this.enemyShots.filter(s=>s.life>0);
    this.enemies=this.enemies.filter(e=>!e.destroyed);
  }
  damagePlayer(p,amount){
    const e=p.entity;if(!p.alive||e.inv>0)return;e.hp=Math.max(0,e.hp-amount);e.inv=.42;p.stats.damageTaken+=amount;
    if(e.hp<=0){p.alive=false;p.stats.deaths++;e.vx=e.vy=0;if(!this.players.some(q=>q.connected&&q.alive))this.state='gameover';}
  }
  destroyEnemy(e,owner){
    e.destroyed=true;this.score+=e.isBoss?1200:100;if(owner){owner.stats.kills++;owner.gold+=e.isBoss?220:35;owner.stats.goldCollected+=e.isBoss?220:35;}
    if(e.isBoss&&this.bossFight){this.bossFight.defeated=true;this.bossFight.intro=0;}
  }
  updateWaves(dt){
    if(this.state!=='play'||this.bossFight?.defeated)return;
    if(this.bossFight){
      if(!this.enemies.length){this.bossFight=null;this.nextWave();}return;
    }
    if(this.waveRemainingToSpawn>0){
      this.waveSpawnClock-=dt;if(this.waveSpawnClock<=0){this.spawnEnemy();this.waveRemainingToSpawn--;this.waveSpawnClock=Math.max(.32,.92-this.wave*.012);}
    }else if(!this.enemies.length){
      if(this.waveCompleteTimer<0)this.waveCompleteTimer=1.5;
      else{this.waveCompleteTimer-=dt;if(this.waveCompleteTimer<=0)this.nextWave();}
    }
  }
  nextWave(){
    this.wave++;this.waveTimer=0;this.waveCompleteTimer=-1;this.bossFight=null;
    if(this.wave===15){this.waveRemainingToSpawn=0;this.waveTotal=1;this.startBoss();return;}
    const count=Math.min(18,3+Math.floor(this.wave*1.45));
    this.waveRemainingToSpawn=count;this.waveTotal=count;this.waveSpawnClock=.8;
    for(const p of this.players){if(p.connected&&p.alive)p.entity.hp=Math.min(p.entity.maxHp,p.entity.hp+4);}
  }

  playerSnapshot(p){
    return {id:p.id,name:p.name,skinId:p.skinId,gold:p.gold,alive:p.alive,connected:p.connected,ready:p.ready,portrait:p.portrait,title:p.title,aim:p.aim,entity:{...p.entity},stats:{...p.stats},lastProcessedInput:p.lastInputSeq};
  }
  motionList(list){return list.map(x=>({...x,hitIds:undefined}));}
  snapshot(full=false){
    const snap={v:2,lite:!full,authoritativeV4:true,seq:++this.seq,serverTime:Date.now(),state:this.state,wave:this.wave,score:this.score,elapsed:this.elapsed,transition:this.transition,waveRemainingToSpawn:this.waveRemainingToSpawn,waveTotal:this.waveTotal,waveSpawnClock:this.waveSpawnClock,players:this.players.map(p=>this.playerSnapshot(p)),enemies:this.motionList(this.enemies),shots:this.motionList(this.shots),enemyShots:this.motionList(this.enemyShots),chests:this.motionList(this.chests),bossFight:this.bossFight?JSON.parse(JSON.stringify(this.bossFight)):null,voyage:{hazards:[],weather:null,event:null}};
    if(full){snap.lite=false;snap.serverMetrics={...this.metrics};}
    return snap;
  }
}

module.exports={AuthoritativeSimulation,W,H,FIXED_DT};
