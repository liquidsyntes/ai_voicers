const started=Date.now();
try{
  const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer invalid-diagnostic-key','Content-Type':'application/json','HTTP-Referer':'http://localhost:3333','X-Title':'AI Voicers'},body:JSON.stringify({model:'z-ai/glm-5.3-flash',messages:[{role:'system',content:'Верни JSON.'},{role:'user',content:'test'}],response_format:{type:'json_object'},provider:{allow_fallbacks:false},stream:false}),signal:AbortSignal.timeout(12000)});
  console.log(JSON.stringify({http:response.status,durationMs:Date.now()-started}));
}catch(error){
  console.log(JSON.stringify({error:error instanceof Error?error.name:'unknown',cause:error?.cause?.code||null,durationMs:Date.now()-started}));
}
