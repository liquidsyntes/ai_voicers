export function supportsReasoningOff(modelId:string){
  return modelId==='~deepseek/deepseek-flash-latest'||modelId==='deepseek/deepseek-v4.1-flash';
}
export function suggestedReasoningEffort(modelId:string):'low'|'auto'{
  return supportsReasoningOff(modelId)||modelId==='z-ai/glm-5.3-flash'?'low':'auto';
}
