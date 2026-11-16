/* Планёр v1: авторизация и синхронизация через Supabase Auth + Edge Function */
(function () {
"use strict";
const API="planner-v1", URL="https://vspytqnxxpvegwohgeag.supabase.co";
const PUBLIC_KEY="sb_publishable_qWzECuZVmVewFbvwZ0ErBg_FqKol8X2";
let sb=null,bridge=null,revision=0,active=false,profile=null,members=[],channel=null,timer=null,busy=false,loading=false,mode="login",lastSync=0;
function esc(x){return String(x==null?"":x).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function show(html){let el=document.getElementById("planner-cloud-gate");if(!el){el=document.createElement("div");el.id="planner-cloud-gate";document.body.appendChild(el)}el.hidden=false;el.innerHTML='<div class="pc-card"><div class="pc-brand"><span class="pc-dot">◉</span>Планёр <small>ОБЩАЯ БАЗА</small></div>'+html+'</div>'}
function hide(){let e=document.getElementById("planner-cloud-gate");if(e)e.hidden=true}
function message(s){let p=document.querySelector("#planner-cloud-gate .pc-message");if(p){p.textContent=s;p.hidden=false}else alert(s)}
function auth(note){
  active=false;const reg=mode==="register";
  show('<h1>'+(reg?"Создать аккаунт":"Войти в продакшен")+'</h1>'+
    '<p class="pc-sub">Личный доступ к календарю и съёмкам. Синхронизация между устройствами.</p>'+
    (note?'<p class="pc-info">'+esc(note)+'</p>':"")+
    '<form id="pc-auth-form">'+
    (reg?'<label>Ваше имя<input id="pc-name" autocomplete="name" maxlength="80" required placeholder="Имя и фамилия"></label>':"")+
    '<label>Электронная почта<input id="pc-email" type="email" autocomplete="email" required placeholder="name@example.com"></label>'+
    '<label>Пароль<input id="pc-password" type="password" autocomplete="'+(reg?"new-password":"current-password")+'" minlength="8" required placeholder="Не менее 8 символов"></label>'+
    '<p class="pc-message" hidden></p><button class="pc-primary" type="submit">'+(reg?"Зарегистрироваться":"Войти")+'</button></form>'+
    '<button class="pc-text" id="pc-switch">'+(reg?"Уже есть аккаунт? Войти":"Нет аккаунта? Зарегистрироваться")+'</button>'+
    '<p class="pc-foot">После регистрации может потребоваться подтверждение электронной почты.</p>');
}
function pending(){
  active=false;
  show('<div class="pc-mini">Аккаунт: '+esc(profile?.display_name||"Участник")+'</div>'+
   '<h1>Ожидание доступа</h1><p class="pc-sub">Администратор должен одобрить аккаунт и, для оператора, назначить профиль сотрудника.</p>'+
   '<div class="pc-divider"></div><h2>Первоначальная настройка</h2>'+
   '<p class="pc-sub">Владелец системы может активировать администраторский аккаунт одноразовым кодом. Другим сотрудникам он не нужен.</p>'+
   '<form id="pc-claim-form"><label>Код владельца<input type="password" id="pc-token" autocomplete="off" required></label>'+
   '<p class="pc-message" hidden></p><button class="pc-primary">Активировать владельца</button></form>'+
   '<div class="pc-row"><button class="pc-text" id="pc-check">Проверить доступ</button><button class="pc-text" id="pc-logout">Выйти</button></div>');
}
function wait(s){show('<h1>Подключение</h1><p class="pc-sub">'+esc(s||"Проверяем аккаунт и календарь…")+'</p><div class="pc-loading"></div><p class="pc-message" hidden></p>')}
async function api(action,params){
  if(!sb)throw Error("Нет соединения с сервером.");
  const {data,error}=await sb.functions.invoke(API,{body:{action,...(params||{})}});
  if(error){
    let msg=error.message||"Ошибка подключения";
    try{const x=await error.context?.json?.();msg=x?.error||x?.message||msg}catch(e){}
    throw Error(msg);
  }
  if(data?.error)throw Error(data.error);
  return data;
}
async function refresh(force){
  if(loading)return;
  loading=true;
  try{
    const sess=await sb.auth.getSession();
    if(!sess.data?.session){auth();return}
    const verify=await sb.auth.getUser();
    if(verify.error||!verify.data?.user){auth("Срок действия сеанса истёк.");return}
    const user=verify.data.user;
    if(user.is_anonymous){await sb.auth.signOut();auth();return}
    const requested=await api("request",{display_name:user.user_metadata?.full_name||user.email?.split("@")[0]||"Сотрудник"});
    profile=requested.profile;
    if(!profile?.active){pending();return}
    const snap=await api("pull");
    if(!snap.profile?.active){profile=snap.profile;pending();return}
    const changed=!active||Number(snap.revision)!==revision;
    active=true;profile=snap.profile;members=snap.members||[];revision=Number(snap.revision);
    hide();
    if(changed||force)bridge.boot(snap.state,profile,members,revision);
    lastSync=Date.now();
    subscribe();
  }catch(e){
    if(!active)show('<h1>Ошибка подключения</h1><p class="pc-sub">Не удалось загрузить общую базу. Проверьте интернет.</p><p class="pc-message">'+esc(e.message)+'</p><button class="pc-primary" id="pc-check">Повторить</button><button class="pc-text" id="pc-logout">Выйти</button>');
    else {console.warn("Синхронизация:",e);let el=document.getElementById("cloud-status");if(el)el.textContent="Нет связи";}
  }finally{loading=false}
}
async function save(data){
  if(!active||!["admin","coordinator"].includes(profile?.role))throw Error("Нет прав изменять общий календарь.");
  if(busy)throw Error("Сохранение ещё выполняется.");
  busy=true;
  try{
    const res=await api("save",{data,revision});
    revision=Number(res.revision);
    const el=document.getElementById("cloud-status");if(el)el.textContent="Облако синхронизировано";
    return true;
  }catch(e){await refresh(true);throw e}finally{busy=false}
}
async function progress(id,status,link,note){
  if(!active||profile?.role!=="operator")throw Error("Нет прав изменять эту съёмку.");
  await api("progress",{id,status,link:link||"",note:note||""});
  await refresh(true);
  return true;
}
function subscribe(){
  if(channel||!sb)return;
  channel=sb.channel("planner-v1-events")
    .on("postgres_changes",{event:"UPDATE",schema:"public",table:"planner_v1_events"},()=>{if(!busy)refresh(false)})
    .subscribe();
  if(!timer)timer=setInterval(()=>{if(active&&document.visibilityState==="visible"&&Date.now()-lastSync>12000)refresh(false)},15000);
}
async function logout(){
  active=false;profile=null;members=[];revision=0;
  if(channel){await sb.removeChannel(channel);channel=null}
  await sb.auth.signOut();auth("Вы вышли из планировщика.");
}
function adminUI(employees){
  if(!active||profile?.role!=="admin")return "";
  const rows=members.map(m=>{
    let isMe=m.user_id===profile.user_id;
    let options=(employees||[]).map(e=>'<option value="'+esc(e.id)+'" '+(Number(m.employee_id)===Number(e.id)?"selected":"")+'>'+esc(e.name)+'</option>').join("");
    return '<div class="pc-member"><div><strong>'+esc(m.display_name)+'</strong><div class="pc-member-meta">'+
      (m.active?"Доступ открыт":"Ожидает одобрения")+(isMe?" · Вы":"")+'</div></div>'+
      (isMe?'<span class="chip">Администратор</span>':
       '<div class="pc-flex"><select class="select pc-role" data-id="'+esc(m.user_id)+'">'+
       '<option value="operator" '+(m.role==="operator"?"selected":"")+'>Оператор</option>'+
       '<option value="coordinator" '+(m.role==="coordinator"?"selected":"")+'>Координатор</option></select>'+
       '<select class="select pc-employee" data-id="'+esc(m.user_id)+'"><option value="">Без привязки</option>'+options+'</select>'+
       '<button class="btn small '+(!m.active?"primary":"")+'" data-cloud-action="member" data-id="'+esc(m.user_id)+'">'+(!m.active?"Одобрить":"Сохранить")+'</button>'+
       (m.active?'<button class="btn small danger" data-cloud-action="disable" data-id="'+esc(m.user_id)+'">Отключить</button>':"")+'</div>')+'</div>'
  }).join("");
  return '<section class="section"><div class="section-head"><h2 class="section-title">Доступ пользователей</h2><span class="chip">Администратор</span></div>'+
   '<div class="section-body"><p class="tiny muted">Сотрудник регистрируется по электронной почте. Здесь одобри его аккаунт и назначь исполнителя из календаря.</p>'+
   (rows||'<div class="empty">Заявок пока нет</div>')+'<div class="pc-divider"></div><button class="btn small" data-cloud-action="import-local">Перенести сохранённые данные прежней версии</button></div></section>';
}
async function start(b){
  bridge=b;wait("Подключаем защищённую базу…");
  if(!window.supabase?.createClient){
    show('<h1>Не загружается модуль авторизации</h1><p class="pc-sub">Проверьте интернет и обновите страницу. Для входа нужна библиотека Supabase.</p>');
    return;
  }
  sb=window.supabase.createClient(URL,PUBLIC_KEY,{
    auth:{storageKey:"planer-cloud-auth-v1",persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  });
  sb.auth.onAuthStateChange(ev=>{if(ev==="SIGNED_OUT")setTimeout(()=>{if(!active)auth()},0)});
  await refresh(true);
  if(!timer)timer=setInterval(function(){
    if(document.visibilityState!=="visible")return;
    if((active||profile&&!profile.active)&&Date.now()-lastSync>12000)refresh(false);
  },15000);
  document.addEventListener("visibilitychange",()=>{if(active&&document.visibilityState==="visible")refresh(false)});
}
document.addEventListener("click",async e=>{
  const el=e.target.closest("#pc-switch,#pc-logout,#pc-check,[data-cloud-action]");
  if(!el)return;
  if(el.id==="pc-switch"){mode=mode==="login"?"register":"login";auth();return}
  if(el.id==="pc-logout"){await logout();return}
  if(el.id==="pc-check"){wait();await refresh(true);return}
  const action=el.getAttribute("data-cloud-action");
  if(action==="import-local"){
    try{await bridge.importLocal();await refresh(true)}
    catch(err){alert(err.message)}
    return;
  }
  if(action!=="member"&&action!=="disable")return;
  const userId=el.dataset.id,role=document.querySelector('.pc-role[data-id="'+userId+'"]'),employee=document.querySelector('.pc-employee[data-id="'+userId+'"]');
  if(!role||!employee)return;
  el.disabled=true;
  try{
    await api("manage",{user_id:userId,role:role.value,employee_id:employee.value?Number(employee.value):null,active:action==="member"});
    await refresh(true);
  }catch(err){alert(err.message);el.disabled=false}
});
document.addEventListener("submit",async e=>{
  if(e.target.id==="pc-auth-form"){
    e.preventDefault();
    const f=e.target,button=f.querySelector("button"),email=f.querySelector("#pc-email").value.trim(),password=f.querySelector("#pc-password").value;
    button.disabled=true;
    try{
      if(mode==="register"){
        const fullName=f.querySelector("#pc-name").value.trim();
        const {data,error}=await sb.auth.signUp({email,password,options:{data:{full_name:fullName},emailRedirectTo:location.origin+location.pathname}});
        if(error)throw error;
        if(data.session){wait();await refresh(true)}
        else {mode="login";auth("Проверьте почту и подтвердите регистрацию. Если ссылка в письме не ведёт в Планёр, администратору нужно добавить адрес приложения в Redirect URLs Supabase.")}
      }else{
        const {error}=await sb.auth.signInWithPassword({email,password});
        if(error)throw error;
        wait();await refresh(true)
      }
    }catch(err){message(err.message)}finally{button.disabled=false}
    return;
  }
  if(e.target.id==="pc-claim-form"){
    e.preventDefault();
    const button=e.target.querySelector("button"),token=e.target.querySelector("#pc-token").value.trim();
    button.disabled=true;
    try{await api("claim",{token});wait();await refresh(true)}catch(err){message(err.message)}
    finally{button.disabled=false}
  }
});
window.PlanerCloud={start,save,progress,refresh,logout,adminUI,
 get active(){return active},get profile(){return profile},get members(){return members},get revision(){return revision}};
})();
