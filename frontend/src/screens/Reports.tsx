import { useEffect, useState } from "react"
import { call, errText, P } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { Input, PageHead, Tag, useToast } from "../components/ui"

interface Dash {
  gross_sales: number; net_sales: number; tax: number; service_charge: number; discounts: number; bills: number; covers: number; avg_bill: number
  by_order_type: { label: string; bills: number; total: number }[]; by_tender: { label: string; total: number }[]
  by_hour: { hour: number; total: number }[]
  open_bills: { name: string; label: string; status: string; grand_total: number; creation: string }[]
  nc: { count: number; value: number; bills: { name: string; label: string; subtotal: number; authorized_by: string; note?: string }[] }
  discount_bills: { name: string; label: string; amount: number; reason?: string }[]
  voids: { order: string; label: string; item_name: string; qty: number; amount: number; reason?: string; by?: string; after_fire: boolean }[]
  cancellations: { name: string; label: string; subtotal: number; reason?: string }[]
  top_items: { item_name: string; qty: number; amount: number }[]
  avg_fire_to_ready_mins: number | null; qr_orders: number
}
const today = () => new Date().toISOString().slice(0, 10)

export default function Reports() {
  const { outlet } = useVenue()
  const toast = useToast()
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const [d, setD] = useState<Dash | null>(null)
  useEffect(() => {
    if (outlet) call<Dash>(`${P}.pos.outlet_dashboard`, { outlet: outlet.name, date: from, to_date: to }).then(setD).catch((e) => toast(errText(e), "bad"))
  }, [outlet, from, to, toast])
  if (!outlet) return null
  const maxHour = Math.max(1, ...(d?.by_hour.map((h) => h.total) ?? [1]))
  const tenderTotal = d?.by_tender.reduce((s, t) => s + t.total, 0) || 1
  return (
    <>
      <PageHead title="Reports" sub={outlet.outlet_name} actions={
        <div className="flex items-center gap-2 text-sm">
          <Input type="date" className="w-40" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value) }} />
          <span>to</span>
          <Input type="date" className="w-40" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>} />
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Sales (incl. tax)" value={money(d.gross_sales)} lead />
            <Kpi label="Bills settled" value={String(d.bills)} />
            <Kpi label="Average bill" value={money(d.avg_bill)} />
            <Kpi label="Covers" value={String(d.covers)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card title="Sales by hour">
              {d.by_hour.length ? (
                <div className="flex h-40 items-end gap-1.5" role="img" aria-label="Sales by hour">
                  {d.by_hour.map((h) => (
                    <div key={h.hour} className="flex flex-1 flex-col items-center gap-1">
                      <div className="w-full rounded-t-md bg-brand" style={{ height: `${(h.total / maxHour) * 100}%` }} title={money(h.total)} />
                      <span className="text-[10px] text-mute">{h.hour}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-mute">No settled bills in this period.</p>}
            </Card>
            <Card title="Payments">
              {d.by_tender.map((t) => (
                <div key={t.label} className="mb-2">
                  <div className="flex justify-between text-sm"><span>{t.label}</span><span className="num font-semibold">{money(t.total)}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-paper"><div className="h-2 rounded-full bg-ink" style={{ width: `${(t.total / tenderTotal) * 100}%` }} /></div>
                </div>
              ))}
              <div className="mt-3 space-y-1 border-t border-line pt-3 text-sm text-ink-2">
                <Line l="Net of discounts" v={money(d.net_sales)} /><Line l="Service charge" v={money(d.service_charge)} />
                <Line l="Tax" v={money(d.tax)} /><Line l="Discounts given" v={money(d.discounts)} />
                {d.by_order_type.map((o) => <Line key={o.label} l={`${o.label} (${o.bills})`} v={money(o.total)} />)}
              </div>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Best sellers">
              {d.top_items.map((t, i) => <Line key={t.item_name} l={`${i + 1}. ${t.item_name} × ${t.qty}`} v={money(t.amount)} />)}
              {!d.top_items.length && <p className="text-sm text-mute">Nothing sold yet.</p>}
            </Card>
            <Card title="Kitchen">
              <Line l="Fired to ready, average" v={d.avg_fire_to_ready_mins != null ? `${d.avg_fire_to_ready_mins} min` : "-"} />
              <Line l="Guest QR orders" v={String(d.qr_orders)} />
              <Line l="Bills still open" v={String(d.open_bills.length)} />
              {d.open_bills.slice(0, 6).map((o) => <p key={o.name} className="text-xs text-mute">{o.label} · {o.status} · {money(o.grand_total)}</p>)}
            </Card>
          </div>
          <Card title="Needs a manager's eye">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-bold text-ink-2">Complimentary (NC) · {d.nc.count} · {money(d.nc.value)} of food</h3>
                {d.nc.bills.map((b) => <p key={b.name} className="text-sm">{b.label} · {money(b.subtotal)} · <span className="text-mute">{b.authorized_by}{b.note ? `, ${b.note}` : ""}</span></p>)}
                <h3 className="mb-1 mt-3 text-xs font-bold text-ink-2">Discounts</h3>
                {d.discount_bills.map((b) => <p key={b.name} className="text-sm">{b.label} · {money(b.amount)} <span className="text-mute">{b.reason}</span></p>)}
                {!d.discount_bills.length && <p className="text-sm text-mute">None.</p>}
              </div>
              <div>
                <h3 className="mb-1 text-xs font-bold text-ink-2">Voided lines</h3>
                {d.voids.map((v, i) => <p key={i} className="text-sm">{v.label} · {v.qty}× {v.item_name} {v.after_fire && <Tag tone="bad">after cooking</Tag>} <span className="text-mute">{v.reason}</span></p>)}
                {!d.voids.length && <p className="text-sm text-mute">None.</p>}
                <h3 className="mb-1 mt-3 text-xs font-bold text-ink-2">Cancelled orders</h3>
                {d.cancellations.map((c) => <p key={c.name} className="text-sm">{c.label} · {money(c.subtotal)} <span className="text-mute">{c.reason}</span></p>)}
                {!d.cancellations.length && <p className="text-sm text-mute">None.</p>}
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  )
}

function Kpi({ label, value, lead }: { label: string; value: string; lead?: boolean }) {
  return (
    <div className={"rounded-xl border p-4 " + (lead ? "border-ink bg-ink text-paper" : "border-line bg-card")}>
      <p className={"text-xs " + (lead ? "text-paper/70" : "text-mute")}>{label}</p>
      <p className="wide num mt-1 text-2xl font-extrabold">{value}</p>
    </div>
  )
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-line bg-card p-4"><h2 className="mb-3 text-sm font-bold">{title}</h2>{children}</section>
}
function Line({ l, v }: { l: string; v: string }) {
  return <div className="flex justify-between py-0.5 text-sm"><span className="truncate pr-3">{l}</span><span className="num font-semibold">{v}</span></div>
}
