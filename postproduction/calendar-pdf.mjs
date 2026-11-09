import {add,diff,statuses,today} from './schedule.mjs';

const PAGE_W = 1191;
const PAGE_H = 842;
const palette = {ink:'#142E47', muted:'#4D6277', line:'#CAD6E1', pale:'#EEF3F8', soft:'#F6F9FC', white:'#FFFFFF'};
const phases = [
  {label:'Съёмка',color:'#A56210',stages:['shoot']},
  {label:'Монтаж / правки',color:'#197779',stages:['transfer','fish','fishReview','premaster','preReview','preFix','iriFix','masterReview','finalFix']},
  {label:'ИРИ / отсмотры',color:'#7856A5',stages:['preIri','masterIri']},
  {label:'Мастер',color:'#3B75A9',stages:['master','sound','color']},
  {label:'Сдачи / окно',color:'#263E58',stages:['delivery','final']},
];
const fmtDate = date => date ? date.split('-').reverse().join('.') : '—';
const dateRange = (start,end) => start===end ? fmtDate(start) : fmtDate(start)+' – '+fmtDate(end);
const localNumber = number => String((number-1)%10+1).padStart(2,'0');
const displayLabel = release => release.shoot?.guest || 'Гость уточняется';
const rgb = value => value.slice(1).match(/../g).map(n=>(parseInt(n,16)/255).toFixed(3)).join(' ');
const hex4 = n => n.toString(16).padStart(4,'0');
const bytes = new TextEncoder();

