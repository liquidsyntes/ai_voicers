import {db} from '../src/lib/db';
import {decrypt} from '../src/lib/secret';
const credential=await db.credential.findUnique({where:{ownerId:'00000000-0000-4000-8000-000000000001'}});
if(!credential)throw new Error('KEY_MISSING');
try{
  const response=await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${decrypt(credential.cipherText)}`},signal:AbortSignal.timeout(12000)});
  console.log(JSON.stringify({status:response.status,valid:response.ok}));
}catch(error){console.log(JSON.stringify({error:error instanceof Error?error.name:'unknown',code:(error as {cause?:{code?:string}})?.cause?.code||null}));}
finally{await db.$disconnect()}
