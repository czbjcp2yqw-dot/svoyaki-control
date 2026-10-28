/** Pure schedule engine. All date arithmetic is UTC calendar-day based. */
export const DAY = 86400000;
export const INPUT_LABELS = {
  planReceived: 'Монтажный план / сценарий',
  materialsReceived: 'Исходные материалы',
  transcriptSent: 'Расшифровка'
};
export function parseDay(s) { if (!/^\d{4}-\d\d-\d\d$/.test(s || '')) return null; const d = new Date(`${s}T12:00:00Z`); return Number.isNaN(d.getTime()) || d.toISOString().slice(0,10)!==s ? null : d; }
export function addDays(s, n) { const d=parseDay(s); if (!d) return ''; d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
export function diffDays(a,b) { const x=parseDay(a), y=parseDay(b); return x && y ? Math.round((x-y)/DAY) : 0; }
export function maxDay(...dates) { return dates.filter(Boolean).sort().at(-1) || ''; }
export function fmtDate(iso, long=false) { if (!iso) return '—'; const d = parseDay(iso); return d ? new Intl.DateTimeFormat('ru-RU', {day:'numeric', month:long?'long':'short', ...(long?{year:'numeric'}:{}) ,timeZone:'UTC'}).format(d) : '—'; }
export function localToday() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
export function isoForMoscow(now=new Date()) { const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value])); return `${parts.year}-${parts.month}-${parts.day}`; }
export const STAGE_CATEGORIES = { '2':'shoot', '3':'transfer', '4':'editing', '5':'approval', '6':'editing', '7':'editing', '8':'approval', '9':'editing', '10':'iri', '11':'editing', '12':'master', '12.1':'sound', '12.2':'color', '13':'editing', '14':'delivery', '15':'iri', '16':'editing', '17':'delivery' };
export function stageGroup(key){return STAGE_CATEGORIES[key] || 'editing';}
export function isParallel(key){return key==='12.1' || key==='12.2';}
export function isCompleted(stage){return stage.status==='done';}

/**
 * Forecast based on individual KP durations/gaps, actual shoot & available inputs.
 * - completed stages use actualEnd and shorten/advance downstream work.
 * - a late montage plan delays fish start without shortening the allowed duration.
 * - parallel sound/color follow master start instead of extending the sequential chain.
 * - any impossible original ordering is corrected in forecast, but the original dates remain intact.
 * - an absent plan keeps provisional forecasts, flagged as unverified, not a studio fault.
 */
export function calculateSchedule(template, data={}) {
  const shift = data.actualShoot ? diffDays(data.actualShoot, template.shootPlanned) : 0;
  const stages=[]; const byKey={}; let previousMain=null;
  const facts = data.stageFacts || {};
  for (const original of template.stages) {
    const key=original.key, fact=facts[key] || {}, parallel=isParallel(key);
    let start = addDays(original.start,shift), blocked='';
    if (key==='2') start=data.actualShoot || original.start;
    else if (parallel) {
      const master=byKey['12'];
      start=addDays(master.start,diffDays(original.start,template.stages.find(x=>x.key==='12').start));
    } else if (previousMain) {
      const gap=Math.max(key==='4'?1:0,diffDays(original.start,previousMain.original.end));
      const minStart=addDays(previousMain.end,gap);
      // Completed tasks do not move forward just because a prior stage was corrected later.
      start=minStart;
      if (key==='13') start=maxDay(start,addDays(byKey['12.1'].end,1),addDays(byKey['12.2'].end,1));
    }
    if (key==='3' && data.materialsReceived) start=data.materialsReceived;
    if (key==='4') {
      if (data.planReceived) start=maxDay(start,data.planReceived);
      else blocked='Нет подтверждённой даты получения монтажного плана';
      if (!data.materialsReceived) blocked = blocked ? `${blocked}; не подтверждена передача исходников` : 'Не подтверждена передача исходников';
    }
    // Unconfirmed inputs block the downstream *attribution* of missed deadlines.
    // An actual completion proves that a stage has passed even if its input dates are unknown.
    if (!parallel && previousMain?.blocked && !previousMain.actualEnd && !fact.actualEnd) {
      blocked=blocked||previousMain.blocked;
    }
    if (parallel && byKey['12']?.blocked && !byKey['12'].actualEnd && !fact.actualEnd) {
      blocked=blocked||byKey['12'].blocked;
    }
    if (key==='2' && data.actualShoot) start=data.actualShoot;
    // Stage-specific actual start is authoritative.
    if (fact.actualStart) start=fact.actualStart;
    const actualEnd=key==='2'&&data.actualShoot ? data.actualShoot : key==='3'&&data.materialsReceived ? data.materialsReceived : fact.actualEnd;
    if(actualEnd)blocked='';
    const end=actualEnd || addDays(start,original.days-1);
    const status=key==='2' && data.actualShoot ? 'done' : key==='3' && data.materialsReceived ? 'done' : fact.status || 'planned';
    const stage={ ...original, key, start, end, actualEnd:actualEnd || '', actualStart:fact.actualStart||'', status, owner:fact.owner||'', note:fact.note||'', blocked, group:stageGroup(key), original, delta:diffDays(end,original.end), days:original.days, isFact:!!actualEnd };
    stages.push(stage); byKey[key]=stage;
    if(!parallel) previousMain=stage;
  }
  const fish=byKey['4'];
  const fishOrig=template.stages.find(x=>x.key==='4');
  const fishStartWithoutPlan=addDays(fishOrig.start,shift);
  const delayFromPlan=data.planReceived ? Math.max(0,diffDays(data.planReceived,fishStartWithoutPlan)) : null;
  const fishDurationFact=fish.actualEnd && data.planReceived ? diffDays(fish.actualEnd, maxDay(fish.start,data.planReceived))+1 : null;
  const fishSaved=fishDurationFact != null ? fish.days-fishDurationFact : null;
  const final=byKey['17']; const originalEnd=template.stages.find(s=>s.key==='17').end;
  return {stages,byKey,deltaFinal:diffDays(final.end,originalEnd),deltaShoot:shift,delayFromPlan,fishSaved,originalEnd,forecastEnd:final.end,assumptions:(!data.planReceived ? ['Нет даты получения монтажного плана: прогноз монтажа предварительный.']:[])};
}

