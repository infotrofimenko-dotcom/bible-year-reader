import {mkdir,lstat,readFile,writeFile,rename,chmod,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {newHostId} from './oauth.mjs';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export class StateStore {
  static async open(directory){
    await mkdir(directory,{recursive:true,mode:0o700});
    const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Unsafe state directory');
    if(process.platform!=='win32')await chmod(directory,0o700);
    const store=new StateStore();store.directory=directory;store.file=path.join(directory,'state.json');store.queue=Promise.resolve();
    try{const f=await lstat(store.file);if(!f.isFile()||f.isSymbolicLink())throw Error('Unsafe state file');store.data=JSON.parse(await readFile(store.file,'utf8'));if(process.platform!=='win32')await chmod(store.file,0o600);}
    catch(e){if(e.code!=='ENOENT')throw e;store.data={schema:1,hostId:newHostId(),credentials:null,sessions:{},pairs:{},daily:{day:'',count:0}};await store.save();}
    if(store.data.schema!==1||!store.data.hostId||!store.data.sessions||!store.data.pairs)throw Error('Invalid state');return store;
  }
  save(){
    const raw=JSON.stringify(this.data);const operation=this.queue.then(async()=>{
      const temp=this.file+'.'+secret()+'.tmp';
      try{await writeFile(temp,raw,{mode:0o600,flag:'wx'});await rename(temp,this.file);}catch(e){await unlink(temp).catch(()=>{});throw e;}
    });this.queue=operation.catch(()=>{});return operation;
  }
  cleanup(now=Date.now()){
    for(const [key,value]of Object.entries(this.data.sessions))if(value.expiresAt<=now)delete this.data.sessions[key];
    for(const [key,value]of Object.entries(this.data.pairs))if(value.expiresAt<=now)delete this.data.pairs[key];
  }
  async createPair(){this.cleanup();if(Object.keys(this.data.pairs).length>=5)throw Error('Слишком много ссылок. Подождите 10 минут.');const code=secret(),expiresAt=Date.now()+10*60*1000;this.data.pairs[digest(code)]={expiresAt};await this.save();return {code,expiresAt};}
  async pair(code){
    this.cleanup();if(typeof code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(code)||!this.data.pairs[digest(code)])return null;
    delete this.data.pairs[digest(code)];const token=secret(),expiresAt=Date.now()+30*86400000;
    if(Object.keys(this.data.sessions).length>=10){const oldest=Object.entries(this.data.sessions).sort((a,b)=>a[1].expiresAt-b[1].expiresAt)[0];delete this.data.sessions[oldest[0]];}
    this.data.sessions[digest(token)]={expiresAt};await this.save();return {token,expiresAt};
  }
  owner(token){return typeof token==='string'&&!!this.data.sessions[digest(token)]&&this.data.sessions[digest(token)].expiresAt>Date.now();}
  async logout(token){if(token)delete this.data.sessions[digest(token)];await this.save();}
  async importCredentials(value){
    if(!value||!['client_id','access_token','refresh_token','subject','issuer'].every(k=>typeof value[k]==='string'&&value[k])||value.issuer!=='https://auth.openai.com'||!Number.isFinite(value.expires_at)||!Array.isArray(value.scopes)||!value.scopes.includes('chatgpt.tokens.use.direct')||!value.scopes.includes('resource.invoke')||value.ext_agent_host_id!==this.data.hostId)throw Error('Invalid credential import');
    const previous=this.data.registration?.subject||this.data.credentials?.subject;if(previous&&previous!==value.subject)throw Error('Different owner account');
    this.data.registration={clientId:value.client_id,subject:value.subject};this.data.credentials=value;await this.save();return this.createPair();
  }
}
