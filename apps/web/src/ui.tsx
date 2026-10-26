import type {ButtonHTMLAttributes,InputHTMLAttributes,ReactNode} from 'react';
import {twMerge} from 'tailwind-merge';
export function Button({className,variant='primary',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'ghost'|'danger'}){
  const style=variant==='primary'?'bg-teal-700 text-white hover:bg-teal-800':variant==='secondary'?'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50':variant==='danger'?'bg-rose-50 text-rose-700 hover:bg-rose-100':'text-slate-600 hover:bg-slate-100';
  return <button className={twMerge('inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',style,className)} {...props}/>;
}
export function Input({className,...props}:InputHTMLAttributes<HTMLInputElement>){return <input className={twMerge('w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-teal-600 focus:ring-2 focus:ring-teal-600/10',className)} {...props}/>;}
export function Card({children,className}:{children:ReactNode;className?:string}){return <div className={twMerge('rounded-lg border border-slate-200 bg-white shadow-sm',className)}>{children}</div>;}
export function Badge({children,tone='neutral'}:{children:ReactNode;tone?:'neutral'|'green'|'red'|'amber'}){return <span className={twMerge('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',tone==='green'?'bg-emerald-50 text-emerald-700':tone==='red'?'bg-rose-50 text-rose-700':tone==='amber'?'bg-amber-50 text-amber-700':'bg-slate-100 text-slate-600')}>{children}</span>;}
