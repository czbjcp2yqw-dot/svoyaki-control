import {calculateSchedule, buildAgenda, formatDigest, fmtDate, localToday, isoForMoscow, diffDays, addDays} from './engine.js';
import {openStorage,readAll,readOne,saveLocal,writeOne,setting} from './storage.js';
import {login,signup,logout,currentSession,checkConnection,syncNow,resolveConflict,getPushConfig,subscribePush,base64ToBytes,signedIn,inviteAvailable} from './sync.js';
import {createIcs} from './ics.js';
const STATIC_MODE = window.SVOYAKI_STATIC_MODE === true;
const appBase = new URL('./', import.meta.url);

const state={offlineReady:false,kpp:null,records:{},page:'dashboard',selected:2,filter:'active',calendarDate:isoForMoscow(),pickedDate:isoForMoscow(),agendaFilter:'today',connection:false,synced:false,pending:0,conflicts:[],showSource:false,search:''};
const tabs=[{key:'dashboard',name:'Главная',icon:'▦'},{key:'episodes',name:'Выпуски',icon:'▣'},{key:'calendar',name:'Календарь',icon:'▤'},{key:'agenda',name:'Задачи',icon:'☷'},{key:'settings',name:'Настройки',icon:'⚙'}];
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const epId=n=>`episode:${String(n).padStart(2,'0')}`;
const index=n=>state.kpp.episodes[n-1];
const rec=n=>state.records[epId(n)]?.data||{number:n,stageFacts:{}};
const niceN=n=>String(n).padStart(2,'0');
const chip=(label,type='blue')=>`<span class="tag ${type}">${e(label)}</span>`;
const isoToday=()=>isoForMoscow();
function toast(message){const root=document.querySelector('#toast-root');root.innerHTML=`<div class="toast">${e(message)}</div>`;clearTimeout(toast.timeout);toast.timeout=setTimeout(()=>root.innerHTML='',4500);}
function badgeForDate(date,today=isoToday()){
  if(!date)return chip('Нет срока');const days=diffDays(date,today);
  if(days<0)return chip(`−${Math.abs(days)} дн.`,'danger');
  if(days===0)return chip('Сегодня','warning');
  if(days===1)return chip('Завтра','warning');
  return chip(fmtDate(date));
}
function currentKppEpisode(n){return state.kpp.episodes[n-1];}
function episodeStatus(n){const x=rec(n),t=currentKppEpisode(n);if(!x.actualShoot)return 'Не снят';const c=calculateSchedule(t,x),done=c.stages.filter(s=>s.status==='done').length;return done===18?'Готов':done>2?'В производстве':'Отснят';}
function episodeProgress(n){return Math.round(calculateSchedule(currentKppEpisode(n),rec(n)).stages.filter(s=>s.status==='done').length/18*100);}
async function refreshRecords(){state.records=Object.fromEntries((await readAll('records')).map(r=>[r.id,r]));state.pending=(await readAll('pending')).length;}
function updateNav(){
  const layout=mobile=>tabs.map(t=>`<button type="button" class="${mobile?'':'nav-button '}${t.key===state.page?'active':''}" data-page="${t.key}"><span class="nav-symbol">${t.icon}</span>${mobile?`<span>${t.name}</span>`:t.name}</button>`).join('');
  document.querySelector('#side-navigation').innerHTML=layout(false);document.querySelector('#mobile-navigation').innerHTML=layout(true);
  const titles={dashboard:'Обзор проекта',episodes:'Выпуски',calendar:'Календарь',agenda:'Задачи и сроки',settings:'Настройки',episode:'Карточка выпуска'};
  document.querySelector('#page-title').textContent=titles[state.page];
  const status=document.querySelector('#connection-chip');
  status.className=`status-chip ${state.connection?'online':'offline'}`;
  status.innerHTML=STATIC_MODE ? '<span class="status-dot"></span>Локально' : `<span class="status-dot"></span>${state.connection?(signedIn()?`Синхр. ${state.pending?`· ${state.pending} ⬆`:''}`:'Онлайн · без входа'):`Офлайн · ${state.pending} в очереди`}`;
  document.querySelector('#desktop-sync').textContent=STATIC_MODE ? 'GitHub Pages · только данные этого устройства' : state.connection? (signedIn()?'Сервер доступен · синхронизация включена':'Сервер доступен · нужен вход'):'Работаем офлайн · изменения сохраняются';
}
function goto(page,n){state.page=page;if(n)state.selected=Number(n);document.querySelector('#view').scrollTo?.({top:0});window.scrollTo({top:0,behavior:'instant'});render();}
function header(title,subtitle,buttons=''){
  return `<div class="page-head"><div><div class="overline">СВОЯКИ · PRODUCTION</div><h1>${e(title)}</h1><p>${subtitle}</p></div><div class="actions">${buttons}</div></div>`;
}
function taskIcon(group){return ({shoot:'▣',transfer:'⇢',editing:'✂',approval:'◎',iri:'⌛',sound:'♫',color:'◐',master:'✦',delivery:'✓'})[group]||'○';}
function taskRow(t){
  const dateStatus=diffDays(t.end,isoToday()),danger=dateStatus<0&&!t.blocked;
  return `<div class="task"><div class="task-marker">${taskIcon(t.group)}</div><div class="task-info"><div class="task-name">Выпуск ${niceN(t.episode)} · ${e(t.name)}</div><div class="task-secondary">${t.blocked?`⚠ ${e(t.blocked)}`:`Срок ${e(fmtDate(t.end,true))}`}</div></div><div class="task-time ${danger?'overdue':''}">${t.blocked?'Ожидание':danger?`${-dateStatus} дн. назад`:fmtDate(t.end)}</div></div>`;
}
function renderDashboard(){
  const today=isoToday(),agenda=buildAgenda(state.kpp,state.records,today),shot=agenda.episodes.length;
  const inProd=agenda.episodes.filter(a=>a.calc.stages.some(s=>s.status==='done')&&!a.calc.stages.every(s=>s.status==='done')).length;
  const ready=agenda.episodes.filter(a=>a.calc.stages.every(s=>s.status==='done')).length;
  const tasks=[...agenda.today,...agenda.tomorrow,...agenda.overdue].filter((x,i,arr)=>arr.findIndex(t=>t.episode===x.episode&&t.kind===x.kind)===i);
  return `${header('Пульс производства',`Сегодня ${fmtDate(today,true)} · 2 сезона · 20 выпусков`,`<button class="btn btn-primary" data-action="add-episode">＋ Добавить съёмку</button>`)}
  <div class="stats-grid">
    <div class="stat"><span class="title">Отснято выпусков</span><span class="stat-icon">◉</span><span class="number">${shot}<span style="font-size:14px;color:var(--muted);font-weight:500"> / 20</span></span><span class="tiny">По фактическим датам</span></div>
    <div class="stat"><span class="title">В производстве</span><span class="stat-icon">✂</span><span class="number">${inProd}</span><span class="tiny">Идут этапы КПП</span></div>
    <div class="stat warn"><span class="title">Задач сегодня</span><span class="stat-icon">◷</span><span class="number">${agenda.today.length}</span><span class="tiny">По активным выпускам</span></div>
    <div class="stat ${agenda.overdue.length?'warn':'positive'}"><span class="title">Требуют внимания</span><span class="stat-icon">!</span><span class="number">${agenda.overdue.length}</span><span class="tiny">Неотмеченные просрочки</span></div>
  </div>
  ${STATIC_MODE?'<div class="notice-card">Автономная версия: даты сохраняются на этом iPhone. Общая база и автоматические push-сводки ещё не подключены. Регулярно сохраняйте резервную копию в настройках.</div>':''}
  <div class="section-title"><h2>Контроль дедлайнов</h2><button class="btn btn-sm" data-page="agenda">Все задачи →</button></div>
  <div class="grid-two">
    <div class="panel"><div class="panel-header"><h3>Сегодня и ближайшие задачи</h3>${chip(`${tasks.length} задач`)}</div><div class="task-list">${tasks.slice(0,6).map(taskRow).join('')||'<div class="empty">На сегодня подтверждённых задач нет. Добавь фактическую дату съёмки, чтобы сформировать график.</div>'}</div></div>
    <div class="panel"><div class="panel-header"><h3>Под рукой</h3><span class="overline">БЫСТРЫЕ ДЕЙСТВИЯ</span></div><div class="quick-links">
      <button class="quick-link" data-action="add-episode"><div><strong>Новая фактическая съёмка</strong><small>Записать дату и гостя</small></div><span class="arrow">›</span></button>
      <button class="quick-link" data-page="calendar"><div><strong>Календарь КПП</strong><small>Сравнить план и прогноз</small></div><span class="arrow">›</span></button>
      <button class="quick-link" data-action="copy-digest"><div><strong>Сводка для Telegram</strong><small>Скопировать задачи по выпускам</small></div><span class="arrow">›</span></button>
    </div><div class="notice-card" style="margin-top:16px">◉ ${state.connection?(signedIn()?'Синхронизация активна':'Онлайн. Войди в настройки для общей базы.'):'Офлайн-режим. Данные и расчёты доступны без соединения.'} ${state.pending?`<br/>Изменений в очереди: ${state.pending}.`:''}</div></div>
  </div>
  <div class="section-title"><h2>Отснятые выпуски</h2><button class="btn btn-sm" data-page="episodes">Все 20 →</button></div>
  <div class="episode-grid">${agenda.episodes.length?agenda.episodes.slice(0,6).map(a=>episodeCard(a.template)).join(''):'<div class="empty">Пока нет отснятых выпусков</div>'}</div>`;
}
function episodeCard(template){
  const n=template.number,d=rec(n),p=episodeProgress(n),isShot=!!d.actualShoot;
  return `<button class="episode-card" data-action="open-episode" data-episode="${n}">
    <div class="episode-top"><span class="episode-number">СЕЗОН ${template.season} · №${niceN(template.seasonEpisode)}</span>${chip(isShot?'Снято':'По КПП',isShot?'success':'')}</div>
    <h3>${e(d.guest||`Выпуск ${niceN(n)}`)}</h3>
    <div class="muted">${isShot?'Съёмка '+fmtDate(d.actualShoot,true):'План съёмки '+fmtDate(template.shootPlanned,true)}</div>
    <div class="progress-track"><div class="progress-value" style="width:${p}%"></div></div>
    <div class="episode-footer"><span>${e(episodeStatus(n))}</span><span>${p}% →</span></div>
  </button>`;
}
function renderEpisodes(){
  const all=state.kpp.episodes.filter(t=>{
    const d=rec(t.number),f=state.filter;
    return (f==='all'||f==='active'&&d.actualShoot||f==='planned'&&!d.actualShoot||f==='season1'&&t.season===1||f==='season2'&&t.season===2)
      &&(!state.search||[t.number,d.guest,d.notes].join(' ').toLowerCase().includes(state.search.toLowerCase()));
  });
  return `${header('Все выпуски','Фактические даты, текущие статусы и индивидуальные сроки КПП','<button class="btn btn-primary" data-action="add-episode">＋ Добавить съёмку</button>')}
  <div class="filters"><div class="segmented">${[['active','Отсняты'],['planned','Не сняты'],['all','Все']].map(([k,l])=>`<button data-action="filter" data-filter="${k}" class="${state.filter===k?'active':''}">${l}</button>`).join('')}</div><input class="search-input" id="episode-search" placeholder="Поиск по гостю или номеру" value="${e(state.search)}" /></div>
  <div class="episode-grid">${all.map(episodeCard).join('')||'<div class="empty">Подходящих выпусков нет</div>'}</div>`;
}
function stageState(s){if(s.status==='done')return '✓ Выполнено';if(s.blocked)return '⚠ Входящие не подтверждены';return '○ '+({planned:'Не подтверждено',in_progress:'В работе',waiting:'Ожидаем',approval:'На согласовании',changes:'Правки',blocked:'Заблокировано'})[s.status]||s.status;}
function renderEpisode(){
  const n=state.selected,t=currentKppEpisode(n),data=rec(n),calc=calculateSchedule(t,data),done=calc.stages.filter(s=>s.status==='done').length;
  return `${header(`Выпуск ${niceN(n)}`,`Сезон ${t.season} · ${e(data.guest||'Гость пока не указан')}`,`<button class="btn" data-page="episodes">← К списку</button><button class="btn btn-primary" data-action="edit-episode" data-episode="${n}">✎ Данные</button>`)}
  <div class="episode-summary">
    <div class="mini-stat"><small>Съёмка (факт)</small><strong>${fmtDate(data.actualShoot)||'—'}</strong></div>
    <div class="mini-stat"><small>Монтажный план</small><strong>${fmtDate(data.planReceived)}</strong></div>
    <div class="mini-stat"><small>Смещение от плана</small><strong class="${calc.deltaFinal>0?'negative':calc.deltaFinal<0?'positive':''}">${calc.deltaFinal>0?'+':''}${calc.deltaFinal} дн.</strong></div>
    <div class="mini-stat"><small>Выполнено этапов</small><strong>${done} / 18</strong></div>
  </div>
  ${!data.actualShoot?'<div class="issue-banner">◷ Фактическая дата съёмки не внесена. Ниже показаны исходные плановые этапы КПП.</div>':''}
  ${!data.planReceived&&data.actualShoot?'<div class="issue-banner">⚠ Монтажный план пока не зафиксирован. Сроки монтажа предварительные, отсутствие материала нельзя считать просрочкой монтажёра.</div>':''}
  ${data.planReceived&&calc.delayFromPlan>0?`<div class="notice-card"><strong>Задержка входящих материалов: +${calc.delayFromPlan} дн.</strong><br/>Плановый старт «рыбы» после сдвига съёмки: ${fmtDate(addDays(t.stages.find(s=>s.key==='4').start,calc.deltaShoot),true)}. Монтажный план получен ${fmtDate(data.planReceived,true)}. Полная длительность «рыбы» по КПП сохраняется: ${calc.byKey['4'].days} дн.${calc.fishSaved!=null?`<br/>Фактически сэкономлено на этапе: ${calc.fishSaved} дн.`:''}</div>`:''}
  <div class="section-title"><h2>Этапы производства</h2><div class="segmented"><button data-action="toggle-source" data-mode="forecast" class="${state.showSource?'':'active'}">Прогноз</button><button data-action="toggle-source" data-mode="source" class="${state.showSource?'active':''}">Исходный КПП</button></div></div>
  <div class="timeline">${calc.stages.map(s=>`<button class="stage ${s.status==='done'?'done':''} ${s.blocked?'uncertain':''}" data-action="edit-stage" data-episode="${n}" data-stage="${s.key}">
    <span class="bar ${s.group}"></span><span class="stage-main"><strong>${e(s.name)}</strong><small>${s.key} · ${s.days} кал. дн. ${s.actualEnd?`· Факт: ${fmtDate(s.actualEnd)}`:''}${s.delta!==0?` · Смещение ${s.delta>0?'+':''}${s.delta} дн.`:''}</small></span>
    <span class="stage-meta"><span class="date">${fmtDate(state.showSource?s.original.end:s.end)}</span><span class="stage-state">${e(stageState(s))}</span></span>
  </button>`).join('')}</div>
  <div class="section-title"><h2>Примечания к расчёту</h2></div>
  <p class="small-note">Сроки этапов взяты из календарного плана «СВОяков» (${e(t.stages[0].sourcePage)} стр. и далее). Календарные дни считаются включительно. Исходный КПП не изменяется. Цветокоррекция и сведение звука планируются параллельно созданию мастера. Сдачи на согласование и отсутствие подтверждённых фактов показаны отдельно.</p>`;
}
function renderCalendar(){
  const cursor=state.calendarDate;const d=new Date(cursor+'T12:00:00Z');const yr=d.getUTCFullYear(),mo=d.getUTCMonth();
  const first=new Date(Date.UTC(yr,mo,1,12));const shift=(first.getUTCDay()+6)%7;
  const monthName=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}).format(first);
  const cells=[];
  const daysIndex={};
  for(const template of state.kpp.episodes){
    const data=rec(template.number);
    if(data.actualShoot){
      const calc=calculateSchedule(template,data);
      for(const s of calc.stages){
        (daysIndex[s.end]??=[]).push({episode:template.number,stage:s});
      }
      (daysIndex[data.actualShoot]??=[]).push({episode:template.number,shoot:true});
    }else{(daysIndex[template.shootPlanned]??=[]).push({episode:template.number,unconfirmedShoot:true});}
  }
  for(let i=0;i<42;i++){
    const date=new Date(Date.UTC(yr,mo,1-shift+i,12)).toISOString().slice(0,10),dayNumber=Number(date.slice(8));
    const items=daysIndex[date]||[];
    cells.push(`<button type="button" class="calday ${date.slice(0,7)!==cursor.slice(0,7)?'outside':''} ${date===state.pickedDate?'selected':''} ${date===isoToday()?'today':''}" data-action="select-date" data-date="${date}"><span class="day-number">${dayNumber}</span><div class="cal-dots">${items.slice(0,7).map(x=>`<i class="${x.unconfirmedShoot?'warn':x.shoot?'':'critical'}"></i>`).join('')}</div></button>`);
  }
  const picked=daysIndex[state.pickedDate]||[];
  return `${header('Календарь','Дедлайны по КПП и фактические съёмки. Точки — этапы и события.',`<button class="btn" data-action="calendar-today">Сегодня</button>`)}
    <div class="panel"><div class="calendar-header"><div class="month">${e(monthName)}</div><div class="month-controls"><button data-action="prev-month">‹</button><button data-action="next-month">›</button></div></div>
      <div class="calendar-grid">${['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=>`<div class="weekday">${x}</div>`).join('')}${cells.join('')}</div>
      <div class="legend" style="margin-top:18px"><span><i style="background:#7eaaff"></i>Фактическая съёмка</span><span><i style="background:#ffbe74"></i>План съёмки</span><span><i style="background:#ff818d"></i>Срок этапа</span></div>
    </div>
    <div class="calendar-details"><div class="section-title"><h2>${fmtDate(state.pickedDate,true)}</h2>${chip(`${picked.length} событий`)}</div><div class="task-list">${picked.length?picked.map(x=>{
      const label=x.shoot?'Фактическая съёмка':x.unconfirmedShoot?'Плановая съёмка (не подтверждена)':x.stage.name;
      return `<button class="task" style="color:var(--text);text-align:left;width:100%" data-action="open-episode" data-episode="${x.episode}"><div class="task-marker">${x.shoot?'▣':x.unconfirmedShoot?'◷':taskIcon(x.stage.group)}</div><div class="task-info"><div class="task-name">Выпуск ${niceN(x.episode)} · ${e(label)}</div><div class="task-secondary">${x.stage?`${e(stageState(x.stage))}`:'По календарю съёмок'}</div></div><span class="arrow">›</span></button>`;
    }).join(''):'<div class="empty">На эту дату в календаре событий нет</div>'}</div></div>`;
}
function renderAgenda(){
  const date=isoToday(),a=buildAgenda(state.kpp,state.records,date),scope=state.agendaFilter;
  const groups={today:a.today,tomorrow:a.tomorrow,overdue:a.overdue,next7:a.next7,all:a.tasks};
  const current=groups[scope]||a.today;
  return `${header('Задачи и сроки',`Сводка на ${fmtDate(date,true)} · по всем фактически отснятым выпускам`,`<button class="btn btn-soft" data-action="copy-digest">⧉ В Telegram</button><button class="btn btn-soft" data-action="export-ics">▤ В календарь</button>`)}
  <div class="filters"><div class="segmented">${[['today','Сегодня'],['tomorrow','Завтра'],['overdue','Просрочено'],['next7','7 дней'],['all','Все']].map(([k,v])=>`<button data-action="agenda-filter" data-filter="${k}" class="${scope===k?'active':''}">${v}</button>`).join('')}</div></div>
  <div class="panel"><div class="panel-header"><h3>${({today:'Сдать сегодня',tomorrow:'Сдать завтра',overdue:'Требуют внимания',next7:'Ближайшие 7 дней',all:'Все этапы в сводке'})[scope]}</h3>${chip(`${current.length} задач`,scope==='overdue'?'danger':'blue')}</div><div class="task-list">${current.map(t=>`<button data-action="open-episode" data-episode="${t.episode}" style="padding:0;border:0;background:none;text-align:initial;color:inherit">${taskRow(t)}</button>`).join('')||'<div class="empty">Нет задач для выбранного периода</div>'}</div></div>
  <div class="section-title"><h2>Ожидаем материалы</h2>${chip(`${a.waiting.length}`)}</div>
  <div class="panel"><div class="task-list">${a.waiting.map(x=>`<button class="quick-link" data-action="open-episode" data-episode="${x.episode}"><div><strong>Выпуск ${niceN(x.episode)} · ${e(x.name)}</strong><small>${e(x.detail)}</small></div><span class="arrow">›</span></button>`).join('')||'<div class="empty">Неуточнённых входящих материалов нет</div>'}</div></div>
  <p class="small-note">Просрочка не считается виной исполнителя, если необходимые входящие материалы не были подтверждены. Чтобы уточнить статус, откройте выпуск и заполните фактические даты.</p>`;
}
async function renderSettings(){
  const lastSync=await setting('lastSync');const username=await setting('lastUser');
  document.querySelector('#view').innerHTML=`${header('Настройки','Офлайн-работа, серверная синхронизация и уведомления')}
    <div class="settings-grid">
      <div class="panel"><div class="panel-header"><h3>Подключение к общей базе</h3>${chip(state.connection?'Сервер доступен':'Без связи',state.connection?'success':'warning')}</div>
      ${STATIC_MODE ? `<p class="small-note">Это автономная версия на GitHub Pages. Данные и факты сохраняются только в этом iPhone (IndexedDB). GitHub Pages не содержит серверной базы — изменения других телефонов автоматически не загружаются.</p><p class="notice-card">Не очищайте данные Safari без резервной копии. Используйте экспорт JSON ниже.</p><div class="actions"><button class="btn btn-primary" data-action="export-backup">↓ Резервная копия</button></div>` : signedIn()?`<p class="small-note">Аккаунт ${e(username||'пользователь')} подключён. Все новые изменения сохраняются на iPhone и передаются на сервер при появлении сети.</p><p class="small-note">Последняя синхронизация: ${e(lastSync?new Date(lastSync).toLocaleString('ru-RU'):'ещё не было')}</p><p>${chip(`${state.pending} несинхронизированных`)}</p><div class="actions"><button class="btn btn-primary" data-action="sync">↻ Обновить базу</button><button class="btn" data-action="logout">Выйти</button></div>`:
      `<p class="small-note">Введите только имя. Никаких писем, паролей и кодов подтверждения.</p><form id="login-form" class="form-grid"><div class="field"><label>Ваше имя</label><input name="username" type="text" autocomplete="name" maxlength="80" minlength="2" placeholder="Например, Михаил" value="${e(username||'')}" required /></div><button class="btn btn-primary wide" type="submit">Войти</button></form><p class="small-note">${inviteAvailable()?'Приглашение обнаружено. После входа данные команды будут доступны на этом iPhone.':'Перейдите по ссылке-приглашению, чтобы войти без пароля. Для установки на iPhone используется такое же приглашение автоматически.'} Имя не подтверждает личность: любой обладатель приглашения может указать чужое имя.</p>`}
      </div>
      <div class="panel"><div class="panel-header"><h3>Уведомления на iPhone</h3></div><p class="small-note">Ежедневную сводку можно прочитать в приложении без связи. ${STATIC_MODE?'В этой версии push не подключён: для них необходим отдельный сервер.':'Для push на закрытом iPhone нужен сервер, интернет и разрешение уведомлений.'} Отдельно можно выгрузить ближайшие сроки в календарь iPhone — это разовый снимок, который не обновляется сам.</p><div class="actions">${STATIC_MODE?'':`<button class="btn btn-primary" data-action="enable-push">◉ Включить push</button>`}<button class="btn" data-action="export-ics">▤ Экспорт .ics (45 дней)</button></div><div class="notice-card" style="margin-top:15px">Установи PWA из Safari: «Поделиться» → «На экран Домой». После установки открой приложение с иконки и включи push.</div></div>
      <div class="panel"><div class="panel-header"><h3>Автономная работа</h3>${chip(state.offlineReady?'Офлайн-пакет сохранён':'Проверить кэш',state.offlineReady?'success':'warning')}</div><p class="small-note">Сроки, введённые даты и статусы хранятся на устройстве. Интерфейс и КПП кэшируются при первом онлайн-запуске. ${STATIC_MODE?'Синхронизация между устройствами без серверной базы недоступна.':'При возвращении связи приложение автоматически синхронизирует очередь.'}</p><p class="small-note">iOS может удалить кэш или локальные данные при нехватке памяти. Не используйте офлайн-хранилище как единственную резервную копию.</p><div class="actions"><button class="btn" data-action="verify-offline">◉ Проверить офлайн-пакет</button><button class="btn" data-action="export-backup">↓ Сохранить резервную копию</button><button class="btn" data-action="import-backup">↑ Восстановить</button></div></div>
      <div class="panel"><div class="panel-header"><h3>Исходный КПП</h3></div><p class="small-note">20 выпусков · 360 этапов. Исходные даты не изменяются, прогноз пересчитывается от подтверждённых фактов.</p><div class="codeblock">Источник: Свояки_Календарный_план.pdf<br/>Граница периода входит в длительность.<br/>Часовой пояс сводки: Москва.</div><p class="small-note">Общая база Supabase (PostgreSQL) требует отдельного резервного копирования.</p></div>
    </div><input type="file" id="backup-picker" accept="application/json,.json" style="display:none"/>`;
  document.querySelector('#login-form')?.addEventListener('submit',async event=>{
    event.preventDefault();const fd=new FormData(event.target);
    try{await login(String(fd.get('username')));toast('Подключено к общей базе');await trySync();render();}catch(err){toast('Не удалось войти: '+err.message);}
  });
  document.querySelector('#backup-picker')?.addEventListener('change',importBackup);
}
function render(){
  updateNav();const view=document.querySelector('#view');
  const content={dashboard:renderDashboard,episodes:renderEpisodes,episode:renderEpisode,calendar:renderCalendar,agenda:renderAgenda};
  if(state.page==='settings'){renderSettings();return;}
  view.innerHTML=(content[state.page]||renderDashboard)();
  document.querySelector('#episode-search')?.addEventListener('input',evt=>{state.search=evt.target.value;const cursor=evt.target.selectionStart;render();const input=document.querySelector('#episode-search');input?.focus();input?.setSelectionRange(cursor,cursor);});
}
function showModal(title,subtitle,body,saveLabel='Сохранить'){
  const modal=document.querySelector('#modal-root');
  modal.innerHTML=`<div class="modal-cover" id="modal-cover"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-heading"><div><h3 id="modal-title">${e(title)}</h3><p>${e(subtitle)}</p></div><button class="circle-btn" data-action="close-modal" title="Закрыть">×</button></div><form id="modal-form">${body}<div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Отмена</button><button type="submit" class="btn btn-primary">${e(saveLabel)}</button></div></form></div></div>`;
  modal.querySelector('#modal-cover').addEventListener('click',evt=>{if(evt.target.id==='modal-cover')closeModal();});
}
function closeModal(){document.querySelector('#modal-root').innerHTML='';}
function field(name,label,val='',type='text',help=''){
  return `<div class="field"><label for="f-${e(name)}">${e(label)}</label><input id="f-${e(name)}" name="${e(name)}" type="${e(type)}" value="${e(val||'')}" />${help?`<small class="text-muted">${e(help)}</small>`:''}</div>`;
}
function modalEpisode(n){
  const template=currentKppEpisode(n),data=rec(n);
  showModal(`Выпуск ${niceN(n)}`,`Исходный КПП: съёмка ${fmtDate(template.shootPlanned,true)}. Заполняйте только фактически известные даты.`,
    `<div class="form-grid">${field('guest','Гость / название',data.guest||'')}${field('actualShoot','Фактическая дата съёмки',data.actualShoot,'date')}${field('materialsReceived','Материалы переданы монтажёру',data.materialsReceived,'date')}${field('transcriptSent','Расшифровка отправлена',data.transcriptSent,'date')}${field('planReceived','Монтажный план / сценарий получен',data.planReceived,'date')}<div class="field wide"><label>Комментарий</label><textarea name="notes">${e(data.notes||'')}</textarea></div></div>`);
  document.querySelector('#modal-form').addEventListener('submit',async evt=>{
    evt.preventDefault();const form=new FormData(evt.target);const next={...data,number:n,guest:String(form.get('guest')).trim(),actualShoot:String(form.get('actualShoot')),materialsReceived:String(form.get('materialsReceived')),transcriptSent:String(form.get('transcriptSent')),planReceived:String(form.get('planReceived')),notes:String(form.get('notes')),stageFacts:data.stageFacts||{}};
    await saveLocal(epId(n),next);await refreshRecords();closeModal();toast('Сохранено на iPhone. Синхронизируем при наличии связи.');state.page='episode';state.selected=n;render();if(state.connection&&signedIn())trySync();
  });
}
function modalAddEpisode(){
  const options=state.kpp.episodes.map(t=>`<option value="${t.number}">${t.season} сезон · выпуск ${niceN(t.seasonEpisode)} ${rec(t.number).actualShoot?'(уже внесён)':''}</option>`).join('');
  showModal('Добавить фактическую съёмку','Выберите выпуск по КПП и заполните известные данные.',`<div class="form-grid"><div class="field wide"><label>Выпуск</label><select name="episode">${options}</select></div>${field('actualShoot','Дата съёмки','','date')}${field('guest','Гость / название','')}<div class="field wide"><label>Комментарий</label><textarea name="notes" placeholder="При необходимости"></textarea></div></div>`,'Добавить');
  document.querySelector('#modal-form').addEventListener('submit',async evt=>{
    evt.preventDefault();const f=new FormData(evt.target),n=Number(f.get('episode')),d=rec(n);
    if(!f.get('actualShoot')){toast('Укажите фактическую дату съёмки');return;}
    const next={...d,number:n,actualShoot:String(f.get('actualShoot')),guest:String(f.get('guest')).trim()||d.guest||'',notes:String(f.get('notes')).trim()||d.notes||'',stageFacts:d.stageFacts||{}};
    await saveLocal(epId(n),next);await refreshRecords();closeModal();state.page='episode';state.selected=n;render();toast('Фактическая съёмка сохранена');if(state.connection&&signedIn())trySync();
  });
}
function modalStage(n,key){
  const template=currentKppEpisode(n),data=rec(n),stage=calculateSchedule(template,data).byKey[key],fact=(data.stageFacts||{})[key]||{};
  showModal(stage.name,`Этап ${stage.code} · КПП ${fmtDate(stage.original.start,true)} — ${fmtDate(stage.original.end,true)} · ${stage.days} календарных дней.`,
    `<div class="issue-banner" style="margin-top:0">Прогноз ${fmtDate(stage.start,true)} — ${fmtDate(stage.end,true)}. Дату выполнения вводите только после реальной сдачи. Пустая дата означает, что факт неизвестен.</div><div class="form-grid">
    <div class="field wide"><label>Статус</label><select name="status">${[['planned','Не подтверждено'],['waiting','Ожидаем'],['in_progress','В работе'],['approval','На согласовании'],['changes','Нужны правки'],['blocked','Заблокировано'],['done','Выполнено']].map(([k,v])=>`<option value="${k}" ${stage.status===k?'selected':''}>${v}</option>`).join('')}</select></div>
    ${field('actualStart','Фактическое начало',fact.actualStart||'','date')}${field('actualEnd','Фактическая дата завершения',fact.actualEnd||'','date')}${field('owner','Ответственный',fact.owner||'')}
    <div class="field wide"><label>Комментарии / причина задержки</label><textarea name="note">${e(fact.note||'')}</textarea></div></div>`);
  document.querySelector('#modal-form').addEventListener('submit',async evt=>{
    evt.preventDefault();const f=new FormData(evt.target),status=String(f.get('status')),end=String(f.get('actualEnd'));
    if(status==='done'&&!end&&!['2','3'].includes(key)){toast('Для выполненного этапа укажите дату сдачи');return;}
    const next={...data,number:n,stageFacts:{...(data.stageFacts||{}),[key]:{status,actualStart:String(f.get('actualStart')),actualEnd:end,owner:String(f.get('owner')),note:String(f.get('note'))}}};
    await saveLocal(epId(n),next);await refreshRecords();closeModal();render();toast('Этап сохранён');if(state.connection&&signedIn())trySync();
  });
}
async function exportIcs(){
  const {ics,count}=createIcs(state.kpp,state.records,isoToday(),45);
  if(!count){toast('Нет подтверждённых доступных дедлайнов на ближайшие 45 дней');return;}
  const blob=new Blob([ics],{type:'text/calendar;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`svoyaki-calendar-${isoToday()}.ics`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
  toast(`Экспортировано ${count} сроков. Импортируйте файл в календарь iPhone; изменения не обновляются автоматически.`);
}
async function exportBackup(){
  const blob=new Blob([JSON.stringify({format:'svoyaki-offline-backup-v1',savedAt:new Date().toISOString(),records:await readAll('records')},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`svoyaki-backup-${isoToday()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Резервная копия готова');
}
async function importBackup(event){
  const file=event.target.files[0];if(!file)return;
  try{
    const body=JSON.parse(await file.text());if(body.format!=='svoyaki-offline-backup-v1'||!Array.isArray(body.records))throw Error('Некорректный формат резервной копии');
    for(const x of body.records){const n=Number((x.id||'').split(':')[1]);if(x.kind==='episode'&&n>=1&&n<=20&&x.data?.number===n)await saveLocal(x.id,x.data);}
    await refreshRecords();render();toast('Резервная копия импортирована. Данные ожидают синхронизации.');
  }catch(err){toast('Ошибка импорта: '+err.message);}
}
async function copyDigest(){
  const text=formatDigest(buildAgenda(state.kpp,state.records,isoToday()),isoToday());
  try{await navigator.clipboard.writeText(text);toast('Сводка скопирована — можно отправить в Telegram.');}
  catch{showModal('Сводка для Telegram','Выделите и скопируйте текст вручную.',`<div class="field"><textarea rows="13" readonly>${e(text)}</textarea></div>`,'Закрыть');document.querySelector('#modal-form').addEventListener('submit',evt=>{evt.preventDefault();closeModal();});}
}
async function handleConflict(conflicts){
  state.conflicts=conflicts;
  const c=conflicts[0];const local=state.records[c.id],server=c.server;
  showModal('Конфликт синхронизации',`На другом устройстве тоже изменили ${c.id}. Выберите версию — автоматического перезаписывания не будет.`,
    `<div class="notice-card"><strong>Локально:</strong> ${e(local?.data?.guest||'Без названия')}<br/>Съёмка: ${e(local?.data?.actualShoot||'не указана')}<br/>Монтажный план: ${e(local?.data?.planReceived||'не указан')}</div>
     <div class="notice-card" style="margin-top:10px"><strong>На сервере:</strong> ${e(server.data.guest||'Без названия')}<br/>Съёмка: ${e(server.data.actualShoot||'не указана')}<br/>Монтажный план: ${e(server.data.planReceived||'не указан')}</div>
     <div class="actions" style="margin-top:14px"><button class="btn" type="button" id="choose-local">Оставить мою версию</button><button class="btn" type="button" id="choose-remote">Взять с сервера</button></div>`,'Позже');
  document.querySelector('#choose-local').addEventListener('click',async()=>{
    await resolveConflict(c,'local');state.conflicts.shift();closeModal();toast('Локальная версия поставлена в очередь.');await trySync();
  });
  document.querySelector('#choose-remote').addEventListener('click',async()=>{
    await resolveConflict(c,'remote');state.conflicts.shift();closeModal();await refreshRecords();render();toast('Принята версия с сервера.');
  });
  document.querySelector('#modal-form').addEventListener('submit',evt=>{evt.preventDefault();closeModal();});
}
async function trySync(){
  if(!(await checkConnection())){state.connection=false;updateNav();return;}
  state.connection=true;
  if(!signedIn()){const s=await currentSession();if(!s.authenticated){updateNav();return;}}
  try{await syncNow(handleConflict);await refreshRecords();state.synced=true;render();}
  catch(err){state.synced=false;updateNav();if(!err.message.includes('Нужен вход'))console.debug('sync paused:',err.message);}
}
async function enablePush(){
  if(!state.connection||!signedIn()){toast('Для push сначала подключитесь к серверу');return;}
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){toast('Push недоступны в этом режиме. Установите приложение на экран «Домой» и откройте его с иконки.');return;}
  if(!window.matchMedia('(display-mode: standalone)').matches&&!navigator.standalone){toast('На iPhone сначала добавьте сайт на экран «Домой» через Safari.');return;}
  try{
    const cfg=await getPushConfig();if(!cfg.configured){toast('Сервер push ещё не настроен. Нужны VAPID-ключи.');return;}
    const permission=await Notification.requestPermission();if(permission!=='granted'){toast('Разрешение на уведомления не предоставлено.');return;}
    const sw=await navigator.serviceWorker.ready;
    const sub=await sw.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64ToBytes(cfg.publicKey)});
    await subscribePush(sub);toast(`Push включены. Сводка: ${cfg.hour}:00 по Москве.`);
  }catch(err){toast('Не удалось включить push: '+err.message);}
}
async function processAction(evt){
  const target=evt.target.closest('[data-action],[data-page]');if(!target)return;
  if(target.dataset.page){goto(target.dataset.page);return;}
  const action=target.dataset.action;
  switch(action){
    case 'add-episode':modalAddEpisode();break;
    case 'open-episode':goto('episode',target.dataset.episode);break;
    case 'edit-episode':modalEpisode(Number(target.dataset.episode));break;
    case 'edit-stage':modalStage(Number(target.dataset.episode),target.dataset.stage);break;
    case 'filter':state.filter=target.dataset.filter;render();break;
    case 'agenda-filter':state.agendaFilter=target.dataset.filter;render();break;
    case 'toggle-source':state.showSource=target.dataset.mode==='source';render();break;
    case 'prev-month':state.calendarDate=addMonths(state.calendarDate,-1);render();break;
    case 'next-month':state.calendarDate=addMonths(state.calendarDate,1);render();break;
    case 'calendar-today':state.calendarDate=isoToday();state.pickedDate=isoToday();render();break;
    case 'select-date':state.pickedDate=target.dataset.date;render();break;
    case 'copy-digest':await copyDigest();break;
    case 'close-modal':closeModal();break;
    case 'sync':if(STATIC_MODE){toast('Версия GitHub Pages работает локально. Сервер синхронизации не подключён.');break;}await trySync();toast(state.connection?'Сверка с общей базой завершена или ожидает входа':'Без соединения — данные в памяти iPhone');break;
    case 'logout':await logout();render();toast('Выход выполнен, офлайн-данные остались на устройстве.');break;
    case 'enable-push':if(STATIC_MODE){toast('Для push требуется отдельный сервер.');break;}await enablePush();break;
    case 'verify-offline':await verifyOffline(true);break;
    case 'export-ics':await exportIcs();break;
    case 'export-backup':await exportBackup();break;
    case 'import-backup':document.querySelector('#backup-picker')?.click();break;
  }
}
function addMonths(s,months){const [y,m]=s.slice(0,7).split('-').map(Number);const d=new Date(Date.UTC(y,m-1+months,1,12));return d.toISOString().slice(0,10);}
async function verifyOffline(showMessage=false){
  try{
    if(!('serviceWorker' in navigator)||!('caches' in window))throw Error('Кэш не поддерживается');
    await navigator.serviceWorker.ready;
    const names=await caches.keys();
    let ready=false;
    for(const name of names.filter(n=>n.startsWith('svoyaki-offline-'))){
      const cache=await caches.open(name);
      const found=await Promise.all(['./index.html','./app.js','./data/kpp.json'].map(x=>cache.match(new URL(x,appBase).href)));
      if(found.every(Boolean)){ready=true;break;}
    }
    state.offlineReady=ready;
    if(showMessage)toast(ready?'Офлайн-пакет сохранён. Можешь проверить работу без сети.':'Кэш ещё готовится. Открой приложение при наличии интернета.');
  }catch(err){state.offlineReady=false;if(showMessage)toast('Офлайн-пакет пока не готов: '+err.message);}
  if(state.page==='settings')render();
  return state.offlineReady;
}
async function bootstrap(){
  try{
    await openStorage();
    const response=await fetch('./data/kpp.json',{cache:'force-cache'});
    if(!response.ok)throw Error('Не загружен календарный план');
    state.kpp=await response.json();
    if(state.kpp.episodes.length!==20)throw Error('Не найдено 20 выпусков');
    await refreshRecords();
    // Initial confirmed fact is a local read-only snapshot, NOT a pending
    // mutation. It uses the same version as the server-side initial record.
    if(!Object.keys(state.records).length){
      const seeded=await fetch('./data/seed.json',{cache:'force-cache'});
      if(seeded.ok){
        const first=await seeded.json();
        await writeOne('records',{...first,version:1,stamp:'seed',updatedAt:''});
        await refreshRecords();
      }
    }
    document.addEventListener('click',processAction);
    if(STATIC_MODE) document.querySelector('#sync-button').style.display='none';
    document.querySelector('#sync-button').addEventListener('click',()=>processAction({target:{closest:()=>({dataset:{action:'sync'}})}}));
    state.connection=STATIC_MODE ? false : await checkConnection();
    if(state.connection)await currentSession();
    if(!signedIn() && inviteAvailable())state.page='settings';
    if(window.location.search.includes('view=today'))state.page='agenda';
    render();
    if('serviceWorker' in navigator){navigator.serviceWorker.register('./service-worker.js',{scope:'./'}).then(()=>verifyOffline()).catch(err=>console.warn('SW register:',err));}
    if(state.connection&&signedIn())trySync();
    window.addEventListener('online',()=>{if(STATIC_MODE)return;state.connection=true;updateNav();trySync();});
    window.addEventListener('offline',()=>{state.connection=false;updateNav();});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!STATIC_MODE)trySync();});
    setInterval(()=>{if(!document.hidden&&!STATIC_MODE)trySync();},30000);
  }catch(err){console.error(err);document.querySelector('#view').innerHTML=`<div class="panel"><h2>Не удалось открыть календарь</h2><p>${e(err.message)}</p><p>Нужно один раз открыть приложение в интернете, чтобы все файлы попали в офлайн-кэш.</p></div>`;}
}
bootstrap();