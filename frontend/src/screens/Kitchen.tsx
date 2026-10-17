import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Bell, BellOff, Check, Maximize2, Undo2 } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { useLive } from "../lib/realtime"
import { useVenue } from "../lib/venue"
import { cn } from "../lib/cn"
import { useToast } from "../components/ui"
import { getKitchenMode } from "../lib/theme"

type LineState = "cooking" | "held" | "cancelled" | "done"
interface KItem {
  name: string; item_name: string; qty: number; instructions?: string; state: LineState; course: string
  is_veg: 0 | 1 | null; is_alcohol: 0 | 1 | null; prep_station?: string; allergy_hits: string[]
  fired_at?: string; void_reason?: string
}
interface KOrder {
  name: string; label: string; outlet_name: string; kot_no?: number; order_type: string; guests?: number
  allergy_note?: string; notes?: string; accepted_at?: string; held_courses: string[]; items: KItem[]; nc: 0 | 1
}

const AMBER_AT = 8
const LATE_AT = 15
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
const mins = (s?: string) => (s ? Math.max(0, (Date.now() - new Date(s.replace(" ", "T")).getTime()) / 60000) : 0)

function chime() {
  try {
    const ctx = new AudioContext()
    ;[0, 0.18].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = i ? 1320 : 880
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t)
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.3)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.32)
    })
  } catch { /* no audio */ }
}

