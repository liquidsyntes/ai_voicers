import { createHash } from 'node:crypto';
import { z } from 'zod';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const wordCount = (s: string) => s.trim() ? s.trim().split(/\s+/u).length : 0;
export const instructionKeys = ['analyze', 'assemble', 'prompt', 'check', 'sample'] as const;
export const allowedVariables:Record<(typeof instructionKeys)[number],string[]>={analyze:['depth','word_count'],assemble:['selected_count'],prompt:['document_length'],check:['document_length'],sample:['document_length']};
export const defaults: Record<(typeof instructionKeys)[number], string> = {
  analyze: 'Разбери выразительные приемы именно в данном тексте. Отделяй наблюдение от предположения. Для каждого приема объясни переносимый принцип и эффект; при недостатке материала честно укажи это.',
  assemble: 'Создай самостоятельную подробную инструкцию авторского голоса из выбранных принципов и пожеланий. Сохрани разные приемы вместе, поясни условия их применения. Не приписывай пожелания источникам.',
  prompt: 'Подготовь более компактную, но содержательную инструкцию из точного текста полной инструкции. Сохрани существенные правила, условия и запреты.',
  check: 'Найди прямые противоречия и возможные потери смысла. Творческие сочетания не объявляй ошибкой. Дай краткие рекомендации без изменения текста.',
  sample: 'Создай одну короткую текстовую пробу по данной ситуации, следуя точному тексту инструкции.'
};
export const instructionsSchema = z.object(Object.fromEntries(instructionKeys.map(k => [k, z.string().trim().min(20).max(12000)])) as Record<(typeof instructionKeys)[number], z.ZodString>).strict().superRefine((content,ctx)=>{
  for(const key of instructionKeys) for(const match of content[key].matchAll(/\{\{([^{}]+)\}\}/g)) if(!allowedVariables[key].includes(match[1])) ctx.addIssue({code:'custom',path:[key],message:`Неизвестная переменная ${match[0]}`});
});
export function renderInstruction(kind:(typeof instructionKeys)[number], template:string,input:Record<string,unknown>){
  const values:Record<string,string>={depth:String(input.depth||''),word_count:String(wordCount(String(input.text||''))),selected_count:String(Array.isArray(input.selected)?input.selected.length:0),document_length:String(String(input.fullText||input.text||'').length)};
  return template.replace(/\{\{([^{}]+)\}\}/g,(_,name:string)=>allowedVariables[kind].includes(name)?values[name]:'');
}
export const elementSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), principle: z.string().min(1), effect: z.string(),
  categories: z.array(z.string()).min(1), nuances: z.array(z.string()).default([]),
  evidence: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string(), verified: z.boolean().optional() })).default([])
}).strict();
export const analysisSchema = z.object({ summary: z.string(), elements: z.array(elementSchema).max(500) }).strict();
export const assemblySchema = z.object({ text: z.string().min(1), notes: z.array(z.string()).default([]) }).strict();
export const promptSchema = z.object({ text: z.string().min(1), retainedRules: z.array(z.string()).default([]) }).strict();
export const checkSchema = z.object({ findings: z.array(z.object({ kind: z.enum(['conflict','recommendation']), detail: z.string() })) }).strict();
export const sampleSchema = z.object({ text: z.string().min(1) }).strict();

export function validateEvidence(text: string, analysis: z.infer<typeof analysisSchema>) {
  return { ...analysis, elements: analysis.elements.map(e => ({ ...e, evidence: e.evidence.map(v => ({ ...v, verified: text.slice(v.start, v.end) === v.quote })) })) };
}

export function cleanSelected(elements: {title:string; principle:string; categories:string[]; effect:string; nuances:string[]}[], settings: {role:string; strength:number; frequency:string; condition:string}) {
  return elements.map(e => ({ principle: e.principle, title: e.title, categories: e.categories, effect: e.effect, nuances: e.nuances, ...settings }));
}
