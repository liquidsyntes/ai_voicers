import {describe,it,expect} from 'vitest';
import {analysisSchema,validateEvidence,wordCount,instructionsSchema,defaults} from './domain';
import {contextCheck,ProviderError} from './provider';
import {recorded,testComplete} from './test-adapter';

describe('границы модельных данных',()=>{
  it('не принимает лишние поля и не подтверждает неверную цитату',()=>{
    const result=analysisSchema.parse({summary:'Разбор',elements:[{id:'a',title:'Ритм',principle:'Чередуй фразы',effect:'Темп',categories:['Ритм'],nuances:[],evidence:[{start:0,end:5,quote:'чужой'}]}]});
    expect(validateEvidence('Текст написан',result).elements[0].evidence[0].verified).toBe(false);
    const relocated=validateEvidence('Одна точная цитата.',{summary:'x',elements:[{id:'x',title:'x',principle:'x',effect:'x',categories:['Ритм'],nuances:[],evidence:[{start:0,end:1,quote:'точная цитата'}]}]});
    expect(relocated.elements[0].evidence[0]).toMatchObject({start:5,end:18,verified:true});
    const repeated=validateEvidence('слово и слово',{summary:'x',elements:[{id:'x',title:'x',principle:'x',effect:'x',categories:['Ритм'],nuances:[],evidence:[{start:2,end:4,quote:'слово'}]}]});
    expect(repeated.elements[0].evidence[0].verified).toBe(false);
    expect(()=>analysisSchema.parse({summary:'x',elements:[],source:'скрытое поле'})).toThrow();
  });
  it('не обрезает большой текст при недостатке контекста',()=>{
    const input={text:'слово '.repeat(5500)};
    expect(()=>contextCheck(input,2000)).toThrowError(ProviderError);
    expect(contextCheck(input,1048576).uncertain).toBe(false);
    expect(input.text.length).toBeGreaterThan(30000);
  });
  it('отличает счетчик слов от числа символов',()=>{
    expect(wordCount('один\n два   три')).toBe(3);
  });
  it('тестовый адаптер явно записывает контекст операции',()=>{
    recorded.length=0;
    testComplete('analyze',{text:'только один референс',depth:'brief'});
    expect(recorded).toEqual([{kind:'analyze',input:{text:'только один референс',depth:'brief'}}]);
  });
  it('отвергает неизвестную переменную рабочих инструкций',()=>{
    expect(()=>instructionsSchema.parse({...defaults,analyze:defaults.analyze+' {{secret_key}}'})).toThrow();
  });
});
