'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {api} from '@/lib/client';
type Project={id:string;name:string;archived:boolean;cycles:{id:string;modelId:string;locked:boolean}[]};
export default function Home(){
  const router=useRouter();
  const [projects,setProjects]=useState<Project[]>([]),[name,setName]=useState(''),[model,setModel]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function load(){try{const [p,s]=await Promise.all([api<{projects:Project[]}>('projects'),api<{settings:{defaultModel:string;theme:string}}> ('settings')]);setProjects(p.projects);setModel(s.settings.defaultModel);document.documentElement.dataset.theme=s.settings.theme}catch(e){setError(String(e))}}
  useEffect(()=>{load()},[]);
  async function create(){setBusy(true);setError('');try{const r=await api<{project:Project}>('projects','POST',{name,modelId:model});router.push('/projects/'+r.project.id)}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <main className="shell"><header className="top"><Link className="brand" href="/">АВТОРСКИЙ ГОЛОС<span> / студия</span></Link><nav><Link href="/settings">Настройки</Link></nav></header><section className="hero"><span className="eyebrow">Локальная мастерская</span><h1>Соберите голос,<br/><em>который будет вашим.</em></h1><p>Разберите тексты по отдельности, выберите точные приемы и соберите переносимую инструкцию для другого ИИ.</p></section><section className="columns"><div className="panel"><div className="section-head"><h2>Проекты</h2><span>{projects.length}</span></div>{projects.length===0?<p className="muted">Пока нет проектов. Начните с одного референса.</p>:<div className="project-list">{projects.map(p=><Link href={'/projects/'+p.id} className="project-row" key={p.id}><span><strong>{p.name}</strong><small>{p.archived?'В архиве':`${p.cycles.length} цикл(ов)`}</small></span><span aria-hidden>↗</span></Link>)}</div>}</div><div className="panel"><div className="section-head"><h2>Новый проект</h2><span>01</span></div><label>Название<input value={name} onChange={e=>setName(e.target.value)} placeholder="Например, мой голос для эссе"/></label><label>Model ID OpenRouter<input value={model} onChange={e=>setModel(e.target.value)} placeholder="provider/model"/></label><p className="hint">Модель можно выбрать в настройках. В новом цикле она фиксируется при первом анализе.</p><button disabled={busy||!name.trim()||!model.trim()} onClick={create}>Создать проект <span>↗</span></button>{error&&<p className="error" role="alert">{error}</p>}</div></section></main>
}
