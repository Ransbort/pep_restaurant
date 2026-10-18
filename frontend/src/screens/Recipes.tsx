import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, Plus, Trash2, Upload } from "lucide-react"
import { DropOverlay, useFileDrop } from "../components/FileDrop"
import { Pager, usePaged } from "../components/Pager"
import { downloadIngredientTemplate, IngredientImportModal } from "./IngredientImport"
import { call, errText, P } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { R, useAuth } from "../lib/auth"
import { cn } from "../lib/cn"
import { Button, Check, Empty, Field, Input, Modal, PageHead, Select, Tag, useToast } from "../components/ui"

interface DishRow { name: string; item_name: string; outlet_name: string; category?: string; price: number; lines: number; food_cost: number; food_cost_pct: number | null }
export interface Ingredient { name: string; ingredient_name: string; uom: string; category?: string; cost_per_unit: number; is_active: 0 | 1 }
interface RecipeLine { ingredient: string; qty: number | string; note?: string; ingredient_name?: string; uom?: string; qty_on_hand?: number | null; line_cost?: number }

export default function Recipes() {
  const { restaurant } = useVenue()
  const { has } = useAuth()
  const [tab, setTab] = useState<"dishes" | "ingredients">("dishes")
  if (!restaurant) return null
  return (
    <>
      <PageHead title="Recipes" sub="What each dish uses. Firing a KOT takes these quantities off the outlet's stock." />
      <div className="mb-4 flex gap-1 rounded-lg bg-line/60 p-1 sm:w-fit">
        {(["dishes", "ingredients"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn("flex-1 rounded-md px-4 py-1.5 text-sm font-semibold capitalize", tab === t && "bg-card shadow-sm")}>{t}</button>
        ))}
      </div>
      {tab === "dishes" ? <DishList restaurant={restaurant.name} canEdit={has(R.manager)} /> : <Ingredients restaurant={restaurant.name} canEdit={has(R.manager)} />}
    </>
  )
}

const pctTone = (p: number | null) => (p == null ? "mute" : p > 40 ? "bad" : p > 32 ? "warn" : "go") as "mute" | "bad" | "warn" | "go"

function DishList({ restaurant, canEdit }: { restaurant: string; canEdit: boolean }) {
  const toast = useToast()
  const [rows, setRows] = useState<DishRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const load = useCallback(() => call<DishRow[]>(`${P}.inventory.recipe_overview`, { restaurant }).then(setRows).catch((e) => toast(errText(e), "bad")), [restaurant, toast])
  useEffect(() => { load() }, [load])
  const [q, setQ] = useState("")
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return rows.filter((r) => (!missing || !r.lines)
      && (!t || r.item_name.toLowerCase().includes(t) || (r.category ?? "").toLowerCase().includes(t)))
  }, [rows, missing, q])
  const { slice, pager } = usePaged(shown, "recipes", `${q}|${missing}|${restaurant}`)
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Input placeholder="Find a dish" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <Check label={`Only dishes without a recipe (${rows.filter((r) => !r.lines).length})`} checked={missing} onChange={setMissing} />
      </div>
      {!rows.length && <Empty title="No dishes yet">Add dishes in Menu, then give them recipes here.</Empty>}
      <div className="overflow-hidden rounded-xl border border-line bg-card">
        <table className="w-full text-sm">
          <thead className="bg-paper text-left text-xs text-ink-2">
            <tr><th className="px-4 py-2">Dish</th><th className="hidden px-4 py-2 sm:table-cell">Outlet</th><th className="px-4 py-2 text-right">Price</th><th className="px-4 py-2 text-right">Food cost</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {slice.map((r) => (
              <tr key={r.name} className="cursor-pointer hover:bg-paper" onClick={() => setOpen(r.name)}>
                <td className="px-4 py-2.5"><p className="font-semibold">{r.item_name}</p><p className="text-xs text-mute">{r.lines ? `${r.lines} ingredient${r.lines === 1 ? "" : "s"}` : "No recipe"}</p></td>
                <td className="hidden px-4 py-2.5 text-mute sm:table-cell">{r.outlet_name}</td>
                <td className="num px-4 py-2.5 text-right">{money(r.price)}</td>
                <td className="px-4 py-2.5 text-right">{r.lines ? <span className="num">{money(r.food_cost)} <Tag tone={pctTone(r.food_cost_pct)}>{r.food_cost_pct}%</Tag></span> : <span className="text-mute">-</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 0 && !shown.length && <p className="px-4 py-6 text-center text-sm text-mute">No dishes match.</p>}
      </div>
      {shown.length > 0 && <Pager {...pager} noun="dishes" />}
      {open && <RecipeModal menuItem={open} restaurant={restaurant} canEdit={canEdit} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load() }} />}
    </>
  )
}

