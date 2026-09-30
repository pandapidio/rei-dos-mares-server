'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express'),crypto=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {installAccounts}=require('./accounts/service');
test('accounts: import only on creation, replacement saves, retries, isolation and private feedback',async()=>{
 const db=new PGlite(),app=express();await installAccounts(app,{db,origins:new Set(['https://pandapidio.github.io'])});
 const server=app.listen(0);await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/accounts';
 async function request(path,method='GET',body,token,origin){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>null)};}
 try{
  const a=await request('/session','POST',{username:'Pandateste',password:'secret-test-123',progress:{reiDosMaresDiamonds:'25',ayuwoke_best:'{"score":40}'}});assert.equal(a.status,200);assert.equal(a.data.created,true);assert.equal(a.data.user.avatar,'panda');assert.equal(a.data.progress.reiDosMaresDiamonds,'25');assert.ok(a.data.user.createdAt);const token=a.data.token;
  const b=await request('/session','POST',{username:'PANDATESTE',password:'secret-test-123',progress:{reiDosMaresDiamonds:'9999'}});assert.equal(b.data.created,false);assert.equal(b.data.progress.reiDosMaresDiamonds,'25');
  assert.equal((await request('/session','POST',{username:'Pandateste',password:'wrong-pass'})).status,401);
  const write={revision:0,progress:{reiDosMaresDiamonds:'30'},writeId:crypto.randomUUID()};const duplicates=await Promise.all([request('/progress','PUT',write,token),request('/progress','PUT',write,token)]);assert.ok(duplicates.every(x=>x.status===200&&x.data.revision===1));assert.equal((await request('/progress','PUT',write,token)).data.revision,1);
  assert.equal((await request('/progress','PUT',{...write,writeId:crypto.randomUUID()},token)).status,409);
  assert.equal((await request('/me','GET',null,token)).data.progress.ayuwoke_best,undefined);
  assert.equal((await request('/me')).status,401);assert.equal((await request('/me','GET',null,token,'https://evil.example')).status,403);
  assert.equal((await request('/progress','PUT',{revision:1,writeId:crypto.randomUUID(),progress:{'pg.account.v1':'no'}},token)).status,400);
  assert.equal((await request('/profile','PATCH',{avatar:'jeff'},token)).data.user.avatar,'jeff');assert.equal((await request('/profile','PATCH',{avatar:'bad'},token)).status,400);
  assert.equal((await request('/password','POST',{currentPassword:'wrong',password:'new-pass-123'},token)).status,401);
  assert.equal((await request('/password','POST',{currentPassword:'secret-test-123',password:'new-pass-123'},token)).status,200);assert.equal((await request('/me','GET',null,b.data.token)).status,401);
  const other=await request('/session','POST',{username:'OutroPanda',password:'other-pass-123',progress:{reiDosMaresDiamonds:'7'}});assert.equal(other.data.progress.reiDosMaresDiamonds,'7');
  assert.equal((await request('/feedback','POST',{subject:'Bug na loja',message:'Detalhes <script>alert(1)</script>'},token)).status,201);
  assert.equal((await db.query('SELECT account_id,subject FROM pg_feedback')).rows[0].account_id,a.data.user.id);
  assert.equal((await request('/feedback','GET',null,other.data.token)).status,404); // no public/admin inbox
  const feedback=(await db.query('SELECT id FROM pg_feedback')).rows[0];
  assert.equal(a.data.user.isAdmin,false);
  for(const [route,method] of [['/admin/feedback','GET'],['/admin/feedback/'+feedback.id,'GET'],['/admin/feedback/'+feedback.id,'DELETE'],['/admin/feedback/'+feedback.id+'/restore','POST']])assert.equal((await request(route,method,null,other.data.token)).status,403);
  assert.equal((await request('/admin/feedback')).status,401);
  // Explicit database grant, bound to the account ID; browser payloads cannot grant roles.
  await db.query('UPDATE pg_accounts SET is_admin=true WHERE id=$1',[a.data.user.id]);
  assert.equal((await request('/me','GET',null,token)).data.user.isAdmin,true);
  const inbox=await request('/admin/feedback','GET',null,token);assert.equal(inbox.status,200);assert.equal(inbox.data.total,1);assert.equal(inbox.data.items[0].username,'Pandateste');assert.equal(inbox.data.items[0].message,undefined);
  const detail=await request('/admin/feedback/'+feedback.id,'GET',null,token);assert.equal(detail.data.item.message,'Detalhes <script>alert(1)</script>');assert.equal(detail.data.item.password_hash,undefined);
  assert.equal((await request('/admin/feedback?offset=-1','GET',null,token)).status,400);
  assert.equal((await request('/admin/feedback/not-a-uuid','GET',null,token)).status,400);
  assert.equal((await request('/admin/feedback','GET',null,token,'https://evil.example')).status,403);
  assert.equal((await request('/admin/feedback/'+feedback.id,'DELETE',null,token)).status,200);
  assert.equal((await request('/admin/feedback','GET',null,token)).data.total,0);
  assert.equal((await request('/admin/feedback?trash=1','GET',null,token)).data.total,1);
  assert.equal((await request('/admin/feedback/'+feedback.id+'/restore','POST',null,token)).status,200);
  assert.equal((await request('/admin/feedback','GET',null,token)).data.total,1);
  await db.query('UPDATE pg_accounts SET is_admin=false WHERE id=$1',[a.data.user.id]);
  assert.equal((await request('/admin/feedback','GET',null,token)).status,403); // revocation takes effect in the same session
  await request('/session','DELETE',null,token);assert.equal((await request('/me','GET',null,token)).status,401);
 }finally{await new Promise(r=>server.close(r));await db.close();}
});
