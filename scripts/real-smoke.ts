import { db } from '../src/lib/db';
import { decrypt } from '../src/lib/secret';
import { complete } from '../src/lib/provider';

if(process.env.AI_ADAPTER==='test')throw new Error('Test adapter is active');
const ownerId='00000000-0000-4000-8000-000000000001';
const credential=await db.credential.findUnique({where:{ownerId}});
if(!credential)throw new Error('OpenRouter key is not configured');
const model='z-ai/glm-5.3-flash';
try{
  const response=await complete('sample',model,'Создай одну короткую текстовую пробу на русском языке.',{text:'Пиши ясно и коротко.',situation:'Опиши тихое утро одной фразой.',words:50},decrypt(credential.cipherText),AbortSignal.timeout(60000));
  console.log(JSON.stringify({status:'passed',model:response.model||model,requestId:response.requestId||null,usage:response.usage,validText:typeof (response.value as {text?:unknown}).text==='string'}));
}catch(error){
  console.error(JSON.stringify({status:'failed',code:error instanceof Error?error.message:'unknown'}));
  process.exitCode=1;
}finally{await db.$disconnect();}
