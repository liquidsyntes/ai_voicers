import assert from 'node:assert/strict';
import pg from 'pg';

assert.equal(process.env.AI_ADAPTER,'test','Run only with the isolated test adapter');
assert.equal(new URL(process.env.DATABASE_URL).pathname,'/voicers_test','Run only against the isolated test database');

const base='http://localhost:3000/api/v1/';
async function request(path,method='GET',value,idem=false){
  const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{Origin:'http://localhost:3000'}:{}),...(value!==undefined?{'Content-Type':'application/json'}:{}),...(idem?{'Idempotency-Key':crypto.randomUUID()}: {})},body:value===undefined?undefined:JSON.stringify(value)});
  return {status:response.status,value:await response.json()};
}
async function success(path,method='GET',value,idem=false){const result=await request(path,method,value,idem);assert.ok(result.status<300,`${path}: ${result.status} ${result.value.code||''}`);return result.value;}
async function wait(jobId){for(let n=0;n<80;n++){const {job}=await success('jobs/'+jobId);if(['succeeded','failed','canceled'].includes(job.state))return job;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('analysis timeout');}

const settings=await success('settings');assert.equal(settings.adapter,'test');
const keep=(await success('projects','POST',{name:'DELETE KEEP',modelId:'test/model'})).project;
const remove=(await success('projects','POST',{name:'DELETE REMOVE',modelId:'test/model'})).project;
const cycleId=remove.cycles[0].id;
const referenceId=(await success('cycles/'+cycleId)).references[0].id;
const ref=(await success('cycles/'+cycleId)).references[0];
await success('references/'+referenceId,'PATCH',{expectedRevision:ref.revision,text:'Synthetic deletion test source.'});
const analysis=await success('references/'+referenceId+'/analyses','POST',{depth:'brief'},true);
assert.equal((await wait(analysis.jobId)).state,'succeeded');
const analyzed=await success('cycles/'+cycleId);
const firstAnalysis=analyzed.references[0].analyses[0];
await success('cycles/'+cycleId+'/selection','PATCH',{analysisId:firstAnalysis.id,elementId:firstAnalysis.elements[0].id,state:'selected'});
const selected=await success('cycles/'+cycleId);
const candidates=await success('cycles/'+cycleId+'/rules','POST',{expectedRevision:selected.cycle.revision},true);
assert.equal((await wait(candidates.jobId)).state,'succeeded');
await success('cycles/'+cycleId+'/manual-rules','POST',{rule:{text:'Use a short sentence.',direction:'do',severity:'none',category:'Test',condition:'',selected:true}},true);
const assembly=await success('cycles/'+cycleId+'/assemblies','POST',{},true);
assert.equal((await wait(assembly.jobId)).state,'succeeded');
const state=await success('cycles/'+cycleId);
assert.ok(state.ruleBatches.length&&state.proposals.length&&state.rules.length);
await success('cycles/'+cycleId+'/versions','POST',{name:'Before deletion',expectedRevision:state.cycle.revision},true);
const keepRule=await success('cycles/'+keep.cycles[0].id+'/manual-rules','POST',{rule:{text:'Keep this rule.',direction:'do',severity:'none',category:'Test',condition:'',selected:true}},true);

const db=new pg.Pool({connectionString:process.env.DATABASE_URL});
const relatedIds=new Set([remove.id,cycleId,...state.jobs.map(job=>job.id)]);
const containsRelatedId=value=>typeof value==='string'?relatedIds.has(value):Array.isArray(value)?value.some(containsRelatedId):value!==null&&typeof value==='object'?Object.values(value).some(containsRelatedId):false;
const beforeEntries=(await db.query('SELECT key,response FROM "Idempotency"')).rows;
const relatedKeys=beforeEntries.filter(entry=>containsRelatedId(entry.response)).map(entry=>entry.key);
assert.ok(relatedKeys.length>=5);
const textIds=(await db.query('SELECT id FROM "ReferenceText" WHERE "referenceId"=$1',[referenceId])).rows.map(row=>row.id);
const ruleRevisionIds=[];
for(const rule of state.rules)ruleRevisionIds.push(...(await db.query('SELECT id FROM "RuleRevision" WHERE "ruleId"=$1',[rule.id])).rows.map(row=>row.id));
const deleted=await success('projects/'+remove.id,'DELETE');assert.equal(deleted.deleted,true);
assert.equal((await request('projects/'+remove.id)).status,404);
assert.equal((await request('jobs/'+analysis.jobId)).status,404);
assert.equal((await request('rules/'+state.rules[0].id+'/revisions')).status,404);
assert.ok((await success('projects/'+keep.id)).project);
assert.ok((await success('rules/'+keepRule.rule.id+'/revisions')).revisions.length);

const checks={Project:['id',remove.id],Cycle:['projectId',remove.id],Reference:['cycleId',cycleId],Analysis:['referenceId',referenceId],VoiceRule:['cycleId',cycleId],RuleBatch:['cycleId',cycleId],VoiceVersion:['cycleId',cycleId],AiJob:['cycleId',cycleId],Proposal:['cycleId',cycleId],Sample:['cycleId',cycleId],Check:['cycleId',cycleId],Usage:['cycleId',cycleId]};
for(const [table,[field,id]] of Object.entries(checks)){
  const rows=await db.query(`SELECT COUNT(*)::int AS count FROM "${table}" WHERE "${field}"=$1`,[id]);
  assert.equal(rows.rows[0].count,0,`${table} still contains deleted project data`);
}
for(const [table,ids] of [['ReferenceText',textIds],['RuleRevision',ruleRevisionIds]])for(const id of ids){
  const rows=await db.query(`SELECT COUNT(*)::int AS count FROM "${table}" WHERE id=$1`,[id]);
  assert.equal(rows.rows[0].count,0,`${table} still contains deleted project data`);
}
const remaining=(await db.query('SELECT key,response FROM "Idempotency"')).rows;
assert.ok(remaining.some(entry=>entry.response?.rule?.id===keepRule.rule.id));
assert.ok(remaining.every(entry=>!relatedKeys.includes(entry.key)));
assert.equal(remaining.length,beforeEntries.length-relatedKeys.length);
await db.end();
console.log(JSON.stringify({status:'passed',removedProject:remove.id,remainingProject:keep.id,relatedTablesChecked:Object.keys(checks).length+2}));
