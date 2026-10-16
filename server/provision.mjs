// Workstation-only provisioning. Credentials travel from RAM to the VM via SSH stdin.
// This tool never writes credentials to workstation files or logs.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {signIn} from './setup.mjs';
const {values}=parseArgs({options:{host:{type:'string'},identity:{type:'string'},'known-hosts':{type:'string'},origin:{type:'string'},'client-id':{type:'string'}}});
if(!/^[a-zA-Z0-9_.@-]+$/.test(values.host||'')||new URL(values.origin).protocol!=='https:'||new URL(values.origin).origin!==values.origin||!values.identity||!values['known-hosts'])throw Error('Explicit SSH host, identity, known-hosts and HTTPS origin required');
const args=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=15','-i',values.identity,'-o','UserKnownHostsFile='+values['known-hosts'],values.host];
function ssh(command,input=''){return new Promise((resolve,reject)=>{let output='',error='';const child=spawn('ssh',[...args,command],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);child.on('error',()=>reject(Error('SSH unavailable')));child.on('close',code=>code===0?resolve(output.trim()):reject(Error('VM provisioning failed; check the service without logging credentials')));child.stdin.on('error',()=>{});child.stdin.end(input);});}
const remote='/opt/bible-year-node/current/bin/node /opt/bible-year/current/server/admin.mjs';
const registration=JSON.parse(await ssh('runuser -u bible-year -- '+remote+' registration')),hostId=registration.hostId;if(!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId))throw Error('Invalid VM host identity');
if(values['client-id']){if(!/^oaiapp_[A-Za-z0-9_-]+$/.test(values['client-id'])||(registration.clientId&&registration.clientId!==values['client-id']))throw Error('Mismatched saved registration');registration.clientId=values['client-id'];}
let started=false,complete=false,failed=false;
const local='http://127.0.0.1:8769';
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.host!=='127.0.0.1:8769'){res.writeHead(403);res.end();return;}
  if(req.url==='/start'&&req.method==='POST'){
    if(req.headers.origin!==local||started){res.writeHead(403);res.end();return;}started=true;
    let resolveUrl;const urlReady=new Promise(resolve=>resolveUrl=resolve);
    signIn({hostId,clientId:registration.clientId,port:1458,onUrl:url=>resolveUrl(url),onAuthorized:async credentials=>{
      const code=await ssh('systemctl stop bible-year.service && (runuser -u bible-year -- '+remote+' import; result=$?; systemctl start bible-year.service; exit $result)',JSON.stringify(credentials));
      if(!/^[A-Za-z0-9_-]{43}$/.test(code))throw Error('Invalid pairing result');return values.origin+'/bible/#owner/'+code;
    }}).then(()=>{complete=true;setTimeout(()=>server.close(),30000);}).catch(()=>{failed=true;resolveUrl(null);});
    const url=await urlReady;res.writeHead(url?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify(url?{url}:{error:'Не удалось начать вход'}));return;
  }
  if(req.url==='/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({started,complete,failed}));return;}
  if(req.url!=='/'||req.method!=='GET'){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Подключение Библии за год</title><body style="max-width:620px;margin:60px auto;padding:24px;font:20px/1.6 system-ui;background:#f7f5ee;color:#244b42"><h1>Подключить ChatGPT к приложению</h1><p>Войдите в свой аккаунт OpenAI. Подключение будет передано по защищённому SSH-соединению вашему серверу. Токены не сохраняются на этом компьютере.</p><button id="start" style="font:inherit;padding:16px">Continue with ChatGPT</button><p id="status"></p><script>document.querySelector('button').onclick=async()=>{document.querySelector('button').disabled=true;try{const r=await fetch('/start',{method:'POST'}),d=await r.json();if(!r.ok)throw Error();if(new URL(d.url).origin!=='https://auth.openai.com')throw Error();location.assign(d.url);}catch{document.querySelector('#status').textContent='Не удалось начать вход. Проверьте подключение на компьютере.';}};</script></body></html>`);
});server.listen(8769,'127.0.0.1',()=>console.log('Local provisioning page ready: http://127.0.0.1:8769/'));
