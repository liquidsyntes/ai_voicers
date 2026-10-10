import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {CheckResults,type CheckView} from './check-results';

const base:CheckView={id:'check-1',document:'full',textHash:'hash',current:true,createdAt:'2026-10-10T12:00:00.000Z',findings:[]};

describe('check results',()=>{
  it('shows an explicit empty result after a completed check',()=>{
    const html=renderToStaticMarkup(<CheckResults checks={[base]} pending={false}/>);
    expect(html).toContain('Результат проверки');
    expect(html).toContain('Модель не указала противоречий и рекомендаций');
    expect(html).toContain('Актуальна');
  });

  it('shows the finding details and marks an old revision',()=>{
    const html=renderToStaticMarkup(<CheckResults checks={[{...base,current:false,document:'prompt',findings:[{kind:'conflict',detail:'Правила противоречат друг другу.'},{kind:'recommendation',detail:'Уточните условие применения.'}]}]} pending={false}/>);
    expect(html).toContain('Промпт-версия');
    expect(html).toContain('Устарела');
    expect(html).toContain('Правила противоречат друг другу.');
    expect(html).toContain('Уточните условие применения.');
  });

  it('shows where a pending check will appear',()=>{
    const html=renderToStaticMarkup(<CheckResults checks={[]} pending/>);
    expect(html).toContain('Результат появится здесь после завершения.');
  });
});
