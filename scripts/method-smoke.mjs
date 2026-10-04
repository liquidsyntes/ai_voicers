import assert from 'node:assert/strict';
import pg from 'pg';
const base='http://localhost:3000/api/v1/',origin='http://localhost:3000';
async function req(path,method='GET',body,key){const r=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{Origin:origin}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});const value=await r.json();return {status:r.status,value}}
async function ok(path,method='GET',body,idem=false){const r=await req(path,method,body,idem?crypto.randomUUID():undefined);assert.ok(r.status<300,`${path}: ${r.status} ${r.value.code||''}`);return r.value}
async function wait(id){for(let i=0;i<80;i++){const {job}=await ok('jobs/'+id);if(['succeeded','failed','canceled'].includes(job.state))return job;await new Promise(r=>setTimeout(r,250))}throw new Error('job timeout')}
async function run(path,body={}){const r=await ok(path,'POST',body,true);const job=await wait(r.jobId);assert.equal(job.state,'succeeded',job.errorCode||'job failed');return r.jobId}
const settings=await ok('settings');assert.equal(settings.adapter,'test');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const {project}=await ok('projects','POST',{name:'METHOD ACCEPTANCE',modelId:'test/model'});const id=project.cycles[0].id;
let data=await ok('cycles/'+id);assert.equal(data.cycle.methodVersion,2);assert.equal(data.references.length,5);
const ref1=data.references[0],ref2=data.references[1];
await ok('references/'+ref1.id,'PATCH',{expectedRevision:ref1.revision,text:'PRIVATE_OWN_SOURCE '.repeat(5500),author:'PRIVATE_AUTHOR',sourceRole:'own'});
await ok('references/'+ref2.id,'PATCH',{expectedRevision:ref2.revision,text:'PRIVATE_INSPIRATION_SOURCE',sourceRole:'inspiration'});
const a1=await run('references/'+ref1.id+'/analyses',{depth:'detailed'}),a2=await run('references/'+ref2.id+'/analyses',{depth:'deep'});
const inputs=(await pool.query('SELECT input FROM "AiJob" WHERE id=ANY($1::text[])',[[a1,a2]])).rows.map(r=>r.input);
assert.ok(inputs.every(i=>!JSON.stringify(i).includes('PRIVATE_AUTHOR')));
assert.ok(inputs.every(i=>!(JSON.stringify(i).includes('PRIVATE_OWN_SOURCE')&&JSON.stringify(i).includes('PRIVATE_INSPIRATION_SOURCE'))));
data=await ok('cycles/'+id);for(const ref of data.references.slice(0,2)){const analysis=ref.analyses[0];assert.ok(analysis.portrait);assert.equal(analysis.elements[0].transferability,'form');await ok('cycles/'+id+'/selection','PATCH',{analysisId:analysis.id,elementId:'e1',state:'selected'})}
data=await ok('cycles/'+id);await ok('cycles/'+id+'/selection-settings','PATCH',{expectedRevision:data.cycle.revision,wishes:'Добавить теплую иронию',constraints:[{kind:'ban',text:'Не использовать штампы'}]});
data=await ok('cycles/'+id);
const key=crypto.randomUUID(),body={expectedRevision:data.cycle.revision};const first=await req('cycles/'+id+'/rules','POST',body,key);assert.equal(first.status,202);const repeated=await req('cycles/'+id+'/rules','POST',body,key);assert.equal(repeated.value.jobId,first.value.jobId);assert.equal((await wait(first.value.jobId)).state,'succeeded');
const ruleInput=(await pool.query('SELECT input FROM "AiJob" WHERE id=$1',[first.value.jobId])).rows[0].input;
const raw=JSON.stringify(ruleInput);for(const forbidden of ['PRIVATE_OWN_SOURCE','PRIVATE_INSPIRATION_SOURCE','PRIVATE_AUTHOR','UNSELECTED_TOPIC_CANARY','quote','evidence'])assert.ok(!raw.includes(forbidden),forbidden);
assert.deepEqual(ruleInput.sources.filter(s=>s.kind==='technique').map(s=>s.role).sort(),['inspiration','own']);
assert.equal(ruleInput.sources.filter(s=>s.kind==='technique').length,2);
data=await ok('cycles/'+id);assert.equal(data.rules.length,4);assert.ok(data.rules.every(r=>!r.selected));assert.equal(data.ruleBatches.length,1);
const doRules=data.rules.filter(r=>r.direction==='do');for(const r of doRules)await ok('rules/'+r.id,'PATCH',{expectedRevision:r.revision,selected:true},true);
data=await ok('cycles/'+id);const edited=data.rules.find(r=>r.id===doRules[0].id);await ok('rules/'+edited.id,'PATCH',{expectedRevision:edited.revision,text:'Ручное правило с точным условием',condition:'Только в финале'},true);
const conflict=await req('rules/'+edited.id,'PATCH',{expectedRevision:edited.revision,text:'потеря правки'},crypto.randomUUID());assert.equal(conflict.status,409);
data=await ok('cycles/'+id);const dont=data.rules.find(r=>r.direction==='dont');await ok('rules/'+dont.id,'PATCH',{expectedRevision:dont.revision,selected:true,severity:'ban'},true);
data=await ok('cycles/'+id);let ban=data.rules.find(r=>r.id===dont.id);await ok('rules/'+ban.id,'PATCH',{expectedRevision:ban.revision,selected:false},true);
data=await ok('cycles/'+id);assert.equal(data.rules.find(r=>r.id===dont.id).severity,'ban');
const initialSelected=data.rules.filter(r=>r.selected).map(r=>r.id);
await run('cycles/'+id+'/rules',{expectedRevision:data.cycle.revision});data=await ok('cycles/'+id);assert.equal(data.rules.length,8);assert.equal(data.rules.find(r=>r.id===edited.id).text,'Ручное правило с точным условием');assert.deepEqual(data.rules.filter(r=>r.selected).map(r=>r.id).sort(),initialSelected.sort());
await ok('cycles/'+id+'/selection-settings','PATCH',{expectedRevision:data.cycle.revision,wishes:'Новое пожелание без автоматического включения',constraints:[]});data=await ok('cycles/'+id);assert.ok(data.ruleBatches.every(b=>b.stale));
await ok('cycles/'+id+'/draft','PATCH',{kind:'full',text:'USER_DOCUMENT_BEFORE',expectedRevision:data.cycle.fullRevision});
const assemblyJob=await run('cycles/'+id+'/assemblies');const assemblyInput=(await pool.query('SELECT input FROM "AiJob" WHERE id=$1',[assemblyJob])).rows[0].input;
assert.equal(assemblyInput.rules.length,3);assert.ok(assemblyInput.rules.some(r=>r.text==='Ручное правило с точным условием'&&r.condition==='Только в финале'));assert.ok(!JSON.stringify(assemblyInput).includes('Новое пожелание'));assert.ok(!assemblyInput.rules.some(r=>r.direction==='dont'));
data=await ok('cycles/'+id);assert.equal(data.cycle.fullText,'USER_DOCUMENT_BEFORE');const proposal=data.proposals[0];await ok('cycles/'+id+'/proposals/'+proposal.id,'PATCH',{expectedRevision:data.cycle.fullRevision,text:proposal.text+'\nUSER_PARTIAL_APPLY'},true);
await run('cycles/'+id+'/prompt-versions');data=await ok('cycles/'+id);assert.ok(data.proposals.find(p=>p.kind==='prompt').text.includes('USER_PARTIAL_APPLY'));
const version=(await ok('cycles/'+id+'/versions','POST',{name:'RULE SNAPSHOT',expectedRevision:data.cycle.revision},true)).version;const snapshot=JSON.stringify(version.snapshot);
const continued=(await ok('versions/'+version.id+'/continue','POST',{})).cycle;let continuation=await ok('cycles/'+continued.id);assert.equal(continuation.cycle.methodVersion,2);assert.equal(continuation.rules.length,8);assert.equal(continuation.references[0].sourceRole,'own');assert.ok(continuation.references[0].analyses[0].portrait);assert.equal(continuation.rules.filter(r=>r.selected).length,3);
const old=continuation.rules.find(r=>r.selected);await ok('rules/'+old.id,'PATCH',{expectedRevision:old.revision,text:'Изменение продолжения'},true);assert.equal(JSON.stringify((await ok('cycles/'+id)).versions[0].snapshot),snapshot);
const history=await ok('rules/'+edited.id+'/revisions');assert.ok(history.revisions.length>=3);
// A canceled delayed generation never publishes candidates.
data=await ok('cycles/'+id);const before=data.rules.length;const cancel=await ok('cycles/'+id+'/rules','POST',{expectedRevision:data.cycle.revision},true);
for(let i=0;i<30;i++){if((await ok('jobs/'+cancel.jobId)).job.state==='running')break;await new Promise(r=>setTimeout(r,100))}
await ok('jobs/'+cancel.jobId+'/cancel','PATCH',{});assert.equal((await wait(cancel.jobId)).state,'canceled');assert.equal((await ok('cycles/'+id)).rules.length,before);
// Late proposals are flagged stale without replacing accepted rules.
data=await ok('cycles/'+id);const late=await ok('cycles/'+id+'/rules','POST',{expectedRevision:data.cycle.revision},true);await ok('cycles/'+id+'/selection-settings','PATCH',{expectedRevision:data.cycle.revision,wishes:'Правка во время генерации',constraints:[]});assert.equal((await wait(late.jobId)).state,'succeeded');data=await ok('cycles/'+id);assert.equal(data.ruleBatches[0].stale,true);assert.equal(data.rules.find(r=>r.id===edited.id).text,'Ручное правило с точным условием');
// Archiving a source preserves old origins but excludes it from new candidates.
data=await ok('cycles/'+id);const archivedRef=data.references.find(r=>r.id===ref2.id);await ok('references/'+ref2.id,'PATCH',{expectedRevision:archivedRef.revision,archived:true});data=await ok('cycles/'+id);const archivedJob=await run('cycles/'+id+'/rules',{expectedRevision:data.cycle.revision});const archivedInput=(await pool.query('SELECT input FROM \"AiJob\" WHERE id=$1',[archivedJob])).rows[0].input;assert.ok(!archivedInput.sources.some(s=>s.role==='inspiration'));data=await ok('cycles/'+id);await ok('references/'+ref2.id,'PATCH',{expectedRevision:data.references.find(r=>r.id===ref2.id).revision,archived:false});
// Legacy records have no method upgrade or generation on read.
await pool.query('UPDATE "Cycle" SET "methodVersion"=1 WHERE id=$1',[continued.id]);continuation=await ok('cycles/'+continued.id);assert.equal(continuation.cycle.methodVersion,1);assert.equal((await req('cycles/'+continued.id+'/rules','POST',{expectedRevision:continuation.cycle.revision},crypto.randomUUID())).status,409);
await pool.end();console.log(JSON.stringify({status:'passed',projectId:project.id,cycleId:id,checks:['roles','independent-analysis','portrait','source-isolation','candidates-unselected','negative-rule-choice','manual-preservation','regeneration','staleness','exact-rule-assembly','idempotency','revision-conflict','immutable-version','continuation','cancel','legacy']}));
