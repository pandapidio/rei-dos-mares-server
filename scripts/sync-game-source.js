'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const source=path.resolve(process.argv[2]||'');
if(!process.argv[2]||!fs.existsSync(path.join(source,'game.js')))throw new Error('Usage: node scripts/sync-game-source.js /frontend/games/rei-dos-mares [frontend-commit]');
const files=['index.html','version.js','polish.js','seascape.js','identity.js','chronicle.js','encounters.js','admirals.js','voyage.js','builds.js','refinement.js','game.js','endgame.js','multiplayer-local-v4.js'];
const target=path.join(__dirname,'../shared-game');fs.mkdirSync(target,{recursive:true});
const manifest={repository:'pandapidio/pandapidio-games',frontendCommit:process.argv[3]||'working-tree',files:{}};
for(const name of files){const content=fs.readFileSync(path.join(source,name));fs.writeFileSync(path.join(target,name),content);manifest.files[name]=crypto.createHash('sha256').update(content).digest('hex');}
fs.writeFileSync(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Synced '+files.length+' original game files');