function RecipeModal({ menuItem, restaurant, canEdit, onClose, onSaved }: { menuItem: string; restaurant: string; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<{ item_name: string; price: number; food_cost: number; food_cost_pct: number | null; recipe: RecipeLine[] } | null>(null)
  const [ings, setIngs] = useState<Ingredient[]>([])
  const [rows, setRows] = useState<RecipeLine[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  useEffect(() => {
    call<typeof data>(`${P}.inventory.menu_recipe`, { menu_item: menuItem }).then((d) => { setData(d); setRows(d!.recipe) })
    call<Ingredient[]>(`${P}.inventory.ingredients`, { restaurant }).then(setIngs)
  }, [menuItem, restaurant])
  const byName = useMemo(() => Object.fromEntries(ings.map((i) => [i.name, i])), [ings])
  const cost = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (byName[r.ingredient]?.cost_per_unit ?? 0), 0)
  const save = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.inventory.save_recipe`, { menu_item: menuItem, rows: rows.map((r) => ({ ingredient: r.ingredient, qty: Number(r.qty), note: r.note })) }); onSaved() }
    catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  if (!data) return null
  return (
    <Modal wide title={`Recipe · ${data.item_name}`} onClose={onClose}
      footer={canEdit ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} onClick={save}>Save recipe</Button></> : undefined}>
      <p className="text-sm text-mute">Quantities are for one portion, in each ingredient's unit.</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Select className="min-w-0 flex-1" disabled={!canEdit} value={r.ingredient}
              options={[{ value: "", label: "Pick an ingredient" }, ...ings.filter((g) => g.is_active || g.name === r.ingredient).map((g) => ({ value: g.name, label: `${g.ingredient_name} (${g.uom})` }))]}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, ingredient: e.target.value } : x)))} />
            <Input className="w-24 shrink-0" inputMode="decimal" disabled={!canEdit} value={r.qty} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <span className="w-10 shrink-0 text-xs text-mute">{byName[r.ingredient]?.uom}</span>
            <span className="num w-20 shrink-0 text-right text-sm">{money((Number(r.qty) || 0) * (byName[r.ingredient]?.cost_per_unit ?? 0))}</span>
            {canEdit && <button aria-label="Remove line" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="p-1 text-mute hover:text-chili"><Trash2 className="size-4" /></button>}
          </div>
        ))}
        {!rows.length && <p className="text-sm text-mute">No recipe: this dish doesn't move stock.</p>}
      </div>
      {canEdit && <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { ingredient: "", qty: "" }])}><Plus className="size-3.5" />Add ingredient</Button>}
      <div className="flex justify-between rounded-lg bg-paper px-3 py-2 text-sm">
        <span>Food cost per portion</span>
        <span className="num font-bold">{money(cost)}{data.price ? ` · ${((cost / data.price) * 100).toFixed(1)}% of ${money(data.price)}` : ""}</span>
      </div>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

export function Ingredients({ restaurant, canEdit }: { restaurant: string; canEdit: boolean }) {
  const toast = useToast()
  const [rows, setRows] = useState<Ingredient[]>([])
  const [edit, setEdit] = useState<Partial<Ingredient> | null>(null)
  const [importing, setImporting] = useState(false)
  const [dropped, setDropped] = useState<File | null>(null)
  const pageDrop = useFileDrop((f) => { setDropped(f); setImporting(true) }, canEdit)
  const blank = { uom: "kg", is_active: 1 as const, cost_per_unit: 0, ingredient_name: "" }
  const load = useCallback(() => call<Ingredient[]>(`${P}.inventory.ingredients`, { restaurant, active_only: 0 }).then(setRows).catch((e) => toast(errText(e), "bad")), [restaurant, toast])
  useEffect(() => { load() }, [load])
  const [q, setQ] = useState("")
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return rows.filter((r) => !t || r.ingredient_name.toLowerCase().includes(t) || (r.category ?? "").toLowerCase().includes(t))
  }, [rows, q])
  const { slice, pager } = usePaged(shown, "ingredients", `${q}|${restaurant}`)
  return (
    <div {...pageDrop.handlers} className="min-h-[60vh]">
      {(canEdit || rows.length > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {rows.length > 0 && <Input placeholder="Find an ingredient" value={q} onChange={(e) => setQ(e.target.value)} className="mr-auto max-w-xs" />}
          {canEdit && <>
          <Button variant="ghost" onClick={downloadIngredientTemplate}><Download className="size-4" />CSV template</Button>
          <Button variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" />Import CSV</Button>
          <Button onClick={() => setEdit(blank)}><Plus className="size-4" />Add ingredient</Button>
          </>}
        </div>
      )}
      {!rows.length && <Empty title="No ingredients yet" action={canEdit && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => setEdit(blank)}>Add the first ingredient</Button>
          <Button variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" />Import a list</Button>
          <Button variant="ghost" onClick={downloadIngredientTemplate}><Download className="size-4" />Download CSV template</Button>
        </div>)}>
        Add what your kitchen buys - chicken by the kg, beer by the bottle - or fill in the CSV template and import the whole list, with opening stock.</Empty>}
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
        {rows.length > 0 && !shown.length && <p className="px-4 py-6 text-center text-sm text-mute">No ingredients match.</p>}
        {slice.map((r) => (
          <button key={r.name} disabled={!canEdit} onClick={() => setEdit(r)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-paper">
            <span className="flex-1"><span className={cn("font-semibold", !r.is_active && "text-mute line-through")}>{r.ingredient_name}</span><span className="block text-xs text-mute">{r.category || "Uncategorised"}</span></span>
            <span className="num text-sm">{money(r.cost_per_unit)} / {r.uom}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 && <Pager {...pager} noun="ingredients" />}
      {edit && <IngredientModal ing={edit} restaurant={restaurant} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load() }} />}
      {importing && <IngredientImportModal restaurant={restaurant} existing={rows} initialFile={dropped}
        onClose={() => { setImporting(false); setDropped(null) }} onDone={() => { setImporting(false); setDropped(null); load() }} />}
      {!importing && pageDrop.over && <DropOverlay label="Drop to import ingredients" />}
    </div>
  )
}

function IngredientModal({ ing, restaurant, onClose, onSaved }: { ing: Partial<Ingredient>; restaurant: string; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(ing)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const save = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.inventory.save_ingredient`, { ...v, restaurant }); onSaved() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const del = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.inventory.delete_ingredient`, { name: v.name }); onSaved() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={v.name ? "Edit ingredient" : "Add ingredient"} onClose={onClose}
      footer={<>{v.name && <Button variant="ghost" className="mr-auto text-chili" busy={busy} onClick={del}>Delete</Button>}<Button busy={busy} onClick={save}>Save</Button></>}>
      <Field label="Name"><Input value={v.ingredient_name} onChange={(e) => setV({ ...v, ingredient_name: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Unit"><Select options={["kg", "g", "L", "ml", "pc", "bottle", "packet", "dozen"]} value={v.uom} onChange={(e) => setV({ ...v, uom: e.target.value })} /></Field>
        <Field label="Cost per unit"><Input inputMode="decimal" value={v.cost_per_unit} onChange={(e) => setV({ ...v, cost_per_unit: e.target.value as unknown as number })} /></Field>
      </div>
      <Field label="Category"><Input value={v.category ?? ""} onChange={(e) => setV({ ...v, category: e.target.value })} placeholder="Dairy, Veg, Bar…" /></Field>
      <Check label="Active" checked={!!v.is_active} onChange={(x) => setV({ ...v, is_active: x ? 1 : 0 })} />
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}
