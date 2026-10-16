import test from 'node:test';import assert from 'node:assert/strict';
import {defaults,validateState,mergeState,dayDone,nextReading,readingVerses,PLAN_ID} from './dist/model.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {begin,newHostId,verifyIdentity} from './server/oauth.mjs';
import {explain} from './server/explain.mjs';
test('Resume finds the first unread passage, including gaps behind later read days',()=>{
 const s=defaults(),days=[{number:1,status:'ready',readings:[{id:'d001-r00'},{id:'d001-r01'}]},{number:2,status:'ready',readings:[{id:'d002-r00'}]}];
 s.read['d002-r00']=true;s.read['d001-r00']=true;assert.equal(nextReading(s,days).reading.id,'d001-r01');assert.equal(dayDone(s,days[0]),false);
 s.read['d001-r01']=true;assert.equal(dayDone(s,days[0]),true);assert.equal(nextReading(s,days),null);
});
test('Restore merges marks and rejects foreign backups and unknown IDs',()=>{
 const current=defaults();current.read['d001-r00']=true;const incoming=validateState({schema:1,planId:PLAN_ID,font:999,read:{'d001-r01':true,'d999-r99':true},bookmarks:{'d001-r01':true}},new Set(['d001-r00','d001-r01']));
 assert.equal(incoming.font,34);assert.equal(incoming.read['d999-r99'],undefined);assert.equal(mergeState(current,incoming).read['d001-r00'],true);
 assert.throws(()=>validateState({...incoming,planId:'other'},new Set()));
});
test('Cross-chapter readings include interior chapters and exact endpoints',()=>{
 const library={chapters:{'Евр.4':[{number:13,text:'excluded'},{number:14,text:'start'},{number:15,text:'tail'}],'Евр.5':[{number:1,text:'inside'}],'Евр.6':[{number:1,text:'inside'},{number:12,text:'end'},{number:13,text:'excluded'}]}};
 const reading={book:'Евр',start:[4,14],end:[6,12],reference:'Евр.4:14–6:12'};assert.deepEqual(readingVerses(reading,library).map(v=>v.text),['start','tail','inside','inside','end']);assert.throws(()=>readingVerses({...reading,end:[6,14]},library));
});
test('OAuth uses PKCE, fresh state and the public registration client',()=>{
 const a=begin({hostId:newHostId(),redirectUri:'http://127.0.0.1:1457/auth/callback'}),b=begin({hostId:newHostId(),redirectUri:'http://127.0.0.1:1457/auth/callback'}),u=new URL(a.url);
 assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client');assert.match(u.searchParams.get('scope'),/chatgpt.tokens.use.direct/);assert.notEqual(a.pending.state,b.pending.state);assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.throws(()=>begin({hostId:newHostId(),redirectUri:'http://localhost:1457/auth/callback'}));
});
test('ID token validation rejects a wrong identity, nonce, expiry and forged signature',()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),key={...publicKey.export({format:'jwk'}),kid:'test',use:'sig'},now=Date.now()/1000;
 const make=claims=>{const a=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'),b=Buffer.from(JSON.stringify(claims)).toString('base64url'),data=a+'.'+b;return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');};
 const claims={iss:'https://auth.openai.com',aud:'client',sub:'subject',exp:now+1000,nonce:'right'},options={jwks:{keys:[key]},audience:'client',nonce:'right'};
 assert.equal(verifyIdentity(make(claims),options).subject,'subject');for(const change of [{aud:'other'},{nonce:'wrong'},{exp:now-1000},{iss:'https://other.invalid'}])assert.throws(()=>verifyIdentity(make({...claims,...change}),options));
 const forged=make(claims).split('.');forged[1]=Buffer.from(JSON.stringify({...claims,sub:'other'})).toString('base64url');assert.throws(()=>verifyIdentity(forged.join('.'),options));
});
test('A partial AI stream is never reported as a completed explanation',async()=>{
 const original=globalThis.fetch;try{
  const run=async events=>{globalThis.fetch=async()=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));return explain({accessToken:'test-only',model:'test',reference:'Быт.1',text:'Текст',question:'Смысл?'});};
  assert.equal(await run([{type:'response.output_text.delta',delta:'Ответ'},{type:'response.completed'}]),'Ответ');
  await assert.rejects(run([{type:'response.output_text.delta',delta:'Часть'}]),/Связь прервалась/);
  await assert.rejects(run([{type:'response.output_text.delta',delta:'Часть'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}]),/Лимиты/);
 }finally{globalThis.fetch=original;}
});
