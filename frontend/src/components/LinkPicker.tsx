import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown, Search, X } from "lucide-react"
import { call, P } from "../lib/api"
import { cn } from "../lib/cn"
import { inputCls } from "./ui"

export type LinkKind =
  | "currency" | "customer" | "item" | "cost_center" | "mode_of_payment"
  | "income_account" | "service_account" | "tax_account"

interface Hit { value: string; label?: string | null }

/** A searchable picker for an ERPNext record. Results come from the server
 *  as you type (pep_restaurant.accounting.search_link), so a site with
 *  thousands of customers or accounts works the same as one with five. */
export function LinkPicker({ kind, value, onChange, company, placeholder = "Search…", blankLabel, disabled }: {
  kind: LinkKind; value?: string | null; onChange: (v: string) => void; company?: string
  placeholder?: string; blankLabel?: string; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const [hits, setHits] = useState<Hit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    const n = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      call<Hit[]>(`${P}.accounting.search_link`, { kind, txt: q, company })
        .then((r) => { if (n === seq.current) { setHits(r); setActive(0) } })
        .catch(() => { if (n === seq.current) setHits([]) })
        .finally(() => { if (n === seq.current) setLoading(false) })
    }, q ? 180 : 0)
    return () => clearTimeout(t)
  }, [open, q, kind, company])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", away)
    return () => document.removeEventListener("mousedown", away)
  }, [open])

  const rows: Hit[] = [...(blankLabel ? [{ value: "", label: blankLabel }] : []), ...hits]
  const choose = (v: string) => { onChange(v); setOpen(false); setQ("") }
  const show = () => { if (disabled) return; setOpen(true); setTimeout(() => input.current?.focus(), 0) }
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[active]) choose(rows[active].value) }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false) }
  }

  return (
    // Field wraps pickers in a <label>; without this a click on an option would
    // also "click" the label's button and reopen the list
    <div ref={box} className="relative" onClick={(e) => e.preventDefault()}>
      <button type="button" onClick={() => (open ? setOpen(false) : show())} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open}
        className={cn(inputCls, "flex items-center justify-between gap-2 text-left disabled:opacity-50")}>
        <span className={cn("truncate", !value && "text-mute")}>{value || blankLabel || "Choose…"}</span>
        <span className="flex shrink-0 items-center gap-1 text-mute">
          {value && blankLabel !== undefined && (
            <span role="button" tabIndex={-1} aria-label="Clear" onClick={(e) => { e.stopPropagation(); onChange("") }}
              className="rounded p-0.5 hover:text-ink"><X className="size-3.5" /></span>
          )}
          <ChevronDown className="size-4" />
        </span>
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-line bg-card shadow-xl">
          <div className="relative border-b border-line">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder={placeholder}
              role="combobox" aria-controls={listId} aria-expanded aria-autocomplete="list"
              aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
              className="w-full bg-transparent py-2.5 pl-9 pr-3 text-sm text-ink placeholder:text-mute focus:outline-none" />
          </div>
          <ul id={listId} role="listbox" className="max-h-64 overflow-auto py-1">
            {rows.map((h, i) => (
              <li key={h.value || "_blank"} id={`${listId}-${i}`} role="option" aria-selected={h.value === (value ?? "")}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(h.value) }}
                className={cn("flex cursor-pointer items-center gap-2 px-3 py-2 text-sm", i === active && "bg-paper")}>
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate", !h.value && "text-mute")}>{h.value ? h.value : h.label}</span>
                  {h.value && h.label && <span className="block truncate text-xs text-mute">{h.label}</span>}
                </span>
                {h.value === (value ?? "") && <Check className="size-4 shrink-0" />}
              </li>
            ))}
            {!loading && !hits.length && (
              <li className="px-3 py-3 text-sm text-mute">{q ? `Nothing matches "${q}".` : "Nothing to choose yet."}</li>
            )}
            {loading && !hits.length && <li className="px-3 py-3 text-sm text-mute">Searching…</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
