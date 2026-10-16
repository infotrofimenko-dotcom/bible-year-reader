"""Import the user's assigned reading plan and public Synodal chapter texts.

The newsletter extract contains reading assignments only, not mail headers,
addresses, account identifiers, login links or unsubscribe links.
"""
import argparse, datetime as dt, hashlib, html, json, re, time
import urllib.request, urllib.parse
from pathlib import Path
from html.parser import HTMLParser

ROOT=Path(__file__).resolve().parent
CACHE=ROOT/'source-cache'
OUT=ROOT/'dist/data'
SOURCE='https://lib.izuchaem-bibliu.ru/'
ALIASES={'2Иоан':'2Ин','Ил':'Иоил'}

class PlainText(HTMLParser):
    def __init__(self,s):
        super().__init__(convert_charrefs=True);self.parts=[];self.feed(s)
    def handle_data(self,s):self.parts.append(s)
    def text(self):return re.sub(r'\s+',' ',''.join(self.parts)).strip()

def chapter(code,number):
    canonical=ALIASES.get(code,code)
    folder=CACHE/'chapters';folder.mkdir(parents=True,exist_ok=True)
    path=folder/f'{canonical}-{number}.json'
    if path.exists():payload=json.loads(path.read_text(encoding='utf-8'))
    else:
        body=urllib.parse.urlencode({'action':'texts','code':f'{code}.{number}:1'}).encode()
        for attempt in range(3):
            try:
                req=urllib.request.Request(SOURCE+'api/ajax.php',data=body,headers={'User-Agent':'PersonalBibleYearReader/1.0 (personal offline reading)','Content-Type':'application/x-www-form-urlencoded'})
                with urllib.request.urlopen(req,timeout=35) as response:payload=json.load(response)
                break
            except Exception:
                if attempt==2:raise
                time.sleep(3*(attempt+1))
        path.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8');time.sleep(.65)
    if not payload.get('isSuccess') or int(payload.get('chapter',0))!=number:raise ValueError(f'Invalid source chapter {code}.{number}')
    verses=[{'number':int(v['number']),'text':PlainText(v['text']).text()} for v in payload['texts'].values()]
    if not verses or any(not v['text'] for v in verses):raise ValueError(f'Empty Scripture {code}.{number}')
    # The course library combines Acts 19:40 and 19:41 under number 40.
    # Split at the exact existing sentence, without generating or changing words.
    tail='Сказав это, он распустил собрание.'
    if canonical=='Деян' and number==19 and verses[-1]['number']==40 and verses[-1]['text'].endswith(' '+tail):
        verses[-1]['text']=verses[-1]['text'][:-len(tail)].strip()
        verses.append({'number':41,'text':tail})
    nums=[v['number'] for v in verses]
    if nums!=sorted(set(nums)):raise ValueError(f'Invalid numbering {code}.{number}')
    return payload['title'],verses

