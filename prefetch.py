"""Sequential, cached download of public chapters used by the official plan."""
import import_data as m
import json
records,_=m.parse_official()
keys=list(dict.fromkeys((r['book'],c) for d in records.values() for r in d['readings'] for c in range(r['start'][0],r['end'][0]+1)))
errors=[]
for n,(book,c) in enumerate(keys,1):
    try:m.chapter(book,c)
    except Exception as e:
        errors.append({'book':book,'chapter':c,'error':str(e)})
        print('ERROR',book,c,str(e),flush=True)
    if n%20==0:print(f'{n}/{len(keys)} chapters; errors={len(errors)}',flush=True)
(m.ROOT/'prefetch-report.json').write_text(json.dumps({'chapters':len(keys),'errors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
print('Finished',len(keys),'chapters;',len(errors),'errors',flush=True)
