import {readAll, mergeRemote, acceptServer, setting, readOne, writeOne, deleteOne} from './storage.js';
// A public browser key is expected here. Never use the Supabase service_role key.
const URL='https://vspytqnxxpvegwohgeag.supabase.co';
const KEY='sb_publishable_qWzECuZVmVewFbvwZ0ErBg_FqKol8X2';
const AUTH_KEY='svoyaki-supabase-session-v1';
let session=null;
const INVITE_KEY='svoyaki-invite-v1';
let syncing=false;
let approved=false;
try {session=JSON.parse(localStorage.getItem(AUTH_KEY)||'null');} catch {}
export function signedIn(){return approved && !!session?.access_token;}
const headers=(jwt=false)=>({'apikey':KEY,'Content-Type':'application/json',...(jwt&&session?.access_token?{'Authorization':`Bearer ${session.access_token}`}:{})});
async function request(path,options={},jwt=false){
 const response=await fetch(URL+path,{...options,headers:{...headers(jwt),...(options.headers||{})},cache:'no-store'});
 const body=await response.text();let data;try{data=body?JSON.parse(body):null;}catch{data=body;}
 if(!response.ok)throw new Error(data?.msg||data?.error_description||data?.message||`Ошибка сервера ${response.status}`);
 return data;
}
async function refresh(){
 if(!session?.refresh_token)throw new Error('Необходимо войти заново');
 const data=await request('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})});
 session=data;localStorage.setItem(AUTH_KEY,JSON.stringify(data));return data;
}
async function token(){
 if(!session?.access_token)throw new Error('Войди в аккаунт команды');
 if(session.expires_at && session.expires_at < Math.floor(Date.now()/1000)+60)await refresh();
 return session.access_token;
}
async function memberCheck(){
 await token();
 const data=await request('/rest/v1/team_members?select=user_id,role&limit=1',{},true);
 approved=Array.isArray(data)&&data.length>0;
 if(!approved)throw new Error('Нет доступа к команде. Откройте личную ссылку-приглашение.');
 return data[0];
}
function invitation(){
 const hash=new URLSearchParams(location.hash.slice(1));
 const token=hash.get('invite');
 if(token){localStorage.setItem(INVITE_KEY,token);history.replaceState(null,'',location.pathname+location.search);}
 return localStorage.getItem(INVITE_KEY)||'';
}
export function inviteAvailable(){return !!invitation();}
export async function login(name){
 const person_name=String(name||'').trim();
 if(person_name.length<2||person_name.length>80)throw new Error('Введите имя от 2 до 80 символов');
 const invite=invitation();
 if(!invite&&!approved)throw new Error('Для первого входа откройте ссылку-приглашение от руководителя');
 if(!session?.access_token){
  const data=await request('/auth/v1/signup',{method:'POST',body:JSON.stringify({data:{display_name:person_name},gotrue_meta_security:{}})});
  if(!data?.access_token)throw new Error('Анонимный вход не включён в Supabase. Включите Anonymous Sign-Ins в настройках Auth.');
  session=data;localStorage.setItem(AUTH_KEY,JSON.stringify(data));
 }
 await token();
 if(invite){
  await request('/rest/v1/rpc/join_svoyaki_team',{
   method:'POST',body:JSON.stringify({invite,person_name})
  },true);
 }
 await memberCheck();
 await setting('lastUser',person_name);
 return {ok:true};
}
export async function signup(name){return login(name);}
export async function logout(){approved=false;session=null;localStorage.removeItem(AUTH_KEY);localStorage.removeItem(INVITE_KEY);}
export async function currentSession(){
 if(!session?.access_token)return {authenticated:false};
 try{await memberCheck();return {authenticated:true};}
 catch{return {authenticated:false,pendingApproval:true};}
}
export async function checkConnection(){
 try{const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),5000);
 const response=await fetch(URL+'/auth/v1/health',{method:'GET',headers:{apikey:KEY},cache:'no-store',signal:ctrl.signal});clearTimeout(timeout);return response.ok;}
 catch{return false;}
}
async function allRemote(){await token();return await request('/rest/v1/production_records?select=*&order=updated_at.asc',{},true);}
async function fetchOne(id){
 const data=await request('/rest/v1/production_records?select=*&id=eq.'+encodeURIComponent(id)+'&limit=1',{},true);return data[0]||null;
}
function normalize(row){return {id:row.id,kind:row.kind,data:row.data,version:row.version,stamp:row.stamp,updatedAt:row.updated_at};}
export async function syncNow(onConflict){
 if(syncing)return {busy:true};syncing=true;
 try{
  await memberCheck();
  const pending=await readAll('pending');
  const accepted=[];const conflicts=[];
  for(const edit of pending){
   const remote=await fetchOne(edit.id);
   if(remote&&Number(remote.version)!==Number(edit.baseVersion)){
    conflicts.push({id:edit.id,server:normalize(remote),local:edit});continue;
   }
   const data={id:edit.id,kind:edit.kind,data:edit.data,stamp:edit.stamp,updated_by:session.user.id};
   const rows= remote?
    await request('/rest/v1/production_records?id=eq.'+encodeURIComponent(edit.id)+'&version=eq.'+edit.baseVersion,
     {method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({...data,version:remote.version+1})},true):
    await request('/rest/v1/production_records',
     {method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({...data,version:1})},true);
   if(!rows?.length){const latest=await fetchOne(edit.id);conflicts.push({id:edit.id,server:normalize(latest),local:edit});continue;}
   const row=normalize(rows[0]);await acceptServer(row);accepted.push(row);
  }
  const remote=await allRemote();await mergeRemote(remote.map(normalize));
  if(conflicts.length)await onConflict?.(conflicts);
  await setting('lastSync',new Date().toISOString());
  return {ok:true,conflicts:conflicts.length,synced:accepted.length};
 }finally{syncing=false;}
}
export async function resolveConflict(conflict,choice){
 if(choice==='remote'){
  await deleteOne('pending',conflict.id);await writeOne('records',conflict.server);
 }else{
  const local=await readOne('records',conflict.id);
  await writeOne('pending',{id:conflict.id,kind:local.kind,data:local.data,baseVersion:conflict.server.version,stamp:crypto.randomUUID()});
 }
}
// Web Push requires an additional notification service and is not yet configured.
export async function getPushConfig(){return {configured:false};}
export async function subscribePush(){throw new Error('Сервер уведомлений ещё не подключён');}
export function base64ToBytes(s){const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}