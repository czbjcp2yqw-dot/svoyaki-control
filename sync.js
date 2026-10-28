import {readAll,mergeRemote,acceptServer,setting,readOne,writeOne,deleteOne} from './storage.js';
const URL='https://vspytqnxxpvegwohgeag.supabase.co',KEY='sb_publishable_qWzECuZVmVewFbvwZ0ErBg_FqKol8X2',SK='svoyaki_auth_v1';
let session=JSON.parse(localStorage.getItem(SK)||'null'),role='',busy=false;
const persist=s=>{session=s;if(s)localStorage.setItem(SK,JSON.stringify(s));else localStorage.removeItem(SK);};
export const signedIn=()=>!!(role&&session?.access_token);
async function decode(r){const x=await r.json().catch(()=>({}));if(!r.ok)throw Error(x.message||x.error_description||x.msg||x.error||'HTTP '+r.status);return x;}
async function refresh(){if(!session?.refresh_token)throw Error('Нужен вход');const r=await fetch(URL+'/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({refresh_token:session.refresh_token})});const x=await decode(r);persist({...x,expires_at:Math.floor(Date.now()/1000)+x.expires_in});}
async function auth(){if(!session?.access_token)throw Error('Нужен вход');if((session.expires_at||0)<Math.floor(Date.now()/1000)+90)await refresh();return {apikey:KEY,Authorization:'Bearer '+session.access_token};}
async function api(path,method='GET',body){let h=await auth();const send=()=>fetch(URL+'/rest/v1/'+path,{method,cache:'no-store',headers:{...h,'Content-Type':'application/json',...(method==='GET'?{}:{Prefer:'return=representation'})},body:body?JSON.stringify(body):undefined});let r=await send();if(r.status===401){await refresh();h=await auth();r=await send();}return decode(r);}
async function checkMember(){const rows=await api('team_members?select=role&user_id=eq.'+session.user.id);role=rows[0]?.role||'';if(!role)throw Error('Аккаунт не добавлен в команду. Передай администратору свой email.');}
export async function login(email,password){const r=await fetch(URL+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});const s=await decode(r);persist({...s,expires_at:Math.floor(Date.now()/1000)+s.expires_in});await setting('lastUser',email);await checkMember();}
export async function signup(email,password){const r=await fetch(URL+'/auth/v1/signup',{method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});await decode(r);}
export async function logout(){role='';persist(null);}
export async function currentSession(){if(!session)return {authenticated:false};try{await checkMember();return {authenticated:true,role};}catch(e){role='';return {authenticated:false,reason:e.message};}}
export async function checkConnection(){if(!navigator.onLine)return false;try{const c=new AbortController();const t=setTimeout(()=>c.abort(),3500);const r=await fetch(URL+'/auth/v1/health',{headers:{apikey:KEY},signal:c.signal,cache:'no-store'});clearTimeout(t);return r.ok;}catch{return false;}}
function normalized(r){return {id:r.id,kind:r.kind,data:r.data,version:r.version,stamp:r.stamp,updatedAt:r.updated_at};}
export async function syncNow(onConflict){
 if(busy)return {busy:true};if(!signedIn())throw Error('Нужен вход для синхронизации');busy=true;
 try{
  let accepted=0;const conflicts=[];
  for(const p of await readAll('pending')){
   const existing=(await api('production_records?select=*&id=eq.'+encodeURIComponent(p.id)))[0];
   if(existing&&existing.version!==p.baseVersion){
    if(existing.stamp===p.stamp){await acceptServer({id:p.id,version:existing.version,stamp:p.stamp,updatedAt:existing.updated_at});accepted++;continue;}
    conflicts.push({id:p.id,server:normalized(existing),local:p});continue;
   }
   if(!existing&&p.baseVersion>0){conflicts.push({id:p.id,server:{id:p.id,version:0},local:p});continue;}
   const data={id:p.id,kind:p.kind,data:p.data,version:(existing?.version||0)+1,stamp:p.stamp,updated_by:session.user.id,updated_at:new Date().toISOString()};
   try{
    const result=existing?await api('production_records?select=*&id=eq.'+encodeURIComponent(p.id)+'&version=eq.'+existing.version,'PATCH',data):await api('production_records?select=*','POST',data);
    if(!result[0]){const remote=(await api('production_records?select=*&id=eq.'+encodeURIComponent(p.id)))[0];conflicts.push({id:p.id,server:normalized(remote),local:p});continue;}
    await acceptServer({id:p.id,version:result[0].version,stamp:p.stamp,updatedAt:result[0].updated_at});accepted++;
   }catch(e){if(!/duplicate|23505|409/.test(e.message))throw e;const remote=(await api('production_records?select=*&id=eq.'+encodeURIComponent(p.id)))[0];conflicts.push({id:p.id,server:normalized(remote),local:p});}
  }
  await mergeRemote((await api('production_records?select=*')).map(normalized));
  if(conflicts.length)await onConflict?.(conflicts);
  await setting('lastSync',new Date().toISOString());
  return {ok:true,synced:accepted,conflicts:conflicts.length};
 }finally{busy=false;}
}
export async function resolveConflict(c,choice){
 if(choice==='remote'){await deleteOne('pending',c.id);await writeOne('records',c.server);}
 else{const local=await readOne('records',c.id);await writeOne('pending',{id:c.id,kind:local.kind,data:local.data,baseVersion:c.server.version,stamp:crypto.randomUUID()});}
}
export async function getPushConfig(){return {configured:false};}
export async function subscribePush(){throw Error('Push ещё не подключён');}
export function base64ToBytes(s){return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
