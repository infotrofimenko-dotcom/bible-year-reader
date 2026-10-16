export const PLAN_ID='patriarchal-bible-year-v1';
export const STORE='bible-year-personal-v1';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export function defaults(){return {schema:1,planId:PLAN_ID,font:22,theme:'light',read:{},bookmarks:{},positions:{}};}
export function validateState(raw,ids){
  if(!raw||raw.schema!==1||raw.planId!==PLAN_ID)throw Error('Это копия другого приложения или плана.');
  const s=defaults();s.font=Math.max(18,Math.min(34,Number(raw.font)||22));s.theme=raw.theme==='dark'?'dark':'light';
  for(const field of ['read','bookmarks','positions']){
    const values=raw[field];if(!values||typeof values!=='object'||Array.isArray(values))continue;
    if(Object.keys(values).length>10000)throw Error('Слишком большая резервная копия.');
    for(const [id,v]of Object.entries(values)){
      if(!/^d\d{3}-r\d{2}$/.test(id)||!ids.has(id))continue;
      if(field==='positions'){if(Number.isInteger(v)&&v>=0&&v<1000)s.positions[id]=v;}
      else if(v===true)s[field][id]=true;
    }
  }
  return s;
}
export function mergeState(current,incoming){return {...incoming,read:{...current.read,...incoming.read},bookmarks:{...current.bookmarks,...incoming.bookmarks},positions:{...current.positions,...incoming.positions}};}
export function isRead(s,id){return own(s.read,id)&&s.read[id]===true;}
export function dayDone(s,day){return day.status==='ready'&&day.readings.length>0&&day.readings.every(r=>isRead(s,r.id));}
export function dayProgress(s,day){return day.readings.filter(r=>isRead(s,r.id)).length;}
export function nextReading(s,days){
  for(const day of days){
    if(day.status!=='ready')return {day,reading:null,pending:true};
    const reading=day.readings.find(r=>!isRead(s,r.id));
    if(reading)return {day,reading,pending:false};
  }
  return null;
}
export function readingVerses(reading,library){
  const result=[];
  for(let chapter=reading.start[0];chapter<=reading.end[0];chapter++){
    const verses=library.chapters[`${reading.book}.${chapter}`];
    if(!Array.isArray(verses)||!verses.length)throw Error('Не найдена глава: '+reading.reference);
    const from=chapter===reading.start[0]?(reading.start[1]??verses[0].number):verses[0].number;
    const to=chapter===reading.end[0]?(reading.end[1]??verses.at(-1).number):verses.at(-1).number;
    if(!verses.some(v=>v.number===from)||!verses.some(v=>v.number===to)||from>to)throw Error('Не найден диапазон: '+reading.reference);
    for(const verse of verses)if(verse.number>=from&&verse.number<=to)result.push({chapter,...verse});
  }
  return result;
}
