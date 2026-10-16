// Run locally only when the owner is ready to authorize this app in ChatGPT.
// Credentials stay in memory and are delivered to the caller, never stdout.
import http from 'node:http';
import {begin,complete} from './oauth.mjs';
export async function signIn({hostId,clientId,onUrl,port=1457}){
  return new Promise((resolve,reject)=>{
    let pending,handled=false;const timer=setTimeout(()=>{server.close();reject(Error('Sign-in timed out'));},10*60*1000);
    const finish=(error,value)=>{clearTimeout(timer);server.close();error?reject(error):resolve(value);};
    const server=http.createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'");
      const u=new URL(req.url,'http://127.0.0.1:'+port);if(u.pathname!=='/auth/callback'){res.writeHead(404);res.end();return;}
      if(handled){res.writeHead(409);res.end('Вход уже обрабатывается.');return;}handled=true;
      try{const credentials=await complete(u.href,pending);res.end('<h1>ChatGPT подключён</h1><p>Вернитесь в приложение. Эту вкладку можно закрыть.</p>');finish(null,credentials);}catch(e){res.writeHead(400);res.end('<h1>Вход не завершён</h1><p>Вернитесь в приложение и начните вход заново.</p>');finish(e);}
    });
    server.once('error',e=>finish(e));server.listen(port,'127.0.0.1',()=>{const flow=begin({hostId,clientId,redirectUri:'http://127.0.0.1:'+port+'/auth/callback'});pending=flow.pending;Promise.resolve(onUrl(flow.url)).catch(e=>finish(e));});
  });
}
