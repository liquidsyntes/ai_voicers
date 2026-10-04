const results=[];
for(let i=0;i<110;i++){
  const start=performance.now();
  const response=await fetch('http://localhost:3000/api/v1/projects');
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  await response.arrayBuffer();
  if(i>=10)results.push(performance.now()-start);
}
results.sort((a,b)=>a-b);
const avg=results.reduce((a,b)=>a+b,0)/results.length;
console.log(JSON.stringify({requests:results.length,averageMs:Math.round(avg),p95Ms:Math.round(results[94]),environment:'Docker Desktop, in-container HTTP, local PostgreSQL'}));
