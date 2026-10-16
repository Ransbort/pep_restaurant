import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { R, useAuth } from "../lib/auth"
import { cn } from "../lib/cn"
import { Button, Empty, Field, Input, Modal, PageHead, Select, Tag, Textarea, useToast } from "../components/ui"

interface StockRow {
  ingredient: string; ingredient_name: string; uom: string; category?: string; qty_on_hand: number; par_level: number
  status: "OK" | "LOW" | "OUT" | "NEGATIVE"; value: number; cost_per_unit: number; last_counted_at?: string
}
const TONE = { OK: "go", LOW: "warn", OUT: "bad", NEGATIVE: "bad" } as const
const LABEL = { OK: "OK", LOW: "Low", OUT: "Out", NEGATIVE: "Recount" }
const fmtQty = (n: number) => (Math.round(n * 1000) / 1000).toLocaleString()

export default function Stock() {
  const { outlet, restaurant } = useVenue()
  const { has } = useAuth()
  const toast = useToast()
  const [rows, setRows] = useState<StockRow[]>([])
  const [tab, setTab] = useState<"hand" | "waste">("hand")
  const [filter, setFilter] = useState("")
  const [modal, setModal] = useState<null | "receive" | "count" | "waste">(null)
  const [ledger, setLedger] = useState<StockRow | null>(null)
  const canMove = has(R.manager)

  const load = useCallback(() => {
    if (outlet) call<StockRow[]>(`${P}.inventory.stock_list`, { outlet: outlet.name }).then(setRows).catch((e) => toast(errText(e), "bad"))
  }, [outlet, toast])
  useEffect(load, [load])

  const shown = rows.filter((r) => !filter || r.status === filter)
  const totalValue = rows.reduce((s, r) => s + r.value, 0)
  const alerts = rows.filter((r) => r.status !== "OK").length

  if (!outlet || !restaurant) return null
  return (
    <>
      <PageHead title="Stock" sub={`${outlet.outlet_name} · worth ${money(totalValue)} on the shelf · ${alerts} need attention`}
        actions={canMove && <>
          <Button variant="outline" onClick={() => setModal("waste")}>Write off</Button>
          <Button variant="outline" onClick={() => setModal("count")}>Stock take</Button>
          <Button onClick={() => setModal("receive")}><Plus className="size-4" />Goods in</Button>
        </>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-line/60 p-1">
          <button onClick={() => setTab("hand")} className={cn("rounded-md px-3 py-1.5 text-sm font-semibold", tab === "hand" && "bg-card shadow-sm")}>On hand</button>
          <button onClick={() => setTab("waste")} className={cn("rounded-md px-3 py-1.5 text-sm font-semibold", tab === "waste" && "bg-card shadow-sm")}>Wastage</button>
        </div>
        {tab === "hand" && ["", "NEGATIVE", "OUT", "LOW", "OK"].map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={cn("rounded-full px-3 py-1 text-xs font-semibold", filter === s ? "bg-ink text-white" : "bg-card text-ink-2")}>
            {s ? LABEL[s as keyof typeof LABEL] : "All"} {s ? `(${rows.filter((r) => r.status === s).length})` : ""}
          </button>
        ))}
      </div>
      {tab === "hand" ? (
        <>
          {!rows.length && <Empty title="No ingredients yet">Add ingredients under Recipes, then record a goods-in here.</Empty>}
          {rows.some((r) => r.status === "NEGATIVE") && filter !== "OK" && (
            <p className="mb-3 rounded-lg bg-chili-soft px-3 py-2 text-sm text-chili">A negative balance means the kitchen used more than the system knew about. Count the shelf and record a stock take.</p>
          )}
          <div className="overflow-x-auto rounded-xl border border-line bg-card">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-paper text-left text-xs text-ink-2">
                <tr><th className="px-4 py-2">Ingredient</th><th className="px-4 py-2 text-right">On hand</th><th className="px-4 py-2 text-right">Par</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Value</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((r) => (
                  <tr key={r.ingredient} className="cursor-pointer hover:bg-paper" onClick={() => setLedger(r)}>
                    <td className="px-4 py-2.5"><p className="font-semibold">{r.ingredient_name}</p><p className="text-xs text-mute">{r.category}{r.last_counted_at ? ` · counted ${r.last_counted_at.slice(0, 10)}` : ""}</p></td>
                    <td className={cn("num px-4 py-2.5 text-right font-bold", r.qty_on_hand < 0 && "text-chili")}>{fmtQty(r.qty_on_hand)} {r.uom}</td>
                    <td className="num px-4 py-2.5 text-right text-mute">{r.par_level ? fmtQty(r.par_level) : "-"}</td>
                    <td className="px-4 py-2.5"><Tag tone={TONE[r.status]}>{LABEL[r.status]}</Tag></td>
                    <td className="num px-4 py-2.5 text-right">{money(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LowStock restaurant={restaurant.name} outlet={outlet.name} canEdit={has(R.kitchen, R.manager)} />
        </>
      ) : <Wastage restaurant={restaurant.name} outlet={outlet.name} />}

      {modal === "receive" && <MoveModal kind="receive" outlet={outlet.name} rows={rows} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); toast("Goods in recorded") }} />}
      {modal === "count" && <CountModal outlet={outlet.name} rows={rows} onClose={() => setModal(null)} onDone={(n) => { setModal(null); load(); toast(n ? `${n} balance${n === 1 ? "" : "s"} corrected` : "Count matched the system") }} />}
      {modal === "waste" && <MoveModal kind="waste" outlet={outlet.name} rows={rows} onClose={() => setModal(null)} onDone={() => { setModal(null); load(); toast("Written off") }} />}
      {ledger && <LedgerModal outlet={outlet.name} row={ledger} canEdit={canMove} onClose={() => setLedger(null)} onChanged={load} />}
    </>
  )
}

