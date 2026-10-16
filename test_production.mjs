import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {StateStore} from './server/state.mjs';
import {createAPI} from './server/production.mjs';
import {request as httpRequest} from 'node:http';
test('Production API protects plan usage, consumes pairing links once, persists login and quota',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'bible-api-test-')),directory=path.join(root,'private'),dataRoot=path.join(root,'data'),origin='https://example.com';
  await mkdir(dataRoot);const reading={id:'d001-r00',book:'Быт',reference:'Быт.1:1',start:[1,1],end:[1,1]};
  await writeFile(path.join(dataRoot,'plan.json'),JSON.stringify({schema:1,planId:'patriarchal-bible-year-v1',days:Array.from({length:365},(_,i)=>({number:i+1,status:'ready',readings:i?[]:[reading]}))}));
  await writeFile(path.join(dataRoot,'library.json'),JSON.stringify({chapters:{'Быт.1':[{number:1,text:'TEST FIXTURE'}]}}));
  let modelCalls=0,explanationCalls=0,refreshCalls=0;
  const options={directory,dataRoot,origin,getModels:async()=>{modelCalls++;return [{slug:'test',display_name:'Test'}];},getExplanation:async()=>{explanationCalls++;return 'Completed test explanation';},refreshToken:async c=>{refreshCalls++;return {...c,access_token:'rotated-test-only',expires_at:Date.now()+3600000};}};
  let app;async function boot(){app=await createAPI(options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+app.server.address().port;}
  let address=await boot();const req=(route,{method='GET',cookie,origin:requestOrigin=origin,data}={})=>new Promise((resolve,reject)=>{const call=httpRequest(address+'/api/'+route,{method,headers:{Host:'example.com',Origin:requestOrigin,...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:Object.fromEntries(Object.entries(res.headers).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value]))})));});call.on('error',reject);call.end(method==='POST'?JSON.stringify(data||{}):undefined);});
  try{
    assert.equal((await req('status')).status,200);assert.equal((await(await req('status')).json()).owner,false);assert.equal(modelCalls,0);
    assert.equal((await req('explain',{method:'POST',data:{}})).status,401);assert.equal(explanationCalls,0);
    const initial=await app.store.importCredentials({client_id:'test-client',subject:'test-owner',issuer:'https://auth.openai.com',access_token:'expired-test-only',refresh_token:'refresh-test-only',expires_at:0,ext_agent_host_id:app.store.data.hostId,scopes:['resource.invoke','chatgpt.tokens.use.direct']});
    assert.equal((await req('auth/pair',{method:'POST',origin:'https://other.invalid',data:{code:initial.code}})).status,403);
    const paired=await req('auth/pair',{method:'POST',data:{code:initial.code}});assert.equal(paired.status,200);
    const header=paired.headers.get('set-cookie');assert.match(header,/Secure; HttpOnly; SameSite=Strict/);assert.match(header,/Path=\/bible\/api\//);const ownerCookie=header.split(';')[0];
    assert.equal((await req('auth/pair',{method:'POST',data:{code:initial.code}})).status,401);
    const status=await(await req('status',{cookie:ownerCookie})).json();assert.equal(status.ready,true);assert.equal(refreshCalls,1);assert.equal(status.access_token,undefined);
    assert.equal((await req('explain',{method:'POST',cookie:ownerCookie,origin:'null',data:{}})).status,403);
    const question={readingId:reading.id,model:'test',question:'Test?'};
    assert.equal((await req('explain',{method:'POST',cookie:ownerCookie,data:{...question,readingId:'missing'}})).status,400);
    assert.equal((await req('explain',{method:'POST',cookie:ownerCookie,data:question})).status,200);assert.equal(explanationCalls,1);
    await new Promise(r=>app.server.close(r));address=await boot();assert.equal((await(await req('status',{cookie:ownerCookie})).json()).ready,true);
    assert.equal(app.store.data.daily.count,1);app.store.data.daily.count=30;await app.store.save();
    assert.equal((await req('explain',{method:'POST',cookie:ownerCookie,data:question})).status,429);assert.equal(explanationCalls,1);
    const disk=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));assert.equal(disk.credentials.access_token,'rotated-test-only');assert.equal(JSON.stringify(disk).includes(ownerCookie.slice(ownerCookie.indexOf('=')+1)),false);
    if(process.platform!=='win32')assert.equal((await stat(path.join(directory,'state.json'))).mode&0o777,0o600);
    assert.equal((await req('auth/logout',{method:'POST',cookie:ownerCookie})).status,200);assert.equal((await(await req('status',{cookie:ownerCookie})).json()).owner,false);
    const expired=await app.store.createPair();app.store.data.pairs[Object.keys(app.store.data.pairs)[0]].expiresAt=0;assert.equal(await app.store.pair(expired.code),null);
    const reopened=await StateStore.open(directory);assert.equal(reopened.data.hostId,app.store.data.hostId);
  }finally{await new Promise(r=>app.server.close(r));await rm(root,{recursive:true,force:true});}
});
