import {db} from './db';
import {analysisSchema,hash} from './domain';
import {validateRuleSources,sourceRoleSchema,type RuleInput,type RuleSource} from './method';
import {Prisma} from '../generated/prisma/client';

type Database=typeof db|Prisma.TransactionClient;
export async function ruleInput(client:Database,cycleId:string):Promise<RuleInput>{
  const cycle=await client.cycle.findUniqueOrThrow({where:{id:cycleId}});
  const references=await client.reference.findMany({where:{cycleId,archived:false},orderBy:[{position:'asc'},{id:'asc'}],include:{analyses:{orderBy:[{createdAt:'desc'},{id:'desc'}],include:{selections:true}}}});
  const sources:RuleSource[]=[];
  for(const reference of references){
    const analysis=reference.analyses.find(a=>a.textRevisionId===reference.currentTextRevisionId);
    if(!analysis)continue;
    const elements=analysisSchema.parse({summary:analysis.summary,elements:analysis.elements}).elements;
    for(const selection of analysis.selections.filter(s=>s.state==='selected').sort((a,b)=>a.id.localeCompare(b.id))){
      const element=elements.find(e=>e.id===selection.elementId);if(!element)continue;
      sources.push({id:selection.id,role:sourceRoleSchema.parse(reference.sourceRole),kind:'technique',principle:element.principle,categories:[...new Set(element.categories)],effect:element.effect,nuances:element.nuances,transferability:element.transferability||'mixed',settings:{role:selection.role,strength:selection.strength,frequency:selection.frequency,condition:selection.condition},severity:'none'});
    }
  }
  if(cycle.wishes.trim())sources.push({id:'wish',role:'unspecified',kind:'wish',principle:cycle.wishes,categories:[],effect:'',nuances:[],transferability:'mixed',settings:{role:'primary',strength:3,frequency:'moderate',condition:''},severity:'none'});
  const constraints=cycle.constraints as {kind:string;text:string}[];
  for(const [index,constraint] of constraints.entries())if(constraint.text.trim())sources.push({id:`constraint-${index}`,role:'unspecified',kind:'constraint',principle:constraint.text,categories:[],effect:'',nuances:[],transferability:'mixed',settings:{role:'primary',strength:3,frequency:'moderate',condition:''},severity:constraint.kind==='ban'?'ban':'soft'});
  return {sources};
}
export const ruleInputHash=(input:RuleInput)=>hash(JSON.stringify({sources:[...input.sources].sort((a,b)=>a.id.localeCompare(b.id))}));
export function ruleSnapshot(rule:{text:string;direction:string;category:string;condition:string;severity:string;selected:boolean;sourceIds:Prisma.JsonValue;origin:string;editedByUser:boolean;archived:boolean}){
  return {text:rule.text,direction:rule.direction,category:rule.category,condition:rule.condition,severity:rule.severity,selected:rule.selected,sourceIds:rule.sourceIds,origin:rule.origin,editedByUser:rule.editedByUser,archived:rule.archived} as Prisma.InputJsonValue;
}
export async function publishRules(tx:Prisma.TransactionClient,cycleId:string,input:RuleInput,value:unknown){
  const result=validateRuleSources(value,input);
  const batch=await tx.ruleBatch.create({data:{cycleId,inputHash:ruleInputHash(input),sourceSnapshot:input as unknown as Prisma.InputJsonValue,candidates:result.candidates as Prisma.InputJsonValue,notes:result.notes}});
  for(const candidate of result.candidates){
    const sources=input.sources.filter(s=>candidate.sourceIds.includes(s.id));
    const origin=sources.every(s=>s.kind!=='technique')?'user':'reference';
    const rule=await tx.voiceRule.create({data:{cycleId,batchId:batch.id,candidateId:candidate.id,text:candidate.text,direction:candidate.direction,category:candidate.category,condition:candidate.condition,severity:candidate.direction==='do'?'none':'soft',sourceIds:candidate.sourceIds,origin}});
    await tx.ruleRevision.create({data:{ruleId:rule.id,number:1,snapshot:ruleSnapshot(rule)}});
  }
  await tx.cycle.update({where:{id:cycleId},data:{rulesRevision:{increment:1},revision:{increment:1}}});
  return batch;
}

export async function restoreRules(tx:Prisma.TransactionClient,cycleId:string,snapshot:Record<string,unknown>,ids:Map<string,string>){
  const batches=Array.isArray(snapshot.ruleBatches)?snapshot.ruleBatches as Record<string,any>[]:[];
  const batchIds=new Map<string,string>();
  for(const old of batches){
    const original=old.sourceSnapshot as RuleInput;
    const sources=original.sources.map(source=>({...source,id:ids.get(source.id)||source.id}));
    const candidates=(old.candidates as {sourceIds:string[]}[]).map(rule=>({...rule,sourceIds:rule.sourceIds.map(id=>ids.get(id)||id)}));
    const created=await tx.ruleBatch.create({data:{cycleId,inputHash:ruleInputHash({sources}),sourceSnapshot:{sources} as unknown as Prisma.InputJsonValue,candidates:candidates as Prisma.InputJsonValue,notes:old.notes as Prisma.InputJsonValue}});
    batchIds.set(String(old.id),created.id);
  }
  const rules=Array.isArray(snapshot.rules)?snapshot.rules as Record<string,any>[]:[];
  for(const old of rules){
    const rule=await tx.voiceRule.create({data:{cycleId,batchId:old.batchId?batchIds.get(old.batchId):null,candidateId:old.candidateId||null,direction:old.direction,text:old.text,category:old.category,condition:old.condition,severity:old.severity,selected:old.selected,sourceIds:(old.sourceIds as string[]).map(id=>ids.get(id)||id),origin:old.origin,editedByUser:old.editedByUser,archived:old.archived}});
    await tx.ruleRevision.create({data:{ruleId:rule.id,number:1,snapshot:ruleSnapshot(rule)}});
  }
  if(rules.length)await tx.cycle.update({where:{id:cycleId},data:{rulesRevision:1}});
}
