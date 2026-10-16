const VERSION='20261016-3',BASE=new URL('./',self.location.href).href,NS='bible-year@'+new URL(BASE).pathname+'@',SHELL=NS+'shell-'+VERSION,META=NS+'metadata',POINTER=new URL('offline-library',BASE).href;
const SHELL_FILES=['./','index.html','style.css','app.js','model.mjs','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png'];
const DATA_FILES=['data/plan.json','data/library.json'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(SHELL);await cache.addAll(SHELL_FILES.map(p=>new URL(p,BASE).href));await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
async function activeLibrary(){try{const pointer=await(await caches.open(META)).match(POINTER);if(!pointer)return null;const data=await pointer.json();if(typeof data.cache!=='string'||!data.cache.startsWith(NS+'library-'))return null;return data;}catch{return null;}}
async function status(){const info=await activeLibrary();if(!info)return {ready:false};const cache=await caches.open(info.cache);for(const file of DATA_FILES)if(!await cache.match(new URL(file,BASE).href))return {ready:false};return {ready:true,savedAt:info.savedAt,version:info.version};}
async function saveLibrary(){
  const name=NS+'library-'+Date.now()+'-'+Math.random().toString(36).slice(2),stage=await caches.open(name);let committed=false;
  try{
    let plan;for(const path of DATA_FILES){const url=new URL(path,BASE).href,response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Ошибка загрузки библиотеки');const raw=await response.clone().text(),data=JSON.parse(raw);if(data.schema!==1)throw Error('Неподдерживаемые данные');
      if(path.endsWith('plan.json')){plan=data;if(plan.planId!=='patriarchal-bible-year-v1'||plan.days.length!==365||plan.days.some(d=>d.status!=='ready'))throw Error('Неполный план');}
      else if(plan.librarySha256){const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==plan.librarySha256)throw Error('Файлы библиотеки не совпадают. Повторите сохранение.');}
      await stage.put(url,response);
    }
    const pointer={cache:name,savedAt:new Date().toISOString(),version:plan.generatedAt};
    await(await caches.open(META)).put(POINTER,new Response(JSON.stringify(pointer),{headers:{'Content-Type':'application/json'}}));committed=true;
    for(const key of await caches.keys())if(key.startsWith(NS)&&key!==SHELL&&key!==META&&key!==name)await caches.delete(key);
    return status();
  }finally{if(!committed)await caches.delete(name);}
}
self.addEventListener('message',event=>{const port=event.ports[0];if(!port||!['SAVE','STATUS'].includes(event.data?.type))return;event.waitUntil((async()=>{try{const data=event.data.type==='SAVE'?await saveLibrary():await status();port.postMessage({ok:true,...data});}catch(e){port.postMessage({ok:false,error:e.message});}})());});
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||!request.url.startsWith(BASE))return;
  const relative=url.href.slice(BASE.length).split('?')[0];if(relative.startsWith('api/'))return;
  event.respondWith((async()=>{
    try{const response=await fetch(request,{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Сеть недоступна');if(!DATA_FILES.includes(relative)&&(request.mode==='navigate'||SHELL_FILES.includes(relative)))await(await caches.open(SHELL)).put(request,response.clone());return response;}
    catch{if(DATA_FILES.includes(relative)){const info=await activeLibrary();if(info){const hit=await(await caches.open(info.cache)).match(new URL(relative,BASE).href);if(hit)return hit;}return new Response('Библиотека не сохранена',{status:503});}
      const cache=await caches.open(SHELL);return await cache.match(request)||(request.mode==='navigate'?await cache.match(new URL('index.html',BASE).href):null)||new Response('',{status:503});
    }
  })());
});
