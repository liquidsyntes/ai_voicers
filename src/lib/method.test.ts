import {describe,it,expect} from 'vitest';
import {ruleDraftSchema,selectedRulePayload,validateRuleSources,ruleWarnings,type RuleInput} from './method';
import {methodAnalysisSchema,analysisSchema,instructionsSchema,defaults} from './domain';
const input:RuleInput={sources:[{id:'s1',kind:'technique',role:'own',principle:'Меняй ритм',categories:['Ритм'],effect:'Пауза',nuances:[],transferability:'form',settings:{role:'secondary',strength:3,frequency:'moderate',condition:''},severity:'none'}]};
const candidate={id:'a',direction:'do',text:'Меняй длину фразы.',category:'Ритм',condition:'После размышления',sourceIds:['s1']};
describe('новый метод',()=>{
  it('проверяет происхождение и не принимает выдуманные источники',()=>{
    expect(validateRuleSources({candidates:[candidate],notes:[]},input).candidates).toHaveLength(1);
    expect(()=>validateRuleSources({candidates:[{...candidate,sourceIds:['another-cycle']}],notes:[]},input)).toThrow('UNKNOWN_RULE_SOURCE');
  });
  it('в сборку входят лишь выбранные правила с точной ручной редакцией',()=>{
    const rule={id:'r',selected:true,archived:false,direction:'do',text:'Моя точная правка',category:'Ритм',condition:'При паузе',severity:'none',sourceIds:['secret'],quote:'PRIVATE',sourceText:'PRIVATE'};
    expect(selectedRulePayload([rule,{...rule,id:'unselected',selected:false,text:'UNSELECTED'},{...rule,id:'archived',archived:true}])).toEqual({rules:[{id:'r',direction:'do',text:'Моя точная правка',category:'Ритм',condition:'При паузе',severity:'none'}]});
  });
  it('снятие отрицательного правила не меняет его силу и не добавляет запрета',()=>{
    const rule={id:'ban',selected:false,archived:false,direction:'dont',text:'Не использовать клише',category:'Лексика',condition:'',severity:'ban'};
    expect(selectedRulePayload([rule]).rules).toEqual([]);
    expect(rule.severity).toBe('ban');
    expect(()=>ruleDraftSchema.parse({text:rule.text,selected:false,category:'Лексика',condition:'',direction:'do',severity:'ban'})).toThrow();
  });
  it('конфликт дает замечание без запрета сохранения',()=>{
    const a={id:'a',selected:true,archived:false,direction:'do',text:'Использовать метафоры'};
    expect(ruleWarnings([a,{...a,id:'b',direction:'dont'}])).toHaveLength(1);
  });
  it('старые анализы читаются, а новый анализ требует портрет и переносимость',()=>{
    const old={summary:'x',elements:[]};expect(analysisSchema.parse(old)).toEqual(old);
    expect(()=>methodAnalysisSchema.parse(old)).toThrow();
    const {rules,...legacy}=defaults;expect(instructionsSchema.parse(legacy).rules).toBe(rules);
  });
});