function drawing(font) {
  const commands = [];
  const points = value => Array.from(String(value),char=>{
    const cp=char.codePointAt(0);
    return Object.hasOwn(font.glyphs,cp) ? cp : 63;
  });
  function text(value,x,y,size=11,color=palette.ink,maxWidth=Infinity) {
    const chars=points(value);
    const width=cp=>font.glyphs[cp][1]*size/1000;
    let used=chars.reduce((sum,cp)=>sum+width(cp),0);
    if (used>maxWidth) {
      const ellipsis=8230;
      while (chars.length && used+width(ellipsis)>maxWidth) used-=width(chars.pop());
      chars.push(ellipsis);
    }
    commands.push(`BT /F1 ${size} Tf ${rgb(color)} rg 1 0 0 1 ${x} ${PAGE_H-y} Tm <${chars.map(hex4).join('')}> Tj ET`);
  }
  function rect(x,y,w,h,color) {
    commands.push(`${rgb(color)} rg ${x.toFixed(2)} ${(PAGE_H-y-h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  return {text,rect,commands};
}
function heading(canvas,title,subtitle) {
  const {text,rect}=canvas;
  rect(36,30,4,68,palette.ink);
  text('СВОЯКИ / КАЛЕНДАРНЫЙ ПЛАН',48,44,10,palette.muted);
  text(title,48,72,24);
  text(subtitle,48,94,11,palette.muted);
}
function overview(canvas,season,releases) {
  const {text,rect}=canvas;
  const allDates=releases.flatMap(release=>release.items.flatMap(item=>
    (release.shoot ? [item.start,item.end,item.actualStart,item.actual] : [item.actualStart,item.actual]).filter(Boolean)
  )).sort();
  const start=allDates[0], end=allDates.at(-1);
  const span=start ? diff(end,start)+1 : 0;
  heading(canvas,`Сезон ${season} — обзор производства`,`${releases.length} выпусков · ${start ? dateRange(start,end)+' · прогноз и фактические даты' : 'Даты пока не указаны'}`);
  phases.forEach((phase,i)=>{
    rect(48+i*150,112,11,6,phase.color);
    text(phase.label,65+i*150,119,10,phase.color);
  });
  const gridX=319, gridW=835, rowH=59, top=162;
  const scale=span ? gridW/span : 0;
  const labelStep=Math.max(7,Math.ceil(span/126)*7);
  if (span<=180) {
    for (let offset=0;offset<span;offset++) {
      const weekday=new Date(add(start,offset)).getUTCDay();
      if (weekday===6 || weekday===0) rect(gridX+offset*scale,top,scale,releases.length*rowH,palette.soft);
    }
  }
  for (let offset=0;offset<span;offset+=labelStep) {
    const x=gridX+offset*scale;
    rect(x,top,.6,releases.length*rowH,palette.line);
    text(fmtDate(add(start,offset)).slice(0,5),Math.min(x,gridX+gridW-27),153,9,palette.muted);
  }
  text('ВЫПУСК / ТЕКУЩИЙ ЭТАП',36,153,9,palette.muted);
  releases.forEach((release,i)=>{
    const y=top+i*rowH;
    rect(36,y,1118,.65,palette.line);
    text(`№ ${localNumber(release.number)}  ${displayLabel(release)}`,36,y+16,12,palette.ink,270);
    text(release.current?.label || 'Все этапы закрыты',36,y+33,10,palette.muted,270);
    text(`${release.percent}% · ${release.closed} из ${release.total} этапов`,36,y+47,9,palette.muted,270);
    phases.forEach((phase,lane)=>{
      release.items.filter(item=>phase.stages.includes(item.key) && item.status!=='skipped').forEach(item=>{
        const to=item.actual || (release.shoot ? item.end : item.actualStart);
        if (!to) return;
        const from=item.actualStart || (release.shoot && item.start<to ? item.start : to);
        const x=gridX+diff(from,start)*scale;
        rect(x,y+7+lane*9,Math.max(1.25,(diff(to,from)+1)*scale),5.5,phase.color);
      });
    });
  });
  rect(36,top+releases.length*rowH,1118,.65,palette.line);
  text('Цветные полосы показывают окна работ по фазам. Прогноз, фактические даты и статусы указаны на следующих листах.',36,774,10,palette.muted);
}
function details(canvas,season,releases) {
  const {text,rect}=canvas;
  const title=releases.map(release=>localNumber(release.number)).join(' / ');
  heading(canvas,`Сезон ${season} — выпуски ${title}`,'Детальный график · актуальный прогноз и фактические даты');
  const columns=[36,93,460,655,825,1015,1154];
  let y=115;
  for (const release of releases) {
    rect(36,y,1118,25,palette.pale);
    text(`№ ${localNumber(release.number)} · ${displayLabel(release)}`,44,y+17,13,palette.ink,600);
    const shoot=release.shoot;
    const input=shoot ? `Монтажный план: ${fmtDate(shoot.plan)} · расшифровка: ${fmtDate(shoot.transcript)}` : 'Дата съёмки не задана';
    text(input,685,y+17,9,palette.muted,450);
    y+=41;
    ['Код','Этап','Актуальный прогноз','Фактическая дата начала','Фактическая дата завершения','Статус'].forEach((value,i)=>text(value,columns[i]+3,y,9,palette.muted,columns[i+1]-columns[i]-5));
    y+=6;
    release.items.forEach((item,index)=>{
      if (index%2===0) rect(36,y,1118,14,palette.soft);
      const cells=[item.code,item.label,shoot ? dateRange(item.start,item.end) : '—',fmtDate(item.actualStart),fmtDate(item.actual),statuses[item.status]||item.status];
      cells.forEach((value,i)=>text(value,columns[i]+3,y+10,9,i===5 && item.status==='done'?'#237054':palette.ink,columns[i+1]-columns[i]-5));
      y+=14;
    });
    y+=15;
  }
  text('Пустые даты обозначены прочерком. Прогноз появляется после добавления даты съёмки.',36,775,10,palette.muted);
}
function unlinked(canvas,shoots) {
  const {text,rect}=canvas;
  heading(canvas,'Съёмки без номера выпуска','Эти съёмки внесены в приложение. Их номера в КПП ещё уточняются.');
  shoots.forEach((shoot,i)=>{
    const y=124+i*39;
    rect(36,y,1118,.65,palette.line);
    text(displayLabel({shoot}),44,y+23,13,palette.ink,630);
    text((shoot.shot?'Снято ':'Запланировано ')+fmtDate(shoot.date),710,y+23,12,palette.muted,400);
  });
}
function pdfFile(pages,font) {
  const objects=[];
  const put=value=>{objects.push(value);return objects.length;};
  const stream=(data,fields='')=>({data:typeof data==='string'?bytes.encode(data):data,fields});
  put('<< /Type /Catalog /Pages 2 0 R >>');
  put('');
  const fontBytes=Uint8Array.from(atob(font.base64),char=>char.charCodeAt(0));
  const embedded=put(stream(fontBytes,`/Length1 ${fontBytes.length}`));
  const {xMin,yMin,xMax,yMax,ascent,descent}=font.metrics;
  const descriptor=put(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${xMin} ${yMin} ${xMax} ${yMax}] /ItalicAngle 0 /Ascent ${ascent} /Descent ${descent} /CapHeight 730 /StemV 80 /FontFile2 ${embedded} 0 R >>`);
  const codes=Object.keys(font.glyphs).map(Number);
  const cidMap=new Uint8Array((codes.at(-1)+1)*2);
  const view=new DataView(cidMap.buffer);
  codes.forEach(cp=>view.setUint16(cp*2,font.glyphs[cp][0]));
  const map=put(stream(cidMap));
  const widths=codes.map(cp=>`${cp} [${font.glyphs[cp][1]}]`).join(' ');
  const system='<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>';
  const cidFont=put(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo ${system} /FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${map} 0 R /W [${widths}] >>`);
  const unicode=put(stream('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /SvUnicode def\n/CMapType 2 def\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'));
  const type0=put(`<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${unicode} 0 R >>`);
  const ids=pages.map(page=>{
    const content=put(stream(page.commands.join('\n')));
    return put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${type0} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[1]=`<< /Type /Pages /Count ${ids.length} /Kids [${ids.map(id=>id+' 0 R').join(' ')}] >>`;
  const chunks=[];
  let length=0;
  function append(value) {
    const data=typeof value==='string'?bytes.encode(value):value;
    chunks.push(data);
    length+=data.length;
  }
  append('%PDF-1.4\n');
  append(new Uint8Array([37,226,227,207,211,10]));
  const offsets=[];
  objects.forEach((object,i)=>{
    offsets.push(length);
    append(`${i+1} 0 obj\n`);
    if (typeof object==='string') append(object);
    else {
      append(`<< /Length ${object.data.length} ${object.fields} >>\nstream\n`);
      append(object.data);
      append('\nendstream');
    }
    append('\nendobj\n');
  });
  const startXref=length;
  append(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);
  const result=new Uint8Array(length);
  let offset=0;
  for (const chunk of chunks) {result.set(chunk,offset);offset+=chunk.length;}
  return result;
}

export function renderCalendarPdf(calendar,font,date=today()) {
  const pages=[];
  for (const season of [1,2]) {
    const releases=calendar.releases.filter(release=>release.season===season);
    if (!releases.length) continue;
    const cover=drawing(font);
    overview(cover,season,releases);
    pages.push(cover);
    for (let i=0;i<releases.length;i+=2) {
      const page=drawing(font);
      details(page,season,releases.slice(i,i+2));
      pages.push(page);
    }
  }
  if (calendar.unlinked.length) {
    const page=drawing(font);
    unlinked(page,calendar.unlinked);
    pages.push(page);
  }
  pages.forEach((page,i)=>{
    page.rect(36,795,1118,1,palette.line);
    page.text(`Выгрузка ${fmtDate(date)} · Москва · Все диапазоны включительны`,36,814,9,palette.muted);
    page.text(`${i+1} / ${pages.length}`,1097,814,9,palette.muted);
  });
  return pdfFile(pages,font);
}
