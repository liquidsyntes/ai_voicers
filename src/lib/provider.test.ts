import {afterEach,describe,expect,it,vi} from 'vitest';
import {catalog,complete,inspectModel,readOpenRouterStream} from './provider';

const encoder=new TextEncoder();
function streamed(parts:string[]){return new Response(new ReadableStream<Uint8Array>({start(controller){for(const part of parts)controller.enqueue(encoder.encode(part));controller.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})}
const payload=JSON.stringify({summary:'Краткий вывод',elements:[]});
const first=`data: ${JSON.stringify({id:'request-1',model:'z-ai/glm-5.3-flash',choices:[{delta:{content:payload.slice(0,10)}}]})}\n\n`;
const second=`data: ${JSON.stringify({choices:[{delta:{content:payload.slice(10)}}]})}\n\n`;
const usage=`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150,completion_tokens_details:{reasoning_tokens:20}}})}\n\n`;

describe('OpenRouter streaming analysis',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('joins split SSE frames and returns actual usage without logging content',async()=>{
    const progress:{stage:string;outputChars:number}[]=[];
    const response=streamed([first.slice(0,31),first.slice(31)+second.slice(0,19),second.slice(19)+usage+'data: [DONE]\n\n']);
    const result=await readOpenRouterStream(response,AbortSignal.timeout(5000),async event=>{progress.push(event)});
    expect(result.content).toBe(payload);
    expect(result.usage.totalTokens).toBe(150);
    expect(result.reasoningTokens).toBe(20);
    expect(result.firstChunkMs).not.toBeNull();
    expect(progress.at(-1)?.outputChars).toBe(payload.length);
  });
  it('sends a strict schema and streams only the selected reference',async()=>{
    let sent:Record<string,unknown>|undefined;
    vi.stubGlobal('fetch',vi.fn(async (_url:string,options:{body:string})=>{sent=JSON.parse(options.body);return streamed([first,second,usage,'data: [DONE]\n\n'])}));
    const result=await complete('analyze','z-ai/glm-5.3-flash','Анализируй один текст.',{text:'Один короткий текст.',depth:'detailed'},'test-key',AbortSignal.timeout(5000),undefined,undefined,'low');
    expect(result.value).toEqual({summary:'Краткий вывод',elements:[]});
    expect(sent?.stream).toBe(true);
    expect((sent?.reasoning as {effort:string}).effort).toBe('low');
    expect((sent?.response_format as {type:string}).type).toBe('json_schema');
    expect((sent?.provider as {preferred_min_throughput:{p90:number}}).preferred_min_throughput.p90).toBe(100);
    expect(JSON.stringify(sent?.messages)).toContain('Один короткий текст.');
    expect(result.timings?.requestBytes).toBeGreaterThan(0);
    expect(result.reasoningTokens).toBe(20);
  });
  it('turns reasoning off when a new cycle requests the fast mode',async()=>{
    let sent:Record<string,unknown>|undefined;
    vi.stubGlobal('fetch',vi.fn(async (_url:string,options:{body:string})=>{sent=JSON.parse(options.body);return streamed([first,second,usage,'data: [DONE]\n\n'])}));
    await complete('analyze','~deepseek/deepseek-flash-latest','Анализируй один текст.',{text:'Синтетический текст.',depth:'detailed'},'test-key',AbortSignal.timeout(5000),undefined,undefined,'none');
    expect(sent?.reasoning).toEqual({enabled:false});
  });
  it('rejects an incomplete stream instead of publishing a partial analysis',async()=>{
    await expect(readOpenRouterStream(streamed([first]),AbortSignal.timeout(5000))).rejects.toMatchObject({code:'STREAM_INTERRUPTED'});
  });
  it('uses the rules protocol and validates the final streamed candidates',async()=>{
    const answer={candidates:[{id:'r1',direction:'do',text:'Меняй длину фраз.',category:'Ритм',condition:'При смене темпа',sourceIds:['s1']}],notes:[]};
    let sent:any;
    vi.stubGlobal('fetch',vi.fn(async (_url:string,options:{body:string})=>{sent=JSON.parse(options.body);return streamed([`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(answer)}}]})}\n\n`,usage,'data: [DONE]\n\n'])}));
    const result=await complete('rules','test/model','Создай кандидаты.',{methodVersion:2,sources:[{id:'s1',principle:'Меняй ритм'}]},'test-key',AbortSignal.timeout(5000));
    expect(result.value).toEqual(answer);
    expect(sent.response_format.json_schema.name).toBe('voice_rules');
    expect(sent.response_format.json_schema.schema.required).toContain('candidates');
    expect(result.usage.totalTokens).toBe(150);
  });
  it('requires the voice portrait in the model-2 analysis response',async()=>{
    const answer={summary:'Наблюдение',portrait:{voice:'Разговорный голос',purposeHypothesis:'Вероятно, объяснить',audienceHypothesis:'Неизвестна',tone:'Спокойный',limits:[]},elements:[]};
    let sent:any;
    vi.stubGlobal('fetch',vi.fn(async (_url:string,options:{body:string})=>{sent=JSON.parse(options.body);return streamed([`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(answer)}}]})}\n\n`,'data: [DONE]\n\n'])}));
    const result=await complete('analyze','test/model','Анализируй текст.',{methodVersion:2,text:'Синтетический текст',depth:'detailed'},'test-key',AbortSignal.timeout(5000));
    expect(result.value).toEqual(answer);
    expect(sent.response_format.json_schema.schema.required).toContain('portrait');
    expect(sent.response_format.json_schema.schema.properties.elements.items.required).toContain('transferability');
  });
  it('checks model availability without starting a completion',async()=>{
    const fetchMock=vi.fn(async(...args:[string,RequestInit])=>{void args;return new Response('',{status:404})});
    vi.stubGlobal('fetch',fetchMock);
    expect(await inspectModel('stealth/space-bunny-alpha','test-key')).toMatchObject({status:'unavailable'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/model/stealth/space-bunny-alpha');
  });
  it('uses a fresh request when the catalog is manually refreshed',async()=>{
    const fetchMock=vi.fn(async(...args:[string,RequestInit])=>{void args;return new Response(JSON.stringify({data:[]}),{status:200})});
    vi.stubGlobal('fetch',fetchMock);
    expect(await catalog(true)).toEqual([]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({cache:'no-store'});
  });
  it('uses the account-filtered catalog when a saved key is available',async()=>{
    const fetchMock=vi.fn(async(...args:[string,RequestInit])=>{void args;return new Response(JSON.stringify({data:[]}),{status:200})});
    vi.stubGlobal('fetch',fetchMock);
    await catalog(true,'test-key');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/models/user');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({cache:'no-store',headers:{Authorization:'Bearer test-key'}});
  });
});