function MoveModal({ kind, outlet, rows, onClose, onDone }: { kind: "receive" | "waste"; outlet: string; rows: StockRow[]; onClose: () => void; onDone: () => void }) {
  const [lines, setLines] = useState([{ ingredient: rows[0]?.ingredient ?? "", qty: "", cost: "" }])
  const [supplier, setSupplier] = useState("")
  const [invoice, setInvoice] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const opts = rows.map((r) => ({ value: r.ingredient, label: `${r.ingredient_name} (${r.uom})` }))
  const go = async () => {
    setBusy(true); setErr("")
    try {
      if (kind === "receive") {
        await call(`${P}.inventory.receive_stock`, { outlet, supplier, invoice_no: invoice,
          rows: lines.filter((l) => l.ingredient && Number(l.qty) > 0).map((l) => ({ ingredient: l.ingredient, qty: Number(l.qty), cost_per_unit: l.cost === "" ? undefined : Number(l.cost) })) })
      } else {
        for (const l of lines.filter((x) => x.ingredient && Number(x.qty) > 0))
          await call(`${P}.inventory.record_wastage`, { outlet, ingredient: l.ingredient, qty: Number(l.qty), reason_note: reason })
      }
      onDone()
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal wide title={kind === "receive" ? "Goods in" : "Write off stock"} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={go}>{kind === "receive" ? "Record goods in" : "Write off"}</Button></>}>
      {kind === "receive" ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>
          <Field label="Invoice no."><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
        </div>
      ) : (
        <p className="text-sm text-mute">For stock lost outside a sale - spoiled, spilled, broken. Food voided after it was cooked is already counted as used; don't write it off again.</p>
      )}
      {lines.map((l, i) => (
        <div key={i} className="flex gap-2">
          <Select className="flex-1" options={opts} value={l.ingredient} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredient: e.target.value } : x)))} />
          <Input className="w-24" placeholder="Qty" inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
          {kind === "receive" && <Input className="w-28" placeholder="Cost / unit" inputMode="decimal" value={l.cost} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, cost: e.target.value } : x)))} />}
          <button aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))} className="p-1 text-mute hover:text-chili"><Trash2 className="size-4" /></button>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { ingredient: rows[0]?.ingredient ?? "", qty: "", cost: "" }])}><Plus className="size-3.5" />Add line</Button>
      {kind === "waste" && <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Spoiled overnight, fridge failure…" /></Field>}
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function CountModal({ outlet, rows, onClose, onDone }: { outlet: string; rows: StockRow[]; onClose: () => void; onDone: (n: number) => void }) {
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const entered = Object.entries(counts).filter(([, v]) => v !== "")
  const go = async () => {
    setBusy(true); setErr("")
    try {
      const r = await call<{ adjusted: unknown[] }>(`${P}.inventory.adjust_stock`, { outlet, note, rows: entered.map(([ingredient, v]) => ({ ingredient, counted_qty: Number(v) })) })
      onDone(r.adjusted.length)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal wide title="Stock take" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!entered.length} onClick={go}>Save {entered.length} count{entered.length === 1 ? "" : "s"}</Button></>}>
      <p className="text-sm text-mute">Type what is physically on the shelf. Leave a line blank to skip it.</p>
      <div className="max-h-[50vh] divide-y divide-line overflow-auto rounded-lg border border-line">
        {rows.map((r) => {
          const v = counts[r.ingredient] ?? ""
          const diff = v === "" ? null : Number(v) - r.qty_on_hand
          return (
            <div key={r.ingredient} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 text-sm font-semibold">{r.ingredient_name}</span>
              <span className="num w-24 text-right text-xs text-mute">system {fmtQty(r.qty_on_hand)}</span>
              <Input className="w-24" inputMode="decimal" value={v} onChange={(e) => setCounts({ ...counts, [r.ingredient]: e.target.value })} />
              <span className="w-8 text-xs text-mute">{r.uom}</span>
              <span className={cn("num w-20 text-right text-xs font-bold", diff && diff < 0 ? "text-chili" : "text-basil")}>{diff ? `${diff > 0 ? "+" : ""}${fmtQty(diff)}` : ""}</span>
            </div>
          )
        })}
      </div>
      <Field label="Note (required)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sunday close count; paneer short - portions running heavy?" /></Field>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function LedgerModal({ outlet, row, canEdit, onClose, onChanged }: { outlet: string; row: StockRow; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<{ name: string; creation: string; qty_change: number; balance_after: number; reason: string; reference_name?: string; note?: string; supplier?: string }[]>([])
  const [par, setPar] = useState(String(row.par_level || ""))
  useEffect(() => { call<typeof rows>(`${P}.inventory.ingredient_ledger`, { outlet, ingredient: row.ingredient }).then(setRows) }, [outlet, row.ingredient])
  return (
    <Modal wide title={`${row.ingredient_name} · ${fmtQty(row.qty_on_hand)} ${row.uom}`} onClose={onClose}>
      {canEdit && (
        <div className="flex items-end gap-2">
          <Field label={`Par level (${row.uom})`} hint="At or below this, it shows as Low."><Input className="w-32" inputMode="decimal" value={par} onChange={(e) => setPar(e.target.value)} /></Field>
          <Button variant="outline" onClick={async () => { await call(`${P}.inventory.set_par_level`, { outlet, ingredient: row.ingredient, par_level: Number(par) || 0 }); onChanged() }}>Save par</Button>
        </div>
      )}
      <h3 className="text-sm font-bold">History</h3>
      <div className="divide-y divide-line rounded-lg border border-line text-sm">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-3 px-3 py-2">
            <span className="w-28 text-xs text-mute">{r.creation.slice(0, 16)}</span>
            <span className="w-20"><Tag tone={r.reason === "Received" ? "go" : r.reason === "Consumed" ? "info" : r.reason === "Count" ? "plum" : r.reason === "Wastage" ? "bad" : "mute"}>{r.reason}</Tag></span>
            <span className="flex-1 truncate text-xs text-ink-2">{r.reference_name || r.supplier || r.note}</span>
            <span className={cn("num w-16 text-right font-bold", r.qty_change < 0 ? "text-chili" : "text-basil")}>{r.qty_change > 0 ? "+" : ""}{fmtQty(r.qty_change)}</span>
            <span className="num w-16 text-right text-mute">{fmtQty(r.balance_after)}</span>
          </div>
        ))}
        {!rows.length && <p className="px-3 py-4 text-mute">Nothing has moved yet.</p>}
      </div>
    </Modal>
  )
}

