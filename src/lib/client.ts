export async function api<T=any>(path:string, method='GET', data?:unknown, idem=false):Promise<T>{
  const r=await fetch('/api/v1/'+path,{method,headers:{...(data!==undefined?{'Content-Type':'application/json'}:{}),...(idem?{'Idempotency-Key':crypto.randomUUID()}:{})},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store'});
  const value=await r.json();
  if(!r.ok) throw new Error(value.message||value.code||'Ошибка запроса');
  return value;
}
