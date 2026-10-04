import {z} from 'zod';

export const sourceRoleSchema=z.enum(['own','inspiration','unspecified']);
export const transferSchema=z.enum(['form','topic','mixed']);
export const portraitSchema=z.object({
  voice:z.string().max(6000), purposeHypothesis:z.string().max(2000),
  audienceHypothesis:z.string().max(2000), tone:z.string().max(2000),
  limits:z.array(z.string().max(1000)).max(20)
}).strict();
export const ruleCandidateSchema=z.object({
  id:z.string().min(1).max(100), direction:z.enum(['do','dont']),
  text:z.string().trim().min(1).max(3000),category:z.string().max(120),condition:z.string().max(1000),
  sourceIds:z.array(z.string()).min(1).max(100)
}).strict();
export const ruleSetSchema=z.object({candidates:z.array(ruleCandidateSchema).min(1).max(150),notes:z.array(z.string().max(2000)).max(30)}).strict();
export const ruleDraftSchema=z.object({
  text:z.string().trim().min(1).max(3000),direction:z.enum(['do','dont']),
  severity:z.enum(['none','soft','ban']),category:z.string().max(120),condition:z.string().max(1000),selected:z.boolean()
}).strict().superRefine((rule,ctx)=>{
  if(rule.direction==='do'&&rule.severity!=='none')ctx.addIssue({code:'custom',path:['severity'],message:'Для положительного правила сила запрета не задается'});
  if(rule.direction==='dont'&&rule.severity==='none')ctx.addIssue({code:'custom',path:['severity'],message:'Укажите: нежелательно или запрет'});
});
export type SourceRole=z.infer<typeof sourceRoleSchema>;
export type RuleCandidate=z.infer<typeof ruleCandidateSchema>;
export type RuleSource={id:string;role:SourceRole;kind:'technique'|'wish'|'constraint';principle:string;categories:string[];effect:string;nuances:string[];transferability:'form'|'topic'|'mixed';settings:{role:string;strength:number;frequency:string;condition:string};severity:'none'|'soft'|'ban'};
export type RuleInput={sources:RuleSource[]};
export const sourceRoleLabels:Record<SourceRole,string>={own:'Мой голос',inspiration:'Ориентир',unspecified:'Не указано'};
export function validateRuleSources(value:unknown,input:RuleInput){
  const parsed=ruleSetSchema.parse(value),allowed=new Set(input.sources.map(s=>s.id));
  if(new Set(parsed.candidates.map(r=>r.id)).size!==parsed.candidates.length)throw new Error('DUPLICATE_RULE_ID');
  for(const rule of parsed.candidates)if(rule.sourceIds.some(id=>!allowed.has(id)))throw new Error('UNKNOWN_RULE_SOURCE');
  return parsed;
}
export function selectedRulePayload(rules:{id:string;selected:boolean;archived:boolean;direction:string;text:string;category:string;condition:string;severity:string}[]){
  return {rules:rules.filter(r=>r.selected&&!r.archived).map(r=>({id:r.id,direction:r.direction,text:r.text,category:r.category,condition:r.condition,severity:r.severity}))};
}
export function ruleWarnings(rules:{id:string;selected:boolean;archived:boolean;direction:string;text:string}[]){
  const selected=rules.filter(r=>r.selected&&!r.archived),warnings:string[]=[];
  const seen=new Map<string,string>();
  for(const rule of selected){const text=rule.text.toLocaleLowerCase('ru').replace(/[\s.,;:!?]+/g,' ').trim();const old=seen.get(text);if(old)warnings.push(old===rule.direction?'Есть повторяющиеся выбранные правила.':'Одна формулировка выбрана одновременно как «Делай» и «Не делай».');else seen.set(text,rule.direction)}
  return [...new Set(warnings)];
}