def parse_newsletters():
    weeks=json.loads((CACHE/'newsletter-plan.json').read_text(encoding='utf-8'))
    result={};corrections=[]
    for week in weeks:
        chunks=re.split(r'(?m)^День\s+(\d+)\s*$',week['text'])
        for index in range(1,len(chunks),2):
            day=int(chunks[index]);block=chunks[index+1].strip()
            if week['startDay']==84 and day==84:
                day=85;corrections.append({'day':85,'field':'dayNumber','original':'84','corrected':'85','reason':'В заголовке первой даты недели опечатка: далее идут дни 86–91, предыдущая неделя заканчивается днём 84.'})
            entries=[];cursor=0
            # Capture the full printed assignment before each public Bible URL.
            for match in re.finditer(r'https://lib\.izuchaem-bibliu\.ru/([^\s]*(?:\s+7:1)?)',block):
                label=block[cursor:match.start()].strip();cursor=match.end()
                dashed=bool(re.match(r'^[\s–—-]',label) and label.lstrip().startswith(('-', '–','—')))
                label=label.strip(' \n\r\t–—-')
                urlpart=urllib.parse.unquote(match.group(1)).replace(' ','').lstrip('#')
                urlmatch=re.match(r'([1-4]?[А-Яа-яЁё]+)\.(\d+)',urlpart)
                if not urlmatch:raise ValueError(f'Unknown source Bible reference, day {day}: {urlpart}')
                code=ALIASES.get(urlmatch.group(1),urlmatch.group(1))
                lm=re.fullmatch(r'(.+?)\s+(\d+)(?::(\d+))?(?:\s*[–—-]\s*(\d+)(?::(\d+))?)?',label,re.S)
                if lm:
                    title=re.sub(r'\s+',' ',lm[1]);c=int(lm[2]);v=int(lm[3]) if lm[3] else None;endc=c;endv=v
                    if lm[5]:endc=int(lm[4]);endv=int(lm[5])
                    elif lm[4]:
                        if v is None:endc=int(lm[4]);endv=None
                        else:endv=int(lm[4])
                elif label=='Послание апостола Иуды':title=label;c=endc=1;v=endv=None
                else:raise ValueError(f'Unparsed assignment on day {day}: {label!r}')
                if day==315 and code=='2Фес' and c==13 and int(urlmatch[2])==3:
                    corrections.append({'day':day,'field':'chapter','original':label,'corrected':'Второе послание к Фессалоникийцам 3','reason':'В послании три главы; ссылка письма указывает главу 3, предыдущие дни содержат главы 1 и 2.'});c=endc=3
                if c!=int(urlmatch[2]):
                    corrections.append({'day':day,'field':'link','original':urlpart,'corrected':f'{code}.{c}:1','reason':'Номер главы взят из напечатанного назначения, ссылка письма указывает другую главу.'})
                item={'book':code,'title':title,'start':[c,v],'end':[endc,endv],'sourceLabel':label,'source':SOURCE+'#'+f'{code}.{c}:1','dashed':dashed}
                # Single-verse endpoints in consecutive chapters describe one
                # cross-chapter passage, sometimes with the dash omitted in mail.
                if entries and v is not None and endv==v:
                    prev=entries[-1]
                    if prev['book']==code and prev['start'][1] is not None and prev['start']==prev['end'] and c>prev['start'][0]:
                        prev['end']=[c,v];prev['sourceLabel']+=' — '+label;continue
                entries.append(item)
            if block[cursor:].strip():raise ValueError(f'Unparsed trailing text on day {day}: {block[cursor:]}')
            if not entries:raise ValueError(f'No assignments for day {day}')
            for n,r in enumerate(entries):
                r.pop('dashed');r['id']=f'd{day:03}-r{n:02}'
                a,b=r['start'],r['end'];ref=f"{r['book']}.{a[0]}"
                if a[1] is not None:ref+=':'+str(a[1])
                if b!=a:ref+='–'+(str(b[0])+':' if b[0]!=a[0] else '')+str(b[1])
                r['reference']=ref
            item={'number':day,'status':'assigned','readings':entries}
            if day in result and result[day]['readings']!=entries:raise ValueError(f'Conflicting plans for day {day}')
            result[day]=item
    return result,corrections

def reference(reading):
    a,b=reading['start'],reading['end']
    ref=f"{reading['book']}.{a[0]}"
    if a[1] is not None:ref+=':'+str(a[1])
    if b!=a:
        if b[0]!=a[0]:ref+='–'+str(b[0])+(':'+str(b[1]) if b[1] is not None else '')
        else:ref+='–'+str(b[1])
    return ref

