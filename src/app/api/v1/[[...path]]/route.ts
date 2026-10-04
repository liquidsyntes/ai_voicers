import {sourceRoleSchema,ruleDraftSchema,selectedRulePayload,ruleWarnings} from '@/lib/method';
import {ruleInput,ruleInputHash,ruleSnapshot,restoreRules} from '@/lib/rules-service';
import { NextRequest } from 'next/server';
import { Prisma } from '@/generated/prisma/client';
import { db, owner } from '@/lib/db';
import { ApiError, body, failed, guard, ok } from '@/lib/http';
import { defaults, hash, instructionsSchema, analysisSchema, methodInstructions } from '@/lib/domain';
import { encrypt, decrypt } from '@/lib/secret';
import { catalog, contextCheck } from '@/lib/provider';
import { queue } from '@/lib/queue';
import { z } from 'zod';

export const runtime = 'nodejs';
type Ctx = {params:Promise<{path?:string[]}>};
const uuid = z.uuid();
const reasoning = z.enum(['auto','low','high','max']);
const text = z.string().max(200000);
const json = (x:unknown) => x as Prisma.InputJsonValue;
const rev = (actual:number, expected:unknown) => { if (actual !== expected) throw new ApiError(409,'REVISION_CONFLICT'); };
const requireCycle = async (id:string, ownerId:string) => {
  const cycle = await db.cycle.findFirst({where:{id,project:{ownerId}},include:{project:true}});
  if (!cycle) throw new ApiError(404,'NOT_FOUND'); return cycle;
};
const writable = (cycle:{archived:boolean;project:{archived:boolean}}) => { if(cycle.archived || cycle.project.archived) throw new ApiError(409,'ARCHIVED'); };
const requireRef = async (id:string, ownerId:string) => {
  const ref = await db.reference.findFirst({where:{id,cycle:{project:{ownerId}}},include:{cycle:{include:{project:true}}}});
  if(!ref) throw new ApiError(404,'NOT_FOUND'); return ref;
};
async function idem(req:NextRequest, ownerId:string, payload:unknown, run:()=>Promise<unknown>) {
  const key=req.headers.get('idempotency-key'); if(!key || key.length>150) throw new ApiError(422,'IDEMPOTENCY_KEY_REQUIRED');
  const id=ownerId+':'+key, requestHash=hash(req.method+req.nextUrl.pathname+JSON.stringify(payload));
  const old=await db.idempotency.findUnique({where:{key:id}});
  if(old) {if(old.requestHash!==requestHash) throw new ApiError(409,'IDEMPOTENCY_CONFLICT'); if((old.response as Record<string,unknown>).pending)throw new ApiError(409,'REQUEST_IN_PROGRESS');return old.response;}
  try {await db.idempotency.create({data:{key:id,ownerId,requestHash,response:json({pending:true})}});} catch {
    const current=await db.idempotency.findUnique({where:{key:id}});
    if(current?.requestHash===requestHash&&!((current.response as Record<string,unknown>).pending)) return current.response;
    throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
  }
  try {const result=await run();await db.idempotency.update({where:{key:id},data:{response:json(result)}});return result;}
  catch(e){await db.idempotency.deleteMany({where:{key:id,requestHash}});throw e;}
}
async function enqueue(cycleId:string,kind:string,input:unknown) {
  if(await db.aiJob.count({where:{state:{in:['queued','running']}}})>=100) throw new ApiError(429,'QUEUE_FULL');
  const job=await db.aiJob.create({data:{cycleId,kind,input:json(input)}});
  try { await (await queue()).send('ai-operation',{jobId:job.id},{retryLimit:0,expireInSeconds:900}); }
  catch { await db.aiJob.update({where:{id:job.id},data:{state:'failed',errorCode:'QUEUE_UNAVAILABLE'}}); throw new ApiError(503,'QUEUE_UNAVAILABLE'); }
  return {jobId:job.id,state:'queued'};
}
async function get(req:NextRequest,p:string[],ownerId:string) {
  if(p[0]==='settings') {
    const settings=await db.settings.findUnique({where:{ownerId}}), credential=await db.credential.findUnique({where:{ownerId}});
    const instructions=await db.instructionRevision.findMany({where:{ownerId},orderBy:{createdAt:'desc'}});
    return {settings,credential:credential?{configured:true,mask:credential.mask}: {configured:false},instructions,defaults,adapter:process.env.AI_ADAPTER==='test'?'test':'openrouter'};
  }
  if(p[0]==='providers'&&p[1]==='models') return {models:await catalog()};
  if(p[0]==='projects'&&p.length===1) return {projects:await db.project.findMany({where:{ownerId},include:{cycles:{select:{id:true,modelId:true,locked:true,createdAt:true},orderBy:{createdAt:'desc'}}},orderBy:{updatedAt:'desc'}})};
  if(p[0]==='projects'&&p[1]) {
    const project=await db.project.findFirst({where:{id:p[1],ownerId},include:{cycles:{orderBy:{createdAt:'desc'}}}});
    if(!project) throw new ApiError(404,'NOT_FOUND'); return {project};
  }
  if(p[0]==='rules'&&p[2]==='revisions'){const rule=await db.voiceRule.findFirst({where:{id:p[1],cycle:{project:{ownerId}}}});if(!rule)throw new ApiError(404,'NOT_FOUND');return {revisions:await db.ruleRevision.findMany({where:{ruleId:rule.id},orderBy:{number:'desc'}})};}
  if(p[0]==='cycles'&&p[1]) {
    const cycle=await requireCycle(p[1],ownerId);
    if(p[2]==='usage') {
      const usages=await db.usage.findMany({where:{cycleId:cycle.id}});
      return {modelId:cycle.modelId,provider:'OpenRouter',inputTokens:usages.some(u=>u.inputTokens===null)?null:usages.reduce((a,u)=>a+(u.inputTokens||0),0),outputTokens:usages.some(u=>u.outputTokens===null)?null:usages.reduce((a,u)=>a+(u.outputTokens||0),0),totalTokens:usages.some(u=>u.totalTokens===null)?null:usages.reduce((a,u)=>a+(u.totalTokens||0),0),complete:!usages.some(u=>u.totalTokens===null),attempts:usages.length};
    }
    const references=await db.reference.findMany({where:{cycleId:cycle.id},include:{texts:true,analyses:{orderBy:{createdAt:'desc'},include:{selections:true}}},orderBy:[{position:'asc'},{title:'asc'}]});
    const [proposals,versions,samples,checks,jobs]=await Promise.all([
      db.proposal.findMany({where:{cycleId:cycle.id},orderBy:{createdAt:'desc'}}),
      db.voiceVersion.findMany({where:{cycleId:cycle.id},orderBy:{createdAt:'desc'}}),
      db.sample.findMany({where:{cycleId:cycle.id},orderBy:{createdAt:'desc'}}),
      db.check.findMany({where:{cycleId:cycle.id},orderBy:{createdAt:'desc'}}),
      db.aiJob.findMany({where:{cycleId:cycle.id},orderBy:{createdAt:'desc'},take:25,select:{id:true,kind:true,state:true,stage:true,errorCode:true,createdAt:true,updatedAt:true,startedAt:true,lastProgressAt:true,progressChars:true,attemptCount:true,input:true}})
    ]);
    const [rules,ruleBatches]=await Promise.all([db.voiceRule.findMany({where:{cycleId:cycle.id},orderBy:[{createdAt:'desc'},{id:'asc'}]}),db.ruleBatch.findMany({where:{cycleId:cycle.id},orderBy:{createdAt:'desc'}})]);
    const currentRuleInputHash=cycle.methodVersion>=2?ruleInputHash(await ruleInput(db,cycle.id)):null;
    const safeJobs=jobs.map(({input,...job})=>{const source=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};return {...job,referenceId:typeof source.referenceId==='string'?source.referenceId:null,depth:typeof source.depth==='string'?source.depth:null}});
    return {cycle,rules,ruleBatches:ruleBatches.map(batch=>({...batch,stale:batch.inputHash!==currentRuleInputHash})),ruleWarnings:ruleWarnings(rules),promptStale:!!cycle.promptText&&cycle.promptSourceHash!==hash(cycle.fullText),references:references.map(r=>({...r,texts:r.texts.filter(t=>t.id===r.currentTextRevisionId),analyses:r.analyses.sort((a,b)=>Number(b.textRevisionId===r.currentTextRevisionId)-Number(a.textRevisionId===r.currentTextRevisionId)||+new Date(b.createdAt)-+new Date(a.createdAt))})),proposals,versions,samples,checks:checks.map(x=>({...x,current:x.textHash===hash(x.document==='full'?cycle.fullText:cycle.promptText)})),jobs:safeJobs,adapter:process.env.AI_ADAPTER==='test'?'test':'openrouter'};
  }
  if(p[0]==='jobs'&&p[1]) {
    const job=await db.aiJob.findFirst({where:{id:p[1],cycle:{project:{ownerId}}},select:{id:true,kind:true,state:true,stage:true,errorCode:true,result:true,createdAt:true,updatedAt:true,startedAt:true,lastProgressAt:true,progressChars:true,attemptCount:true,input:true}});
    if(!job) throw new ApiError(404,'NOT_FOUND');
    const {input,...safe}=job;
    const source=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
    return {job:{...safe,referenceId:typeof source.referenceId==='string'?source.referenceId:null,depth:typeof source.depth==='string'?source.depth:null}};
  }
  if(p[0]==='exports') {
    const cycle=await requireCycle(uuid.parse(req.nextUrl.searchParams.get('cycleId')),ownerId);
    const kind=z.enum(['full','prompt']).parse(req.nextUrl.searchParams.get('kind'));
    const format=z.enum(['md','txt']).parse(req.nextUrl.searchParams.get('format'));
    const value=kind==='full'?cycle.fullText:cycle.promptText;
    if(!value) throw new ApiError(404,'DOCUMENT_EMPTY');
    return new Response(value,{headers:{'Content-Type':format==='md'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="voice-${kind}.${format}"`,'Cache-Control':'no-store'}});
  }
  throw new ApiError(404,'NOT_FOUND');
}
async function post(req:NextRequest,p:string[],ownerId:string) {
  const b=await body(req);
  if(p[0]==='settings'&&p[1]==='credential') {
    const value=z.string().min(10).max(500).parse(b.key);
    const old=await db.credential.findUnique({where:{ownerId}});
    const cipherText=encrypt(value,!!old);
    await db.credential.upsert({where:{ownerId},create:{ownerId,cipherText,mask:'••••'+value.slice(-4)},update:{cipherText,mask:'••••'+value.slice(-4)}});
    return {configured:true,mask:'••••'+value.slice(-4)};
  }
  if(p[0]==='providers'&&p[1]==='check') {
    const credential=await db.credential.findUnique({where:{ownerId}});if(!credential)throw new ApiError(422,'KEY_MISSING');
    const response=await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${decrypt(credential.cipherText)}`},signal:AbortSignal.timeout(12000)});
    if(response.status===401||response.status===403)throw new ApiError(422,'KEY_INVALID');
    if(!response.ok)throw new ApiError(503,'PROVIDER_UNAVAILABLE');
    return {connected:true};
  }
  if(p[0]==='instructions') {
    const content=instructionsSchema.parse(b.content);
    const item=await db.instructionRevision.create({data:{ownerId,name:z.string().min(1).max(100).parse(b.name),content:json(content)}});
    await db.settings.update({where:{ownerId},data:{instructionId:item.id,revision:{increment:1}}}); return {instruction:item};
  }
  if(p[0]==='projects'&&p.length===1) {
    const settings=await db.settings.findUniqueOrThrow({where:{ownerId}});
    const inst=settings.instructionId?await db.instructionRevision.findFirst({where:{id:settings.instructionId,ownerId}}):null;
    const modelId=z.string().min(1).max(250).parse(b.modelId||settings.defaultModel);
    const modelContext=b.modelContext===undefined?(modelId===settings.defaultModel?settings.defaultModelContext:null):b.modelContext===null?null:z.number().int().positive().parse(b.modelContext);
    const reasoningEffort=b.reasoningEffort===undefined?(modelId===settings.defaultModel?settings.defaultReasoningEffort:'auto'):reasoning.parse(b.reasoningEffort);
    const project=await db.project.create({data:{ownerId,name:z.string().min(1).max(120).parse(b.name),cycles:{create:{methodVersion:2,modelId,modelContext,reasoningEffort,instructionId:inst?.id||'standard',instructions:json(methodInstructions(inst?.content||defaults))}}},include:{cycles:true}});
    for(let n=1;n<=5;n++) {
      const ref=await db.reference.create({data:{cycleId:project.cycles[0].id,title:`Отрывок ${n}`,position:n,texts:{create:{body:'',hash:hash('')}}},include:{texts:true}});
      await db.reference.update({where:{id:ref.id},data:{currentTextRevisionId:ref.texts[0].id}});
    }
    return {project};
  }
  if(p[0]==='projects'&&p[2]==='cycles') {
    const project=await db.project.findFirst({where:{id:p[1],ownerId}}); if(!project) throw new ApiError(404,'NOT_FOUND');
    const source=await requireCycle(uuid.parse(b.sourceCycleId),ownerId); if(source.projectId!==project.id) throw new ApiError(404,'NOT_FOUND');
    const settings=await db.settings.findUniqueOrThrow({where:{ownerId}});
    const inst=settings.instructionId?await db.instructionRevision.findFirst({where:{id:settings.instructionId,ownerId}}):null;
    const refs=await db.reference.findMany({where:{cycleId:source.id,archived:false},include:{texts:true}});
    const modelId=z.string().min(1).max(250).parse(b.modelId||source.modelId);
    const modelContext=b.modelContext===undefined?(modelId===source.modelId?source.modelContext:modelId===settings.defaultModel?settings.defaultModelContext:null):b.modelContext===null?null:z.number().int().positive().parse(b.modelContext);
    const reasoningEffort=b.reasoningEffort===undefined?(modelId===settings.defaultModel?settings.defaultReasoningEffort:modelId===source.modelId?source.reasoningEffort:'auto'):reasoning.parse(b.reasoningEffort);
    const cycle=await db.cycle.create({data:{methodVersion:2,projectId:project.id,modelId,modelContext,reasoningEffort,instructionId:inst?.id||'standard',instructions:json(methodInstructions(inst?.content||defaults)),references:{create:refs.map(r=>{const current=r.texts.find(t=>t.id===r.currentTextRevisionId);return {title:r.title,position:r.position,sourceRole:r.sourceRole,author:r.author,note:r.note,focus:r.focus,texts:{create:{body:current?.body||'',hash:current?.hash||hash('')}}}})}}});
    const copied=await db.reference.findMany({where:{cycleId:cycle.id},include:{texts:true}});
    for(const ref of copied) await db.reference.update({where:{id:ref.id},data:{currentTextRevisionId:ref.texts[0].id}});
    return {cycle};
  }
  if(p[0]==='cycles'&&p[2]==='references') {
    const cycle=await requireCycle(p[1],ownerId); writable(cycle);
    const title=z.string().min(1).max(120).parse(b.title||'Отрывок'); const content=text.parse(b.text||'');
    const last=await db.reference.aggregate({where:{cycleId:cycle.id},_max:{position:true}});
    const ref=await db.reference.create({data:{cycleId:cycle.id,title,sourceRole:sourceRoleSchema.parse(b.sourceRole||'unspecified'),position:(last._max.position||0)+1,author:z.string().max(150).parse(b.author||''),note:z.string().max(2000).parse(b.note||''),focus:z.string().max(500).parse(b.focus||''),texts:{create:{body:content,hash:hash(content)}}},include:{texts:true}});
    await db.reference.update({where:{id:ref.id},data:{currentTextRevisionId:ref.texts[0].id}}); return {reference:ref};
  }
  if(p[0]==='references'&&p[2]==='duplicate') {
    const source=await requireRef(p[1],ownerId);writable(source.cycle);
    const current=await db.referenceText.findUnique({where:{id:source.currentTextRevisionId||''}});
    const value=current?.body||'';
    const last=await db.reference.aggregate({where:{cycleId:source.cycleId},_max:{position:true}});
    const ref=await db.reference.create({data:{cycleId:source.cycleId,title:source.title+' — копия',sourceRole:source.sourceRole,position:(last._max.position||0)+1,author:source.author,note:source.note,focus:source.focus,texts:{create:{body:value,hash:hash(value)}}},include:{texts:true}});
    await db.reference.update({where:{id:ref.id},data:{currentTextRevisionId:ref.texts[0].id}});return {reference:ref};
  }
  if(p[0]==='references'&&p[2]==='analyses') {
    const ref=await requireRef(p[1],ownerId); writable(ref.cycle);
    const depth=z.enum(['brief','detailed','deep']).parse(b.depth||'detailed');
    const cycle=ref.cycle;
    const current=await db.referenceText.findUnique({where:{id:ref.currentTextRevisionId||''}});
    if(!current?.body.trim()) throw new ApiError(422,'EMPTY_REFERENCE');
    contextCheck({text:current.body},cycle.modelContext);
    return idem(req,ownerId,{refId:ref.id,textRevisionId:current.id,depth},async()=>{
      if(!cycle.locked) await db.cycle.updateMany({where:{id:cycle.id,locked:false},data:{locked:true}});
      return enqueue(cycle.id,'analyze',{referenceId:ref.id,textRevisionId:current.id,text:current.body,depth,...(cycle.methodVersion>=2?{methodVersion:2}:{})});
    });
  }
  if(p[0]==='cycles'&&p[2]==='rules') {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);
    if(cycle.methodVersion<2)throw new ApiError(409,'NEW_METHOD_CYCLE_REQUIRED');
    return idem(req,ownerId,b,async()=>{
      const latest=await requireCycle(cycle.id,ownerId);rev(latest.revision,b.expectedRevision);
      const input=await ruleInput(db,cycle.id);
      if(!input.sources.length)throw new ApiError(422,'RULE_SOURCES_EMPTY');
      contextCheck(input,cycle.modelContext);
      if(!cycle.locked)await db.cycle.updateMany({where:{id:cycle.id,locked:false},data:{locked:true}});
      return enqueue(cycle.id,'rules',{...input,methodVersion:2});
    });
  }
  if(p[0]==='cycles'&&p[2]==='manual-rules') {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);
    if(cycle.methodVersion<2)throw new ApiError(409,'NEW_METHOD_CYCLE_REQUIRED');
    const rule=ruleDraftSchema.parse(b.rule);
    return idem(req,ownerId,b,()=>db.$transaction(async tx=>{
      const created=await tx.voiceRule.create({data:{cycleId:cycle.id,...rule,origin:'user',editedByUser:true}});
      await tx.ruleRevision.create({data:{ruleId:created.id,number:1,snapshot:ruleSnapshot(created)}});
      await tx.cycle.update({where:{id:cycle.id},data:{rulesRevision:{increment:1},revision:{increment:1}}});
      return {rule:created};
    }));
  }
  if(p[0]==='cycles'&&p[1]&&['assemblies','prompt-versions','checks','samples'].includes(p[2]||'')) {
    const cycle=await requireCycle(p[1],ownerId); writable(cycle);
    const kind=p[2]==='assemblies'?'assemble':p[2]==='prompt-versions'?'prompt':p[2]==='checks'?'check':'sample';
    let input:unknown;
    if(kind==='assemble'&&cycle.methodVersion>=2){
      const rules=await db.voiceRule.findMany({where:{cycleId:cycle.id},orderBy:[{createdAt:'asc'},{id:'asc'}]});
      const payload=selectedRulePayload(rules);if(!payload.rules.length)throw new ApiError(422,'SELECT_RULES_FIRST');
      input={...payload,methodVersion:2};
    }else if(kind==='assemble') {
      const currentReferences=await db.reference.findMany({where:{cycleId:cycle.id},select:{currentTextRevisionId:true,analyses:{select:{id:true,textRevisionId:true},orderBy:[{createdAt:'desc'},{id:'desc'}]}}});
      const latestIds=currentReferences.map(reference=>reference.analyses.find(analysis=>analysis.textRevisionId===reference.currentTextRevisionId)?.id).filter((id):id is string=>!!id);
      const selections=await db.selection.findMany({where:{state:'selected',analysisId:{in:latestIds}},include:{analysis:{include:{reference:true}}}});
      const selected=selections.filter(s=>s.analysis.textRevisionId===s.analysis.reference.currentTextRevisionId).map(s=>{
        const e=analysisSchema.parse({summary:s.analysis.summary,elements:s.analysis.elements}).elements.find(e=>e.id===s.elementId);
        return e?{id:s.elementId,title:e.title,principle:e.principle,effect:e.effect,categories:e.categories,nuances:e.nuances,role:s.role,strength:s.strength,frequency:s.frequency,condition:s.condition}:null;
      }).filter(Boolean);
      input={selected,wishes:cycle.wishes,constraints:cycle.constraints};
    } else if(kind==='prompt') { if(!cycle.fullText) throw new ApiError(422,'FULL_EMPTY'); input={fullText:cycle.fullText,fullHash:hash(cycle.fullText),baseRevision:cycle.promptRevision}; }
    else if(kind==='check') {const document=z.enum(['full','prompt']).parse(b.document||'full'); const value=document==='full'?cycle.fullText:cycle.promptText; if(!value) throw new ApiError(422,'DOCUMENT_EMPTY'); input={document,text:value,textHash:hash(value)};}
    else {const document=z.enum(['full','prompt']).parse(b.document||'full');const value=document==='full'?cycle.fullText:cycle.promptText;if(!value) throw new ApiError(422,'DOCUMENT_EMPTY');input={document,text:value,textHash:hash(value),situation:z.string().min(1).max(2000).parse(b.situation),words:z.number().int().min(50).max(500).parse(b.words||200)};}
    if(kind==='assemble') input={...(input as object),baseRevision:cycle.fullRevision};
    contextCheck(input,cycle.modelContext);
    return idem(req,ownerId,{kind,input},async()=>{if(cycle.methodVersion>=2&&!cycle.locked)await db.cycle.updateMany({where:{id:cycle.id,locked:false},data:{locked:true}});return enqueue(cycle.id,kind,input)});
  }
  if(p[0]==='cycles'&&p[2]==='versions') {
    const cycle=await requireCycle(p[1],ownerId);
    return idem(req,ownerId,{name:b.name,revision:b.expectedRevision},()=>db.$transaction(async tx=>{
      const current=await tx.cycle.findUniqueOrThrow({where:{id:cycle.id}});rev(current.revision,b.expectedRevision);
      const selections=await tx.selection.findMany({where:{analysis:{reference:{cycleId:cycle.id}}}});
      const usages=await tx.usage.findMany({where:{cycleId:cycle.id}});
      const references=await tx.reference.findMany({where:{cycleId:cycle.id},include:{texts:true,analyses:{include:{selections:true}}}});
      const rules=await tx.voiceRule.findMany({where:{cycleId:cycle.id}});
      const ruleBatches=await tx.ruleBatch.findMany({where:{cycleId:cycle.id}});
      const snapshot={methodVersion:current.methodVersion,rules,ruleBatches,rulesRevision:current.rulesRevision,modelId:current.modelId,reasoningEffort:current.reasoningEffort,instructionId:current.instructionId,fullText:current.fullText,promptText:current.promptText,promptSourceHash:current.promptSourceHash,wishes:current.wishes,constraints:current.constraints,selections,references,fullRevision:current.fullRevision,promptRevision:current.promptRevision,usage:{total:usages.some(u=>u.totalTokens===null)?null:usages.reduce((a,u)=>a+(u.totalTokens||0),0)}};
      const version=await tx.voiceVersion.create({data:{cycleId:cycle.id,name:z.string().min(1).max(100).parse(b.name),snapshot:json(JSON.parse(JSON.stringify(snapshot)))}});
      return {version};
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead}));
  }
  if(p[0]==='versions'&&p[2]==='continue') {
    const version=await db.voiceVersion.findFirst({where:{id:p[1],cycle:{project:{ownerId}}},include:{cycle:true}});if(!version) throw new ApiError(404,'NOT_FOUND');
    const snap=version.snapshot as Record<string,unknown>;
    const cycle=await db.$transaction(async tx=>{
    const createdCycle=await tx.cycle.create({data:{projectId:version.cycle.projectId,methodVersion:version.cycle.methodVersion,modelId:version.cycle.modelId,modelContext:version.cycle.modelContext,reasoningEffort:version.cycle.reasoningEffort,instructionId:version.cycle.instructionId,instructions:json(version.cycle.instructions),locked:true,fullText:String(snap.fullText||''),promptText:String(snap.promptText||''),promptSourceHash:snap.promptSourceHash?String(snap.promptSourceHash):null,wishes:String(snap.wishes||''),constraints:json(snap.constraints||[]),fullRevision:1,promptRevision:1}});
    const selectionIds=new Map<string,string>();
    const refs=Array.isArray(snap.references)?snap.references as Record<string,unknown>[]:[];
    for(const raw of refs) {
      const texts=Array.isArray(raw.texts)?raw.texts as Record<string,unknown>[]:[];
      const current=texts.find(t=>t.id===raw.currentTextRevisionId)||texts[0];
      const value=String(current?.body||'');
      const ref=await tx.reference.create({data:{cycleId:createdCycle.id,title:String(raw.title||'Отрывок'),position:Number(raw.position||0),sourceRole:sourceRoleSchema.parse(raw.sourceRole||'unspecified'),author:String(raw.author||''),note:String(raw.note||''),focus:String(raw.focus||''),archived:Boolean(raw.archived),texts:{create:{body:value,hash:hash(value)}}},include:{texts:true}});
      await tx.reference.update({where:{id:ref.id},data:{currentTextRevisionId:ref.texts[0].id}});
      const analyses=Array.isArray(raw.analyses)?raw.analyses as Record<string,unknown>[]:[];
      for(const original of analyses.filter(a=>a.textRevisionId===raw.currentTextRevisionId)) {
        const oldSelections=Array.isArray(original.selections)?original.selections as Record<string,unknown>[]:[];
        await tx.analysis.create({data:{referenceId:ref.id,textRevisionId:ref.texts[0].id,depth:String(original.depth),summary:String(original.summary),portrait:original.portrait?json(original.portrait):undefined,elements:json(original.elements),selections:{create:oldSelections.map(s=>{const id=crypto.randomUUID();selectionIds.set(String(s.id),id);return {id,elementId:String(s.elementId),state:String(s.state),role:String(s.role),strength:Number(s.strength),frequency:String(s.frequency),condition:String(s.condition)}})}}});
      }
    }
    await restoreRules(tx,createdCycle.id,snap,selectionIds);
    return tx.cycle.findUniqueOrThrow({where:{id:createdCycle.id}});
    },{timeout:15000});
    return {cycle};
  }
  throw new ApiError(404,'NOT_FOUND');
}
async function patch(req:NextRequest,p:string[],ownerId:string) {
  const b=await body(req);
  if(p[0]==='rules'&&p[1]) {
    const existing=await db.voiceRule.findFirst({where:{id:p[1],cycle:{project:{ownerId}}},include:{cycle:{include:{project:true}}}});
    if(!existing)throw new ApiError(404,'NOT_FOUND');writable(existing.cycle);
    const change=z.object({expectedRevision:z.number().int().positive(),text:z.string().optional(),direction:z.enum(['do','dont']).optional(),severity:z.enum(['none','soft','ban']).optional(),category:z.string().optional(),condition:z.string().optional(),selected:z.boolean().optional(),archived:z.boolean().optional()}).strict().parse(b);
    const {expectedRevision,archived,...fields}=change;
    return idem(req,ownerId,b,()=>db.$transaction(async tx=>{
      const current=await tx.voiceRule.findUniqueOrThrow({where:{id:existing.id}});rev(current.revision,expectedRevision);
      const value=ruleDraftSchema.parse({text:current.text,direction:current.direction,severity:current.severity,category:current.category,condition:current.condition,selected:current.selected,...fields});
      const edited=current.editedByUser||['text','direction','category','condition','severity'].some(k=>k in fields&&fields[k as keyof typeof fields]!==current[k as keyof typeof current]);
      const changed=await tx.voiceRule.updateMany({where:{id:current.id,revision:expectedRevision},data:{...value,archived:archived??current.archived,editedByUser:edited,revision:{increment:1}}});
      if(!changed.count)throw new ApiError(409,'REVISION_CONFLICT');
      const rule=await tx.voiceRule.findUniqueOrThrow({where:{id:current.id}});
      await tx.ruleRevision.create({data:{ruleId:rule.id,number:rule.revision,snapshot:ruleSnapshot(rule)}});
      await tx.cycle.update({where:{id:rule.cycleId},data:{rulesRevision:{increment:1},revision:{increment:1}}});
      return {rule};
    }));
  }
  if(p[0]==='settings') {
    const current=await db.settings.findUniqueOrThrow({where:{ownerId}}); rev(current.revision,b.expectedRevision);
    const settings=await db.settings.update({where:{ownerId},data:{theme:b.theme===undefined?undefined:z.enum(['light','dark']).parse(b.theme),defaultModel:b.defaultModel===undefined?undefined:z.string().max(250).parse(b.defaultModel),defaultModelContext:b.defaultModelContext===undefined?undefined:b.defaultModelContext===null?null:z.number().int().positive().parse(b.defaultModelContext),defaultReasoningEffort:b.defaultReasoningEffort===undefined?undefined:reasoning.parse(b.defaultReasoningEffort),instructionId:b.instructionId===undefined?undefined:b.instructionId===null?null:z.string().parse(b.instructionId),revision:{increment:1}}}); return {settings};
  }
  if(p[0]==='projects'&&p[1]) {
    const project=await db.project.findFirst({where:{id:p[1],ownerId}});if(!project) throw new ApiError(404,'NOT_FOUND');rev(project.revision,b.expectedRevision);
    const updated=await db.project.update({where:{id:project.id},data:{name:b.name===undefined?undefined:z.string().min(1).max(120).parse(b.name),archived:b.archived===undefined?undefined:z.boolean().parse(b.archived),revision:{increment:1}}});return {project:updated};
  }
  if(p[0]==='cycles'&&p[2]==='config') {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);if(cycle.locked)throw new ApiError(409,'CYCLE_LOCKED');rev(cycle.revision,b.expectedRevision);
    const settings=await db.settings.findUniqueOrThrow({where:{ownerId}});
    const instructionId=b.instructionId===undefined?cycle.instructionId:z.string().parse(b.instructionId);
    const modelId=b.modelId===undefined?cycle.modelId:z.string().min(1).max(250).parse(b.modelId);
    const modelContext=b.modelContext===undefined?(modelId===cycle.modelId?cycle.modelContext:modelId===settings.defaultModel?settings.defaultModelContext:null):b.modelContext===null?null:z.number().int().positive().parse(b.modelContext);
    const reasoningEffort=b.reasoningEffort===undefined?(modelId===cycle.modelId?cycle.reasoningEffort:modelId===settings.defaultModel?settings.defaultReasoningEffort:'auto'):reasoning.parse(b.reasoningEffort);
    const selected=instructionId==='standard'?null:await db.instructionRevision.findFirst({where:{id:instructionId,ownerId}});
    if(instructionId!=='standard'&&!selected)throw new ApiError(404,'INSTRUCTIONS_NOT_FOUND');
    const updated=await db.cycle.update({where:{id:cycle.id},data:{modelId,modelContext,reasoningEffort,instructionId,instructions:cycle.methodVersion>=2?json(methodInstructions(selected?.content||defaults)):selected?.content||json(defaults),revision:{increment:1}}});
    return {cycle:updated,currentInstructionId:settings.instructionId};
  }
  if(p[0]==='references'&&p[1]) {
    const ref=await requireRef(p[1],ownerId);writable(ref.cycle);rev(ref.revision,b.expectedRevision);
    const sourceRole=b.sourceRole===undefined?undefined:sourceRoleSchema.parse(b.sourceRole);
    const title=b.title===undefined?undefined:z.string().min(1).max(120).parse(b.title);
    const author=b.author===undefined?undefined:z.string().max(150).parse(b.author);
    const note=b.note===undefined?undefined:z.string().max(2000).parse(b.note);
    const focus=b.focus===undefined?undefined:z.string().max(500).parse(b.focus);
    const archived=b.archived===undefined?undefined:z.boolean().parse(b.archived);
    let currentTextRevisionId: string|undefined;
    if(b.text!==undefined) {
      const value=text.parse(b.text), current=await db.referenceText.findUnique({where:{id:ref.currentTextRevisionId||''}});
      if(current?.body!==value) currentTextRevisionId=(await db.referenceText.create({data:{referenceId:ref.id,body:value,hash:hash(value)}})).id;
    }
    const changed=await db.reference.updateMany({where:{id:ref.id,revision:b.expectedRevision},data:{title,sourceRole,author,note,focus,archived,currentTextRevisionId,revision:{increment:1}}});if(!changed.count)throw new ApiError(409,'REVISION_CONFLICT');await db.cycle.update({where:{id:ref.cycleId},data:{revision:{increment:1}}});return {reference:await db.reference.findUniqueOrThrow({where:{id:ref.id}})};
  }
  if(p[0]==='cycles'&&p[2]==='selection') {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);
    const analysis=await db.analysis.findFirst({where:{id:uuid.parse(b.analysisId),reference:{cycleId:cycle.id}},include:{reference:true}});
    if(!analysis||analysis.textRevisionId!==analysis.reference.currentTextRevisionId) throw new ApiError(409,'STALE_ANALYSIS');
    const latest=await db.analysis.findFirst({where:{referenceId:analysis.referenceId,textRevisionId:analysis.textRevisionId},orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true}});
    if(latest?.id!==analysis.id)throw new ApiError(409,'STALE_ANALYSIS');
    const e=analysisSchema.parse({summary:analysis.summary,elements:analysis.elements}).elements.find(e=>e.id===b.elementId);
    if(!e) throw new ApiError(404,'ELEMENT_NOT_FOUND');
    const state=z.enum(['selected','deferred','excluded','unreviewed']).parse(b.state);
    const old=await db.selection.findUnique({where:{analysisId_elementId:{analysisId:analysis.id,elementId:e.id}}});
    if(old) rev(old.revision,b.expectedRevision);
    const selection=state==='unreviewed' ? (old?await db.selection.delete({where:{id:old.id}}):null) : await db.selection.upsert({where:{analysisId_elementId:{analysisId:analysis.id,elementId:e.id}},create:{analysisId:analysis.id,elementId:e.id,state},update:{state,role:b.role===undefined?undefined:z.enum(['primary','secondary']).parse(b.role),strength:b.strength===undefined?undefined:z.number().int().min(1).max(5).parse(b.strength),frequency:b.frequency===undefined?undefined:z.enum(['rare','moderate','regular','conditional']).parse(b.frequency),condition:b.condition===undefined?undefined:z.string().max(500).parse(b.condition),revision:{increment:1}}});
    await db.cycle.update({where:{id:cycle.id},data:{revision:{increment:1}}});
    return {selection};
  }
  if(p[0]==='cycles'&&p[2]==='selection-settings') {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);rev(cycle.revision,b.expectedRevision);
    const constraints=z.array(z.object({kind:z.enum(['soft','ban']),text:z.string().min(1).max(1000)})).max(100).parse(b.constraints||[]);
    const updated=await db.cycle.update({where:{id:cycle.id},data:{wishes:z.string().max(4000).parse(b.wishes||''),constraints:json(constraints),revision:{increment:1}}});return {cycle:updated};
  }
  if(p[0]==='cycles'&&p[2]==='draft') {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);
    const kind=z.enum(['full','prompt']).parse(b.kind);
    const expected=z.number().int().nonnegative().parse(b.expectedRevision);
    const value=z.string().max(200000).parse(b.text);
    if(kind==='full') {
      rev(cycle.fullRevision,expected);
      const changed=await db.cycle.updateMany({where:{id:cycle.id,fullRevision:expected},data:{fullText:value,fullRevision:{increment:1},fullManual:true,revision:{increment:1}}});if(!changed.count)throw new ApiError(409,'REVISION_CONFLICT');return {cycle:await db.cycle.findUniqueOrThrow({where:{id:cycle.id}})};
    }
    rev(cycle.promptRevision,expected);
    const changed=await db.cycle.updateMany({where:{id:cycle.id,promptRevision:expected},data:{promptText:value,promptRevision:{increment:1},promptManual:true,revision:{increment:1}}});if(!changed.count)throw new ApiError(409,'REVISION_CONFLICT');return {cycle:await db.cycle.findUniqueOrThrow({where:{id:cycle.id}})};
  }
  if(p[0]==='cycles'&&p[2]==='proposals'&&p[3]) {
    const cycle=await requireCycle(p[1],ownerId);writable(cycle);
    const proposal=await db.proposal.findFirst({where:{id:p[3],cycleId:cycle.id}});if(!proposal)throw new ApiError(404,'NOT_FOUND');
    return idem(req,ownerId,{proposalId:proposal.id,text:b.text,revision:b.expectedRevision},async()=>{
      if(proposal.applied) throw new ApiError(409,'ALREADY_APPLIED');
      const kind=proposal.kind;
      rev(kind==='full'?cycle.fullRevision:cycle.promptRevision,b.expectedRevision);
      const value=z.string().max(200000).parse(b.text??proposal.text);
      await db.$transaction(async tx=>{
        const changed=await tx.cycle.updateMany({where:kind==='full'?{id:cycle.id,fullRevision:b.expectedRevision}:{id:cycle.id,promptRevision:b.expectedRevision},data:kind==='full'?{fullText:value,fullRevision:{increment:1},fullManual:value!==proposal.text,revision:{increment:1}}:{promptText:value,promptRevision:{increment:1},promptSourceHash:proposal.sourceHash,promptManual:value!==proposal.text,revision:{increment:1}}});
        if(!changed.count)throw new ApiError(409,'REVISION_CONFLICT');
        const applied=await tx.proposal.updateMany({where:{id:proposal.id,applied:false},data:{applied:true}});
        if(!applied.count)throw new ApiError(409,'ALREADY_APPLIED');
      });return {applied:true};
    });
  }
  if(p[0]==='samples'&&p[1]) {
    const sample=await db.sample.findFirst({where:{id:p[1],cycle:{project:{ownerId}}}});if(!sample)throw new ApiError(404,'NOT_FOUND');
    return {sample:await db.sample.update({where:{id:sample.id},data:{comment:z.string().max(2000).parse(b.comment)}})};
  }
  if(p[0]==='jobs'&&p[2]==='cancel') {
    const job=await db.aiJob.findFirst({where:{id:p[1],cycle:{project:{ownerId}}}});if(!job)throw new ApiError(404,'NOT_FOUND');
    if(['succeeded','failed','canceled'].includes(job.state)) return {job};
    return {job:await db.aiJob.update({where:{id:job.id},data:{state:job.state==='queued'?'canceled':'cancel_requested'}})};
  }
  throw new ApiError(404,'NOT_FOUND');
}
async function del(req:NextRequest,p:string[],ownerId:string) {
  if(p[0]==='settings'&&p[1]==='credential') {await db.credential.deleteMany({where:{ownerId}});return {deleted:true};}
  if(p[0]==='projects'&&p[1]) {const project=await db.project.findFirst({where:{id:p[1],ownerId}});if(!project)throw new ApiError(404,'NOT_FOUND');await db.project.delete({where:{id:project.id}});return {deleted:true};}
  throw new ApiError(404,'NOT_FOUND');
}
async function handle(req:NextRequest,ctx:Ctx) {
  try {guard(req);const p=(await ctx.params).path||[];const current=await owner();
    const result=req.method==='GET'?await get(req,p,current.id):req.method==='POST'?await post(req,p,current.id):req.method==='PATCH'?await patch(req,p,current.id):req.method==='DELETE'?await del(req,p,current.id):null;
    if(result===null)throw new ApiError(405,'METHOD_NOT_ALLOWED');
    return result instanceof Response?result:ok(result,req.method==='POST'&&(['analyses','rules','assemblies','prompt-versions','checks','samples'].includes(p[2]||''))?202:200);
  } catch(e) {return failed(e);}
}
export const GET=handle; export const POST=handle; export const PATCH=handle; export const DELETE=handle;
