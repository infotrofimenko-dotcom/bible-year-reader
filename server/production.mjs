import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {StateStore} from './state.mjs';
import {availableModels,explain} from './explain.mjs';
import {refresh,AUTH} from './oauth.mjs';
import {readingVerses,PLAN_ID} from '../dist/model.mjs';
const COOKIE='bible_owner';
function cookie(req){return req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);}
async function body(req){let value='';for await(const chunk of req){value+=chunk;if(Buffer.byteLength(value)>10000)throw Error('Слишком большой запрос');}return JSON.parse(value||'{}');}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
export async function createAPI({directory,dataRoot,origin,basePath='/bible',getModels=availableModels,getExplanation=explain,refreshToken=refresh}){
  if(new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin||!/^\/[a-z0-9-]+$/.test(basePath))throw Error('Invalid public origin or base path');
  const store=await StateStore.open(directory);
  const plan=JSON.parse(await readFile(path.join(dataRoot,'plan.json'),'utf8')),library=JSON.parse(await readFile(path.join(dataRoot,'library.json'),'utf8'));
  if(plan.schema!==1||plan.planId!==PLAN_ID||plan.days.length!==365||plan.days.some(d=>d.status!=='ready'))throw Error('Invalid library');
  const readings=new Map(plan.days.flatMap(d=>d.readings.map(r=>[r.id,r])));let busy=false,renewing=null,catalog=null,catalogAt=0;const attempts={since:Date.now(),count:0};
  async function token(){const c=store.data.credentials;if(!c)throw Error('Подписка не подключена');if(c.expires_at<Date.now()+60000){if(!renewing)renewing=(async()=>{const next=await refreshToken(c);store.data.credentials=next;await store.save();return next.access_token;})().finally(()=>renewing=null);return renewing;}return c.access_token;}
  async function models(){if(!catalog||Date.now()-catalogAt>600000){catalog=await getModels(await token());catalogAt=Date.now();}return catalog;}
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(origin).host){send(res,403,{error:'Неверный адрес сервера'});return;}
      const route=new URL(req.url,origin).pathname;
      if(req.headers.origin&&req.headers.origin!==origin){send(res,403,{error:'Недопустимый источник запроса'});return;}
      if(req.method==='POST'&&(req.headers.origin!==origin||!(req.headers['content-type']||'').startsWith('application/json'))){send(res,403,{error:'Откройте приложение по его адресу'});return;}
      if(route==='/api/health'&&req.method==='GET'){send(res,200,{service:'bible-year',version:1,days:365,passages:readings.size});return;}
      const owner=store.owner(cookie(req));
      if(route==='/api/status'&&req.method==='GET'){
        if(!owner){send(res,200,{remote:true,owner:false,ready:false,canConnect:false});return;}
        let list=[];try{if(store.data.credentials)list=await models();}catch{send(res,200,{remote:true,owner:true,ready:false,canConnect:false,error:'Подключение ChatGPT требует проверки владельцем на компьютере.'});return;}
        send(res,200,{remote:true,owner:true,ready:!!store.data.credentials&&list.length>0,canConnect:false,models:list});return;
      }
      if(route==='/api/auth/pair'&&req.method==='POST'){
        if(Date.now()-attempts.since>60000){attempts.since=Date.now();attempts.count=0;}if(++attempts.count>60){send(res,429,{error:'Попробуйте через минуту'});return;}
        const value=await body(req),session=await store.pair(value.code);if(!session){send(res,401,{error:'Ссылка уже использована или истекла. Создайте новую на подключённом устройстве.'});return;}
        res.setHeader('Set-Cookie',`${COOKIE}=${session.token}; Path=${basePath}/api/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`);send(res,200,{ok:true});return;
      }
      if(!owner){send(res,401,{error:'Подключите это устройство через настройки на компьютере владельца.'});return;}
      if(route==='/api/auth/device'&&req.method==='POST'){const pair=await store.createPair();send(res,200,{url:origin+basePath+'/#owner/'+pair.code,expiresAt:pair.expiresAt});return;}
      if(route==='/api/auth/logout'&&req.method==='POST'){await store.logout(cookie(req));res.setHeader('Set-Cookie',`${COOKIE}=; Path=${basePath}/api/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);send(res,200,{ok:true});return;}
      if(route==='/api/disconnect'&&req.method==='POST'){
        if(busy||renewing){send(res,409,{error:'Дождитесь завершения пояснения'});return;}let revoked=false;const c=store.data.credentials;
        if(c?.refresh_token){try{const discovery=await(await fetch(AUTH+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)})).json();if(new URL(discovery.revocation_endpoint).origin!==AUTH)throw Error();const r=await fetch(discovery.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:c.refresh_token,token_type_hint:'refresh_token',client_id:c.client_id}),signal:AbortSignal.timeout(10000)});revoked=r.ok;}catch{}}
        store.data.credentials=null;catalog=null;await store.save();send(res,200,{revoked});return;
      }
      if(route==='/api/explain'&&req.method==='POST'){
        if(busy){send(res,429,{error:'Дождитесь предыдущего пояснения'});return;}const request=await body(req),reading=readings.get(request.readingId);
        if(!reading||typeof request.question!=='string'||!request.question.trim()||request.question.length>1500){send(res,400,{error:'Проверьте отрывок и вопрос (до 1500 символов)'});return;}
        busy=true;try{
          const list=await models();if(!list.some(m=>m.slug===request.model)){send(res,400,{error:'Выберите доступную модель'});return;}
          const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow'}).format(new Date());if(store.data.daily.day!==day)store.data.daily={day,count:0};
          if(store.data.daily.count>=30){send(res,429,{error:'Достигнут лимит: 30 запросов в день'});return;}
          const text=readingVerses(reading,library).map(v=>v.chapter+':'+v.number+' '+v.text).join('\n');store.data.daily.count++;await store.save();
          const answer=await getExplanation({accessToken:await token(),model:request.model,reference:reading.reference,text,question:request.question});send(res,200,{answer,reference:reading.reference});
        }finally{busy=false;}return;
      }
      send(res,404,{error:'Нет такого действия'});
    }catch{if(!res.headersSent)send(res,503,{error:'Сервис временно недоступен. Попробуйте позже или проверьте подключение ChatGPT в настройках.'});else res.end();}
  });server.requestTimeout=120000;server.headersTimeout=15000;server.maxHeadersCount=50;server.on('clientError',(_,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  return {server,store};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  const {server}=await createAPI({directory:process.env.BIBLE_STATE_DIR||'/var/lib/bible-year',dataRoot:process.env.BIBLE_DATA_DIR||new URL('../dist/data/',import.meta.url).pathname,origin:process.env.BIBLE_ORIGIN,basePath:process.env.BIBLE_BASE_PATH||'/bible'});
  const port=Number(process.env.BIBLE_PORT||8768);server.listen(port,'127.0.0.1',()=>console.log('Bible Year API ready on loopback.'));
}
