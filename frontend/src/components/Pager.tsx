import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "../lib/cn"

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

/** Rows per page, remembered on this device per list. */
export function savedPageSize(key: string, fallback = 15) {
  const n = Number(store.get(`pep.pagesize.${key}`))
  return [10, 15, 30, 60].includes(n) ? n : fallback
}
export const savePageSize = (key: string, n: number) => store.set(`pep.pagesize.${key}`, String(n))

/** Page numbers to show: always the first and last, the current one and its
 *  neighbours, with gaps marked - "1 … 4 5 6 … 12". */
function pages(current: number, count: number): (number | "gap")[] {
  const want = new Set([1, count, current - 1, current, current + 1].filter((p) => p >= 1 && p <= count))
  const list = [...want].sort((a, b) => a - b)
  const out: (number | "gap")[] = []
  list.forEach((p, i) => {
    // a gap of exactly one page shows that page; "…" only stands in for two or more
    if (i && p - list[i - 1] === 2) out.push(p - 1)
    else if (i && p - list[i - 1] > 2) out.push("gap")
    out.push(p)
  })
  return out
}

export function Pager({ page, pageSize, total, onPage, onPageSize, noun = "items" }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void; noun?: string
}) {
  const count = Math.max(1, Math.ceil(total / pageSize))
  if (total <= 10 && !onPageSize) return null
  const from = total ? (page - 1) * pageSize + 1 : 0
  const to = Math.min(total, page * pageSize)
  const btn = "inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2 text-sm font-semibold disabled:opacity-35"
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-mute">{from}–{to} of {total} {noun}</p>
      <div className="flex items-center gap-1">
        <button className={cn(btn, "hover:bg-line/60")} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="size-4" />
        </button>
        {pages(page, count).map((p, i) => p === "gap"
          ? <span key={`g${i}`} className="px-1 text-mute">…</span>
          : <button key={p} onClick={() => onPage(p)} aria-current={p === page ? "page" : undefined}
              className={cn(btn, p === page ? "bg-ink text-paper" : "hover:bg-line/60")}>{p}</button>)}
        <button className={cn(btn, "hover:bg-line/60")} disabled={page >= count} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight className="size-4" />
        </button>
      </div>
      {onPageSize && (
        <label className="flex items-center gap-2 text-sm text-mute">
          Show
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
            className="rounded-lg border border-line bg-card px-2 py-1.5 text-sm text-ink">
            {[10, 15, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          per page
        </label>
      )}
    </nav>
  )
}

/** Paging state for a client-side list. Goes back to page 1 when `resetKey`
 *  changes (a new search or filter) and never sits past the last page. */
export function usePaged<T>(items: T[], key: string, resetKey: unknown) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState(() => savedPageSize(key))
  const count = Math.max(1, Math.ceil(items.length / pageSize))
  useEffect(() => { setPage(1) }, [resetKey, pageSize])
  useEffect(() => { if (page > count) setPage(count) }, [page, count])
  const go = (p: number) => { setPage(p); document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" }) }
  return {
    slice: items.slice((page - 1) * pageSize, page * pageSize),
    pager: { page, pageSize, total: items.length, onPage: go,
             onPageSize: (n: number) => { setPageSizeState(n); savePageSize(key, n) } },
  }
}
