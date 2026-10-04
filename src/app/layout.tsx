import type { Metadata } from 'next';
import './style.css';
export const metadata:Metadata={title:'Авторский голос',description:'Локальный конструктор авторского голоса'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ru"><body>{children}</body></html>}
