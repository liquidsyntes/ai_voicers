import type { Completion, Kind } from './provider';
export const recorded: {kind:Kind; input:unknown}[] = [];
export async function testComplete(kind: Kind, input: unknown): Promise<Completion> {
  recorded.push({kind, input});
  const delay=Number(process.env.AI_TEST_DELAY_MS||0);
  if(delay>0)await new Promise(resolve=>setTimeout(resolve,Math.min(delay,30000)));
  const x = input as Record<string, unknown>;
  const value = kind === 'analyze' ? { summary:'Тестовый разбор', elements:[{id:'e1',title:'Короткие фразы',principle:'Чередуй короткие фразы с развернутыми.',effect:'Меняется темп.',categories:['Ритм'],nuances:['Уместно для пауз.'],evidence:[]}] } :
    kind === 'assemble' ? { text:'# Авторский голос\n\nЧередуй короткие фразы с развернутыми.\n\n'+String(x.wishes||''), notes:[] } :
    kind === 'prompt' ? { text:'Чередуй короткие фразы с развернутыми. '+String(x.fullText||'').slice(0,100), retainedRules:[] } :
    kind === 'check' ? {findings:[]} : {text:'Тестовая короткая проба по ситуации: '+String(x.situation||'')};
  return {value,usage:{inputTokens:10,outputTokens:20,totalTokens:30},requestId:'test-adapter'};
}
