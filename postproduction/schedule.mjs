const DAY = 86400000;
export const add = (date, days) => new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
export const diff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / DAY);
export const latest = (...dates) => dates.filter(Boolean).sort().at(-1) || '';
export const statuses = {
  todo:'Не начато', working:'В работе', waiting:'Ожидает', review:'На согласовании',
  done:'Готово', skipped:'Не требуется',
};
export function today() {
  return new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
}
export function forecast(episode, shoot, get) {
  const shift = shoot ? diff(shoot.date, episode.stages[0].start) : 0;
  const filmed = Boolean(shoot && shoot.shot !== false);
  const items = [];
  let previous;
  for (const base of episode.stages) {
    const key = base.key;
    const prefix = `stage/${episode.number}/${key}/`;
    const read = name => get(prefix + name);
    const baseStart = add(base.start, shift);
    const actualStart = key === 'shoot' ? (filmed ? shoot.date : '') : read('actualStart');
    const actual = key === 'shoot' ? (filmed ? shoot.date : '') : read('actual');
    const status = key === 'shoot' ? (filmed ? 'done' : 'todo') : read('status') || 'todo';
    const parallel = key === 'sound' || key === 'color';
    let start = baseStart;
    if (parallel) {
      const master = items.find(item => item.key === 'master');
      start = add(master.start, diff(base.start, master.originalStart));
    } else if (previous) {
      const gap = Math.max(key === 'transfer' || key === 'fish' ? 1 : 0, diff(base.start, previous.originalEnd));
      start = latest(start, add(previous.actual || previous.end, gap));
    }
    if (key === 'fish' && shoot?.plan) start = latest(start, shoot.plan);
    if (key === 'masterReview') {
      const finishing = items.filter(item => item.key === 'sound' || item.key === 'color');
      start = latest(start, ...finishing.map(item => add(item.actual || item.end, 1)));
    }
    const end = add(start, Math.max(0, diff(base.end, base.start)));
    const item = {
      ...base, originalStart:base.start, originalEnd:base.end, start, end, status, actualStart, actual,
      note:read('note'), owner:read('owner'), link:read('link'),
      waiting: key === 'fish' && shoot && !shoot.plan && status !== 'done',
      sourceIssue: base.sourceDays !== diff(base.end, base.start) + 1 ||
        Boolean(!parallel && previous && base.start < previous.originalEnd),
    };
    items.push(item);
    if (!parallel) previous = item;
  }
  return {shift, items};
}

export function progressFor(items) {
  const closed = items.filter(item=>item.status==='done' || item.status==='skipped').length;
  const current = items.find(item=>item.status==='working' || item.status==='review') ||
    items.find(item=>item.status!=='done' && item.status!=='skipped');
  return {closed,total:items.length,percent:items.length ? Math.round(100*closed/items.length) : 0,current};
}

export function resolveShoots(episodes, baseShoots, read) {
  const additions = episodes.flatMap(episode => {
    const id = 'p'+episode.number;
    const value = read(`shoot/${id}/create`);
    return value ? [{...JSON.parse(value),id,number:episode.number,plan:''}] : [];
  });
  return [...baseShoots,...additions].map(shoot => {
    const key = 'shoot/'+shoot.id+'/';
    const shot = read(key+'shot');
    return {...shoot,
      date:read(key+'date') || shoot.date,
      guest:read(key+'guest') || shoot.guest,
      shot:shot ? shot==='yes' : shoot.shot!==false,
      number:Number(read(key+'number') || shoot.number) || null,
      plan:read(key+'plan') ?? shoot.plan,
      link:read(key+'link') || '', transcript:read(key+'transcript') || '',
    };
  });
}

export function calendarFor(episodes, shoots, read, season) {
  const numbered = new Map(shoots.filter(shoot=>shoot.number).map(shoot=>[shoot.number,shoot]));
  const releases = episodes.filter(episode=>!season || episode.season===season).map(episode=>{
    const shoot = numbered.get(episode.number);
    const {items} = forecast(episode,shoot,read);
    return {number:episode.number,season:episode.season,shoot,items,...progressFor(items)};
  });
  return {releases,unlinked:shoots.filter(shoot=>!shoot.number)};
}

export const defaultEditors = {'editor/артем':'Артём','editor/сергей':'Сергей'};
export const normalizeEditorName = name => name.normalize('NFKC').trim().replace(/\s+/gu,' ');
export function editorKey(name) {
  return 'editor/'+normalizeEditorName(name).toLocaleLowerCase('ru').replaceAll('ё','е');
}
export function validEditorName(name) {
  return name.length <= 60 && /^[\p{L}\p{M}][\p{L}\p{M} .’'()-]*$/u.test(name);
}
export function releaseEditor(episode,shoot,read) {
  const assigned = shoot ? read(`shoot/${shoot.id}/editor`) ?? shoot.editor : undefined;
  return assigned ?? (episode ? read(`release/${episode.number}/editor`) : undefined) ?? '';
}