export default function Kitchen() {
  const { restaurant, outlet } = useVenue()
  const toast = useToast()
  const [orders, setOrders] = useState<KOrder[]>([])
  const [scope, setScope] = useState<"outlet" | "all">((lsGet("pep.kds.scope") as "outlet" | "all") || "outlet")
  const stations = ["All", ...(restaurant?.prep_stations ?? [])]
  const saved = lsGet("pep.kds.station") || "All"
  // a station removed in Setup falls back to everything
  const [station, setStation] = useState(saved)
  useEffect(() => { if (restaurant && !stations.includes(station)) setStation("All") }, [restaurant, station])
  const [sound, setSound] = useState(lsGet("pep.kds.sound") !== "0")
  const [, tick] = useState(0)
  const seen = useRef<Set<string> | null>(null)
  const [kdsMode, setKdsMode] = useState(getKitchenMode())
  useEffect(() => {
    const h = () => setKdsMode(getKitchenMode())
    window.addEventListener("pep:theme", h)
    return () => window.removeEventListener("pep:theme", h)
  }, [])

  const load = useCallback(async () => {
    if (!restaurant) return
    try {
      const rows = await call<KOrder[]>(`${P}.pos.kitchen_queue`, {
        restaurant: restaurant.name, outlet: scope === "outlet" ? outlet?.name : undefined,
        station: station === "All" ? undefined : station,
      })
      const keys = new Set(rows.flatMap((o) => o.items.filter((i) => i.state === "cooking").map((i) => i.name)))
      if (seen.current && sound && [...keys].some((k) => !seen.current!.has(k))) chime()
      seen.current = keys
      setOrders(rows)
    } catch (e) { toast(errText(e), "bad") }
  }, [restaurant, outlet, scope, station, sound, toast])
  useEffect(() => { seen.current = null; load() }, [load])
  useLive(load, 8000)
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t) }, [])

  const act = async (method: string, args: Record<string, unknown>) => {
    try { await call(`${P}.pos.${method}`, args); load() } catch (e) { toast(errText(e), "bad") }
  }

  const counts = orders.reduce((s, o) => s + o.items.filter((i) => i.state === "cooking").length, 0)

  return (
    <div className={cn("kds flex min-h-full flex-col", kdsMode === "dark" && "dark")}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <Link to="/" className="rounded-md p-1.5 text-mute hover:text-ink" aria-label="Back"><ArrowLeft className="size-5" /></Link>
        <h1 className="wide mr-2 text-xl font-extrabold">Kitchen</h1>
        <span className="rounded-md bg-brand px-2 py-0.5 text-sm font-extrabold text-on-brand">{counts} to cook</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <select aria-label="Which outlets" value={scope} onChange={(e) => { setScope(e.target.value as "outlet" | "all"); lsSet("pep.kds.scope", e.target.value) }}
            className="rounded-md border border-line bg-card px-2 py-1.5 text-sm">
            <option value="outlet">{outlet?.outlet_name ?? "This outlet"}</option>
            <option value="all">All outlets</option>
          </select>
          {stations.map((s) => (
            <button key={s} onClick={() => { setStation(s); lsSet("pep.kds.station", s) }}
              className={cn("rounded-md px-2.5 py-1.5 text-sm font-semibold", station === s ? "bg-ink text-paper" : "bg-card text-ink-2")}>{s}</button>
          ))}
          <button onClick={() => { setSound(!sound); lsSet("pep.kds.sound", sound ? "0" : "1"); if (!sound) chime() }} aria-label={sound ? "Mute new-ticket chime" : "Turn chime on"}
            className="rounded-md bg-card p-2 text-ink-2">{sound ? <Bell className="size-4" /> : <BellOff className="size-4" />}</button>
          <button onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined)} aria-label="Full screen" className="rounded-md bg-card p-2 text-ink-2"><Maximize2 className="size-4" /></button>
        </div>
      </header>

      {!orders.length ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center text-mute">
          <p className="wide text-3xl font-extrabold text-ink-2">Pass is clear</p>
          <p className="mt-1 text-sm">New tickets appear here the moment a captain sends them.</p>
        </div>
      ) : (
        <div className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-3">
          {orders.map((o) => {
            const cooking = o.items.filter((i) => i.state === "cooking")
            const age = Math.max(0, ...cooking.map((i) => mins(i.fired_at)))
            const tone = !cooking.length ? "border-line" : age >= LATE_AT ? "border-chili" : age >= AMBER_AT ? "border-amber" : "border-basil"
            return (
              <article key={o.name} className={cn("flex flex-col overflow-hidden rounded-xl border-t-[6px] bg-card", tone)}>
                <div className="flex items-start justify-between gap-2 px-3 pt-2.5">
                  <div>
                    <p className="wide text-2xl font-extrabold leading-none">{o.label}</p>
                    <p className="mt-1 text-xs text-mute">KOT {o.kot_no ?? "-"} · {o.order_type}{o.guests ? ` · ${o.guests} pax` : ""}{scope === "all" ? ` · ${o.outlet_name}` : ""}</p>
                  </div>
                  {cooking.length > 0 && (
                    <span className={cn("num rounded-md px-2 py-1 text-lg font-extrabold",
                      age >= LATE_AT ? "bg-chili text-white" : age >= AMBER_AT ? "bg-amber text-ink" : "bg-basil text-white")}>
                      {Math.floor(age)}′
                    </span>
                  )}
                </div>
                {o.allergy_note && <p className="mx-3 mt-2 rounded-md bg-chili px-2 py-1 text-sm font-bold text-white">Allergy: {o.allergy_note}</p>}
                {o.nc ? <p className="mx-3 mt-1 text-xs font-bold text-amber">NC - complimentary</p> : null}
                <ul className="mt-2 flex-1 divide-y divide-line">
                  {o.items.map((i) => (
                    <li key={i.name} className={cn("flex items-start gap-2 px-3 py-2",
                      i.state === "held" && "opacity-45", i.state === "done" && "opacity-55",
                      i.state === "cancelled" && "bg-chili/20")}>
                      <span className="num w-8 shrink-0 text-xl font-extrabold">{i.qty}</span>
                      <div className="min-w-0 flex-1">
                        <p className={cn("text-base font-bold leading-tight", (i.state === "done" || i.state === "cancelled") && "line-through")}>
                          <span className={cn("mr-1.5 inline-block size-2.5 rounded-sm border-2 align-middle", i.is_veg ? "border-basil" : "border-chili")} />
                          {i.item_name}
                        </p>
                        {i.instructions && <p className="text-sm font-semibold text-amber">» {i.instructions}</p>}
                        {i.allergy_hits.length > 0 && <p className="text-xs font-bold text-chili">Contains {i.allergy_hits.join(", ")}</p>}
                        <p className="text-[11px] text-mute">
                          {i.state === "held" ? `Held - ${i.course}` : i.state === "cancelled" ? `CANCELLED - ${i.void_reason ?? ""}` : i.prep_station}
                        </p>
                      </div>
                      {i.state === "cooking" && <button onClick={() => act("mark_prepared", { order: o.name, item_row: i.name })} aria-label={`${i.item_name} ready`} className="rounded-lg bg-basil/20 p-2 text-basil hover:bg-basil hover:text-white"><Check className="size-5" /></button>}
                      {i.state === "done" && <button onClick={() => act("recall_prepared", { order: o.name, item_row: i.name })} aria-label="Undo ready" className="rounded-lg p-2 text-mute hover:text-ink"><Undo2 className="size-4" /></button>}
                      {i.state === "cancelled" && <button onClick={() => act("acknowledge_void", { order: o.name, item_row: i.name })} className="rounded-lg bg-chili px-2.5 py-1.5 text-xs font-bold text-white">Seen</button>}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2 p-2">
                  {!o.accepted_at && cooking.length > 0
                    ? <button onClick={() => act("accept_ticket", { order: o.name })} className="h-12 flex-1 rounded-lg bg-brand text-base font-extrabold text-on-brand">Start</button>
                    : cooking.length > 0 && <button onClick={() => act("mark_prepared", { order: o.name })} className="h-12 flex-1 rounded-lg bg-basil text-base font-extrabold text-white">All ready</button>}
                  {o.held_courses.length > 0 && <p className="self-center px-1 text-xs text-mute">Next: {o.held_courses.join(", ")}</p>}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
