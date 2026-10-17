import { useCallback, useEffect, useMemo, useState } from "react"
import {
  BadgePercent, Ban, Bike, Check, ChefHat, CircleDollarSign, Gift, Minus, MoreHorizontal, MoveRight, Plus,
  Printer, Receipt, Search, ShoppingBag, Sparkles, Split, Trash2, UserRound, Users, X,
} from "lucide-react"
import { call, errText, P } from "../lib/api"
import { useLive } from "../lib/realtime"
import { money, useVenue } from "../lib/venue"
import { R, useAuth } from "../lib/auth"
import { cn } from "../lib/cn"
import { printBill, printKot, type BillData, type KotTicket } from "../lib/print"
import { usePinned } from "../components/PinGate"
import { Button, Check as CheckBox, Field, Input, Modal, Select, Tag, Textarea, useToast } from "../components/ui"

// ------------------------------------------------------------------ types
type TileState = "vacant" | "reserved" | "cleaning" | "new_qr" | "running" | "fired" | "ready"
interface Tile {
  table: string; seats: number | null; area: string | null; temp: boolean; state: TileState; bills: number
  grand_total?: number; guests?: number | null; since?: string
  res_guest?: string; res_time?: string; res_party?: number; reservation?: string
  orders: { order: string; label: string; grand_total: number; state: TileState }[]
}
interface Tab { name: string; label: string; order_type: string; grand_total: number; state: TileState; customer_name?: string; creation: string }
interface MenuItem { name: string; item_name: string; category: string; price: number; is_veg: 0 | 1; is_alcohol: 0 | 1; course: string; allergens?: string; image?: string }
interface Line { row: string; menu_item: string; item_name: string; qty: number; rate: number; amount: number; instructions?: string; course: string; kot_status: "New" | "Fired" | "Prepared"; voided: 0 | 1; void_reason?: string }
interface Order {
  name: string; status: string; source: string; table_no?: string; order_type: string; guests?: number; label: string
  customer_name?: string; customer_phone?: string; delivery_address?: string; notes?: string; allergy_note?: string
  kot_no?: number; nc: 0 | 1; nc_authorized_by?: string; paid: 0 | 1; discount_amount: number; discount_reason?: string
  subtotal: number; service_charge: number; service_charge_rate: number; tax_amount: number; tax_rate: number
  prices_include_tax: 0 | 1; grand_total: number; items: Line[]; kot_tickets: KotTicket[]; creation: string
}
interface Draft { key: string; menu_item: string; item_name: string; rate: number; qty: number; instructions?: string; course: string }
type Sel =
  | { kind: "table"; table: string }
  | { kind: "order"; order: string }
  | { kind: "new"; order_type: "Takeaway" | "Delivery" }
  | null

const TILE: Record<TileState, string> = {
  vacant: "bg-card border-line text-ink",
  reserved: "bg-card border-plum border-dashed text-plum",
  cleaning: "bg-paper border-line text-mute cleaning-stripes",
  new_qr: "bg-plum text-white border-plum",
  running: "bg-sky-soft border-sky/40 text-sky",
  fired: "bg-amber-soft border-amber text-amber-deep",
  ready: "bg-basil text-white border-basil",
}
const STATE_LABEL: Record<TileState, string> = {
  vacant: "Free", reserved: "Reserved", cleaning: "Clearing", new_qr: "Guest order", running: "Ordering",
  fired: "In kitchen", ready: "Food ready",
}
const COURSES = ["Starter", "Main", "Dessert", "Drink"]
const PRINT_KEY = "pep.print_kot"
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }

