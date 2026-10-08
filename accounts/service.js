'use strict';
const express=require('express'), crypto=require('node:crypto'), path=require('node:path');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const AVATARS=['panda','jeff','liu','ayuwoke','blackbeard','ghost','marine'];
const ownKey=k=>/^reiDosMares[A-Za-z0-9]+$/.test(k)||['ayuwoke_best','game_complete','predio_esquizito_save_v2'].includes(k);
function snapshot(value){
 if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('Save inválido.');
 const clean=Object.create(null);
 for(const [k,v] of Object.entries(value)){
  if(!ownKey(k)||typeof v!=='string'||v.length>500000)throw new Error('Save inválido.');
  clean[k]=v;
 }
 if(JSON.stringify(clean).length>1000000)throw new Error('Save muito grande.');
 return clean;
}
const digest=t=>crypto.createHash('sha256').update(t).digest('hex');
async function hash(password,salt=crypto.randomBytes(16).toString('hex')){
 const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 return salt+':'+key.toString('hex');
}
async function verify(password,stored){const [salt]=stored.split(':');return crypto.timingSafeEqual(Buffer.from(await hash(password,salt)),Buffer.from(stored));}
async function installAccounts(app,{db,origins,production=true}={}){
 const router=express.Router();
 app.use('/accounts',router);
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');next();});
 router.use((req,res,next)=>{
  const origin=req.get('origin');
  if(origin&&!origins.has(origin)&&origin!==`${req.protocol}://${req.get('host')}`&&origin!==`https://${req.get('host')}`)return res.status(403).json({error:'Origem não permitida.'});
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');res.set('Access-Control-Allow-Headers','Authorization, Content-Type');res.set('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS');}
  if(req.method==='OPTIONS')return res.sendStatus(204);
  next();
 });
 router.get('/status',(_req,res)=>res.json({ready:!!db}));
 router.use('/window',express.static(path.join(__dirname,'public'),{index:'index.html'}));
 router.use(express.json({limit:'1100kb'}));
 if(!db){router.use((_req,res)=>res.status(503).json({error:'As contas estão sendo preparadas. Seus dados continuam salvos neste navegador.'}));return;}
 const schema=`CREATE TABLE IF NOT EXISTS pg_accounts (
 id UUID PRIMARY KEY, username TEXT NOT NULL, username_key TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT 'panda', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 progress JSONB NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS pg_sessions(token_hash TEXT PRIMARY KEY, account_id UUID NOT NULL REFERENCES pg_accounts(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
 CREATE TABLE IF NOT EXISTS pg_save_writes(account_id UUID NOT NULL REFERENCES pg_accounts(id) ON DELETE CASCADE, write_id UUID NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(account_id,write_id));
 CREATE TABLE IF NOT EXISTS pg_feedback(id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES pg_accounts(id), subject TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
 ALTER TABLE pg_accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
 ALTER TABLE pg_accounts ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
 CREATE INDEX IF NOT EXISTS pg_accounts_created ON pg_accounts(created_at,id);
 ALTER TABLE pg_feedback ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
 CREATE INDEX IF NOT EXISTS pg_feedback_inbox ON pg_feedback(deleted_at,created_at DESC,id);`;
 for(const statement of schema.split(';').filter(x=>x.trim()))await db.query(statement);
 const attempts=new Map();
 // Express trusts one Railway edge hop only when deployed on Railway.
 router.use((req,res,next)=>{
  if(req.method==='GET')return next();
  const now=Date.now(),ip=req.ip||req.socket.remoteAddress;
  if(attempts.size>5000)for(const [k,x]of attempts)if(x.until<now)attempts.delete(k);
  let x=attempts.get(ip);if(!x||x.until<now)attempts.set(ip,x={count:0,until:now+60000});
  if(++x.count>60)return res.status(429).json({error:'Muitas tentativas. Aguarde um minuto.'});next();
 });
 const publicUser=a=>({id:a.id,username:a.username,avatar:a.avatar,createdAt:a.created_at,isAdmin:a.is_admin===true});
 const wrap=fn=>async(req,res,next)=>{try{await fn(req,res,next);}catch(e){next(e);}};
 router.post('/session',wrap(async(req,res)=>{
  const {username,password,progress={}}=req.body;
  if(typeof username!=='string'||!/^\p{L}[\p{L}\p{N}_ -]{2,23}$/u.test(username.trim()))return res.status(400).json({error:'Use um nome de 3 a 24 caracteres, começando com uma letra.'});
  if(typeof password!=='string'||password.length<8||password.length>128)return res.status(400).json({error:'A senha deve ter de 8 a 128 caracteres.'});
  const name=username.trim(),key=name.normalize('NFKC').toLocaleLowerCase('pt-BR');
  let a=(await db.query('SELECT * FROM pg_accounts WHERE username_key=$1',[key])).rows[0],created=false;
  if(!a){
   const data=snapshot(progress),passwordHash=await hash(password);
   const inserted=await db.query('INSERT INTO pg_accounts(id,username,username_key,password_hash,progress) VALUES($1,$2,$3,$4,$5) ON CONFLICT(username_key) DO NOTHING RETURNING *',[crypto.randomUUID(),name,key,passwordHash,JSON.stringify(data)]);
   a=inserted.rows[0];created=!!a;
   if(!a)a=(await db.query('SELECT * FROM pg_accounts WHERE username_key=$1',[key])).rows[0];
  }
  if(!created&&!await verify(password,a.password_hash))return res.status(401).json({error:'Senha incorreta.'});
  if(a.banned_at)return res.status(403).json({error:'Esta conta está banida do site.'});
  const token=crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM pg_sessions WHERE expires_at<now()');
  await db.query("INSERT INTO pg_sessions VALUES($1,$2,now()+interval '30 days')",[digest(token),a.id]);
  res.json({token,created,user:publicUser(a),progress:a.progress,revision:a.revision});
 }));
 router.use(wrap(async(req,res,next)=>{
  const raw=req.get('authorization')||'',token=raw.startsWith('Bearer ')?raw.slice(7):'';
  const a=(await db.query('SELECT a.* FROM pg_accounts a JOIN pg_sessions s ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()',[digest(token)])).rows[0];
  if(!a)return res.status(401).json({error:'Entre novamente na sua conta.'});
  if(a.banned_at)return res.status(403).json({error:'Esta conta está banida do site.'});req.account=a;req.tokenHash=digest(token);next();
 }));
 router.get('/me',wrap(async(req,res)=>res.json({user:publicUser(req.account),progress:req.account.progress,revision:req.account.revision})));
 router.put('/progress',wrap(async(req,res)=>{
  const data=snapshot(req.body.progress),revision=req.body.revision,writeId=req.body.writeId;
  if(!Number.isSafeInteger(revision)||revision<0||typeof writeId!=='string'||!(/^[0-9a-f-]{36}$/i.test(writeId)))return res.status(400).json({error:'Versão do save inválida.'});
  const previous=(await db.query('SELECT revision FROM pg_save_writes WHERE account_id=$1 AND write_id=$2',[req.account.id,writeId])).rows[0];
  if(previous)return res.json({revision:previous.revision});
  // A single statement commits the save and its retry receipt atomically.
  const r=await db.query(`WITH updated AS (UPDATE pg_accounts SET progress=$1,revision=revision+1 WHERE id=$2 AND revision=$3 RETURNING id,revision)
   INSERT INTO pg_save_writes(account_id,write_id,revision) SELECT id,$4,revision FROM updated RETURNING revision`,[JSON.stringify(data),req.account.id,revision,writeId]);
  if(!r.rows.length){const receipt=(await db.query('SELECT revision FROM pg_save_writes WHERE account_id=$1 AND write_id=$2',[req.account.id,writeId])).rows[0];if(receipt)return res.json({revision:receipt.revision});}
  if(!r.rows.length)return res.status(409).json({error:'A conta foi atualizada em outra aba ou dispositivo. Carregue o save atual da conta para continuar.'});
  res.json({revision:r.rows[0].revision});
 }));
 router.patch('/profile',wrap(async(req,res)=>{
  if(!AVATARS.includes(req.body.avatar))return res.status(400).json({error:'Avatar inválido.'});
  const a=(await db.query('UPDATE pg_accounts SET avatar=$1 WHERE id=$2 RETURNING *',[req.body.avatar,req.account.id])).rows[0];res.json({user:publicUser(a)});
 }));
 router.post('/password',wrap(async(req,res)=>{
  const {currentPassword,password}=req.body;
  if(typeof currentPassword!=='string'||currentPassword.length>128||!await verify(currentPassword,req.account.password_hash))return res.status(401).json({error:'Senha atual incorreta.'});
  if(typeof password!=='string'||password.length<8||password.length>128)return res.status(400).json({error:'A nova senha deve ter de 8 a 128 caracteres.'});
  await db.query('UPDATE pg_accounts SET password_hash=$1 WHERE id=$2',[await hash(password),req.account.id]);
  await db.query('DELETE FROM pg_sessions WHERE account_id=$1 AND token_hash<>$2',[req.account.id,req.tokenHash]);res.json({ok:true});
 }));
 router.post('/feedback',wrap(async(req,res)=>{
  const {subject,message}=req.body;
  if(typeof subject!=='string'||!subject.trim()||subject.length>120||typeof message!=='string'||!message.trim()||message.length>5000)return res.status(400).json({error:'Preencha o assunto (até 120 caracteres) e o feedback (até 5.000).'});
  const count=(await db.query("SELECT count(*) FROM pg_feedback WHERE account_id=$1 AND created_at>now()-interval '1 day'",[req.account.id])).rows[0].count;
  if(Number(count)>=10)return res.status(429).json({error:'Você já enviou 10 feedbacks hoje. Volte amanhã.'});
  await db.query('INSERT INTO pg_feedback(id,account_id,subject,message) VALUES($1,$2,$3,$4)',[crypto.randomUUID(),req.account.id,subject.trim(),message.trim()]);res.status(201).json({ok:true});
 }));
 router.delete('/session',wrap(async(req,res)=>{await db.query('DELETE FROM pg_sessions WHERE token_hash=$1',[req.tokenHash]);res.json({ok:true});}));
 // Roles come from the database on every authenticated request, never from the browser.
 router.use('/admin',(req,res,next)=>req.account.is_admin===true?next():res.status(403).json({error:'Esta página é exclusiva para administradores.'}));
 const uuid=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
 const adminUser=a=>({...publicUser(a),bannedAt:a.banned_at});
 router.get('/admin/users',wrap(async(req,res)=>{
  const offset=Number(req.query.offset||0);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)return res.status(400).json({error:'Página inválida.'});
  const total=Number((await db.query('SELECT count(*) FROM pg_accounts')).rows[0].count);
  const items=(await db.query('SELECT id,username,avatar,created_at,is_admin,banned_at FROM pg_accounts ORDER BY created_at ASC,id ASC LIMIT 30 OFFSET $1',[offset])).rows.map(adminUser);
  res.json({items,total,offset,limit:30});
 }));
 async function accountTransaction(fn){
  // Serialize role changes, then recheck the acting admin inside the transaction.
  if(typeof db.transaction==='function')return db.transaction(async tx=>{await tx.query('LOCK TABLE pg_accounts IN SHARE ROW EXCLUSIVE MODE');return fn(tx);});
  const client=await db.connect();try{await client.query('BEGIN');await client.query('LOCK TABLE pg_accounts IN SHARE ROW EXCLUSIVE MODE');const result=await fn(client);await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 router.patch('/admin/users/:id',wrap(async(req,res)=>{
  const action=req.body.action;
  if(!uuid(req.params.id)||!['ban','unban','grant-admin','revoke-admin'].includes(action))return res.status(400).json({error:'Ação de conta inválida.'});
  if(req.params.id===req.account.id)return res.status(409).json({error:'Você não pode alterar suas próprias permissões ou banir sua conta.'});
  const result=await accountTransaction(async tx=>{
   const actor=(await tx.query('SELECT is_admin,banned_at FROM pg_accounts WHERE id=$1',[req.account.id])).rows[0];
   if(!actor?.is_admin||actor.banned_at)return {status:403,error:'Sua conta não tem mais acesso de administrador.'};
   const target=(await tx.query('SELECT id,is_admin,banned_at FROM pg_accounts WHERE id=$1',[req.params.id])).rows[0];
   if(!target)return {status:404,error:'Conta não encontrada.'};
   if(action==='ban'&&target.is_admin)return {status:409,error:'Retire o acesso de administrador antes de banir esta conta.'};
   if(action==='grant-admin'&&target.banned_at)return {status:409,error:'Desbana a conta antes de conceder acesso de administrador.'};
   const statements={ban:'banned_at=COALESCE(banned_at,now())',unban:'banned_at=NULL','grant-admin':'is_admin=true','revoke-admin':'is_admin=false'};
   const a=(await tx.query(`UPDATE pg_accounts SET ${statements[action]} WHERE id=$1 RETURNING id,username,avatar,created_at,is_admin,banned_at`,[target.id])).rows[0];
   if(action==='ban')await tx.query('DELETE FROM pg_sessions WHERE account_id=$1',[target.id]);
   return {user:adminUser(a)};
  });
  if(result.error)return res.status(result.status).json({error:result.error});res.json(result);
 }));
 router.get('/admin/feedback',wrap(async(req,res)=>{
  const offset=Number(req.query.offset||0),trash=req.query.trash==='1';
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)return res.status(400).json({error:'Página inválida.'});
  const where=trash?'f.deleted_at IS NOT NULL':'f.deleted_at IS NULL';
  const total=Number((await db.query(`SELECT count(*) FROM pg_feedback f WHERE ${where}`)).rows[0].count);
  const rows=(await db.query(`SELECT f.id,f.subject,f.created_at,f.deleted_at,a.username FROM pg_feedback f JOIN pg_accounts a ON a.id=f.account_id WHERE ${where} ORDER BY f.created_at DESC,f.id DESC LIMIT 30 OFFSET $1`,[offset])).rows;
  res.json({items:rows,total,offset,limit:30});
 }));
 router.get('/admin/feedback/:id',wrap(async(req,res)=>{
  if(!uuid(req.params.id))return res.status(400).json({error:'Feedback inválido.'});
  const item=(await db.query('SELECT f.id,f.subject,f.message,f.created_at,f.deleted_at,a.username FROM pg_feedback f JOIN pg_accounts a ON a.id=f.account_id WHERE f.id=$1',[req.params.id])).rows[0];
  if(!item)return res.status(404).json({error:'Feedback não encontrado.'});res.json({item});
 }));
 router.delete('/admin/feedback/:id',wrap(async(req,res)=>{
  if(!uuid(req.params.id))return res.status(400).json({error:'Feedback inválido.'});
  const r=await db.query('UPDATE pg_feedback SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'Feedback não encontrado.'});res.json({ok:true});
 }));
 router.post('/admin/feedback/:id/restore',wrap(async(req,res)=>{
  if(!uuid(req.params.id))return res.status(400).json({error:'Feedback inválido.'});
  const r=await db.query('UPDATE pg_feedback SET deleted_at=NULL WHERE id=$1 RETURNING id',[req.params.id]);
  if(!r.rows.length)return res.status(404).json({error:'Feedback não encontrado.'});res.json({ok:true});
 }));
 router.use((err,_req,res,_next)=>{res.status(err.message.startsWith('Save')?400:500).json({error:err.message.startsWith('Save')?err.message:'Não foi possível concluir. Tente novamente.'});});
}
module.exports={installAccounts,snapshot,hash,verify};
