import { useEffect, useMemo, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { Minus, Plus, ShoppingBag } from "lucide-react"
import { callGuest, errText, P } from "../lib/api"
import { money, setMoney } from "../lib/venue"
import { cn } from "../lib/cn"
import { Button, Field, Input, Modal } from "../components/ui"

interface Item { name: string; item_name: string; category: string; price: number; is_veg: 0 | 1; is_alcohol: 0 | 1; image?: string; description?: string; allergens?: string }
interface Menu { outlet_name: string; restaurant_name: string; currency: string; currency_symbol?: string; logo?: string; prices_include_tax: 0 | 1; ordering: boolean; categories: { category: string; items: Item[] }[] }

export default function QrMenu() {
  const { outlet = "" } = useParams()
  const [sp] = useSearchParams()
  const table = sp.get("table") || undefined
  const [menu, setMenu] = useState<Menu | null>(null)
  const [err, setErr] = useState("")
  const [cart, setCart] = useState<Record<string, number>>({})
  const [vegOnly, setVegOnly] = useState(false)
  const [checkout, setCheckout] = useState(false)
  const [placed, setPlaced] = useState<string | null>(null)
  useEffect(() => {
    callGuest<Menu>(`${P}.public_api.qr_menu`, { outlet }).then((m) => { setMoney(m.currency, m.currency_symbol); setMenu(m); document.title = m.restaurant_name }).catch((e) => setErr(errText(e)))
  }, [outlet])
  const items = useMemo(() => Object.fromEntries((menu?.categories ?? []).flatMap((c) => c.items).map((i) => [i.name, i])), [menu])
  const count = Object.values(cart).reduce((s, n) => s + n, 0)
  const total = Object.entries(cart).reduce((s, [k, n]) => s + (items[k]?.price ?? 0) * n, 0)
  const bump = (k: string, by: number) => setCart((c) => { const n = (c[k] ?? 0) + by; const x = { ...c }; if (n <= 0) delete x[k]; else x[k] = n; return x })

  if (err) return <div className="flex min-h-full items-center justify-center p-6 text-center"><p className="font-semibold">{err}</p></div>
  if (!menu) return <div className="p-6 text-center text-mute">Loading the menu…</div>
  if (placed) return (
    <div className="flex min-h-full flex-col items-center justify-center p-8 text-center">
      <p className="wide text-3xl font-extrabold">Order sent</p>
      <p className="mt-2 max-w-xs text-mute">A server will confirm it with you shortly{table ? ` at table ${table}` : ""}. Your reference is {placed}.</p>
      <Button className="mt-6" variant="outline" onClick={() => setPlaced(null)}>Order something else</Button>
    </div>
  )
  return (
    <div className="mx-auto min-h-full max-w-xl bg-card pb-28">
      <header className="bg-ink px-5 pb-6 pt-8 text-white">
        {menu.logo && <img src={menu.logo} alt="" className="mb-3 size-12 rounded-xl object-cover" />}
        <h1 className="wide text-3xl font-extrabold leading-tight">{menu.restaurant_name}</h1>
        <p className="mt-1 text-sm text-white/70">{menu.outlet_name}{table ? ` · Table ${table}` : ""}</p>
      </header>
      <div className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-line bg-card px-4 py-2.5">
        <button onClick={() => setVegOnly(!vegOnly)} className={cn("shrink-0 rounded-full border px-3 py-1 text-sm font-semibold", vegOnly ? "border-basil bg-basil text-white" : "border-line")}>Veg only</button>
        {menu.categories.map((c) => <a key={c.category} href={`#c-${c.category}`} className="shrink-0 rounded-full bg-paper px-3 py-1 text-sm font-semibold">{c.category}</a>)}
      </div>
      {menu.categories.map((c) => {
        const list = c.items.filter((i) => !vegOnly || i.is_veg)
        if (!list.length) return null
        return (
          <section key={c.category} id={`c-${c.category}`} className="scroll-mt-14 px-4 pt-6">
            <h2 className="wide mb-2 text-xl font-extrabold">{c.category}</h2>
            <div className="divide-y divide-line">
              {list.map((i) => (
                <div key={i.name} className="flex gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 font-semibold"><span className={cn("size-3 shrink-0 rounded-sm border-2", i.is_veg ? "border-basil" : "border-chili")} />{i.item_name}</p>
                    <p className="text-sm font-bold">{money(i.price)}</p>
                    {i.description && <p className="mt-0.5 text-sm text-mute">{i.description}</p>}
                    {i.allergens && <p className="mt-0.5 text-xs text-mute">Contains {i.allergens}</p>}
                  </div>
                  <div className="flex w-24 shrink-0 flex-col items-center gap-2">
                    {i.image && <img src={i.image} alt="" className="size-20 rounded-xl object-cover" />}
                    {menu.ordering && (cart[i.name]
                      ? <div className="flex items-center rounded-lg bg-ink text-white">
                          <button aria-label="One less" className="p-2" onClick={() => bump(i.name, -1)}><Minus className="size-4" /></button>
                          <span className="num w-5 text-center font-bold">{cart[i.name]}</span>
                          <button aria-label="One more" className="p-2" onClick={() => bump(i.name, 1)}><Plus className="size-4" /></button>
                        </div>
                      : <Button size="sm" variant="outline" onClick={() => bump(i.name, 1)}>Add</Button>)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
      {!menu.prices_include_tax && <p className="px-4 pt-6 text-xs text-mute">Prices exclude taxes.</p>}
      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-xl p-3">
          <Button size="lg" variant="brand" className="w-full justify-between shadow-xl" onClick={() => setCheckout(true)}>
            <span className="flex items-center gap-2"><ShoppingBag className="size-5" />{count} item{count === 1 ? "" : "s"}</span>
            <span>Review order · {money(total)}</span>
          </Button>
        </div>
      )}
      {checkout && <Checkout outlet={outlet} table={table} cart={cart} items={items} bump={bump} total={total} onClose={() => setCheckout(false)}
        onPlaced={(ref) => { setCart({}); setCheckout(false); setPlaced(ref) }} />}
    </div>
  )
}

function Checkout({ outlet, table, cart, items, bump, total, onClose, onPlaced }: {
  outlet: string; table?: string; cart: Record<string, number>; items: Record<string, Item>; bump: (k: string, by: number) => void
  total: number; onClose: () => void; onPlaced: (ref: string) => void
}) {
  const [name, setName] = useState("")
  const [allergy, setAllergy] = useState("")
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const place = async () => {
    setBusy(true); setErr("")
    try {
      const r = await callGuest<{ order: string }>(`${P}.public_api.qr_order`, {
        outlet, table_no: table, customer_name: name || undefined, allergy_note: allergy || undefined, notes: notes || undefined,
        items: Object.entries(cart).map(([menu_item, qty]) => ({ menu_item, qty })),
      })
      onPlaced(r.order)
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title="Your order" onClose={onClose} footer={<Button variant="brand" size="lg" className="w-full" busy={busy} onClick={place}>Send order · {money(total)}</Button>}>
      {Object.entries(cart).map(([k, n]) => (
        <div key={k} className="flex items-center gap-3">
          <div className="flex items-center rounded-lg border border-line">
            <button aria-label="One less" className="p-1.5" onClick={() => bump(k, -1)}><Minus className="size-3.5" /></button>
            <span className="num w-5 text-center text-sm font-bold">{n}</span>
            <button aria-label="One more" className="p-1.5" onClick={() => bump(k, 1)}><Plus className="size-3.5" /></button>
          </div>
          <span className="flex-1 text-sm font-semibold">{items[k]?.item_name}</span>
          <span className="num text-sm">{money((items[k]?.price ?? 0) * n)}</span>
        </div>
      ))}
      <Field label="Your name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Any allergies?"><Input value={allergy} onChange={(e) => setAllergy(e.target.value)} placeholder="Nuts, gluten…" /></Field>
      <Field label="Anything else for the kitchen?"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Less spicy, no onion…" /></Field>
      <p className="text-xs text-mute">A server confirms your order before it goes to the kitchen. You pay at the end of your meal.</p>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}
