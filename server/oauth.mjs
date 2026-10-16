// Sign in with ChatGPT: official public-client flow. No API key is used.
import {randomBytes,randomUUID,createHash,createPublicKey,verify,timingSafeEqual} from 'node:crypto';
export const AUTH='https://auth.openai.com',RESOURCE='https://api.openai.com/v1';
export const SCOPES=['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'];
const b64=b=>b.toString('base64url');
export const newHostId=()=>`urn:uuid:${randomUUID()}`;
export function equal(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
export function begin({hostId,redirectUri,clientId}){
  if(!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId))throw Error('Invalid host ID');
  const cb=new URL(redirectUri);if(cb.hostname!=='127.0.0.1'||cb.protocol!=='http:'||cb.pathname!=='/auth/callback')throw Error('Loopback callback required');
  const pending={hostId,redirectUri,clientId,state:b64(randomBytes(32)),nonce:b64(randomBytes(32)),verifier:b64(randomBytes(48)),startedAt:Date.now()};
  const url=new URL(AUTH+'/api/accounts/authorize');url.search=new URLSearchParams({client_id:clientId||'dynamic_agent_client',...(!clientId?{agent_name_hint:'Библия за год'}:{}),ext_agent_host_id:hostId,response_type:'code',redirect_uri:redirectUri,scope:SCOPES.join(' '),resource:RESOURCE,state:pending.state,nonce:pending.nonce,code_challenge_method:'S256',code_challenge:b64(createHash('sha256').update(pending.verifier).digest())});
  return {url:url.href,pending};
}
async function jsonFetch(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('OpenAI authorization request failed ('+r.status+')');return r.json();}
export function verifyIdentity(token,{jwks,issuer=AUTH,audience,nonce,now=Date.now()/1000}){
  const bits=token.split('.');if(bits.length!==3)throw Error('Invalid ID token');
  const header=JSON.parse(Buffer.from(bits[0],'base64url')),claims=JSON.parse(Buffer.from(bits[1],'base64url'));
  if(header.alg!=='RS256')throw Error('Unsupported ID token algorithm');
  const jwk=jwks.keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.use||k.use==='sig'));if(!jwk)throw Error('Unknown ID token signing key');
  if(!verify('RSA-SHA256',Buffer.from(bits[0]+'.'+bits[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(bits[2],'base64url')))throw Error('Invalid ID token signature');
  const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(claims.iss!==issuer||!audiences.includes(audience)||typeof claims.sub!=='string'||!claims.sub||!Number.isFinite(claims.exp)||claims.exp<now-30||claims.iat>now+60||!equal(claims.nonce,nonce))throw Error('ID token identity checks failed');
  if(audiences.length>1&&claims.azp!==audience)throw Error('Invalid authorized party');
  return {subject:claims.sub,email:typeof claims.email==='string'?claims.email:undefined,issuer:claims.iss};
}
export async function complete(callback,pending){
  if(Date.now()-pending.startedAt>10*60*1000)throw Error('Authorization expired');
  const params=new URL(callback).searchParams;if(!equal(params.get('state'),pending.state))throw Error('Authorization state mismatch');
  if(params.has('error'))throw Error('ChatGPT authorization was not completed');
  const issued=params.get('client_id')||pending.clientId;if(!issued||issued==='dynamic_agent_client'||(pending.clientId&&pending.clientId!==issued))throw Error('Missing or mismatched issued client ID');
  const code=params.get('code');if(!code)throw Error('Missing authorization code');
  const tokens=await jsonFetch(AUTH+'/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:issued,code,code_verifier:pending.verifier,redirect_uri:pending.redirectUri,resource:RESOURCE})});
  const discovery=await jsonFetch(AUTH+'/.well-known/openid-configuration');if(discovery.issuer!==AUTH||new URL(discovery.jwks_uri).origin!==AUTH)throw Error('Unexpected identity provider');
  const identity=verifyIdentity(tokens.id_token,{jwks:await jsonFetch(discovery.jwks_uri),audience:issued,nonce:pending.nonce});
  const scopes=String(tokens.scope||'').split(' ');if(!scopes.includes('chatgpt.tokens.use.direct')||!scopes.includes('resource.invoke')||!tokens.access_token)throw Error('ChatGPT plan usage was not authorized');
  return {...identity,client_id:issued,ext_agent_host_id:pending.hostId,access_token:tokens.access_token,refresh_token:tokens.refresh_token,id_token:tokens.id_token,scopes,expires_at:Date.now()+Number(tokens.expires_in||3600)*1000};
}
export async function refresh(record){
  if(!record.refresh_token)throw Error('Sign in with ChatGPT again');
  const tokens=await jsonFetch(AUTH+'/api/accounts/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:record.client_id,refresh_token:record.refresh_token,resource:RESOURCE})});
  const scopes=tokens.scope?tokens.scope.split(' '):record.scopes;if(!scopes.includes('chatgpt.tokens.use.direct')||!tokens.access_token)throw Error('ChatGPT plan permission is unavailable');
  return {...record,access_token:tokens.access_token,refresh_token:tokens.refresh_token||record.refresh_token,id_token:tokens.id_token||record.id_token,scopes,expires_at:Date.now()+Number(tokens.expires_in||3600)*1000};
}
