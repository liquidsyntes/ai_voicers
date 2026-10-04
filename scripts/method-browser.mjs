import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base='http://127.0.0.1:3334';
async function api(path,method='GET',body){const response=await fetch(base+'/api/v1/'+path,{method,headers:{...(body?{'Content-Type':'application/json',Origin:base}:{}),'Idempotency-Key':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});if(!response.ok)throw new Error(`${path}: ${response.status}`);return response.json()}
async function until(check){for(let i=0;i<80;i++){if(await check())return;await new Promise(r=>setTimeout(r,150))}throw new Error('condition timeout')}
const settings=await api('settings');assert.equal(settings.adapter,'test');
await api('settings','PATCH',{expectedRevision:settings.settings.revision,theme:'light'});
const project=(await api('projects')).projects.find(p=>p.name==='METHOD ACCEPTANCE');
const details=(await api('projects/'+project.id)).project;
const cycle=details.cycles.find(c=>c.methodVersion===2);assert.ok(cycle);
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base+'/projects/'+project.id,{waitUntil:'networkidle'});await page.getByLabel('Цикл',{exact:true}).selectOption(cycle.id);
await page.getByRole('tab',{name:'Приемы',exact:true}).click();
await page.locator('.method-lane.own .technique-card').first().waitFor();
assert.ok(await page.locator('.method-lane.inspiration .technique-card').count());
await page.locator('.method-lane.own').getByText('Описание звучания',{exact:true}).click();
await page.getByLabel('Фильтр категории',{exact:true}).selectOption('Ритм');
await page.screenshot({path:'/tmp/voicers-method-techniques.png',fullPage:true});
const beforeJobs=(await api('cycles/'+cycle.id)).jobs.length;
await page.getByLabel('Только выбранные').check();await page.getByLabel('Только выбранные').uncheck();
assert.equal((await api('cycles/'+cycle.id)).jobs.length,beforeJobs);
await page.getByRole('tab',{name:'Правила',exact:true}).click();await page.locator('.rule-card').first().waitFor();
const card=page.locator('.rule-card').filter({hasText:'Редакция пользователя'}).first();await card.waitFor();
const field=card.locator('textarea').first();await field.fill('Правка из браузера с сохранением выбора');await field.blur();
await until(async()=> (await api('cycles/'+cycle.id)).rules.some(r=>r.text==='Правка из браузера с сохранением выбора'));
await page.screenshot({path:'/tmp/voicers-method-rules.png',fullPage:true});
// Keyboard action uses the same immediate server save.
const keyboardCard=page.locator('.rule-card').first();const checkbox=keyboardCard.locator('.rule-select input');const checked=await checkbox.isChecked();await checkbox.focus();await page.keyboard.press('Space');await until(async()=>await checkbox.isChecked()!==checked);await page.waitForTimeout(500);
// Two tabs cannot silently replace the same rule revision.
const other=await browser.newPage({viewport:{width:1440,height:1000}});other.on('pageerror',e=>errors.push(e.message));
await other.goto(base+'/projects/'+project.id,{waitUntil:'networkidle'});await other.getByLabel('Цикл',{exact:true}).selectOption(cycle.id);await other.getByRole('tab',{name:'Правила',exact:true}).click();
const rule=(await api('cycles/'+cycle.id)).rules.find(r=>r.text==='Правка из браузера с сохранением выбора');
const otherField=other.locator('.rule-card textarea');
const index=await otherField.evaluateAll((nodes)=>nodes.findIndex(n=>n.value==='Правка из браузера с сохранением выбора'));assert.ok(index>=0);
await api('rules/'+rule.id,'PATCH',{expectedRevision:rule.revision,text:'Конкурентная серверная правка'});
await otherField.nth(index).fill('Несохраненная правка второй вкладки');await otherField.nth(index).blur();
await other.getByRole('alert').filter({hasText:'REVISION_CONFLICT'}).waitFor();assert.equal(await otherField.nth(index).inputValue(),'Несохраненная правка второй вкладки');await other.close();
// Re-open clean UI for responsive checks in both themes.
await page.reload({waitUntil:'networkidle'});await page.getByLabel('Цикл',{exact:true}).selectOption(cycle.id);
for(const theme of ['light','dark']){const current=await api('settings');await api('settings','PATCH',{expectedRevision:current.settings.revision,theme});await page.reload({waitUntil:'networkidle'});await page.getByLabel('Цикл',{exact:true}).selectOption(cycle.id);await page.setViewportSize({width:360,height:780});for(const tab of ['Референсы','Приемы','Правила','Результат']){await page.getByRole('tab',{name:tab,exact:true}).click();await page.waitForTimeout(100);const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert.ok(overflow<=1,`${theme}/${tab}: ${overflow}px`)}await page.getByRole('tab',{name:'Правила',exact:true}).click();await page.screenshot({path:`/tmp/voicers-method-${theme}-mobile.png`,fullPage:true});}
assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',checks:['role-lanes','local-filter','rule-autosave','keyboard','two-tabs-conflict','light-dark','360px'],pageErrors:errors.length}));await browser.close();
