import { db } from './lib/db';
import { queue } from './lib/queue';
import { complete, ProviderError, type Kind, type ReasoningEffort } from './lib/provider';
import { decrypt } from './lib/secret';
import { analysisSchema, assemblySchema, checkSchema, promptSchema, sampleSchema, validateEvidence, renderInstruction } from './lib/domain';
import { Prisma } from './generated/prisma/client';

const json=(x:unknown)=>x as Prisma.InputJsonValue;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function processJob(id:string, signal:AbortSignal) {
  const job=await db.aiJob.findUnique({where:{id},include:{cycle:{include:{project:true}}}});
  if(!job||job.state!=='queued'||job.cycle.archived||job.cycle.project.archived) return;
  const claimed=await db.aiJob.updateMany({where:{id,state:'queued'},data:{state:'running',stage:'preparing',startedAt:new Date(),progressChars:0,attemptCount:0,lastProgressAt:new Date()}});
  if(!claimed.count)return;
  const {cycle}=job;
  const input=job.input as Record<string,unknown>;
  const kind=job.kind as Kind;
  const instructions=cycle.instructions as Record<Kind,string>;
  async function stage(value:string,attempt?:number,progressChars?:number){
    await db.aiJob.updateMany({where:{id,state:'running'},data:{stage:value,lastProgressAt:new Date(),...(attempt===undefined?{}:{attemptCount:attempt}),...(progressChars===undefined?{}:{progressChars})}});
  }
  let key:string|null=null;
  try {
    if(process.env.AI_ADAPTER!=='test') {
      const credential=await db.credential.findUnique({where:{ownerId:cycle.project.ownerId}});
      key=credential?decrypt(credential.cipherText):null;
    }
    let repairText:string|undefined;
    let repairUsed=false, transientRetries=0;
    for(let attempt=1;attempt<=4;attempt++) {
      const latest=await db.aiJob.findUnique({where:{id},select:{state:true}});
      if(latest?.state==='cancel_requested'||latest?.state==='canceled') {await db.aiJob.updateMany({where:{id,state:{in:['running','cancel_requested']}},data:{state:'canceled',stage:'canceled'}});return;}
      try {
        await stage('connecting',attempt);
        const timeoutMs=kind==='analyze'?(input.depth==='brief'?180000:input.depth==='deep'?840000:720000):180000;
        const timeout=AbortSignal.timeout(timeoutMs);
        const cancelController=new AbortController();
        const poll=setInterval(async()=>{try{const j=await db.aiJob.findUnique({where:{id},select:{state:true}});if(!j||j.state==='cancel_requested'||j.state==='canceled')cancelController.abort()}catch{}},1000);
        let result;
        let lastProgress=0;
        const progress=async(event:{stage:'waiting'|'reasoning'|'generating';outputChars:number})=>{
          const now=Date.now();
          if(event.outputChars===0&&event.stage==='generating')return;
          if(now-lastProgress<1500&&event.outputChars>0)return;
          lastProgress=now;
          try{await stage(event.stage,attempt,event.outputChars)}catch{}
        };
        try {result=await complete(kind,cycle.modelId,renderInstruction(kind,instructions[kind],input),input,key,AbortSignal.any([signal,timeout,cancelController.signal]),repairText,progress,cycle.reasoningEffort as ReasoningEffort);}
        finally {clearInterval(poll);}
        await stage('validating',attempt);
        await db.usage.upsert({where:{jobId_attempt:{jobId:id,attempt}},create:{cycleId:cycle.id,jobId:id,attempt,inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,totalTokens:result.usage.totalTokens,providerRequestId:result.requestId},update:{}});
        await stage('saving',attempt,result.value&&kind==='analyze'?JSON.stringify(result.value).length:undefined);
        await db.$transaction(async tx=>{
          const locked=await tx.$queryRaw<{state:string}[]>`SELECT state FROM "AiJob" WHERE id = ${id} FOR UPDATE`;
          if(locked[0]?.state!=='running')return;
          const still=await tx.cycle.findUnique({where:{id:cycle.id},include:{project:true}});
          if(!still||still.archived||still.project.archived){await tx.aiJob.update({where:{id},data:{state:'canceled',stage:'canceled'}});return;}
          if(kind==='analyze') {
            const parsed=analysisSchema.parse(result.value);
            const ref=await tx.reference.findUnique({where:{id:String(input.referenceId)}});
            if(!ref||ref.cycleId!==cycle.id){await tx.aiJob.update({where:{id},data:{state:'canceled',stage:'canceled'}});return;}
            const validated=validateEvidence(String(input.text),parsed);
            await tx.analysis.create({data:{referenceId:ref.id,textRevisionId:String(input.textRevisionId),depth:String(input.depth),summary:parsed.summary,elements:json(validated.elements)}});
          } else if(kind==='assemble'||kind==='prompt') {
            const parsed=kind==='assemble'?assemblySchema.parse(result.value):promptSchema.parse(result.value);
            const notes=kind==='assemble'?assemblySchema.parse(result.value).notes:promptSchema.parse(result.value).retainedRules;
            await tx.proposal.create({data:{cycleId:cycle.id,kind:kind==='assemble'?'full':'prompt',text:parsed.text,baseRevision:Number(input.baseRevision),sourceHash:kind==='prompt'?String(input.fullHash):null,notes:json(notes)}});
          } else if(kind==='check') {
            const parsed=checkSchema.parse(result.value);
            await tx.check.create({data:{cycleId:cycle.id,document:String(input.document),textHash:String(input.textHash),findings:json(parsed.findings)}});
          } else {
            const parsed=sampleSchema.parse(result.value);
            await tx.sample.create({data:{cycleId:cycle.id,document:String(input.document),documentHash:String(input.textHash),situation:String(input.situation),result:parsed.text}});
          }
          await tx.aiJob.update({where:{id},data:{state:'succeeded',stage:'completed',result:json({model:result.model||cycle.modelId})}});
        });
        return;
      } catch(error) {
        const e=error instanceof ProviderError?error:new ProviderError('INVALID_RESPONSE');
        if(e.usage) await db.usage.upsert({where:{jobId_attempt:{jobId:id,attempt}},create:{cycleId:cycle.id,jobId:id,attempt,inputTokens:e.usage.inputTokens,outputTokens:e.usage.outputTokens,totalTokens:e.usage.totalTokens,providerRequestId:e.requestId},update:{}});
        if(e.code==='INVALID_RESPONSE'&&!repairUsed&&e.repairText){repairUsed=true;repairText=e.repairText;await stage('repairing',attempt);continue;}
        if(e.retryable&&transientRetries<2){transientRetries++;await stage('retrying',attempt);await sleep(Math.max(e.retryAfter*1000,1000*2**(transientRetries-1)));continue;}
        if((await db.aiJob.findUnique({where:{id}}))?.state==='cancel_requested') {await db.aiJob.update({where:{id},data:{state:'canceled',stage:'canceled'}});return;}
        await db.aiJob.updateMany({where:{id,state:{in:['running','cancel_requested']}},data:{state:'failed',stage:'failed',errorCode:e.code}});return;
      }
    }
  } catch(error) {
    const code=error instanceof Error&&error.message.startsWith('MASTER_KEY_')?error.message:'WORKER_ERROR';
    await db.aiJob.updateMany({where:{id,state:{in:['running','cancel_requested']}},data:{state:'failed',stage:'failed',errorCode:code}});
  }
}
async function main() {
  const boss=await queue();
  const interrupted=await db.aiJob.findMany({where:{state:'running'},select:{id:true}});
  for(const item of interrupted){
    const reset=await db.aiJob.updateMany({where:{id:item.id,state:'running'},data:{state:'queued',stage:'queued'}});
    if(reset.count)await boss.send('ai-operation',{jobId:item.id},{retryLimit:0,expireInSeconds:900});
  }
  await db.aiJob.updateMany({where:{state:'cancel_requested'},data:{state:'canceled',stage:'canceled'}});
  async function heartbeat(){await db.workerHeartbeat.upsert({where:{id:'worker'},create:{id:'worker'},update:{seenAt:new Date()}})}
  await heartbeat();
  await boss.work<{jobId:string}>('ai-operation',{localConcurrency:2},async jobs=>{
    for(const job of jobs) await processJob(job.data.jobId,job.signal);
  });
  setInterval(async()=>{
    try {await heartbeat();}catch{console.error('worker-heartbeat-failed');}
  },30000);
}
main().catch(()=>{console.error('worker-start-failed');process.exit(1)});