const ago = (s?: string) => {
  if (!s) return ""
  const m = Math.max(0, Math.round((Date.now() - new Date(s.replace(" ", "T")).getTime()) / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`
}

export default function Till() {
  const { outlet, restaurant } = useVenue()
  const { has } = useAuth()
  const toast = useToast()
  const pinned = usePinned()
  const [map, setMap] = useState<{ tables: Tile[]; other: Tab[] }>({ tables: [], other: [] })
  const [menu, setMenu] = useState<{ category: string; items: MenuItem[] }[]>([])
  const [sel, setSel] = useState<Sel>(null)
  const [order, setOrder] = useState<Order | null>(null)
  const [draft, setDraft] = useState<Draft[]>([])
  const [head, setHead] = useState({ guests: "", customer_name: "", customer_phone: "", delivery_address: "", allergy_note: "", notes: "" })
  const [cat, setCat] = useState<string>(ALL)
  const [q, setQ] = useState("")
  const [area, setArea] = useState<string>("All")
  const [pane, setPane] = useState<"floor" | "menu" | "bill">("floor")
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<null | "pay" | "discount" | "nc" | "split" | "cancel" | "move" | "void" | "reserve" | "notes" | "merge" | "pick">(null)
  const [voidRow, setVoidRow] = useState<Line | null>(null)
  const [printOn, setPrintOn] = useState(lsGet(PRINT_KEY) === "1")
  const canPay = has(R.cashier)

  const loadMap = useCallback(async () => {
    if (!outlet) return
    try { setMap(await call(`${P}.pos.table_map`, { outlet: outlet.name })) } catch { /* keep last */ }
  }, [outlet])
  const loadOrder = useCallback(async (name: string) => {
    const o = await call<Order>(`${P}.pos.order_detail`, { order: name })
    setOrder(o)
    return o
  }, [])

  useEffect(() => {
    if (!outlet) return
    setSel(null); setOrder(null); setDraft([])
    call<{ categories: { category: string; items: MenuItem[] }[] }>(`${P}.pos.pos_menu`, { outlet: outlet.name })
      .then((m) => { setMenu(m.categories); setCat(ALL) })
      .catch((e) => toast(errText(e), "bad"))
    loadMap()
  }, [outlet, loadMap, toast])

  const refreshAll = useCallback(() => {
    loadMap()
    if (order && order.status !== "Closed" && order.status !== "Cancelled") loadOrder(order.name).catch(() => undefined)
  }, [loadMap, loadOrder, order])
  useLive(refreshAll, 15000)

  // ------------------------------------------------------------ selection
  const resetHead = () => setHead({ guests: "", customer_name: "", customer_phone: "", delivery_address: "", allergy_note: "", notes: "" })
  const openTile = async (t: Tile) => {
    setDraft([]); resetHead()
    if (t.orders.length === 1) { setSel({ kind: "order", order: t.orders[0].order }); await loadOrder(t.orders[0].order) }
    else if (t.orders.length > 1) { setSel({ kind: "table", table: t.table }); setOrder(null); setModal("pick") }
    else {
      if (t.state === "cleaning") call(`${P}.pos.mark_table_clean`, { outlet: outlet!.name, table_no: t.table }).then(loadMap).catch(() => undefined)
      setSel({ kind: "table", table: t.table }); setOrder(null)
      if (t.res_party) setHead((h) => ({ ...h, guests: String(t.res_party) }))
      setPane("menu")
    }
  }
  const openOrder = async (name: string) => {
    setDraft([]); resetHead(); setSel({ kind: "order", order: name }); setModal(null)
    await loadOrder(name); setPane("bill")
  }
  const newTab = (order_type: "Takeaway" | "Delivery") => {
    setSel({ kind: "new", order_type }); setOrder(null); setDraft([]); resetHead(); setPane("menu")
  }
  const newBillOnTable = (table: string) => {
    setSel({ kind: "table", table }); setOrder(null); setDraft([]); resetHead(); setModal(null); setPane("menu")
  }

  // ----------------------------------------------------------------- cart
  const add = (m: MenuItem) => {
    if (!sel) { toast("Pick a table, or start a takeaway, first.", "bad"); return }
    setDraft((d) => {
      const i = d.findIndex((x) => x.menu_item === m.name && !x.instructions)
      if (i >= 0) return d.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x))
      return [...d, { key: `${m.name}-${Date.now()}`, menu_item: m.name, item_name: m.item_name, rate: m.price, qty: 1, course: m.course || "Main" }]
    })
  }
  const bump = (key: string, by: number) =>
    setDraft((d) => d.flatMap((x) => (x.key !== key ? [x] : x.qty + by <= 0 ? [] : [{ ...x, qty: x.qty + by }])))
  const setNote = (key: string, instructions: string) => setDraft((d) => d.map((x) => (x.key === key ? { ...x, instructions } : x)))

  const draftTotal = draft.reduce((s, d) => s + d.qty * d.rate, 0)
  const lines = draft.map((d) => ({ menu_item: d.menu_item, qty: d.qty, instructions: d.instructions || undefined }))

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) toast(ok); loadMap() } catch (e) { toast(errText(e), "bad") } finally { setBusy(false) }
  }

  /** Save the draft as a new bill or a new round; optionally send to kitchen. */
  const commit = (fire: boolean, course?: string) => act(async () => {
    if (!outlet) return
    let name = order?.name
    if (draft.length) {
      if (name) {
        await call(`${P}.pos.add_items`, { order: name, items: lines })
      } else {
        const r = await call<{ order: string }>(`${P}.pos.create_order`, {
          outlet: outlet.name, items: lines,
          order_type: sel?.kind === "new" ? sel.order_type : "Dine In",
          table_no: sel?.kind === "table" ? sel.table : undefined,
          guests: head.guests || undefined, customer_name: head.customer_name || undefined,
          customer_phone: head.customer_phone || undefined, delivery_address: head.delivery_address || undefined,
          allergy_note: head.allergy_note || undefined, notes: head.notes || undefined,
        })
        name = r.order
        setSel({ kind: "order", order: name })
      }
      setDraft([])
    }
    if (!name) return
    if (fire) {
      const r = await call<{ ticket: KotTicket; auto_print: boolean; stock_alerts: { ingredient_name: string; level: string }[] }>(
        `${P}.pos.fire_kot`, { order: name, course })
      if (r.auto_print || printOn) printKot(outlet.outlet_name, r.ticket)
      toast(`KOT #${r.ticket.kot_no} sent to the kitchen`)
      if (r.stock_alerts?.length) toast(`Stock check: ${r.stock_alerts.map((a) => a.ingredient_name).join(", ")} now ${r.stock_alerts[0].level}`, "bad")
    } else toast("Saved")
    await loadOrder(name)
  })

  const heldCourses = useMemo(() => {
    if (!order) return []
    const s = new Set(order.items.filter((i) => !i.voided && i.kot_status === "New").map((i) => i.course || "Main"))
    return COURSES.filter((c) => s.has(c))
  }, [order])
  const hasNew = !!order?.items.some((i) => !i.voided && i.kot_status === "New")
  const isQrPending = order?.source === "QR" && order.status === "Placed"
  const closed = !!order && (order.status === "Closed" || order.status === "Cancelled")

  const printTheBill = () => act(async () => {
    if (!order) return
    printBill(await call<BillData>(`${P}.pos.bill_data`, { order: order.name }))
  })
  const closeSel = () => { setSel(null); setOrder(null); setDraft([]); setPane("floor") }

  // ------------------------------------------------------------ menu view
  // what the menu pane shows, as headed groups: every category under "All",
  // one category without a heading, or one list of search results
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase()
    if (term) {
      const hits = menu.flatMap((c) => c.items).filter((i) =>
        i.item_name.toLowerCase().includes(term) || (i.category ?? "").toLowerCase().includes(term))
      return [{ category: "", items: hits }]
    }
    if (cat === ALL) return menu
    return [{ category: "", items: menu.find((c) => c.category === cat)?.items ?? [] }]
  }, [menu, cat, q])
  const shownCount = groups.reduce((n, g) => n + g.items.length, 0)
  const totalCount = menu.reduce((n, c) => n + c.items.length, 0)

  const areas = useMemo(() => ["All", ...Array.from(new Set(map.tables.map((t) => t.area || "Tables")))], [map.tables])
  const tiles = map.tables.filter((t) => area === "All" || (t.area || "Tables") === area)
  const selTable = sel?.kind === "table" ? sel.table : order?.table_no
  const title = order ? order.label : sel?.kind === "table" ? `Table ${sel.table}` : sel?.kind === "new" ? `New ${sel.order_type.toLowerCase()}` : ""

  if (!outlet) return <div className="p-8 text-mute">Add an outlet in Setup to start taking orders.</div>

  return (
    <div className="flex h-full flex-col">
      {/* mobile pane switch */}
      <div className="flex border-b border-line bg-card lg:hidden">
        {(["floor", "menu", "bill"] as const).map((p) => (
          <button key={p} onClick={() => setPane(p)} className={cn("flex-1 py-2.5 text-sm font-semibold capitalize",
            pane === p ? "border-b-2 border-ink text-ink" : "text-mute")}>
            {p === "bill" && (draft.length || order) ? `Bill · ${money(order ? order.grand_total + draftTotal : draftTotal)}` : p}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(280px,340px)_1fr_minmax(330px,380px)]">
        {/* ---------------------------------------------------------- floor */}
        <section className={cn("min-h-0 overflow-auto border-r border-line bg-paper p-3", pane !== "floor" && "hidden lg:block")}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="wide text-lg font-extrabold">{outlet.outlet_name}</h2>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => newTab("Takeaway")} title="New takeaway"><ShoppingBag className="size-3.5" />Takeaway</Button>
              <Button size="sm" variant="outline" onClick={() => newTab("Delivery")} title="New delivery"><Bike className="size-3.5" /></Button>
            </div>
          </div>
          {areas.length > 2 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {areas.map((a) => (
                <button key={a} onClick={() => setArea(a)} className={cn("rounded-full px-2.5 py-1 text-xs font-semibold",
                  area === a ? "bg-ink text-paper" : "bg-card text-ink-2")}>{a}</button>
              ))}
            </div>
          )}
          {!map.tables.length && <p className="rounded-lg border border-dashed border-line p-4 text-sm text-mute">No tables set up for this outlet. Add them in Setup, or use takeaway.</p>}
          <div className="grid grid-cols-3 gap-2 xl:grid-cols-3">
            {tiles.map((t) => (
              <button key={t.table} onClick={() => openTile(t)}
                className={cn("relative flex min-h-[78px] flex-col rounded-xl border-2 p-2 text-left transition active:scale-[.97]",
                  TILE[t.state], selTable === t.table && "ring-3 ring-ink ring-offset-2 ring-offset-paper")}>
                {t.bills > 1 && <span className="absolute -right-1.5 -top-1.5 rounded-full bg-ink px-1.5 text-[10px] font-bold text-paper">{t.bills}</span>}
                <span className="flex items-baseline justify-between">
                  <span className="wide text-lg font-extrabold leading-none">{t.table}</span>
                  {t.since && <span className="text-[10px] font-semibold opacity-75">{ago(t.since)}</span>}
                </span>
                <span className="mt-auto text-[11px] font-semibold leading-tight opacity-90">
                  {t.bills ? money(t.grand_total) : t.state === "reserved" ? `${t.res_time} ${t.res_guest ?? ""}` : STATE_LABEL[t.state]}
                </span>
                <span className="text-[10px] opacity-70">
                  {t.bills ? STATE_LABEL[t.state] : t.seats ? `${t.seats} seats` : ""}
                </span>
              </button>
            ))}
          </div>
          {map.other.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1.5 text-xs font-bold text-ink-2">Takeaway and delivery</h3>
              <div className="space-y-1.5">
                {map.other.map((o) => (
                  <button key={o.name} onClick={() => openOrder(o.name)} className={cn("flex w-full items-center justify-between rounded-lg border-2 px-3 py-2 text-left text-sm",
                    TILE[o.state], order?.name === o.name && "ring-3 ring-ink")}>
                    <span className="font-semibold">{o.label}</span>
                    <span className="text-xs font-semibold">{money(o.grand_total)} · {ago(o.creation)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mute">
            {(["running", "fired", "ready", "new_qr", "reserved"] as TileState[]).map((s) => (
              <span key={s} className="flex items-center gap-1"><span className={cn("size-2.5 rounded-sm border", TILE[s])} />{STATE_LABEL[s]}</span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setModal("reserve")}>Reserve a table</Button>
            <RecentBills outlet={outlet.name} onOpen={openOrder} />
          </div>
        </section>

        {/* ----------------------------------------------------------- menu */}
        <section className={cn("flex min-h-0 flex-col bg-card", pane !== "menu" && "hidden lg:flex")}>
          <div className="border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" />
              <Input placeholder="Search the menu" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            {!q && (
              <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
                <button onClick={() => setCat(ALL)} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold",
                  cat === ALL ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-line")}>
                  All <span className="opacity-60">{totalCount}</span>
                </button>
                {menu.map((c) => (
                  <button key={c.category} onClick={() => setCat(c.category)} className={cn("shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold",
                    cat === c.category ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-line")}>{c.category}</button>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!sel && <p className="mb-3 rounded-lg bg-amber-soft px-3 py-2 text-sm font-medium text-amber-deep">Pick a table on the floor, or start a takeaway, to add items.</p>}
            {groups.map((g) => (
              <section key={g.category || "_"} className="mb-4 last:mb-0">
                {g.category && <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-mute">{g.category}</h3>}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
                  {g.items.map((m) => (
                    <DishTile key={m.name} m={m} disabled={closed} onAdd={() => add(m)}
                      inCart={draft.filter((d) => d.menu_item === m.name).reduce((n, d) => n + d.qty, 0)} />
                  ))}
                </div>
              </section>
            ))}
            {!shownCount && <p className="py-10 text-center text-sm text-mute">{q ? "Nothing on the menu matches." : "This category is empty."}</p>}
          </div>
        </section>

        {/* ----------------------------------------------------------- bill */}
        <section className={cn("flex min-h-0 flex-col border-l border-line bg-card", pane !== "bill" && "hidden lg:flex")}>
          {!sel ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-mute">
              <Receipt className="mb-2 size-8" />
              <p className="text-sm">Tap a table to open its bill.</p>
            </div>
          ) : (
            <>
              <div className="border-b border-line px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="wide truncate text-xl font-extrabold">{title}</h2>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-mute">
                      {order ? <>{order.name}{order.kot_no ? ` · KOT ${order.kot_no}` : ""}{order.guests ? <> · <Users className="inline size-3" /> {order.guests}</> : null}</> : "Not saved yet"}
                      {order?.source === "QR" && <Tag tone="plum">QR</Tag>}
                      {order?.nc ? <Tag tone="warn">NC</Tag> : null}
                      {closed && <Tag tone={order?.status === "Closed" ? "go" : "bad"}>{order?.status}</Tag>}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {order && !closed && <Button size="sm" variant="ghost" onClick={() => setModal("notes")} title="Guests, customer and notes"><UserRound className="size-4" /></Button>}
                    <Button size="sm" variant="ghost" onClick={closeSel} aria-label="Close bill"><X className="size-4" /></Button>
                  </div>
                </div>
                {!order && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {sel.kind === "table" && <Input inputMode="numeric" placeholder="Guests" value={head.guests} onChange={(e) => setHead({ ...head, guests: e.target.value })} />}
                    {sel.kind === "new" && <Input placeholder="Customer name" value={head.customer_name} onChange={(e) => setHead({ ...head, customer_name: e.target.value })} />}
                    {sel.kind === "new" && <Input placeholder="Phone" inputMode="tel" value={head.customer_phone} onChange={(e) => setHead({ ...head, customer_phone: e.target.value })} />}
                    <Input placeholder="Allergies" value={head.allergy_note} onChange={(e) => setHead({ ...head, allergy_note: e.target.value })} className={sel.kind === "new" ? "" : ""} />
                    {sel.kind === "new" && sel.order_type === "Delivery" && <Textarea placeholder="Delivery address" className="col-span-2 min-h-14" value={head.delivery_address} onChange={(e) => setHead({ ...head, delivery_address: e.target.value })} />}
                  </div>
                )}
                {order?.allergy_note && <p className="mt-2 rounded-md bg-chili-soft px-2 py-1 text-xs font-semibold text-chili">Allergy: {order.allergy_note}</p>}
                {isQrPending && (
                  <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-plum-soft px-3 py-2">
                    <span className="text-sm font-semibold text-plum">A guest ordered from the table.</span>
                    <Button size="sm" variant="ink" busy={busy} onClick={() => act(async () => { await call(`${P}.pos.confirm_order`, { order: order!.name }); await loadOrder(order!.name) }, "Confirmed")}>
                      <Check className="size-3.5" />Confirm
                    </Button>
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
                {order?.items.map((l) => (
                  <div key={l.row} className={cn("group flex items-start gap-2 rounded-lg px-2 py-1.5", l.voided && "opacity-55")}>
                    <span className="num w-7 shrink-0 pt-0.5 text-right text-sm font-bold">{l.qty}×</span>
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-sm font-semibold leading-tight", l.voided && "line-through")}>{l.item_name}</p>
                      <p className="text-[11px] text-mute">
                        {l.voided ? `Void: ${l.void_reason}` : <>
                          <LineStatus s={l.kot_status} />{l.instructions ? ` · ${l.instructions}` : ""}
                        </>}
                      </p>
                    </div>
                    <span className="num pt-0.5 text-sm font-semibold">{money(l.amount)}</span>
                    {!closed && !l.voided && (
                      l.kot_status === "New"
                        ? <span className="flex shrink-0 gap-0.5">
                            <button aria-label="One less" onClick={() => act(async () => { await call(`${P}.pos.change_qty`, { order: order.name, item_row: l.row, qty: l.qty - 1 }); await loadOrder(order.name) })} className="rounded p-1 text-mute hover:bg-paper"><Minus className="size-3.5" /></button>
                            <button aria-label="One more" onClick={() => act(async () => { await call(`${P}.pos.change_qty`, { order: order.name, item_row: l.row, qty: l.qty + 1 }); await loadOrder(order.name) })} className="rounded p-1 text-mute hover:bg-paper"><Plus className="size-3.5" /></button>
                          </span>
                        : <button aria-label="Void line" title="Void with a reason" onClick={() => { setVoidRow(l); setModal("void") }} className="shrink-0 rounded p-1 text-mute hover:bg-chili-soft hover:text-chili"><Ban className="size-3.5" /></button>
                    )}
                  </div>
                ))}
                {draft.length > 0 && (
                  <div className="mt-1 rounded-xl border-2 border-dashed border-brand bg-brand-soft/40 p-1.5">
                    <p className="px-1.5 pb-1 text-[11px] font-bold text-brand-deep">{order ? "New round - not sent" : "Not sent yet"}</p>
                    {draft.map((d) => (
                      <div key={d.key} className="flex items-start gap-2 rounded-lg px-1.5 py-1">
                        <div className="flex shrink-0 items-center rounded-lg bg-card">
                          <button aria-label="One less" onClick={() => bump(d.key, -1)} className="p-1.5"><Minus className="size-3.5" /></button>
                          <span className="num w-6 text-center text-sm font-bold">{d.qty}</span>
                          <button aria-label="One more" onClick={() => bump(d.key, 1)} className="p-1.5"><Plus className="size-3.5" /></button>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold leading-tight">{d.item_name}</p>
                          <input placeholder="Add a note for the kitchen" value={d.instructions ?? ""} onChange={(e) => setNote(d.key, e.target.value)}
                            className="w-full bg-transparent text-[11px] text-ink-2 placeholder:text-mute focus:outline-none" maxLength={140} />
                        </div>
                        <span className="num pt-1 text-sm font-semibold">{money(d.qty * d.rate)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {!order?.items.length && !draft.length && <p className="px-3 py-8 text-center text-sm text-mute">Tap dishes on the menu to add them.</p>}
              </div>

              {/* totals + actions */}
              <div className="border-t border-line px-4 py-3">
                {order && (
                  <div className="space-y-0.5 text-sm">
                    <Row l="Subtotal" v={order.subtotal} />
                    {order.discount_amount > 0 && <Row l={`Discount${order.discount_reason ? ` · ${order.discount_reason}` : ""}`} v={-order.discount_amount} />}
                    {order.service_charge > 0 && <Row l={`Service ${order.service_charge_rate}%`} v={order.service_charge} />}
                    {order.tax_amount > 0 && <Row l={`${restaurant?.tax_label ?? "Tax"} ${order.tax_rate}%${order.prices_include_tax ? " (incl.)" : ""}`} v={order.tax_amount} muted={!!order.prices_include_tax} />}
                  </div>
                )}
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-ink-2">{draft.length && order ? "Total after this round" : "Total"}</span>
                  <span className="wide num text-2xl font-extrabold">{money((order?.grand_total ?? 0) + draftTotal)}</span>
                </div>
                {draft.length > 0 && !!order && <p className="text-right text-[11px] text-mute">Tax on the new round is added when it's saved</p>}

                {!closed && (
                  <div className="mt-3 space-y-2">
                    {(draft.length > 0 || hasNew) && (
                      <div className="flex gap-2">
                        {draft.length > 0 && <Button variant="outline" className="flex-1" busy={busy} onClick={() => commit(false)}>Save</Button>}
                        <Button variant="brand" className="flex-[2]" busy={busy} disabled={isQrPending}
                          onClick={() => commit(true)}><ChefHat className="size-4" />Send to kitchen</Button>
                      </div>
                    )}
                    {!draft.length && heldCourses.length > 1 && (
                      <div className="flex flex-wrap gap-1.5">
                        {heldCourses.map((c) => (
                          <Button key={c} size="sm" variant="outline" busy={busy} disabled={isQrPending} onClick={() => commit(true, c)}>
                            <Sparkles className="size-3.5" />Fire {c.toLowerCase()}s only
                          </Button>
                        ))}
                      </div>
                    )}
                    {order && (
                      <>
                        <div className="grid grid-cols-4 gap-1.5">
                          <Act icon={Printer} label="Bill" onClick={printTheBill} />
                          <Act icon={BadgePercent} label="Discount" onClick={() => setModal("discount")} />
                          <Act icon={Split} label="Split" onClick={() => setModal("split")} />
                          <MoreMenu items={[
                            { label: "Move to another table", icon: MoveRight, onClick: () => setModal("move") },
                            { label: "Merge into another bill", icon: Plus, onClick: () => setModal("merge") },
                            { label: order.nc ? "Remove NC" : "Mark NC (complimentary)", icon: Gift, onClick: () => order.nc ? act(async () => { await call(`${P}.pos.mark_nc`, { order: order.name, undo: 1 }); await loadOrder(order.name) }) : setModal("nc") },
                            { label: "Reprint last KOT", icon: Printer, onClick: () => { const t = order.kot_tickets.at(-1); if (t) printKot(outlet.outlet_name, t, true); else toast("No KOT yet", "bad") } },
                            { label: "Cancel order", icon: Trash2, danger: true, onClick: () => setModal("cancel") },
                          ]} />
                        </div>
                        {order.nc || order.grand_total <= 0
                          ? <Button size="lg" variant="go" className="w-full" busy={busy} disabled={draft.length > 0}
                              onClick={() => act(async () => { await call(`${P}.pos.close_order`, { order: order.name }); await loadOrder(order.name) }, "Bill closed")}>
                              <Check className="size-5" />Close bill
                            </Button>
                          : <Button size="lg" variant="go" className="w-full" disabled={!canPay || draft.length > 0} title={canPay ? "" : "Only a cashier can take payment"}
                              onClick={() => setModal("pay")}>
                              <CircleDollarSign className="size-5" />{canPay ? `Take payment · ${money(order.grand_total)}` : "Cashier settles this bill"}
                            </Button>}
                      </>
                    )}
                  </div>
                )}
                {closed && order && (
                  <div className="mt-3 flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={printTheBill}><Printer className="size-4" />Reprint bill</Button>
                    <Button className="flex-1" onClick={closeSel}>Done</Button>
                  </div>
                )}
                <div className="mt-2">
                  <CheckBox label="Print a KOT slip when sending" checked={printOn} onChange={(v) => { setPrintOn(v); lsSet(PRINT_KEY, v ? "1" : "0") }} />
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ------------------------------------------------------------ modals */}
      {modal === "pick" && sel?.kind === "table" && (
        <Modal title={`Table ${sel.table}`} onClose={() => setModal(null)}>
          <p className="text-sm text-mute">This table has more than one bill running.</p>
          {map.tables.find((t) => t.table === sel.table)?.orders.map((o) => (
            <button key={o.order} onClick={() => openOrder(o.order)} className={cn("flex w-full items-center justify-between rounded-lg border-2 px-3 py-2.5 text-left", TILE[o.state])}>
              <span className="font-semibold">{o.label}</span><span className="font-bold">{money(o.grand_total)}</span>
            </button>
          ))}
          <Button variant="outline" className="w-full" onClick={() => newBillOnTable(sel.table)}><Plus className="size-4" />Start another bill on this table</Button>
        </Modal>
      )}
      {modal === "pay" && order && <PayModal order={order} onClose={() => setModal(null)} onPaid={async (change) => {
        setModal(null); toast(change > 0 ? `Paid. Give back ${money(change)} change.` : "Paid and closed"); loadMap(); await loadOrder(order.name)
      }} pinned={pinned} />}
      {modal === "discount" && order && <DiscountModal order={order} onClose={() => setModal(null)} onDone={async () => { setModal(null); await loadOrder(order.name) }} />}
      {modal === "nc" && order && <ReasonModal title="Mark as complimentary (NC)" fields={[["authorized_by", "Authorized by", "Manager, chef, owner…"], ["note", "Reason", "Birthday, complaint, staff meal…"]]}
        confirm="Mark NC" onClose={() => setModal(null)} onSubmit={async (v) => { await call(`${P}.pos.mark_nc`, { order: order.name, ...v }); setModal(null); await loadOrder(order.name) }} />}
      {modal === "cancel" && order && <ReasonModal title="Cancel this order" danger fields={[["reason", "Why is it cancelled?", "Guest left, duplicate order…"]]}
        confirm="Cancel order" onClose={() => setModal(null)} onSubmit={async (v) => { await call(`${P}.pos.cancel_order`, { order: order.name, ...v }); setModal(null); toast("Order cancelled"); loadMap(); await loadOrder(order.name) }} />}
      {modal === "void" && order && voidRow && <ReasonModal title={`Void ${voidRow.item_name}`} danger fields={[["reason", "Why?", "Wrong dish, guest changed mind, quality…"]]}
        note={voidRow.kot_status !== "New" ? "This dish is already in the kitchen. The cook will see it's cancelled, and its ingredients stay used." : undefined}
        confirm="Void line" onClose={() => setModal(null)} onSubmit={async (v) => { await call(`${P}.pos.void_item`, { order: order.name, item_row: voidRow.row, ...v }); setModal(null); await loadOrder(order.name) }} />}
      {modal === "move" && order && <ReasonModal title="Move to another table" fields={[["table_no", "Table", "e.g. T4"]]} confirm="Move bill"
        options={{ table_no: map.tables.map((t) => t.table) }} onClose={() => setModal(null)}
        onSubmit={async (v) => { await call(`${P}.pos.update_order`, { order: order.name, ...v }); setModal(null); loadMap(); await loadOrder(order.name) }} />}
      {modal === "merge" && order && <MergeModal order={order} map={map} onClose={() => setModal(null)} onMerged={async (into) => { setModal(null); toast("Bills merged"); await openOrder(into) }} />}
      {modal === "split" && order && <SplitModal order={order} tables={map.tables.map((t) => t.table)} onClose={() => setModal(null)} onSplit={async (n) => { setModal(null); toast(`New bill ${n}`); loadMap(); await loadOrder(order.name) }} />}
      {modal === "notes" && order && <NotesModal order={order} onClose={() => setModal(null)} onSaved={async () => { setModal(null); await loadOrder(order.name) }} />}
      {modal === "reserve" && <ReserveModal outlet={outlet.name} tables={map.tables.map((t) => t.table)} onClose={() => setModal(null)} onDone={() => { setModal(null); loadMap() }} />}
    </div>
  )
}

const ALL = "__all__"

/** A menu tile: the dish's photo on top (or a tinted initial when it has
 *  none, so the grid stays even), then name, veg mark and price. */
function DishTile({ m, inCart, disabled, onAdd }: { m: MenuItem; inCart: number; disabled: boolean; onAdd: () => void }) {
  const [broken, setBroken] = useState(false)
  return (
    <button onClick={onAdd} disabled={disabled}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-card text-left transition hover:border-ink-2 active:scale-[.97] disabled:opacity-40">
      <span className="relative block aspect-[4/3] w-full overflow-hidden bg-paper">
        {m.image && !broken
          ? <img src={m.image} alt="" loading="lazy" onError={() => setBroken(true)}
              className="size-full object-cover transition duration-200 group-hover:scale-[1.04]" />
          : <span aria-hidden className="flex size-full items-center justify-center bg-brand-soft text-3xl font-extrabold text-brand-deep">
              {m.item_name.trim().charAt(0).toUpperCase()}
            </span>}
        {inCart > 0 && <span className="absolute right-1.5 top-1.5 rounded-md bg-brand px-2 py-0.5 text-sm font-extrabold text-on-brand shadow">{inCart}</span>}
        {m.is_alcohol ? <span className="absolute left-1.5 top-1.5"><Tag tone="plum">Bar</Tag></span> : null}
      </span>
      <span className="flex flex-1 flex-col p-2">
        <span className="flex items-start gap-1.5">
          <span aria-label={m.is_veg ? "Veg" : "Non-veg"} className={cn("mt-1 size-2.5 shrink-0 rounded-sm border-2", m.is_veg ? "border-basil" : "border-chili")} />
          <span className="line-clamp-2 text-sm font-semibold leading-tight">{m.item_name}</span>
        </span>
        <span className="mt-auto flex items-end justify-between pt-1.5">
          <span className="text-sm font-bold">{money(m.price)}</span>
          <span className="text-[10px] text-mute">{m.course}</span>
        </span>
      </span>
    </button>
  )
}

function LineStatus({ s }: { s: Line["kot_status"] }) {
  if (s === "New") return <span className="font-semibold text-sky">Not sent</span>
  if (s === "Fired") return <span className="font-semibold text-amber-deep">Cooking</span>
  return <span className="font-semibold text-basil">Ready</span>
}
function Row({ l, v, muted }: { l: string; v: number; muted?: boolean }) {
  return <div className={cn("flex justify-between", muted ? "text-mute" : "text-ink-2")}><span className="truncate pr-2">{l}</span><span className="num">{money(v)}</span></div>
}
function Act({ icon: Icon, label, onClick }: { icon: typeof Printer; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-0.5 rounded-lg border border-line py-1.5 text-[11px] font-semibold text-ink-2 hover:border-ink-2">
      <Icon className="size-4" />{label}
    </button>
  )
}
function MoreMenu({ items }: { items: { label: string; icon: typeof Printer; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-col items-center gap-0.5 rounded-lg border border-line py-1.5 text-[11px] font-semibold text-ink-2 hover:border-ink-2">
        <MoreHorizontal className="size-4" />More
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-40 mb-1 w-56 rounded-xl border border-line bg-card p-1 shadow-xl">
            {items.map(({ label, icon: Icon, onClick, danger }) => (
              <button key={label} onClick={() => { setOpen(false); onClick() }} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-paper", danger && "text-chili")}>
                <Icon className="size-4" />{label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function RecentBills({ outlet, onOpen }: { outlet: string; onOpen: (n: string) => void }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<{ name: string; label: string; status: string; grand_total: number; paid: 0 | 1; nc: 0 | 1; payment_mode?: string }[]>([])
  const [q, setQ] = useState("")
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => call<typeof rows>(`${P}.pos.recent_orders`, { outlet, search: q || undefined, limit: 30 }).then(setRows).catch(() => undefined), 200)
    return () => clearTimeout(t)
  }, [open, q, outlet])
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Recent bills</Button>
      {open && (
        <Modal title="Recent bills" onClose={() => setOpen(false)}>
          <Input placeholder="Bill no., table, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="divide-y divide-line">
            {rows.map((r) => (
              <button key={r.name} onClick={() => { setOpen(false); onOpen(r.name) }} className="flex w-full items-center justify-between py-2 text-left">
                <span><span className="font-semibold">{r.label}</span><span className="block text-xs text-mute">{r.name} · {r.nc ? "NC" : r.paid ? r.payment_mode : r.status}</span></span>
                <span className="num font-bold">{money(r.grand_total)}</span>
              </button>
            ))}
            {!rows.length && <p className="py-6 text-center text-sm text-mute">No bills found.</p>}
          </div>
        </Modal>
      )}
    </>
  )
}

const MODES = ["Cash", "Card", "UPI", "Wallet", "Other"]
function PayModal({ order, onClose, onPaid, pinned }: { order: Order; onClose: () => void; onPaid: (change: number) => void; pinned: ReturnType<typeof usePinned> }) {
  const [split, setSplit] = useState(false)
  const [mode, setMode] = useState("Cash")
  const [tendered, setTendered] = useState("")
  const [parts, setParts] = useState<{ mode: string; amount: string }[]>([{ mode: "Cash", amount: "" }, { mode: "Card", amount: "" }])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const due = order.grand_total
  const change = mode === "Cash" && Number(tendered) > due ? Number(tendered) - due : 0
  const splitSum = parts.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const quick = [due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, Math.ceil(due / 2000) * 2000].filter((v, i, a) => a.indexOf(v) === i)
  const pay = async () => {
    setBusy(true); setErr("")
    try {
      const r = await pinned((pin) => call<{ change: number }>(`${P}.pos.pay_order`, split
        ? { order: order.name, payments: parts.filter((p) => Number(p.amount) > 0).map((p) => ({ mode: p.mode, amount: Number(p.amount) })), pin }
        : { order: order.name, mode, tendered: mode === "Cash" && tendered ? Number(tendered) : undefined, pin }))
      onPaid(r.change || change)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Take payment · ${money(due)}`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant="go" busy={busy} onClick={pay} disabled={split && Math.abs(splitSum - due) > 0.009 && !(splitSum > due && parts.some((p) => p.mode === "Cash" && Number(p.amount) > 0))}>Confirm payment</Button></>}>
      <div className="flex gap-1 rounded-lg bg-paper p-1">
        <button onClick={() => setSplit(false)} className={cn("flex-1 rounded-md py-1.5 text-sm font-semibold", !split && "bg-card shadow-sm")}>One payment</button>
        <button onClick={() => setSplit(true)} className={cn("flex-1 rounded-md py-1.5 text-sm font-semibold", split && "bg-card shadow-sm")}>Split payment</button>
      </div>
      {!split ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            {MODES.map((m) => (
              <button key={m} onClick={() => setMode(m)} className={cn("h-12 rounded-xl border-2 text-sm font-bold", mode === m ? "border-ink bg-ink text-paper" : "border-line")}>{m}</button>
            ))}
          </div>
          {mode === "Cash" && (
            <Field label="Cash received (optional - works out the change)">
              <Input inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder={money(due, { bare: true })} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {quick.map((v) => <Button key={v} size="sm" variant="outline" onClick={() => setTendered(String(v))}>{money(v)}</Button>)}
              </div>
              {change > 0 && <p className="mt-2 text-lg font-extrabold text-basil">Change: {money(change)}</p>}
            </Field>
          )}
        </>
      ) : (
        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex gap-2">
              <Select className="w-32" options={MODES} value={p.mode} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, mode: e.target.value } : x)))} />
              <Input inputMode="decimal" placeholder="Amount" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <Button variant="ghost" size="sm" className="h-10" onClick={() => setParts(parts.map((x, j) => (j === i ? { ...x, amount: String(Math.max(0, due - (splitSum - (Number(x.amount) || 0))).toFixed(2)) } : x)))}>Rest</Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setParts([...parts, { mode: "UPI", amount: "" }])}><Plus className="size-3.5" />Add a payment</Button>
          <p className={cn("text-sm font-semibold", Math.abs(splitSum - due) < 0.01 ? "text-basil" : "text-ink-2")}>
            {money(splitSum)} of {money(due)}{splitSum < due ? ` · ${money(due - splitSum)} left` : splitSum > due ? ` · ${money(splitSum - due)} change (cash only)` : ""}
          </p>
        </div>
      )}
      {err && <p className="text-sm font-medium text-chili">{err}</p>}
    </Modal>
  )
}

function DiscountModal({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"percent" | "amount">("percent")
  const [val, setVal] = useState("")
  const [reason, setReason] = useState(order.discount_reason ?? "")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const save = async (clear = false) => {
    setBusy(true); setErr("")
    try {
      await call(`${P}.pos.apply_discount`, clear ? { order: order.name, amount: 0 } : { order: order.name, [kind]: Number(val) || 0, reason })
      onDone()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title="Discount" onClose={onClose} footer={<>
      {order.discount_amount > 0 && <Button variant="ghost" onClick={() => save(true)}>Remove discount</Button>}
      <Button busy={busy} onClick={() => save()}>Apply discount</Button></>}>
      <div className="flex gap-2">
        {[5, 10, 15, 20].map((p) => <Button key={p} variant="outline" size="sm" onClick={() => { setKind("percent"); setVal(String(p)) }}>{p}%</Button>)}
      </div>
      <div className="flex gap-2">
        <Select className="w-36" value={kind} onChange={(e) => setKind(e.target.value as "percent" | "amount")} options={[{ value: "percent", label: "Percent" }, { value: "amount", label: "Amount" }]} />
        <Input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder={kind === "percent" ? "10" : "100"} />
      </div>
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Regular guest, late food…" /></Field>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function ReasonModal({ title, fields, confirm, onClose, onSubmit, danger, note, options }: {
  title: string; fields: [string, string, string][]; confirm: string; onClose: () => void
  onSubmit: (v: Record<string, string>) => Promise<void>; danger?: boolean; note?: string; options?: Record<string, string[]>
}) {
  const [v, setV] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const go = async () => {
    setBusy(true); setErr("")
    try { await onSubmit(v) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={title} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button variant={danger ? "danger" : "ink"} busy={busy} onClick={go}>{confirm}</Button></>}>
      {note && <p className="rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber-deep">{note}</p>}
      {fields.map(([k, label, ph]) => (
        <Field key={k} label={label}>
          <Input list={options?.[k] ? `opt-${k}` : undefined} value={v[k] ?? ""} placeholder={ph} onChange={(e) => setV({ ...v, [k]: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && go()} />
          {options?.[k] && <datalist id={`opt-${k}`}>{options[k].map((o) => <option key={o} value={o} />)}</datalist>}
        </Field>
      ))}
      {err && <p className="text-sm font-medium text-chili">{err}</p>}
    </Modal>
  )
}

function SplitModal({ order, tables, onClose, onSplit }: { order: Order; tables: string[]; onClose: () => void; onSplit: (n: string) => void }) {
  const live = order.items.filter((i) => !i.voided)
  const [pick, setPick] = useState<Set<string>>(new Set())
  const [table, setTable] = useState(order.table_no ?? "")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const total = live.filter((i) => pick.has(i.row)).reduce((s, i) => s + i.amount, 0)
  const go = async () => {
    setBusy(true); setErr("")
    try {
      const r = await call<{ new_order: string }>(`${P}.pos.split_order`, { order: order.name, item_rows: [...pick], table_no: table || undefined })
      onSplit(r.new_order)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title="Split the bill" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Back</Button><Button busy={busy} disabled={!pick.size} onClick={go}>Move {pick.size} line{pick.size === 1 ? "" : "s"} · {money(total)}</Button></>}>
      <p className="text-sm text-mute">Pick the lines that go on a new bill.</p>
      <div className="divide-y divide-line rounded-lg border border-line">
        {live.map((l) => (
          <label key={l.row} className="flex cursor-pointer items-center gap-3 px-3 py-2">
            <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={pick.has(l.row)}
              onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(l.row); else n.delete(l.row); setPick(n) }} />
            <span className="flex-1 text-sm">{l.qty}× {l.item_name}</span>
            <span className="num text-sm font-semibold">{money(l.amount)}</span>
          </label>
        ))}
      </div>
      {order.order_type === "Dine In" && (
        <Field label="New bill's table" hint="Leave as is to keep both bills on this table.">
          <Input list="split-tables" value={table} onChange={(e) => setTable(e.target.value)} />
          <datalist id="split-tables">{tables.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
      )}
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function MergeModal({ order, map, onClose, onMerged }: { order: Order; map: { tables: Tile[]; other: Tab[] }; onClose: () => void; onMerged: (into: string) => void }) {
  const targets = [...map.tables.flatMap((t) => t.orders.map((o) => ({ name: o.order, label: o.label, total: o.grand_total }))),
    ...map.other.map((o) => ({ name: o.name, label: o.label, total: o.grand_total }))].filter((o) => o.name !== order.name)
  const [err, setErr] = useState("")
  return (
    <Modal title={`Merge ${order.label} into…`} onClose={onClose}>
      {!targets.length && <p className="text-sm text-mute">There is no other open bill to merge into.</p>}
      {targets.map((t) => (
        <button key={t.name} onClick={async () => {
          try { await call(`${P}.pos.merge_orders`, { order: order.name, into: t.name }); onMerged(t.name) } catch (e) { setErr(errText(e)) }
        }} className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2.5 text-left hover:border-ink-2">
          <span className="font-semibold">{t.label}</span><span className="num font-bold">{money(t.total)}</span>
        </button>
      ))}
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function NotesModal({ order, onClose, onSaved }: { order: Order; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    guests: String(order.guests ?? ""), customer_name: order.customer_name ?? "", customer_phone: order.customer_phone ?? "",
    delivery_address: order.delivery_address ?? "", allergy_note: order.allergy_note ?? "", notes: order.notes ?? "",
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const save = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.pos.update_order`, { order: order.name, ...v }); onSaved() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title="Guests and notes" onClose={onClose} footer={<Button busy={busy} onClick={save}>Save</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Guests"><Input inputMode="numeric" value={v.guests} onChange={(e) => setV({ ...v, guests: e.target.value })} /></Field>
        <Field label="Allergies"><Input value={v.allergy_note} onChange={(e) => setV({ ...v, allergy_note: e.target.value })} /></Field>
        <Field label="Customer name"><Input value={v.customer_name} onChange={(e) => setV({ ...v, customer_name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={v.customer_phone} onChange={(e) => setV({ ...v, customer_phone: e.target.value })} /></Field>
      </div>
      {order.order_type === "Delivery" && <Field label="Delivery address"><Textarea value={v.delivery_address} onChange={(e) => setV({ ...v, delivery_address: e.target.value })} /></Field>}
      <Field label="Notes"><Textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function ReserveModal({ outlet, tables, onClose, onDone }: { outlet: string; tables: string[]; onClose: () => void; onDone: () => void }) {
  const today = new Date().toISOString().slice(0, 10)
  const [day, setDay] = useState(today)
  const [list, setList] = useState<{ name: string; table_no: string; guest_name: string; phone?: string; party_size?: number; reserved_at: string; status: string }[]>([])
  const [f, setF] = useState({ table_no: tables[0] ?? "", guest_name: "", phone: "", party_size: "", time: "20:00", notes: "" })
  const [err, setErr] = useState("")
  const load = useCallback(() => call<typeof list>(`${P}.pos.reservations`, { outlet, date: day }).then(setList).catch(() => undefined), [outlet, day])
  useEffect(() => { load() }, [load])
  const save = async () => {
    setErr("")
    try {
      await call(`${P}.pos.reserve_table`, { outlet, table_no: f.table_no, guest_name: f.guest_name, phone: f.phone, party_size: f.party_size, notes: f.notes, reserved_at: `${day} ${f.time}:00` })
      setF({ ...f, guest_name: "", phone: "", party_size: "", notes: "" }); load(); onDone()
    } catch (e) { setErr(errText(e)) }
  }
  const setStatus = async (name: string, status: string) => { await call(`${P}.pos.set_reservation`, { reservation: name, status }); load() }
  return (
    <Modal wide title="Table reservations" onClose={onClose}>
      <div className="flex items-center gap-2"><Input type="date" className="w-44" value={day} onChange={(e) => setDay(e.target.value)} /></div>
      <div className="divide-y divide-line rounded-lg border border-line">
        {list.map((r) => (
          <div key={r.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="num w-12 font-bold">{r.reserved_at.slice(11, 16)}</span>
            <span className="w-14 font-semibold">{r.table_no}</span>
            <span className="flex-1">{r.guest_name}{r.party_size ? ` · ${r.party_size}` : ""}{r.phone ? ` · ${r.phone}` : ""}</span>
            {r.status === "Booked" ? (
              <span className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => setStatus(r.name, "Seated")}>Seated</Button>
                <Button size="sm" variant="ghost" onClick={() => setStatus(r.name, "No Show")}>No-show</Button>
                <Button size="sm" variant="ghost" onClick={() => setStatus(r.name, "Cancelled")}>Cancel</Button>
              </span>
            ) : <Tag>{r.status}</Tag>}
          </div>
        ))}
        {!list.length && <p className="px-3 py-4 text-sm text-mute">No reservations for this day.</p>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <Select className="sm:col-span-1" options={tables} value={f.table_no} onChange={(e) => setF({ ...f, table_no: e.target.value })} />
        <Input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        <Input className="sm:col-span-2" placeholder="Guest name" value={f.guest_name} onChange={(e) => setF({ ...f, guest_name: e.target.value })} />
        <Input placeholder="Phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input placeholder="Party" inputMode="numeric" value={f.party_size} onChange={(e) => setF({ ...f, party_size: e.target.value })} />
      </div>
      <div className="flex justify-end"><Button onClick={save} disabled={!f.guest_name.trim() || !f.table_no}>Add reservation</Button></div>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}
