import type {Completion,Kind} from './provider';
import type {RuleInput} from './method';
export const recorded:{kind:Kind;input:unknown}[]=[];
export async function testComplete(kind:Kind,input:unknown):Promise<Completion>{
  recorded.push({kind,input});
  const delay=Number(process.env.AI_TEST_DELAY_MS||0);if(delay>0)await new Promise(r=>setTimeout(r,Math.min(delay,30000)));
  const x=input as Record<string,unknown>;
  let value:unknown;
  if(kind==='analyze'){
    const richer=Number(x.methodVersion)>=2;
    const elements=[{id:'e1',title:'Переменный ритм',principle:'Чередуй короткие фразы с развернутыми.',effect:'Меняется темп.',categories:['Ритм','Синтаксис'],nuances:x.depth==='brief'?[]:x.depth==='deep'?['Уместно для пауз.','Учитывай взаимодействие с интонацией.']:['Уместно для пауз.'],evidence:[],...(richer?{transferability:'form'}:{})}];
    value={summary:`Тестовый разбор: ${x.depth}`,elements:richer?[...elements,{id:'topic',title:'Тематический мотив',principle:'UNSELECTED_TOPIC_CANARY',effect:'Связан с темой',categories:['Образность'],nuances:[],evidence:[],transferability:'topic'}]:elements,...(richer?{portrait:{voice:'Спокойный наблюдающий голос.',purposeHypothesis:'Возможно, осмыслить опыт.',audienceHypothesis:'Предположительно, читатель личных заметок.',tone:'Разговорный',limits:['Тестовый адаптер: выводы не являются реальным анализом.']}}:{})};
  }else if(kind==='rules'){
    const sources=(input as RuleInput).sources;
    value={candidates:sources.map((s,i)=>({id:`candidate-${i}`,direction:s.kind==='constraint'?'dont':'do',text:s.kind==='technique'?`${s.principle} Условие источника ${i+1}.`:s.principle,category:s.categories[0]||'Пожелание пользователя',condition:s.settings.condition,sourceIds:[s.id]})),notes:['Тестовый адаптер: проверьте сочетания вручную.']};
  }else if(kind==='assemble'){
    const rules=x.rules as {direction:string;text:string;severity:string;condition:string}[]|undefined;
    value={text:rules?'# Авторский голос\n\n'+rules.map(r=>`${r.direction==='do'?'Делай':r.severity==='ban'?'Запрет':'Нежелательно'}: ${r.text}${r.condition?' Когда: '+r.condition:''}`).join('\n\n'):'# Авторский голос\n\nЧередуй короткие фразы с развернутыми.\n\n'+String(x.wishes||''),notes:[]};
  }else if(kind==='prompt')value={text:String(x.fullText||''),retainedRules:[]};
  else if(kind==='check')value={findings:[]};
  else value={text:'Тестовая короткая проба по ситуации: '+String(x.situation||'')};
  return {value,usage:{inputTokens:10,outputTokens:20,totalTokens:30},requestId:'test-adapter'};
}
