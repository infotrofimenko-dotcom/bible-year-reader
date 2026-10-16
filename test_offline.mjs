import assert from 'node:assert/strict';import fs from 'node:fs/promises';import vm from 'node:vm';
const source=await fs.readFile(new URL('./dist/sw.js',import.meta.url),'utf8'),storage=new Map();let offline=false,revision='one',failWrite=0,writes=0;
const key=r=>typeof r==='string'?r:r.url;
const caches={async open(name){if(!storage.has(name))storage.set(name,new Map());const map=storage.get(name);return {async match(r){return map.get(key(r))?.clone();},async put(r,response){if(name.includes('library-')&&failWrite&&++writes===failWrite)throw Error('Quota exceeded');map.set(key(r),response.clone());},async addAll(urls){for(const u of urls)map.set(u,new Response('shell '+u));}};},async delete(n){return storage.delete(n);},async keys(){return [...storage.keys()];}};
function boot(){const handlers={},self={location:{href:'https://example.com/bible/sw.js',origin:'https://example.com'},clients:{claim:async()=>{}},skipWaiting:async()=>{},addEventListener:(name,fn)=>handlers[name]=fn};
 const context=vm.createContext({self,caches,URL,Response,Request,Date,Math,JSON,TextEncoder,Uint8Array,crypto,AbortSignal,fetch:async r=>{if(offline)throw Error('Offline');const url=key(r);return new Response(url.endsWith('plan.json')?JSON.stringify({schema:1,planId:'patriarchal-bible-year-v1',generatedAt:revision,days:Array.from({length:365},()=>({status:'ready'}))}):url.endsWith('library.json')?JSON.stringify({schema:1,revision}):revision+' '+url);}});
 vm.runInContext(source+'\nthis.testAPI={saveLibrary,status};',context);return {api:context.testAPI,handlers};}
let {api,handlers}=boot();assert.equal((await api.status()).ready,false);
await new Promise(resolve=>handlers.install({waitUntil:p=>p.then(resolve)}));await api.saveLibrary();assert.equal((await api.status()).ready,true);assert.equal((await api.status()).version,'one');
offline=true;await assert.rejects(api.saveLibrary(),/Offline/);assert.equal((await api.status()).version,'one');
function fetchThrough(req){let response;handlers.fetch({request:req,respondWith:p=>response=p});return response;}
let response=await fetchThrough(new Request('https://example.com/bible/data/library.json'));assert.equal((await response.json()).revision,'one');
response=await fetchThrough({url:'https://example.com/bible/',method:'GET',mode:'navigate'});assert.match(await response.text(),/^shell /);
assert.equal(fetchThrough(new Request('https://example.com/bible/api/status')),undefined);assert.equal(fetchThrough(new Request('https://example.com/other/')),undefined);
offline=false;revision='two';failWrite=2;writes=0;await assert.rejects(api.saveLibrary(),/Quota/);assert.equal((await api.status()).version,'one');assert.equal((await caches.keys()).filter(x=>x.includes('library-')).length,1);
failWrite=0;await api.saveLibrary();assert.equal((await api.status()).version,'two');assert.equal((await caches.keys()).filter(x=>x.includes('library-')).length,1);
({api,handlers}=boot());offline=true;assert.equal((await api.status()).ready,true);response=await fetchThrough(new Request('https://example.com/bible/data/library.json'));assert.equal((await response.json()).revision,'two');
console.log('PASS: offline shell and texts, worker restart, failed network/quota updates retain previous complete library; API and other sites are untouched.');