def parse_official():
    rows=json.loads((CACHE/'official-plan-rows.json').read_text(encoding='utf-8'))
    result={};notes=[]
    pattern=re.compile(r'([А-Яа-яЁё][А-Яа-яЁё\s]+?)\s*(\d+)(?::(\d+))?(?:\s*[–—-]\s*(\d+)(?::(\d+))?)?')
    for row in rows:
        day=int(re.fullmatch(r'День\s+(\d+)',row['cells'][0])[1]);entries=[]
        for column in range(1,4):
            label=re.sub(r'\s+',' ',row['cells'][column]).strip()
            links=row['cellSources'][column]
            codes={urllib.parse.unquote(urllib.parse.urlsplit(u).fragment).split('.')[0] for u in links}
            if len(codes)!=1:raise ValueError(f'Expected one source book: {day}/{column}: {codes}')
            code=codes.pop();parts=[];end=0
            for m in pattern.finditer(label):
                if label[end:m.start()].strip(' –—-'):raise ValueError(f'Unparsed PDF text: {day}: {label}')
                title=m[1].strip();c=int(m[2]);v=int(m[3]) if m[3] else None;ec=c;ev=v
                if m[5]:ec=int(m[4]);ev=int(m[5])
                elif m[4]:
                    if v is None:ec=int(m[4]);ev=None
                    else:ev=int(m[4])
                parts.append({'book':code,'title':title,'start':[c,v],'end':[ec,ev],'sourceLabel':m[0].strip(),'source':SOURCE+'#'+f'{code}.{c}:1','section':'Новый Завет' if column==2 else 'Ветхий Завет'})
                end=m.end()
            if not parts and label=='Послание апостола Иуды':
                parts=[{'book':code,'title':label,'start':[1,None],'end':[1,None],'sourceLabel':label,'source':SOURCE+'#'+f'{code}.1:1','section':'Новый Завет'}];end=len(label)
            if not parts or label[end:].strip(' –—-'):raise ValueError(f'Unparsed PDF cell: {day}: {label}')
            if len(parts)>1 and parts[0]['start'][1] is not None and parts[-1]['end'][1] is not None:
                if not all(p['start']==p['end'] for p in parts):raise ValueError(f'Complex PDF range {day}: {label}')
                parts[0]['end']=parts[-1]['end'];parts[0]['sourceLabel']=label;parts=parts[:1]
            for r in parts:
                if r['start']>r['end']:raise ValueError(f'Reversed PDF range: {day}: {label}')
                r['reference']=reference(r);r['id']=f'd{day:03}-r{len(entries):02}';entries.append(r)
        if day in result:raise ValueError(f'Duplicate day {day}')
        result[day]={'number':day,'status':'assigned','readings':entries}
        if day in [92,106,296]:
            note={92:'В PDF-плане указаны главы Чис.32 и Чис.34. Глава Чис.33 в назначения не включена; порядок источника сохранён.',106:'В PDF-плане указаны Втор.25 и Втор.27. Глава Втор.26 в назначения не включена; порядок источника сохранён.',296:'В PDF-плане назначено Дан.11:21–45 после Дан.11:1–19 в предыдущем дне. Стих 11:20 в назначения не включён; границы источника сохранены.'}[day]
            result[day]['notes']=[note];notes.append({'day':day,'note':note})
        extra_notes={118:'В PDF-плане после Нав.15 указана Нав.17. Глава Нав.16 в назначения не включена; порядок источника сохранён.',139:'PDF-план заканчивает отрывок на Ин.7:52. Стих Ин.7:53 в назначения не включён; границы источника сохранены.',198:'PDF-план заканчивает чтение главы Деян.20 на стихе 34. Стихи 20:35–38 в назначения не включены; границы источника сохранены.',201:'В PDF-плане чтение заканчивается на Еккл.4:16. В библиотеке Синодального перевода есть также стих 4:17, не включённый в назначения; границы источника сохранены.'}
        if day in extra_notes:
            result[day]['notes']=[extra_notes[day]];notes.append({'day':day,'note':extra_notes[day]})
    if sorted(result)!=list(range(1,366)):raise ValueError('Incomplete official PDF plan')
    return result,notes

