import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus, Upload } from "lucide-react"
import { call, errText, P, uploadImage } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { R, useAuth } from "../lib/auth"
import { cn } from "../lib/cn"
import { Button, Check, Empty, Field, Input, Modal, PageHead, Select, Tag, Textarea, useToast } from "../components/ui"

interface Dish {
  name: string; item_name: string; category?: string; price: number; course: string; prep_station: string
  is_veg: 0 | 1; is_alcohol: 0 | 1; available: 0 | 1; allergens?: string; description?: string; image?: string; sort_order: number
}
const BLANK: Partial<Dish> = { item_name: "", price: 0, course: "Main", prep_station: "Kitchen", is_veg: 0, is_alcohol: 0, available: 1, sort_order: 0 }

export default function Dishes() {
  const { outlet } = useVenue()
  const { has } = useAuth()
  const toast = useToast()
  const [rows, setRows] = useState<Dish[]>([])
  const [edit, setEdit] = useState<Partial<Dish> | null>(null)
  const [importing, setImporting] = useState(false)
  const [q, setQ] = useState("")
  const canEdit = has(R.manager)

  const load = useCallback(() => {
    if (outlet) call<Dish[]>(`${P}.menu.menu_items`, { outlet: outlet.name }).then(setRows).catch((e) => toast(errText(e), "bad"))
  }, [outlet, toast])
  useEffect(load, [load])

  const groups = useMemo(() => {
    const g: Record<string, Dish[]> = {}
    rows.filter((r) => !q || r.item_name.toLowerCase().includes(q.toLowerCase()))
      .forEach((r) => (g[r.category || "Other"] ??= []).push(r))
    return Object.entries(g)
  }, [rows, q])
  const categories = useMemo(() => [...new Set(rows.map((r) => r.category).filter(Boolean))] as string[], [rows])

  const toggle = async (d: Dish) => {
    try {
      await call(`${P}.menu.set_availability`, { menu_item: d.name, available: d.available ? 0 : 1 })
      setRows(rows.map((r) => (r.name === d.name ? { ...r, available: d.available ? 0 : 1 } : r)))
      toast(d.available ? `${d.item_name} is off the menu` : `${d.item_name} is back on`)
    } catch (e) { toast(errText(e), "bad") }
  }

  if (!outlet) return <Empty title="No outlet yet">Create an outlet in Setup first.</Empty>
  return (
    <>
      <PageHead title="Menu" sub={`${outlet.outlet_name} · ${rows.length} dishes · ${rows.filter((r) => !r.available).length} off today`}
        actions={canEdit && <>
          <Button variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" />Import CSV</Button>
          <Button onClick={() => setEdit({ ...BLANK })}><Plus className="size-4" />Add dish</Button>
        </>} />
      <Input placeholder="Find a dish" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 max-w-xs" />
      {!rows.length && <Empty title="This menu is empty" action={canEdit && <Button onClick={() => setEdit({ ...BLANK })}>Add the first dish</Button>}>
        Add dishes one by one, or paste a whole menu as CSV.</Empty>}
      <div className="space-y-6">
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h2 className="mb-2 text-sm font-bold text-ink-2">{cat}</h2>
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
              {list.map((d) => (
                <div key={d.name} className={cn("flex items-center gap-3 px-4 py-2.5", !d.available && "bg-paper")}>
                  {d.image ? <img src={d.image} alt="" className="size-10 rounded-lg object-cover" /> : <span className={cn("size-3 shrink-0 rounded-sm border-2", d.is_veg ? "border-basil" : "border-chili")} />}
                  <button className="min-w-0 flex-1 text-left" onClick={() => canEdit && setEdit(d)} disabled={!canEdit}>
                    <p className={cn("font-semibold", !d.available && "text-mute line-through")}>{d.item_name}</p>
                    <p className="truncate text-xs text-mute">{d.course} · {d.prep_station}{d.allergens ? ` · ${d.allergens}` : ""}</p>
                  </button>
                  {d.is_alcohol ? <Tag tone="plum">Alcohol</Tag> : null}
                  <span className="num w-20 text-right font-bold">{money(d.price)}</span>
                  <button onClick={() => toggle(d)} className={cn("w-24 rounded-lg px-2 py-1.5 text-xs font-bold",
                    d.available ? "bg-basil-soft text-basil" : "bg-chili-soft text-chili")}>
                    {d.available ? "On menu" : "86'd"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {edit && <DishModal dish={edit} outlet={outlet.name} categories={categories} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load() }} />}
      {importing && <ImportModal outlet={outlet.name} onClose={() => setImporting(false)} onDone={() => { setImporting(false); load() }} />}
    </>
  )
}

function DishModal({ dish, outlet, categories, onClose, onSaved }: { dish: Partial<Dish>; outlet: string; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Partial<Dish>>(dish)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const set = (k: keyof Dish, v: unknown) => setD({ ...d, [k]: v })
  const save = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.menu.save_menu_item`, { ...d, outlet }); onSaved() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const del = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.menu.delete_menu_item`, { name: d.name }); onSaved() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal wide title={d.name ? `Edit ${dish.item_name}` : "Add a dish"} onClose={onClose}
      footer={<>{d.name && <Button variant="ghost" className="mr-auto text-chili" onClick={del} busy={busy}>Delete</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save}>Save dish</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={d.item_name} onChange={(e) => set("item_name", e.target.value)} /></Field>
        <Field label="Price"><Input inputMode="decimal" value={d.price} onChange={(e) => set("price", e.target.value)} /></Field>
        <Field label="Category">
          <Input list="dish-cats" value={d.category ?? ""} onChange={(e) => set("category", e.target.value)} placeholder="Starters, Mains…" />
          <datalist id="dish-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label="Sort order" hint="Lower numbers show first in their category."><Input inputMode="numeric" value={d.sort_order ?? 0} onChange={(e) => set("sort_order", e.target.value)} /></Field>
        <Field label="Course" hint="Lets a captain fire starters first and hold mains."><Select options={["Starter", "Main", "Dessert", "Drink"]} value={d.course} onChange={(e) => set("course", e.target.value)} /></Field>
        <Field label="Cooked at" hint="Which kitchen screen and KOT the dish goes to."><Select options={["Kitchen", "Tandoor", "Grill", "Fryer", "Bar", "Cold"]} value={d.prep_station} onChange={(e) => set("prep_station", e.target.value)} /></Field>
        <Field label="Allergens" hint="Comma separated. The kitchen screen flags them against a guest's allergy note."><Input value={d.allergens ?? ""} onChange={(e) => set("allergens", e.target.value)} placeholder="Nuts, Dairy, Gluten" /></Field>
        <Field label="Photo">
          <div className="flex items-center gap-2">
            {d.image && <img src={d.image} alt="" className="size-10 rounded-lg object-cover" />}
            <input type="file" accept="image/*" className="text-sm" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return
              try { set("image", await uploadImage(f)) } catch (er) { setErr(errText(er)) }
            }} />
          </div>
        </Field>
      </div>
      <Field label="Description (shown on the guest QR menu)"><Textarea value={d.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
      <div className="flex flex-wrap gap-5">
        <Check label="Vegetarian" checked={!!d.is_veg} onChange={(v) => set("is_veg", v ? 1 : 0)} />
        <Check label="Contains alcohol" checked={!!d.is_alcohol} onChange={(v) => set("is_alcohol", v ? 1 : 0)} />
        <Check label="On the menu" checked={!!d.available} onChange={(v) => set("available", v ? 1 : 0)} />
      </div>
      {err && <p className="text-sm font-medium text-chili">{err}</p>}
    </Modal>
  )
}

function ImportModal({ outlet, onClose, onDone }: { outlet: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("item_name,price,category,course,prep_station,is_veg,allergens\nMasala Dosa,160,Breakfast,Main,Kitchen,yes,\n")
  const [update, setUpdate] = useState(true)
  const [res, setRes] = useState<{ created: number; updated: number; errors: { line: number; item: string; error: string }[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const go = async () => {
    setBusy(true); setErr("")
    try { setRes(await call(`${P}.menu.import_csv`, { outlet, csv_text: text, update_existing: update ? 1 : 0 })) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal wide title="Import a menu" onClose={onClose}
      footer={res ? <Button onClick={onDone}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={go}>Import</Button></>}>
      <p className="text-sm text-mute">Paste CSV with a header row. <b>item_name</b> and <b>price</b> are required; category, course, prep_station, is_veg, is_alcohol, allergens and description are optional.</p>
      <Textarea className="min-h-56 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      <Check label="Update dishes that already exist (matched by name)" checked={update} onChange={setUpdate} />
      {res && (
        <div className="rounded-lg bg-paper p-3 text-sm">
          <p className="font-semibold">{res.created} added, {res.updated} updated{res.errors.length ? `, ${res.errors.length} skipped` : ""}.</p>
          {res.errors.map((e) => <p key={e.line} className="text-chili">Line {e.line} ({e.item}): {e.error}</p>)}
        </div>
      )}
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}
