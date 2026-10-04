import {afterEach,describe,expect,it,vi} from 'vitest';
import {complete,readOpenRouterStream} from './provider';

const encoder=new TextEncoder();
function streamed(parts:string[]){return new Response(new ReadableStream<Uint8Array>({start(controller){for(const part of parts)controller.enqueue(encoder.encode(part));controller.close()}}),{status:200,headers:{'Content-Type':'text/event-stream'}})}
const payload=JSON.stringify({summary:'Краткий вывод',elements:[]});
const first=`data: ${JSON.stringify({id:'request-1',model:'z-ai/glm-5.3-flash',choices:[{delta:{content:payload.slice(0,10)}}]})}\n\n`;
const second=`data: ${JSON.stringify({choices:[{delta:{content:payload.slice(10)}}]})}\n\n`;
const usage=`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}})}\n\n`;

describe('OpenRouter streaming analysis',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('joins split SSE frames and returns actual usage without logging content',async()=>{
    const progress:{stage:string;outputChars:number}[]=[];
    const response=streamed([first.slice(0,31),first.slice(31)+second.slice(0,19),second.slice(19)+usage+'data: [DONE]\n\n']);
    const result=await readOpenRouterStream(response,AbortSignal.timeout(5000),async event=>{progress.push(event)});
    expect(result.content).toBe(payload);
    expect(result.usage.totalTokens).toBe(150);
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
    expect(JSON.stringify(sent?.messages)).toContain('Один короткий текст.');
  });
  it('rejects an incomplete stream instead of publishing a partial analysis',async()=>{
    await expect(readOpenRouterStream(streamed([first]),AbortSignal.timeout(5000))).rejects.toMatchObject({code:'STREAM_INTERRUPTED'});
  });
});
