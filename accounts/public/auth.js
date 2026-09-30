'use strict';
const params=new URLSearchParams(location.search),state=params.get('state'),statusEl=document.querySelector('#status');
const allowed=['https://pandapidio.github.io','http://localhost:5500','http://127.0.0.1:5500'];
const origin=params.get('origin');let init=null;
const passwordMode=params.get('mode')==='password';
document.querySelector('#login').hidden=passwordMode;document.querySelector('#password').hidden=!passwordMode;
function send(data){window.opener?.postMessage({...data,state},origin);}
if(!allowed.includes(origin)||!window.opener){statusEl.textContent='Abra sua conta pelo portal Pandapidio Games.';document.querySelectorAll('button').forEach(b=>b.disabled=true);}
else{
 addEventListener('message',e=>{if(e.origin!==origin||e.source!==opener||e.data?.state!==state||e.data?.type!=='pg-init')return;init=e.data;statusEl.textContent=passwordMode?'Confirme sua senha atual.':'Seu progresso acompanha você.';});send({type:'pg-ready'});
}
document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',async e=>{
 e.preventDefault();if(!init){statusEl.textContent='Não conseguimos conectar ao portal. Feche e tente novamente.';return;}
 const button=form.querySelector('button');button.disabled=true;statusEl.textContent='Só um instante…';
 try{
  const fields=Object.fromEntries(new FormData(form));if(!passwordMode)fields.progress=init.progress;
  const res=await fetch(passwordMode?'/accounts/password':'/accounts/session',{method:'POST',headers:{'Content-Type':'application/json',...(passwordMode?{Authorization:'Bearer '+init.token}:{})},body:JSON.stringify(fields)});
  const data=await res.json();if(!res.ok)throw Error(data.error);
  send({type:passwordMode?'pg-password':'pg-session',data});form.reset();statusEl.textContent=passwordMode?'Senha alterada. Você pode fechar esta janela.':'Tudo certo! Voltando ao portal…';
 }catch(err){statusEl.textContent=err.message;}finally{button.disabled=false;}
}));
