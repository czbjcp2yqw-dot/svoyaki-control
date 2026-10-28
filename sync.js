import { readAll, mergeRemote, acceptServer, setting, readOne, saveLocal, deleteOne } from './storage.js';
const STATIC_MODE = window.SVOYAKI_STATIC_MODE === true;
let syncing=false;
let isSignedIn=false;
export function signedIn(){return isSignedIn;}
async function api(path,opts={}){
  const res=await fetch(`/api/${path}`,{credentials:'same-origin',cache:'no-store',...opts,headers:{'Content-Type':'application/json',...(opts.headers||{})}});
  if(res.status===401){isSignedIn=false;throw new Error('Нужен вход в аккаунт для синхронизации');}
  if(!res.ok)throw new Error(`Ошибка сервера ${res.status}`);
  return res.json();
}
export async function login(username,password){const result=await api('login',{method:'POST',body:JSON.stringify({username,password})});isSignedIn=true;await setting('lastUser',username);return result;}
export async function logout(){try{await api('logout',{method:'POST',body:'{}'});}catch{}isSignedIn=false;}
export async function currentSession(){if(STATIC_MODE)return {authenticated:false};try{const data=await api('session');isSignedIn=!!data.authenticated;return data;}catch{return {authenticated:false};}}
export async function checkConnection(){if(STATIC_MODE)return false;try{const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),3500);const res=await fetch('/api/health',{cache:'no-store',signal:ctl.signal});clearTimeout(timer);return res.ok;}catch{return false;}}
export async function syncNow(onConflict){
  if(STATIC_MODE)throw new Error('Общая серверная база не подключена');
  if(syncing)return {busy:true}; syncing=true;
  try{
    const queued=await readAll('pending');
    const result=await api('sync',{method:'POST',body:JSON.stringify({changes:queued})});
    isSignedIn=true;
    for(const ack of result.accepted||[])await acceptServer(ack);
    await mergeRemote(result.records||[]);
    const conflicts=result.conflicts||[];
    if(conflicts.length)await onConflict?.(conflicts);
    await setting('lastSync',new Date().toISOString());
    return {ok:true,conflicts:conflicts.length,synced:result.accepted?.length||0};
  }finally{syncing=false;}
}
export async function resolveConflict(conflict,choice){
  if(choice==='remote'){
    await deleteOne('pending',conflict.id);
    await (await import('./storage.js')).writeOne('records',conflict.server);
  }else{
    const local=await readOne('records',conflict.id);
    await (await import('./storage.js')).writeOne('pending',{
      id:conflict.id,kind:local.kind,data:local.data,baseVersion:conflict.server.version,stamp:crypto.randomUUID()
    });
  }
}
export async function getPushConfig(){return api('push/config');}
export async function subscribePush(subscription){return api('push/subscribe',{method:'POST',body:JSON.stringify(subscription.toJSON())});}
export function base64ToBytes(s){const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));}