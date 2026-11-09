import {calendarFor,defaultEditors,editorKey,forecast,normalizeEditorName,progressFor,releaseEditor,resolveShoots,statuses,today,validEditorName} from './schedule.mjs';

const main = document.querySelector('#main');
const nav = document.querySelector('#nav');
const dialog = document.querySelector('#dialog');
const syncBadge = document.querySelector('#sync');
const toast = document.querySelector('#toast');
const sanitize = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const fmt = value => value ? value.split('-').reverse().join('.') : '—';
const state = {data:null, pending:[], page:'home', selected:null, search:'', filter:'all', season:1, online:false, last:'', busy:false, team:[]};
let notification;
let viewNeedsRefresh=false;
const onPages = location.origin === 'https://czbjcp2yqw-dot.github.io';
const apiRoot = onPages ? 'https://svoyaki-postproduction.v7gfckmnr2.chatgpt.site/api/' : '/api/';
const keyFromHash = hash => hash.match(/^#team=([a-f0-9]{64})$/)?.[1] || '';
let accessKey = onPages ? keyFromHash(location.hash) : '';
let teamSession = '';
const day = () => today();
function notify(message) {
  toast.textContent = message;
  clearTimeout(notification);
  notification = setTimeout(() => {toast.textContent = '';}, 4500);
}
const database = new Promise((resolve,reject) => {
  const req = indexedDB.open('svoyaki-new-v1',1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function disk(mode, run) {
  const db = await database;
  return new Promise((resolve,reject) => {
    const tx = db.transaction('kv',mode);
    const req = run(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
const get = key => disk('readonly', store => store.get(key));
const put = (key,value) => disk('readwrite', store => store.put(value,key));
const remove = key => disk('readwrite', store => store.delete(key));
const changeList = () => disk('readonly',store => store.getAll(IDBKeyRange.bound('op:','op;')));
function savedOrQueued(field) {
  return state.pending.findLast(op=>op.field===field && (!op.error || !/\/(create|number)$/.test(field)))?.value ?? state.data.fields[field]?.value;
}
const read = field => savedOrQueued(field) ?? '';
const shoots = () => resolveShoots(state.data.episodes,state.data.shoots,savedOrQueued);
const planFor = number => state.data.episodes.find(episode => episode.number === number);
const episodeNumber = number => (number-1)%10+1;
const seasonLabel = season => season===1 ? 'Сезон 1 · 2026' : 'Сезон 2 · с февраля 2027';
const seasonPicker = () => `<div class="season-picker" role="group" aria-label="Сезон">${[1,2].map(season=>
  `<button data-season="${season}" aria-pressed="${state.season===season}"><strong>${seasonLabel(season)}</strong><small>10 выпусков</small></button>`).join('')}</div>`;
const newButton = number => manager() ? `<button class="primary" data-action="add-release"${number ? ` data-number="${number}"` : ''}>＋ Добавить выпуск</button>` : '';
const compute = (episode,shoot) => forecast(episode,shoot,read);
const editingStages = new Set(['fish','fishFix','premaster','preFix','iriFix','master','finalFix']);
const assignedEditor = (episode,shoot) => releaseEditor(episode,shoot,savedOrQueued);
const editorName = key => defaultEditors[key] || savedOrQueued(key) || 'Не назначен';
const editorLabel = (episode,shoot) => editorName(assignedEditor(episode,shoot));
const stageOwner = (item,episode,shoot) => item.owner || (editingStages.has(item.key) && assignedEditor(episode,shoot) ? editorLabel(episode,shoot) : '');
const editorField = (episode,shoot) => shoot ? `shoot/${shoot.id}/editor` : `release/${episode.number}/editor`;
const manager = () => state.data.member.role !== 'member';
const pill = value => `<span class="pill">${sanitize(value)}</span>`;
const title = (overline,heading,desc) => `<div class="eyebrow">${sanitize(overline)}</div><h1>${sanitize(heading)}</h1><p class="muted tagline">${sanitize(desc)}</p>`;
const validLink = value => {try {return new URL(value).protocol === 'https:';}catch{return false;}};
const external = (value,label) => validLink(value) ? `<a href="${sanitize(value)}" target="_blank" rel="noopener noreferrer">${sanitize(label)}</a>` : '';

async function api(path,body) {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type','application/json');
  if (teamSession) headers.set('X-Svoyaki-Session',teamSession);
  const response = await fetch(apiRoot+path,{
    method:body === undefined ? 'GET' : 'POST', cache:'no-store',
    headers, credentials:onPages?'omit':'same-origin', redirect:'error',
    body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(9000),
  });
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    const status = response.ok ? 401 : response.status;
    throw Object.assign(new Error('Не удалось открыть рабочее пространство.'),{status});
  }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Ошибка сервера'),{status:response.status,data});
  return data;
}
async function loadTeam() {
  try {state.team = await api('team'); render();}
  catch (error) {notify(error.message);}
}
function syncLabel() {
  const conflicts = state.pending.filter(op => op.error).length;
  syncBadge.textContent = conflicts ? `Требуется сверка · ${conflicts}` :
    state.pending.length ? `Ждёт отправки · ${state.pending.length}` :
    state.data ? state.online ? 'Синхронизировано' : 'Офлайн' : '';
}
async function synchronize() {
  if (state.busy || !navigator.onLine || (onPages && !teamSession)) {syncLabel();return;}
  state.busy = true;
  const viewState = () => JSON.stringify([state.data?.member,state.data?.fields,state.data?.history,state.pending]);
  const before = viewState();
  try {
    const remote = await api('state');
    if (state.data && remote.member.id !== state.data.member.id) {
      await disk('readwrite',store=>store.delete(IDBKeyRange.bound('op:','op;')));
      state.pending = [];
    }
    state.data = remote;
    state.online = true;
    const waiting = (await changeList()).filter(op => op.member === remote.member.id).sort((a,b)=>a.order-b.order);
    for (const op of waiting) {
      if (op.error || waiting.some(earlier => earlier.field === op.field && earlier.order < op.order && earlier.error)) continue;
      try {
        const saved = await api('change',op);
        state.data.fields[op.field] = saved;
        await remove('op:'+op.id);
      } catch (error) {
        if (![400,403,409,422].includes(error.status)) throw error;
        op.error = error.message;
        op.server = error.data;
        await put('op:'+op.id,op);
      }
    }
    state.pending = (await changeList()).filter(op => op.member === remote.member.id).sort((a,b)=>a.order-b.order);
    await put('snapshot',state.data);
    state.last = new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  } catch (error) {
    state.online = false;
    if (error.status === 401) {
      if (onPages && teamSession) {
        teamSession = '';
        await remove('team-session');
        viewNeedsRefresh = true;
      }
      state.data = null;
      state.pending = [];
      await remove('snapshot');
    }
  } finally {
    state.busy = false;
    syncLabel();
    viewNeedsRefresh ||= before !== viewState();
    if (viewNeedsRefresh && !dialog.open && !document.activeElement?.matches('input,textarea,select')) render();
  }
}
async function change(entries) {
  for (const [field,value] of entries) {
    const previousValue=savedOrQueued(field);
    if (value===previousValue || (value==='' && previousValue==null && !field.endsWith('/editor'))) continue;
    const previous = state.pending.findLast(item => item.field === field);
    const op = {id:crypto.randomUUID(),field,value,version:previous ? previous.version+1 : state.data.fields[field]?.version || 0,
      order:Math.max(Date.now(),(state.pending.at(-1)?.order || 0)+1),member:state.data.member.id};
    await put('op:'+op.id,op);
    state.pending.push(op);
  }
  render();
  synchronize();
}
function login() {
  nav.hidden = true;
  if (onPages) {
    main.innerHTML = `<section class="panel narrow">${title('РАБОЧЕЕ ПРОСТРАНСТВО','СВОяки','Введите своё имя, чтобы команда видела автора изменений.')}
      <form class="fields" id="team-login"><label>Имя<input name="memberName" autocomplete="name" maxlength="70" required></label>
      ${accessKey?'':'<label>Ссылка команды<input name="teamLink" type="url" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>'}
      <button type="submit" class="primary">Войти</button></form></section>`;
    const form = document.querySelector('#team-login');
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const input = form.elements;
      let key = accessKey;
      if (!key) {
        try {
          const link = new URL(input.teamLink.value);
          if (link.origin===location.origin && link.pathname===new URL('./',location.href).pathname) key = keyFromHash(link.hash);
        } catch {}
      }
      if (!key) return notify('Вставьте рабочую ссылку, полученную от команды.');
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const result = await api('team-access',{key,name:input.memberName.value});
        await put('team-session',result.token);
        teamSession = result.token;
        history.replaceState(null,'',location.pathname+location.search);
        input.memberName.blur();
        input.teamLink?.blur();
        await synchronize();
        if (!state.data) notify('Не удалось загрузить выпуски. Попробуйте снова.');
      } catch (error) {notify(error.message);}
      finally {button.disabled = false;}
    });
    return;
  }
  main.innerHTML = `<section class="panel narrow">${title('РАБОЧЕЕ ПРОСТРАНСТВО','СВОяки','Войдите в разрешённый аккаунт ChatGPT.')}
    <a href="/signin-with-chatgpt?return_to=%2F" target="_top">Войти через ChatGPT</a></section>`;
}
function card(shoot,episode) {
  const number = shoot?.number || episode?.number;
  const progress = shoot && episode ? progressFor(compute(episode,shoot).items) : null;
  return `<button class="card" data-card="${shoot?.id || 'p'+number}">${pill(number ? `СЕЗОН ${episode.season} · №${episodeNumber(number)}` : 'НУЖНО СВЯЗАТЬ С КПП')}
    <h3>${sanitize(shoot?.guest || 'Выпуск №'+episodeNumber(number))}</h3><span class="muted">${shoot ? (shoot.shot?'Снято ':'Съёмка запланирована ')+fmt(shoot.date) : 'Съёмка по КПП '+fmt(episode.stages[0].start)}</span>
    <span class="muted card-editor">Монтажёр: ${sanitize(editorLabel(episode,shoot))}</span>
    ${progress == null ? '' : `<p class="muted">${progress.percent}% · ${progress.closed} из ${progress.total} этапов</p>`}</button>`;
}
function overview() {
  const shots = shoots();
  const tasks = shots.filter(shoot=>shoot.number && shoot.shot).flatMap(shoot => {
    const next = compute(planFor(shoot.number),shoot).items.find(item=>!['done','skipped'].includes(item.status));
    return next ? [{...next,shoot}] : [];
  });
  const due = task => task.pinned || task.end;
  const now = day();
  const overdue = tasks.filter(task=>due(task)<now && !task.waiting && task.status!=='waiting');
  const upcoming = tasks.filter(task=>due(task)>=now && !task.waiting && task.status!=='waiting');
  const waiting = tasks.filter(task=>task.waiting || ['waiting','review'].includes(task.status));
  const taskCards = items => items.length ? items.map(task=>`<button class="card" data-card="${task.shoot.id}"><b>${sanitize(task.label)}</b><small>${sanitize(task.shoot.guest)} · ${fmt(due(task))}</small></button>`).join('') : '<p class="muted">Пока пусто</p>';
  return title('ПРОИЗВОДСТВО · 2026/2027','СВОяки','Съёмки, монтаж, согласование и сдача выпусков.')+
    `<div class="grid"><div class="card stat"><small>Фактические съёмки</small><strong>${shots.filter(s=>s.shot).length}</strong></div><div class="card stat"><small>Выпуски в КПП</small><strong>${state.data.episodes.length}</strong></div><div class="card stat"><small>Нужно подтвердить номер</small><strong>${shots.filter(s=>!s.number).length}</strong></div></div>
    <h2>Сегодня</h2><div class="grid">${taskCards(upcoming.filter(task=>due(task)===now))}</div>
    <h2>Просрочено</h2><div class="grid">${taskCards(overdue)}</div><h2>Ближайшие 7 дней</h2><div class="grid">${taskCards(upcoming.filter(task=>due(task)>now && (Date.parse(due(task))-Date.parse(now))/86400000<=7))}</div>
    <h2>Ожидаем материалы или согласование</h2><div class="grid">${taskCards(waiting)}</div><h2>Отснятые выпуски</h2><div class="grid">${shots.filter(s=>s.shot).map(shoot=>card(shoot,planFor(shoot.number))).join('')}</div>`;
}
function list() {
  const shots = shoots();
  const q = state.search.toLowerCase().trim();
  const match = (shoot,episode) => `${shoot?.guest || ''} ${episode ? episodeNumber(episode.number) : ''} ${shoot?.date || ''}`.toLowerCase().includes(q);
  const seasonEpisodes = state.data.episodes.filter(episode=>episode.season===state.season);
  const registered = shots.filter(shoot=>seasonEpisodes.some(e=>e.number===shoot.number))
    .filter(shoot=>match(shoot,planFor(shoot.number)) && (state.filter!=='actual' || shoot.shot));
  const unlinked = shots.filter(shoot=>!shoot.number && match(shoot,null));
  const plans = seasonEpisodes.filter(e=>!shots.some(s=>s.number===e.number) && match(null,e));
  return title('КАТАЛОГ','Выпуски','В каждом сезоне по 10 выпусков. Выберите выпуск, чтобы открыть его этапы.')+
    seasonPicker()+
    `<div class="split release-toolbar"><div class="row"><input class="search" id="search" aria-label="Поиск" placeholder="Имя, номер или дата" value="${sanitize(state.search)}"><select class="search" id="filter" aria-label="Фильтр">${Object.entries({all:'Все',actual:'Отсняты',unlinked:'Нужно связать',plan:'По КПП'}).map(([value,label])=>`<option value="${value}" ${state.filter===value?'selected':''}>${label}</option>`).join('')}</select></div>${newButton()}</div>
    ${['all','actual'].includes(state.filter)?`<h2>Добавленные выпуски</h2><div class="grid">${registered.map(s=>card(s,planFor(s.number))).join('') || '<p class="muted">Пока пусто</p>'}</div>`:''}
    ${['all','plan'].includes(state.filter)?`<h2>Плановые выпуски КПП</h2><div class="grid">${plans.map(e=>card(null,e)).join('') || '<p class="muted">Нет совпадений</p>'}</div>`:''}
    ${['all','unlinked'].includes(state.filter) && unlinked.length?`<h2>Съёмки без номера</h2><div class="grid">${unlinked.map(s=>card(s,null)).join('')}</div>`:''}`;
}
function graph() {
  const shots = shoots();
  const episodes = state.data.episodes.filter(e=>e.season===state.season);
  const rows = episodes.map(episode=>{
    const shoot = shots.find(item=>item.number===episode.number);
    const {percent,closed,total,current} = progressFor(compute(episode,shoot).items);
    const number = episodeNumber(episode.number);
    const label = shoot?.guest || `Выпуск №${number}`;
    const stage = current ? `${current.label} · ${statuses[current.status]}` : 'Все этапы закрыты';
    return `<button class="graph-row" data-card="${shoot?.id || 'p'+episode.number}">
      <span class="graph-heading"><span><small>ВЫПУСК ${String(number).padStart(2,'0')}</small><strong>${sanitize(label)}</strong></span><span class="graph-percent ${percent===100?'complete':''}">${percent}%</span></span>
      <progress class="${percent===100?'complete':''}" max="100" value="${percent}" aria-label="${sanitize(label)} · выполнено этапов"></progress>
      <span class="graph-caption"><span>${sanitize(stage)}</span><small>${closed} из ${total}</small></span>
    </button>`;
  }).join('');
  const unlinked = shots.filter(shoot=>!shoot.number);
  return title('ПРОГРЕСС ПРОИЗВОДСТВА','График','Выполненные этапы по каждому выпуску, от 0 до 100%. Нажмите на строку, чтобы открыть карточку.')+
    seasonPicker()+`<div class="graph-scale" aria-hidden="true"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
    <div class="graph-grid">${rows}</div>
    ${unlinked.length?`<h2>Съёмки без номера</h2><p class="muted">Прогресс появится после привязки к выпуску.</p><div class="grid">${unlinked.map(shoot=>card(shoot,null)).join('')}</div>`:''}`;
}
async function downloadCalendar(season) {
  notify('Готовлю календарный план…');
  const [snapshot,{renderCalendarPdf},{calendarFont}]=await Promise.all([
    api('state'),
    import('./calendar-pdf.mjs'),
    import('./calendar-font.mjs'),
  ]);
  const readSaved=field=>snapshot.fields[field]?.value;
  const shootsSaved=resolveShoots(snapshot.episodes,snapshot.shoots,readSaved);
  const plan=calendarFor(snapshot.episodes,shootsSaved,readSaved,season);
  const file=new Blob([renderCalendarPdf(plan,calendarFont)],{type:'application/pdf'});
  const href=URL.createObjectURL(file);
  const link=document.createElement('a');
  link.href=href;
  link.download=`svoyaki-kpp-${season ? 'season-'+season+'-' : ''}${today()}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(href),60000);
  notify('PDF готов.');
}
function calendar() {
  const {releases,unlinked}=calendarFor(state.data.episodes,shoots(),read,state.season);
  const stageDate=item=>item ? fmt(item.actual || item.pinned || item.end) : '—';
  const highlights=[['shoot','Съёмка'],['fish','Рыба'],['premaster','Предмастер'],['delivery','Сдача мастера']];
  return title('КПП · 2026/2027','Календарный план','Сроки по выпускам с учётом сохранённых дат, фактов и статусов.')+
    seasonPicker()+`<div class="calendar-download"><button data-action="calendar-pdf" data-season-download="${state.season}" class="download primary">Скачать PDF сезона ${state.season}</button><button data-action="calendar-pdf" class="download">Скачать оба сезона</button></div>
    <p class="muted">${state.pending.length?'Есть правки в очереди. В PDF попадут данные, которые уже сохранены на сервере.':'PDF формируется из сохранённых данных на момент скачивания.'}</p>
    <div class="grid">${releases.map(release=>{
      const label=release.shoot?.guest || 'Гость уточняется';
      const number=episodeNumber(release.number);
      return `<button class="card calendar-card" data-card="${release.shoot?.id || 'p'+release.number}">
        <span class="split">${pill('ВЫПУСК №'+number)}<small>${release.percent}%</small></span>
        <strong>${sanitize(label)}</strong>
        <span class="calendar-dates">${highlights.map(([key,name])=>`<span><small>${name}</small><span>${stageDate(release.items.find(item=>item.key===key))}</span></span>`).join('')}</span>
        <small>${sanitize(release.current?.label || 'Все этапы закрыты')}</small>
      </button>`;
    }).join('')}</div>
    ${unlinked.length?`<h2>Съёмки без номера</h2><div class="grid">${unlinked.map(shoot=>card(shoot,null)).join('')}</div>`:''}`;
}
function selection() {
  const shoot = shoots().find(s=>s.id===state.selected);
  return {shoot,episode:planFor(shoot ? shoot.number : Number(state.selected?.slice(1)))};
}
function detail() {
  const {shoot,episode} = selection();
  if (!shoot && !episode) return list();
  const calc = episode ? compute(episode,shoot) : null;
  const overline = episode ? `СЕЗОН ${episode.season} · ВЫПУСК №${episodeNumber(episode.number)}` : 'СЪЁМКА · НУЖНО СВЯЗАТЬ С КПП';
  return `<button data-page="episodes">← Выпуски</button><div class="actions">${title(overline,shoot?.guest || 'Выпуск №'+episodeNumber(episode.number),
    shoot ? `${shoot.shot?'Факт':'План'} съёмки ${fmt(shoot.date)}${episode ? ` · план ${fmt(episode.stages[0].start)} · сдвиг ${calc.shift>0?'+':''}${calc.shift} дн.` : ''}` : `План съёмки ${fmt(episode.stages[0].start)}`)}</div>
    <div class="panel editor-panel"><div class="split"><div><small>Монтажёр выпуска</small><div><strong>${sanitize(editorLabel(episode,shoot))}</strong></div></div>${manager()?'<button data-action="editor">Изменить монтажёра</button>':''}</div></div>
    ${shoot ? `<div class="panel"><div class="split"><div><h3>Материалы и входящие</h3><p class="muted">Монтажный план ${fmt(shoot.plan)} · расшифровка ${fmt(shoot.transcript)}</p>${external(shoot.link,'Открыть папку материалов') || '<small>Ссылка на папку пока не добавлена</small>'}</div><button data-action="shoot">Изменить</button></div></div>` : ''}
    ${!shoot && episode ? `<div class="actions">${newButton(episode.number)}</div>` : ''}
    ${!episode ? `<div class="notice">Календарь появится после подтверждения номера выпуска.</div>${manager()?'<button class="primary" data-action="bind">Связать с КПП</button>':''}` :
    `<h2>Этапы производства</h2><div class="stack">${calc.items.map(item=>{
      const locked = item.key==='shoot' || !shoot;
      const done = item.status==='done';
      return `<div class="stage ${done?'done':''}">
        ${locked?'':`<button class="check" aria-label="${done?'Снять отметку':'Отметить готовым'}" data-check="${item.key}">${done?'✓':'□'}</button>`}
        <button data-stage="${item.key}" ${locked?'disabled':''}><strong>${sanitize(item.label)} · ${sanitize(statuses[item.status])}</strong>
        <small>КПП ${fmt(item.originalStart)}–${fmt(item.originalEnd)} · прогноз ${fmt(item.start)}–${fmt(item.end)} · факт ${fmt(item.actual)}</small>
        ${item.pinned?`<small>Закреплённый срок ${fmt(item.pinned)}</small>`:''}
        ${item.waiting?'<small>Ожидается монтажный план. Прогноз предварительный.</small>':''}
        ${item.conflict?'<small class="danger">Прогноз позже закреплённого срока.</small>':''}
        ${item.sourceIssue?'<small>Исходное окно и длительность требуют сверки.</small>':''}
        ${stageOwner(item,episode,shoot)?`<small>Ответственный: ${sanitize(stageOwner(item,episode,shoot))}</small>`:''}</button></div>`;
    }).join('')}</div>`}`;
}
function settings() {
  const role = state.data.member.role;
  return title('ДОСТУП И IPHONE','Команда',`Вы вошли как ${state.data.member.name}.`)+
    `<div class="panel"><h3>Установить на iPhone</h3><p>Откройте приложение в Safari. Нажмите «Поделиться», выберите «На экран “Домой”», включите «Открывать как веб-приложение» и нажмите «Добавить».</p><p class="muted">После входа данные доступны офлайн. Синхронизация возобновляется при открытии приложения или возвращении связи.</p><button data-action="sync">Синхронизировать</button> <button data-action="logout">Выйти</button></div>
    ${role==='owner'?`<h2>Участники</h2><div class="panel fields">
    <button data-action="team">Обновить список участников</button>${state.team.map(member=>`<div class="split"><span>${sanitize(member.name)} · ${member.role==='manager'?'менеджер':'участник'}</span>${member.revoked?'Доступ отозван':`<button data-revoke="${member.id}">Отозвать</button>`}</div>`).join('')}</div>`:''}
    ${state.pending.some(op=>op.error)?`<h2>Изменения для сверки</h2>${state.pending.filter(op=>op.error).map(op=>`<div class="notice"><b>${sanitize(fieldLabel(op.field))}</b><p>${sanitize(op.error)} Моя версия — ${sanitize(op.value)}. На сервере — ${sanitize(op.server?.value || 'пусто')}.</p><button data-discard="${op.id}">Принять серверную</button> ${op.server?.version===undefined || /\/(number|create)$/.test(op.field)?'':`<button data-keep="${op.id}">Оставить мою</button>`}</div>`).join('')}`:''}`;
}
function fieldLabel(field) {
  const [group,id,key,prop] = field.split('/');
  if (group==='editor') return 'Добавлен монтажёр';
  if (group==='release') {
    const episode=planFor(Number(id));
    return `Сезон ${episode?.season} · №${episodeNumber(Number(id))} · монтажёр`;
  }
  if (group==='shoot') return `${shoots().find(x=>x.id===id)?.guest || id} · ${({number:'привязка к КПП',date:'съёмка',plan:'сценарий',transcript:'расшифровка',link:'материалы',create:'добавление выпуска',shot:'статус съёмки',editor:'монтажёр'})[key]}`;
  const stage = planFor(Number(id))?.stages.find(x=>x.key===key);
  return `Сезон ${planFor(Number(id))?.season} · №${episodeNumber(Number(id))} · ${stage?.label || key} · ${({status:'статус',actual:'факт',due:'срок',note:'заметка',owner:'ответственный',link:'ссылка'})[prop]}`;
}
function historyValue(row) {
  if (row.field.endsWith('/create')) {
    const project=JSON.parse(row.value);
    return `${project.guest} · ${project.shot?'снято':'запланировано'} ${fmt(project.date)}${project.editor ? ' · Монтажёр: '+editorName(project.editor) : ''}`;
  }
  if (/^(shoot|release)\/[^/]+\/editor$/.test(row.field)) {
    if (row.previous!=null) return `${editorName(row.previous)} → ${editorName(row.value)}`;
    return row.value ? 'Назначен: '+editorName(row.value) : 'Назначение снято';
  }
  if (row.field.endsWith('/shot')) return row.value==='yes' ? 'Снято' : 'Запланировано';
  return statuses[row.value] || row.value || 'Значение очищено';
}
function log() {
  return title('КОМАНДА','История','Последние сохранённые изменения.')+
    (state.data.history.length ? `<div class="stack">${state.data.history.map(row=>`<div class="card log"><strong>${sanitize(fieldLabel(row.field))}</strong><p>${sanitize(historyValue(row))}</p><small>${sanitize(row.name)} · ${new Date(row.created).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}</small></div>`).join('')}</div>` : '<p class="muted">Изменений ещё нет</p>');
}
function render() {
  viewNeedsRefresh=false;
  syncLabel();
  if (!state.data) return login();
  nav.hidden = false;
  for (const button of nav.querySelectorAll('button')) {
    if (button.dataset.page === (state.page==='detail'?'episodes':state.page)) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
  main.innerHTML = ({home:overview,episodes:list,calendar,graph,detail,settings,history:log}[state.page] || overview)();
}
function modal(heading,html,save) {
  dialog.innerHTML = `<form class="fields"><div class="split"><h2>${sanitize(heading)}</h2><button type="button" data-action="close" aria-label="Закрыть">×</button></div>${html}<button class="primary">Сохранить</button></form>`;
  const form = dialog.querySelector('form');
  const editorPicker=form.elements.editor;
  if (editorPicker) editorPicker.addEventListener('change',()=>{
    const adding=editorPicker.value==='__add';
    const field=form.elements.editorName;
    field.disabled=!adding;
    field.closest('[data-editor-name]').hidden=!adding;
    if (adding) field.focus();
  });
  form.onsubmit = async event => {
    event.preventDefault();
    try {await save(new FormData(event.target));dialog.close();}
    catch (error) {notify(error.message);}
  };
  if (!dialog.open) dialog.showModal();
}
const input = (label,key,value,type='text') => `<label>${sanitize(label)}<input name="${key}" type="${type}" value="${sanitize(value)}"></label>`;
function editorSelect(selected='') {
  const keys=new Set([...Object.keys(defaultEditors),...Object.keys(state.data.fields),...state.pending.map(op=>op.field)]);
  const options=[...keys].filter(key=>key.startsWith('editor/')).map(key=>
    `<option value="${sanitize(key)}" ${key===selected?'selected':''}>${sanitize(editorName(key))}</option>`);
  return `<label>Монтажёр<select name="editor"><option value="">Не назначен</option>${options.join('')}<option value="__add">＋ Добавить монтажёра</option></select></label>
    <label data-editor-name hidden>Имя нового монтажёра<input name="editorName" maxlength="60" disabled></label>`;
}
function readEditorForm(form) {
  const selected=form.get('editor');
  if (selected!=='__add') return {selected,entries:[]};
  const name=normalizeEditorName(String(form.get('editorName') || ''));
  if (!validEditorName(name)) throw Error('Введите имя монтажёра, до 60 символов.');
  const key=editorKey(name);
  if (Object.hasOwn(defaultEditors,key) || savedOrQueued(key)) throw Error('Это имя уже есть в списке. Выберите его.');
  return {selected:key,entries:[[key,name]]};
}
function openEditor() {
  if (!manager()) return;
  const {shoot,episode}=selection();
  const current=assignedEditor(episode,shoot);
  modal('Монтажёр выпуска',editorSelect(current),async form=>{
    const {selected,entries}=readEditorForm(form);
    if (selected!==current) entries.push([editorField(episode,shoot),selected]);
    await change(entries);
  });
}
function openStage(key) {
  const {shoot,episode} = selection();
  const item = compute(episode,shoot).items.find(x=>x.key===key);
  const prefix = `stage/${episode.number}/${key}/`;
  modal(item.label,`<label>Статус<select name="status">${Object.entries(statuses).map(([id,label])=>`<option value="${id}" ${item.status===id?'selected':''}>${label}</option>`).join('')}</select></label>
    ${input('Фактическая дата завершения','actual',item.actual,'date')}${manager()?input('Закреплённый срок','due',item.pinned,'date'):''}
    ${input('Ответственный','owner',item.owner)}${!item.owner && stageOwner(item,episode,shoot)?`<small class="muted">По умолчанию: ${sanitize(stageOwner(item,episode,shoot))}</small>`:''}${input('Ссылка на материалы этапа','link',item.link,'url')}${external(item.link,'Открыть ссылку этапа')}
    <label>Комментарий или причина ожидания<textarea name="note" maxlength="2000">${sanitize(item.note)}</textarea></label>`,async form=>{
    const entries = [...form.entries()];
    if (form.get('status')==='done' && !form.get('actual')) entries.push(['actual',day()]);
    if (form.get('status')==='waiting' && !String(form.get('note')).trim()) throw Error('Укажите причину ожидания.');
    if (form.get('link') && !validLink(form.get('link'))) throw Error('Используйте HTTPS-ссылку.');
    await change([...new Map(entries)].map(([field,value])=>[prefix+field,value]));
  });
}
function openShoot() {
  const {shoot,episode} = selection();
  const editor=assignedEditor(episode,shoot);
  modal('Материалы и даты',`${manager()?input('Имя гостя или название','guest',shoot.guest)+input('Дата съёмки','date',shoot.date,'date')+shotSelect(shoot.shot)+input('Монтажный план получен','plan',shoot.plan,'date')+input('Расшифровка передана','transcript',shoot.transcript,'date'):''}
    ${manager()?editorSelect(editor):''}${input('Ссылка на папку материалов','link',shoot.link,'url')}`,async form=>{
    if (form.get('date')==='') throw Error('Укажите дату съёмки.');
    if (form.get('link') && !validLink(form.get('link'))) throw Error('Используйте HTTPS-ссылку.');
    const old = {...shoot,shot:shoot.shot?'yes':'no'};
    const {selected,entries}=readEditorForm(form);
    if (selected!==null && selected!==editor) entries.push([editorField(episode,shoot),selected]);
    const fields = [...form.entries()].filter(([key])=>key!=='editor' && key!=='editorName').map(([key,value])=>[key,value.trim()]);
    const guest = fields.find(([key])=>key==='guest')?.[1];
    if (guest!==undefined && (!guest || guest.length>120)) throw Error('Введите имя гостя или название до 120 символов.');
    await change([...entries,...fields.filter(([key,value])=>value!==(old[key] || '')).map(([key,value])=>[`shoot/${shoot.id}/${key}`,value])]);
  });
}
function bind() {
  const {shoot} = selection();
  const taken = new Set(shoots().map(s=>s.number));
  const options = state.data.episodes.filter(e=>!taken.has(e.number));
  modal('Привязать съёмку к КПП',`<label>Выпуск<select id="number" name="number" required><option value="">Выберите выпуск</option>${options.map(e=>`<option value="${e.number}">Сезон ${e.season} · №${episodeNumber(e.number)} · план ${fmt(e.stages[0].start)}</option>`).join('')}</select></label><p id="preview" class="muted"></p>`,form=>change([[`shoot/${shoot.id}/number`,form.get('number')]]));
  dialog.querySelector('#number').onchange = event => {
    const e = planFor(Number(event.target.value));
    const x = e ? compute(e,shoot) : null;
    dialog.querySelector('#preview').textContent = x ? `Сдвиг ${x.shift>0?'+':''}${x.shift} дн. Рыба до ${fmt(x.items.find(t=>t.key==='fish').end)}, сдача мастера до ${fmt(x.items.find(t=>t.key==='delivery').end)}.` : '';
  };
}
function shotSelect(shot) {
  return `<label>Статус съёмки<select name="shot"><option value="no">Запланирована</option><option value="yes" ${shot?'selected':''}>Снято</option></select></label>`;
}
function addRelease(prefill) {
  const occupied = new Set(shoots().map(shoot=>shoot.number));
  const available = state.data.episodes.filter(episode=>!occupied.has(episode.number));
  if (!available.length) return notify('Все 20 выпусков уже добавлены.');
  const first = available.find(e=>e.number===prefill) || available.find(e=>e.season===state.season) || available[0];
  modal('Добавить выпуск',`<label>Сезон<select name="season">${[1,2].map(season=>`<option value="${season}" ${season===first.season?'selected':''}>${seasonLabel(season)}</option>`).join('')}</select></label>
    <label>Номер выпуска<select name="number" required></select></label>
    <label>Имя гостя или название<input name="guest" maxlength="120" placeholder="Можно заполнить позже"></label>
    <label>Дата съёмки<input type="date" name="date" required></label>${shotSelect(false)}${editorSelect(assignedEditor(first))}`,async form=>{
    const number = Number(form.get('number'));
    const date = form.get('date');
    const guest = String(form.get('guest')).trim() || `Выпуск №${episodeNumber(number)}`;
    const shot = form.get('shot')==='yes';
    if (!date || !available.some(episode=>episode.number===number)) throw Error('Укажите номер выпуска и дату съёмки.');
    const {selected,entries}=readEditorForm(form);
    const details={guest,date,shot};
    if (selected!==assignedEditor(planFor(number))) details.editor=selected;
    await change([...entries,[`shoot/p${number}/create`,JSON.stringify(details)]]);
    state.season = planFor(number).season;
    state.selected = 'p'+number;
    go('detail');
    notify('Выпуск добавлен.');
  });
  const form = dialog.querySelector('form');
  const {season,number,date,editor}=form.elements;
  const resetFields=()=>{
    const episode=planFor(Number(number.value));
    date.value=episode?.stages[0].start || '';
    editor.value=assignedEditor(episode);
    editor.dispatchEvent(new Event('change'));
  };
  const showNumbers = selected => {
    number.innerHTML = available.filter(e=>e.season===Number(season.value)).map(e=>`<option value="${e.number}" ${e.number===selected?'selected':''}>№${episodeNumber(e.number)}</option>`).join('');
    resetFields();
  };
  season.onchange=()=>showNumbers();
  number.onchange=resetFields;
  showNumbers(first.number);
}
function go(page) {state.page=page;render();window.scrollTo(0,0);}
document.addEventListener('click',async event=>{
  const button = event.target.closest('button');
  if (!button) return;
  const d = button.dataset;
  if (button.id==='home' && state.data) return go('home');
  if (d.page) return go(d.page);
  if (d.season) {state.season=Number(d.season);return render();}
  if (d.card) {state.selected=d.card;return go('detail');}
  if (d.stage) return openStage(d.stage);
  if (d.check) {
    const {shoot,episode} = selection();
    const item = compute(episode,shoot).items.find(x=>x.key===d.check);
    const prefix = `stage/${episode.number}/${d.check}/`;
    const reopen = item.status==='done';
    return change([[prefix+'status',reopen?'working':'done'],[prefix+'actual',reopen?'':item.actual || day()]]).catch(error=>notify(error.message));
  }
  try {
    if (d.revoke && confirm('Завершить текущую сессию участника?')) {await api('revoke',{id:d.revoke});return loadTeam();}
    if (d.discard || d.keep) {
      const op = state.pending.find(x=>x.id===(d.discard || d.keep));
      for (const entry of state.pending.filter(x=>x.field===op.field)) await remove('op:'+entry.id);
      state.pending = state.pending.filter(x=>x.field!==op.field);
      if (d.keep) {
        state.data.fields[op.field] = {version:op.server.version,value:op.server.value};
        await change([[op.field,op.value]]);
      } else await synchronize();
      return render();
    }
    switch (d.action) {
      case 'close': dialog.close(); break;
      case 'shoot': openShoot(); break;
      case 'editor': openEditor(); break;
      case 'bind': bind(); break;
      case 'add-release': addRelease(Number(d.number)); break;
      case 'calendar-pdf': await downloadCalendar(d.seasonDownload ? Number(d.seasonDownload) : undefined); break;
      case 'sync': await synchronize(); notify(state.last ? 'Последняя синхронизация '+state.last : 'Синхронизация ожидает связи'); break;
      case 'team': await loadTeam(); break;
      case 'logout':
        if (state.pending.length) throw Error('Сначала синхронизируйте сохранённые изменения.');
        if (state.busy) throw Error('Дождитесь завершения синхронизации.');
        state.busy=true;
        try {
          if (onPages) {
            try {await api('team-exit',{});}
            catch (error) {if (error.status!==401) throw error;}
            teamSession = '';
          }
          await disk('readwrite',store=>store.clear());
          if (onPages) {
            state.data = null;
            state.page = 'home';
            state.online = false;
            syncLabel();
            render();
          } else location.assign('/signout-with-chatgpt?return_to=%2F');
        } finally {state.busy=false;}
        break;
    }
  } catch (error) {notify(error.message);}
});
main.addEventListener('input',event=>{
  if (event.target.id!=='search') return;
  state.search=event.target.value;
  const cursor=event.target.selectionStart;
  render();
  const search=document.querySelector('#search');
  search.focus();search.setSelectionRange(cursor,cursor);
});
main.addEventListener('change',event=>{if (event.target.id==='filter') {state.filter=event.target.value;render();}});
window.addEventListener('online',synchronize);
window.addEventListener('pageshow',synchronize);
window.addEventListener('focus',synchronize);
document.addEventListener('visibilitychange',()=>{if (!document.hidden) synchronize();});
setInterval(()=>{if (!document.hidden) synchronize();},5000);
try {
  if (onPages) teamSession = await get('team-session') || '';
  if (!onPages || teamSession) state.data = await get('snapshot');
  if (state.data) state.pending = (await changeList()).filter(op=>op.member===state.data.member.id).sort((a,b)=>a.order-b.order);
  render();
  await synchronize();
  if ('serviceWorker' in navigator) await navigator.serviceWorker.register('./sw.js');
} catch (error) {notify('Не удалось открыть локальные данные. '+error.message);render();}