function LowStock({ restaurant, outlet, canEdit }: { restaurant: string; outlet: string; canEdit: boolean }) {
  const [rows, setRows] = useState<{ ingredient: string; ingredient_name: string; status: string; qty_on_hand: number; uom: string; dishes: { name: string; item_name: string; available: 0 | 1 }[] }[]>([])
  const load = useCallback(() => call<typeof rows>(`${P}.inventory.low_stock`, { restaurant, outlet }).then(setRows).catch(() => undefined), [restaurant, outlet])
  useEffect(() => { load() }, [load])
  const withDishes = useMemo(() => rows.filter((r) => r.dishes.length && r.status !== "LOW"), [rows])
  if (!withDishes.length) return null
  return (
    <section className="mt-6">
      <h2 className="mb-1 text-sm font-bold">Dishes affected by stock that's out</h2>
      <p className="mb-2 text-xs text-mute">Nothing comes off the menu by itself - check the shelf, then take a dish off if you need to.</p>
      <div className="space-y-2">
        {withDishes.map((r) => (
          <div key={r.ingredient} className="rounded-xl border border-line bg-card p-3">
            <p className="text-sm font-semibold">{r.ingredient_name} <span className="text-xs text-mute">· {fmtQty(r.qty_on_hand)} {r.uom}</span></p>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.dishes.map((d) => (
                <button key={d.name} disabled={!canEdit} onClick={async () => { await call(`${P}.menu.set_availability`, { menu_item: d.name, available: d.available ? 0 : 1 }); load() }}
                  className={cn("rounded-lg px-2.5 py-1 text-xs font-semibold", d.available ? "bg-paper text-ink" : "bg-chili-soft text-chili line-through")}>
                  {d.item_name} {canEdit && (d.available ? "· take off" : "· put back")}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Wastage({ restaurant, outlet }: { restaurant: string; outlet: string }) {
  const [days, setDays] = useState("30")
  const [data, setData] = useState<{ lines: { item_name: string; qty: number; void_reason?: string; order_name: string; creation: string; value: number }[]; by_reason: { reason: string; value: number }[]; total_value: number; written_off: { ingredient_name: string; qty_change: number; note?: string; creation: string; value: number }[]; written_off_value: number } | null>(null)
  useEffect(() => { call<typeof data>(`${P}.inventory.wastage_report`, { restaurant, outlet, days: Number(days) }).then(setData) }, [restaurant, outlet, days])
  if (!data) return null
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2"><span className="text-sm">Last</span><Select className="w-28" options={["7", "30", "90"]} value={days} onChange={(e) => setDays(e.target.value)} /><span className="text-sm">days</span></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-card p-4"><p className="text-sm text-mute">Cooked, then voided</p><p className="wide num text-2xl font-extrabold">{money(data.total_value)}</p></div>
        <div className="rounded-xl border border-line bg-card p-4"><p className="text-sm text-mute">Written off</p><p className="wide num text-2xl font-extrabold">{money(data.written_off_value)}</p></div>
      </div>
      {data.by_reason.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold">Why cooked food was voided</h2>
          <div className="divide-y divide-line rounded-xl border border-line bg-card text-sm">
            {data.by_reason.map((r) => <div key={r.reason} className="flex justify-between px-4 py-2"><span>{r.reason}</span><span className="num font-semibold">{money(r.value)}</span></div>)}
          </div>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-sm font-bold">Write-offs</h2>
        <div className="divide-y divide-line rounded-xl border border-line bg-card text-sm">
          {data.written_off.map((w, i) => <div key={i} className="flex gap-3 px-4 py-2"><span className="w-24 text-xs text-mute">{w.creation.slice(0, 10)}</span><span className="flex-1">{w.ingredient_name} · {fmtQty(-w.qty_change)} <span className="text-mute">{w.note}</span></span><span className="num">{money(w.value)}</span></div>)}
          {!data.written_off.length && <p className="px-4 py-3 text-mute">None in this period.</p>}
        </div>
      </section>
    </div>
  )
}
