import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react"
import { X } from "lucide-react"
import { cn } from "../lib/cn"

type Variant = "ink" | "brand" | "ghost" | "danger" | "outline" | "go"
const VARIANTS: Record<Variant, string> = {
  ink: "bg-ink text-paper hover:bg-ink-2",
  brand: "bg-brand text-on-brand hover:brightness-95",
  go: "bg-basil text-white hover:brightness-110",
  ghost: "bg-transparent text-ink-2 hover:bg-line/60",
  outline: "border border-line bg-card text-ink hover:border-ink-2",
  danger: "bg-chili text-white hover:brightness-110",
}

export function Button({ variant = "ink", size = "md", className, busy, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cn(
        "inline-flex select-none items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-8 px-2.5 text-xs" : size === "lg" ? "h-14 px-5 text-base" : "h-10 px-3.5 text-sm",
        VARIANTS[variant], className)}
    >
      {busy ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
      {children}
    </button>
  )
}

export const inputCls =
  "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-mute focus:border-ink-2 focus:outline-none"

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cn(inputCls, p.className)} />
}
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cn(inputCls, "min-h-20", p.className)} />
}
export function Select({ options, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: Array<string | { value: string; label: string }> }) {
  return (
    <select {...p} className={cn(inputCls, "pr-8", p.className)}>
      {options.map((o) => typeof o === "string"
        ? <option key={o} value={o}>{o}</option>
        : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-xs font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-mute">{hint}</span>}
    </label>
  )
}
export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", k)
    ref.current?.querySelector<HTMLElement>("input,textarea,select,button")?.focus()
    return () => window.removeEventListener("keydown", k)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true"
        className={cn("max-h-[92vh] w-full overflow-auto rounded-t-2xl bg-card text-ink shadow-2xl sm:rounded-2xl", wide ? "sm:max-w-3xl" : "sm:max-w-md")}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-card px-5 py-3.5">
          <h2 className="text-base font-bold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="rounded-md p-1 text-mute hover:text-ink"><X className="size-5" /></button>
        </div>
        <div className="space-y-3 px-5 py-4">{children}</div>
        {footer && <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-card px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-mute">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Tag({ tone = "mute", children, className }: { tone?: "mute" | "brand" | "go" | "warn" | "bad" | "info" | "plum"; children: ReactNode; className?: string }) {
  const t = {
    mute: "bg-line/70 text-ink-2", brand: "bg-brand-soft text-brand-deep", go: "bg-basil-soft text-basil",
    warn: "bg-amber-soft text-amber-deep", bad: "bg-chili-soft text-chili", info: "bg-sky-soft text-sky",
    plum: "bg-plum-soft text-plum",
  }[tone]
  return <span className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold", t, className)}>{children}</span>
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="wide text-2xl font-extrabold tracking-tight">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-mute">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; text: string; tone: "ok" | "bad" }
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => undefined)
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random()
    setList((l) => [...l.slice(-3), { id, text, tone }])
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === "bad" ? 6000 : 2800)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6">
        {list.map((t) => (
          <div key={t.id} className={cn("pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg",
            t.tone === "bad" ? "bg-chili text-white" : "bg-ink text-paper")}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
