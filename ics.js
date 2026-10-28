/** Generate a standard RFC 5545 calendar containing only eligible upcoming deadlines.
 * Export is a snapshot: after changing a deadline, users need to export again.
 * All reminders are at 10:00 Europe/Moscow (07:00 UTC), not local device time.
 */
import {addDays, calculateSchedule, parseDay} from './engine.js';

function escapeIcs(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}
function foldLine(line) {
  // ICS lines are limited to 75 *octets*, not characters.
  const encoder = new TextEncoder();
  const result=[];
  let current='';
  let bytes=0;
  for (const c of line) {
    const size=encoder.encode(c).length;
    if (bytes + size > 75) {
      result.push(current);
      current=' ' + c;
      bytes=1+size;
    } else {
      current+=c;
      bytes+=size;
    }
  }
  result.push(current);
  return result.join('\r\n');
}
function utcAtMoscowTen(iso) {
  if (!parseDay(iso)) throw new RangeError(`Invalid date: ${iso}`);
  // Europe/Moscow observes UTC+3 without daylight saving in this project period.
  return `${iso.replaceAll('-','')}T070000Z`;
}
const id = n => `episode:${String(n).padStart(2,'0')}`;

export function deadlineEvents(kpp, records, today, horizonDays=45) {
  if (!parseDay(today)) throw new RangeError('Invalid beginning of calendar export');
  const limit=addDays(today,horizonDays);
  const events=[];
  for (const template of kpp.episodes) {
    const record=records[id(template.number)];
    const data=record?.data;
    if (!data?.actualShoot) continue;
    const base={episode:template.number,guest:data.guest || '',season:template.season};
    const add = (key,name,date) => {
      if (date && date>=today && date<=limit) {
        events.push({...base,key,name,date});
      }
    };
    if (!data.transcriptSent) {
      add('transcript','Передать текстовую расшифровку',addDays(data.actualShoot,1));
    }
    const calc=calculateSchedule(template,data);
    for (const stage of calc.stages) {
      if (stage.key==='2'||stage.key==='3'||stage.status==='done'||stage.blocked) continue;
      // No deadlines should be attributed to production if their prerequisites
      // have not been received / approved.
      add(stage.key,stage.name,stage.end);
    }
  }
  events.sort((a,b)=>a.date.localeCompare(b.date)||a.episode-b.episode||a.key.localeCompare(b.key));
  return events;
}

export function createIcs(kpp, records, today, horizonDays=45, generatedAt=new Date()) {
  const events=deadlineEvents(kpp,records,today,horizonDays);
  const stamp=generatedAt.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  const lines=[
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Svoyaki Production Control//Offline Calendar//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:СВОяки — дедлайны',
    'X-WR-TIMEZONE:Europe/Moscow',
  ];
  for (const event of events) {
    const number=String(event.episode).padStart(2,'0');
    const summary=`СВОяки · Выпуск ${number} · ${event.name}`;
    const description=`Выпуск ${number}${event.guest?' — '+event.guest:''}. Плановая дата из актуального прогноза КПП. После изменения сроков экспортируйте календарь повторно.`;
    const dt=utcAtMoscowTen(event.date);
    const enddt=new Date(`${event.date}T07:15:00Z`).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
    lines.push('BEGIN:VEVENT',
      `UID:svoyaki-${number}-${event.key.replaceAll('.','-')}@production-control`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${dt}`,
      `DTEND:${enddt}`,
      `SUMMARY:${escapeIcs(summary)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT0M',
      `DESCRIPTION:${escapeIcs(summary)}`,
      'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return {ics:lines.map(foldLine).join('\r\n')+'\r\n',count:events.length};
}