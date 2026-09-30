'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const dir=path.join(__dirname,'../shared-game'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
for(const [name,hash]of Object.entries(manifest.files)){
 const content=fs.readFileSync(path.join(dir,name));
 if(crypto.createHash('sha256').update(content).digest('hex')!==hash)throw new Error('Shared game source changed without synchronization: '+name);
 if(name.endsWith('.js'))new vm.Script(content.toString(),{filename:name});
 if(process.env.RDM_FRONTEND_SOURCE&&!content.equals(fs.readFileSync(path.join(process.env.RDM_FRONTEND_SOURCE,name))))throw new Error('Frontend/server differ: '+name);
}
console.log('Original game source verified: '+Object.keys(manifest.files).length+' files');
