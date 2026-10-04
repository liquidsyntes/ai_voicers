import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ProviderError } from './provider';

export class ApiError extends Error { constructor(public status:number, public code:string, public fields?:unknown) { super(code); } }
export function guard(req:NextRequest) {
  const host = req.headers.get('host') || '';
  const hostname = host.split(':')[0];
  if (!['localhost','127.0.0.1','[::1]'].includes(hostname)) throw new ApiError(403,'HOST_FORBIDDEN');
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    const origin = req.headers.get('origin');
    if (!origin || new URL(origin).host !== host) throw new ApiError(403,'ORIGIN_FORBIDDEN');
    if (req.headers.get('content-type')?.includes('application/json') !== true && req.method !== 'DELETE') throw new ApiError(415,'JSON_REQUIRED');
  }
}
export async function body(req:NextRequest) {
  const size = Number(req.headers.get('content-length') || 0);
  if (size > 2*1024*1024) throw new ApiError(413,'REQUEST_TOO_LARGE');
  const text = await req.text();
  if (text.length > 2*1024*1024) throw new ApiError(413,'REQUEST_TOO_LARGE');
  try { return JSON.parse(text || '{}'); } catch { throw new ApiError(422,'INVALID_JSON'); }
}
export function ok(data:unknown,status=200) { return NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}}); }
export function failed(error:unknown) {
  const id=crypto.randomUUID();
  if (error instanceof ApiError) return ok({code:error.code,message:error.code,fields:error.fields,requestId:id,retryable:error.status>=500},error.status);
  if (error instanceof ProviderError) return ok({code:error.code,message:error.code==='CONTEXT_EXCEEDED'?'Контекст выбранной модели недостаточен; текст сохранен. Уменьшите вход или начните новый цикл с другой моделью.':error.code,requestId:id,retryable:error.retryable},error.code==='CONTEXT_EXCEEDED'?422:503);
  if (error instanceof ZodError) return ok({code:'INVALID_INPUT',message:'Проверьте поля',fields:error.flatten(),requestId:id,retryable:false},422);
  if (error instanceof Error && error.message.startsWith('MASTER_KEY_')) return ok({code:error.message,message:'Ключ шифрования недоступен. Восстановите том ключа или заново настройте API-ключ.',requestId:id,retryable:false},503);
  console.error('request failed',id,error instanceof Error?error.name:'unknown');
  return ok({code:'INTERNAL',message:'Внутренняя ошибка',requestId:id,retryable:true},500);
}
