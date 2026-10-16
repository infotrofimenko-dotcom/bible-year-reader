// Run as the service account over an authenticated SSH connection. Never log stdin.
import {StateStore} from './state.mjs';
const store=await StateStore.open(process.env.BIBLE_STATE_DIR||'/var/lib/bible-year');
const command=process.argv[2];
if(command==='host')process.stdout.write(store.data.hostId);
else if(command==='registration')process.stdout.write(JSON.stringify({hostId:store.data.hostId,clientId:store.data.registration?.clientId||store.data.credentials?.client_id}));
else if(command==='import'){
  let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>100000)throw Error('Input too large');}
  const pair=await store.importCredentials(JSON.parse(input));process.stdout.write(pair.code);
}else if(command==='pair'){const pair=await store.createPair();process.stdout.write(pair.code);}
else throw Error('Expected host, registration, import or pair');