def build(limit=None,allow_partial=False):
    records,corrections=parse_official()
    expected=range(1,(limit or 365)+1)
    missing=[n for n in expected if n not in records]
    report={'preparedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'assignedDays':len(records),'missingDays':[n for n in range(1,366) if n not in records],'corrections':corrections}
    (ROOT/'import-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    if missing and not allow_partial:raise ValueError('The source plan is incomplete: '+str(missing))
    library={'schema':1,'translation':'Русский Синодальный перевод','source':SOURCE,'chapters':{}}
    books={};ready=[];chapter_total=0
    for number in expected:
        if number not in records:
            ready.append({'number':number,'status':'pending','readings':[]});continue
        day=records[number]
        for reading in day['readings']:
            for c in range(reading['start'][0],reading['end'][0]+1):
                key=f"{reading['book']}.{c}"
                if key not in library['chapters']:
                    title,verses=chapter(reading['book'],c);books[reading['book']]=title;library['chapters'][key]=verses;chapter_total+=1
                verses=library['chapters'][key]
                lo=reading['start'][1] if c==reading['start'][0] and reading['start'][1] is not None else verses[0]['number']
                hi=reading['end'][1] if c==reading['end'][0] and reading['end'][1] is not None else verses[-1]['number']
                if number==363 and reading['book']=='Мл' and c==4 and hi==7 and verses[-1]['number']==6:
                    reading['sourceEnd']=[4,7];reading['end']=[4,6];hi=6;reading['reference']=reference(reading)
                    reading['sourceIssue']='В PDF-плане этот отрывок заканчивается на Мл.4:7, но в Синодальном переводе глава 4 содержит 6 стихов. Здесь показан существующий текст Мл.2:10–4:6. Исходная запись плана требует уточнения.'
                    corrections.append({'day':number,'original':reading['sourceLabel'],'note':reading['sourceIssue']})
                if lo>hi or lo not in [v['number'] for v in verses] or hi not in [v['number'] for v in verses]:raise ValueError(f'Range outside source verses: day {number}, {reading["reference"]}, {lo}–{hi}; chapter ends {verses[-1]["number"]}')
        day['status']='ready';ready.append(day)
        print(f'Day {number}: ready; {chapter_total} chapters',flush=True)
    library['books']=books
    library_raw=json.dumps(library,ensure_ascii=False,separators=(',',':'))
    plan={'schema':1,'planId':'patriarchal-bible-year-v1','title':'Библия за год','totalDays':365,'sourceTitle':'Официальный PDF-план курса «Исследуйте Писания»','source':'https://izuchaem-bibliu.ru/biblia-za-god','generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'librarySha256':hashlib.sha256(library_raw.encode()).hexdigest(),'days':ready,'corrections':corrections}
    OUT.mkdir(parents=True,exist_ok=True)
    for name,payload in [('plan.json',plan),('library.json',library)]:
        path=OUT/name;temp=path.with_suffix('.tmp');temp.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8');temp.replace(path)
    print(json.dumps({'readyDays':sum(d['status']=='ready' for d in ready),'chapters':chapter_total,'missingDays':missing},ensure_ascii=False))
    pdf=CACHE/'official-reading-plan.pdf';metadata=CACHE/'official-plan-metadata.json'
    pdf_hash=hashlib.sha256(pdf.read_bytes()).hexdigest() if pdf.exists() else json.loads(metadata.read_text(encoding='utf-8'))['sha256']
    if not metadata.exists():metadata.write_text(json.dumps({'sha256':pdf_hash,'pages':27,'rows':365,'title':'Библия за год — план чтений на год'},ensure_ascii=False,indent=2),encoding='utf-8')
    report.update({'readyDays':sum(d['status']=='ready' for d in ready),'chapters':chapter_total,'passages':sum(len(d['readings']) for d in ready),'sourcePdfSha256':pdf_hash,'corrections':corrections,'textNormalizations':[{'chapter':'Деян.19','note':'В библиотеке курса стихи 40 и 41 объединены под номером 40. Заключительное предложение «Сказав это, он распустил собрание.» выделено в стих 41 без изменения слов.'}]})
    (ROOT/'import-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--limit',type=int);p.add_argument('--allow-partial',action='store_true');args=p.parse_args();build(args.limit,args.allow_partial)
