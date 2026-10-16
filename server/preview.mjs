// Personal local preview. Never bind this development server to a public IP.
// OAuth credentials live only in memory; restarting disconnects ChatGPT.
import http from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {signIn} from './setup.mjs';
import {newHostId,refresh,AUTH} from './oauth.mjs';
import {availableModels,explain} from './explain.mjs';
import {readingVerses} from '../dist/model.mjs';
const root=path.resolve(fileURLToPath(new URL('../dist/',import.meta.url))),port=8767,origin='http://127.0.0.1:'+port;
let credentials=null,models=[],connecting=false,connectUrl=null,connectError=null,busy=false,renewing=null,daily={day:'',count:0};
let hostId;const hostFile=new URL('../local-host-id.json',import.meta.url);
try{hostId=JSON.parse(await readFile(hostFile,'utf8')).hostId;}catch{hostId=newHostId();await writeFile(hostFile,JSON.stringify({hostId}),{flag:'wx'});}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'};
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const part of req){text+=part;if(Buffer.byteLength(text)>10000)throw Error('Слишком большой запрос');}return JSON.parse(text||'{}');}
async function token(){if(!credentials)throw Error('Сначала подключите ChatGPT');if(credentials.expires_at<Date.now()+60000){if(!renewing)renewing=refresh(credentials).then(v=>credentials=v).finally(()=>renewing=null);await renewing;}return credentials.access_token;}
async function connect(){if(connecting||credentials)return;connecting=true;connectUrl=null;connectError=null;
  try{credentials=await signIn({hostId,onUrl:url=>{connectUrl=url;}});models=await availableModels(await token());connectUrl=null;}catch{credentials=null;models=[];connectUrl=null;connectError='Не удалось завершить вход. Подключение подписки может быть недоступно для аккаунта или приложения.';}finally{connecting=false;}
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,origin);res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)){send(res,403,{error:'Неверный адрес сервера'});return;}
  if(url.pathname.startsWith('/api/')){
    if(req.headers.origin&&req.headers.origin!==origin){send(res,403,{error:'Недопустимый источник запроса'});return;}
    if(req.method==='POST'&&req.headers.origin!==origin){send(res,403,{error:'Запрос должен быть сделан из приложения'});return;}
    try{
      if(url.pathname==='/api/status'&&req.method==='GET'){send(res,200,{canConnect:true,ready:!!credentials,connecting,error:connectError,models});return;}
      if(url.pathname==='/api/connect'&&req.method==='POST'){connect();send(res,202,{connecting:true});return;}
      if(url.pathname==='/api/connect-url'&&req.method==='GET'){send(res,200,{url:connectUrl});return;}
      if(url.pathname==='/api/disconnect'&&req.method==='POST'){
        if(connecting)throw Error('Сначала завершите или отмените открытый вход');let revoked=false;
        if(credentials?.refresh_token){try{const d=await(await fetch(AUTH+'/.well-known/openid-configuration',{signal:AbortSignal.timeout(10000)})).json();if(new URL(d.revocation_endpoint).origin!==AUTH)throw Error();const r=await fetch(d.revocation_endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:credentials.refresh_token,token_type_hint:'refresh_token',client_id:credentials.client_id}),signal:AbortSignal.timeout(10000)});revoked=r.ok;}catch{}}
        credentials=null;models=[];send(res,200,{revoked});return;
      }
      if(url.pathname==='/api/explain'&&req.method==='POST'){
        if(busy){send(res,429,{error:'Дождитесь предыдущего пояснения'});return;}
        const request=await body(req);if(!models.some(m=>m.slug===request.model))throw Error('Выберите доступную модель');
        const day=new Date().toISOString().slice(0,10);if(daily.day!==day)daily={day,count:0};if(daily.count>=30){send(res,429,{error:'Достигнут установленный лимит: 30 пояснений в день'});return;}
        const plan=JSON.parse(await readFile(path.join(root,'data/plan.json'),'utf8')),library=JSON.parse(await readFile(path.join(root,'data/library.json'),'utf8'));
        const reading=plan.days.flatMap(d=>d.readings).find(r=>r.id===request.readingId);if(!reading)throw Error('Отрывок не найден');
        const text=readingVerses(reading,library).map(v=>v.chapter+':'+v.number+' '+v.text).join('\n');
        if(typeof request.question!=='string'||!request.question.trim()||request.question.length>1500)throw Error('Вопрос должен содержать от 1 до 1500 символов');
        busy=true;daily.count++;try{const answer=await explain({accessToken:await token(),model:request.model,reference:reading.reference,text,question:request.question});send(res,200,{answer,reference:reading.reference,model:models.find(m=>m.slug===request.model)?.display_name});}finally{busy=false;}return;
      }send(res,404,{error:'Нет такого действия'});
    }catch(e){send(res,400,{error:e.message});}return;
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
  try{const rel=decodeURIComponent(url.pathname).replace(/^\/+/,''),target=path.resolve(root,rel||'index.html');if(target!==root&&!target.startsWith(root+path.sep))throw Error();const bytes=await readFile(target);res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);}catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log('Local preview:',origin));