export function buildAgenda(kpp, records, date=localToday()) {
  const episodes=[], tasks=[], waiting=[];
  for(const template of kpp.episodes){
    const rec=records[`episode:${String(template.number).padStart(2,'0')}`];
    if(!rec?.data?.actualShoot) continue;
    const data=rec.data, calc=calculateSchedule(template,data);
    const episode={template,data,calc}; episodes.push(episode);
    const pending=calc.stages.filter(s=>s.status!=='done');
    // Display next actionable stage, not every future stage of a blocked chain.
    const next=pending.find(s=>!['2','3','12.1','12.2'].includes(s.key));
    if(!data.planReceived) waiting.push({episode:template.number,name:'Монтажный план',detail:'Дата не подтверждена'});
    if(!data.materialsReceived) waiting.push({episode:template.number,name:'Исходники',detail:'Дата передачи не подтверждена'});
    if(!data.transcriptSent) {
      const due=addDays(data.actualShoot,1);
      tasks.push({episode:template.number,name:'Передать текстовую расшифровку',end:due, status:'planned',group:'transfer',kind:'transcript', isNext:true,blocked:''});
    }
    for(const stage of pending){
      if(['2','3'].includes(stage.key)) continue;
      const isNext=stage===next;
      const isParallelNow=['12.1','12.2'].includes(stage.key)&&calc.byKey['12'].status==='done';
      const futureSoon=diffDays(stage.end,date)>=0 && diffDays(stage.end,date)<=7;
      if(isNext || (isParallelNow && !stage.blocked) || (futureSoon && !stage.blocked)) {
        tasks.push({episode:template.number,name:stage.name,end:stage.end,start:stage.start,status:stage.status,group:stage.group,kind:stage.key,blocked:stage.blocked, isNext});
      }
    }
  }
  tasks.sort((a,b)=>a.end.localeCompare(b.end)||a.episode-b.episode);
  return {episodes,tasks,waiting,
    today:tasks.filter(t=>t.end===date && !t.blocked),
    tomorrow:tasks.filter(t=>t.end===addDays(date,1) && !t.blocked),
    overdue:tasks.filter(t=>t.end<date && (t.isNext || t.kind==='transcript') && !t.blocked),
    next7:tasks.filter(t=>t.end>date && t.end<=addDays(date,7))};
}
export function formatDigest(agenda, date=localToday()) {
  const lines=[`СВОяки — сводка на ${fmtDate(date,true)}`,''];
  for(const [label,items] of [['Сегодня',agenda.today],['Завтра',agenda.tomorrow],['Просрочено',agenda.overdue]]){
    lines.push(`${label}: ${items.length}`);
    for(const t of items.slice(0,12))lines.push(`• Выпуск ${String(t.episode).padStart(2,'0')}: ${t.name}${label==='Просрочено'?` (+${diffDays(date,t.end)} дн.)`:''}`);
    lines.push('');
  }
  lines.push(`Ожидаем материалы: ${agenda.waiting.length}`);
  for(const x of agenda.waiting.slice(0,8)) lines.push(`• Выпуск ${String(x.episode).padStart(2,'0')}: ${x.name}`);
  return lines.join('\n');
}