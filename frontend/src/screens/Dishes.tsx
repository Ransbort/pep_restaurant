import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, Plus, Upload } from "lucide-react"
import { downloadText, readCsvFile, slug, toCsv } from "../lib/csv"
import { DropOverlay, useFileDrop } from "../components/FileDrop"
import { Pager, savePageSize, savedPageSize } from "../components/Pager"
import { call, errText, P, uploadImage } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { R, useAuth } from "../lib/auth"
import { cn } from "../lib/cn"
import { Button, Check, Empty, Field, Input, Modal, PageHead, Select, Tag, Textarea, useToast } from "../components/ui"

interface Dish {
  name: string; item_name: string; category?: string; price: number; course: string; prep_station: string
  is_veg: 0 | 1; is_alcohol: 0 | 1; available: 0 | 1; allergens?: string; description?: string; image?: string; image_credit?: string; sort_order: number
}
const BLANK: Partial<Dish> = { item_name: "", price: 0, course: "Main", prep_station: "", is_veg: 0, is_alcohol: 0, available: 1, sort_order: 0 }

export default function Dishes() {
  const { outlet, restaurant } = useVenue()
  const stations = restaurant?.prep_stations ?? ["Kitchen"]
  const { has } = useAuth()
  const toast = useToast()
  const [rows, setRows] = useState<Dish[]>([])
  const [edit, setEdit] = useState<Partial<Dish> | null>(null)
  const [importing, setImporting] = useState(false)
  const [dropped, setDropped] = useState<File | null>(null)
  const pageDrop = useFileDrop((f) => { setDropped(f); setImporting(true) }, canEditOf(has))
  const [q, setQ] = useState("")
  const [catFilter, setCatFilter] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(() => savedPageSize("dishes"))
  const canEdit = has(R.manager)

  const load = useCallback(() => {
    if (outlet) call<Dish[]>(`${P}.menu.menu_items`, { outlet: outlet.name }).then(setRows).catch((e) => toast(errText(e), "bad"))
  }, [outlet, toast])
  useEffect(load, [load])

  // filter, then page through the list in menu order; headings are rebuilt
  // for whatever falls on the current page
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    return rows.filter((r) => (!catFilter || (r.category || "Other") === catFilter)
      && (!term || r.item_name.toLowerCase().includes(term) || (r.allergens ?? "").toLowerCase().includes(term)))
  }, [rows, q, catFilter])
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  useEffect(() => { setPage(1) }, [q, catFilter, outlet?.name, pageSize])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  const groups = useMemo(() => {
    const g: Record<string, Dish[]> = {}
    filtered.slice((page - 1) * pageSize, page * pageSize).forEach((r) => (g[r.category || "Other"] ??= []).push(r))
    return Object.entries(g)
  }, [filtered, page, pageSize])
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
    <div {...pageDrop.handlers} className="min-h-[75vh]">
      <PageHead title="Menu" sub={`${outlet.outlet_name} · ${rows.length} dishes · ${rows.filter((r) => !r.available).length} off today`}
        actions={canEdit && <>
          <Button variant="ghost" onClick={() => downloadTemplate(stations)}><Download className="size-4" />CSV template</Button>
          <Button variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" />Import CSV</Button>
          <Button onClick={() => setEdit({ ...BLANK })}><Plus className="size-4" />Add dish</Button>
        </>} />
      {rows.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Input placeholder="Find a dish" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <Select className="w-auto min-w-44" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
            options={[{ value: "", label: `All categories (${rows.length})` },
              ...[...new Set(rows.map((r) => r.category || "Other"))].map((c) => ({ value: c, label: `${c} (${rows.filter((r) => (r.category || "Other") === c).length})` }))]} />
        </div>
      )}
      {rows.length > 0 && !filtered.length && <Empty title="No dishes match">Try another search or category.</Empty>}
      {!rows.length && <Empty title="This menu is empty" action={canEdit && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => setEdit({ ...BLANK })}>Add the first dish</Button>
          <Button variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" />Import a menu</Button>
          <Button variant="ghost" onClick={() => downloadTemplate(stations)}><Download className="size-4" />Download CSV template</Button>
        </div>)}>
        Add dishes one by one, or fill in the CSV template in Excel or Google Sheets and import the whole menu.</Empty>}
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
      {filtered.length > 0 && (
        <Pager page={page} pageSize={pageSize} total={filtered.length} noun="dishes" onPage={(p) => { setPage(p); document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" }) }}
          onPageSize={(n) => { setPageSize(n); savePageSize("dishes", n) }} />
      )}
      {edit && <DishModal dish={edit} outlet={outlet.name} categories={categories} stations={stations} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load() }} />}
      {importing && <ImportModal outlet={outlet.name} outletName={outlet.outlet_name} stations={stations} dishes={rows} initialFile={dropped}
        onClose={() => { setImporting(false); setDropped(null) }} onDone={() => { setImporting(false); setDropped(null); load() }} />}
      {!importing && pageDrop.over && <DropOverlay label={`Drop to import into ${outlet.outlet_name}`} />}
    </div>
  )
}

function DishModal({ dish, outlet, categories, stations, onClose, onSaved }: { dish: Partial<Dish>; outlet: string; categories: string[]; stations: string[]; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Partial<Dish>>({ ...dish, prep_station: dish.prep_station || stations[0] })
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
        <Field label="Station" hint="Where it's cooked. Each station's kitchen screen shows only its own dishes; set stations up in Setup."><Select options={stations.includes(d.prep_station ?? "") || !d.prep_station ? stations : [...stations, d.prep_station!]} value={d.prep_station} onChange={(e) => set("prep_station", e.target.value)} /></Field>
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
        {d.image && (
          <Field label="Photo credit" hint="Shown small under the photo on the guest menu. Free-licence photos (CC BY, CC BY-SA) must credit the photographer.">
            <Input value={d.image_credit ?? ""} onChange={(e) => set("image_credit", e.target.value)} placeholder="Photo: Jane Doe, CC BY-SA 4.0" />
          </Field>
        )}
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

const COLUMNS: [string, string, string][] = [
  ["item_name", "Required", "The dish's name. A dish with the same name at this outlet is updated, not duplicated."],
  ["price", "Required", "A number, no currency sign: 160 or 160.50."],
  ["category", "Optional", "How the menu is grouped: Starters, Mains, Drinks…"],
  ["course", "Optional", "Starter, Main, Dessert or Drink. Blank means Main."],
  ["prep_station", "Optional", "Where it's cooked - one of your kitchen stations. Blank means the first one."],
  ["is_veg", "Optional", "yes / no"],
  ["is_alcohol", "Optional", "yes / no"],
  ["available", "Optional", "yes / no - no adds it already off the menu."],
  ["allergens", "Optional", "Comma separated inside quotes: \"Nuts, Dairy\""],
  ["description", "Optional", "Shown on the guest QR menu."],
  ["image", "Optional", "A link to the dish's photo (https://…jpg/png/webp, up to 5 MB). The import downloads it and attaches it to the dish."],
  ["image_credit", "Optional", "Who took the photo and its licence - shown under it on the guest menu."],
  ["sort_order", "Optional", "Lower numbers show first in their category."],
]
const HEADER = COLUMNS.map(([c]) => c)
const yn = (v: unknown) => (Number(v) ? "yes" : "no")

/** A CSV with every column and example rows that use this restaurant's own stations. */
function downloadTemplate(stations: string[]) {
  const st = (i: number) => stations[Math.min(i, stations.length - 1)] ?? "Kitchen"
  downloadText("pep-menu-template.csv", toCsv(HEADER, [
    ["Masala Dosa", 160, "Breakfast", "Main", st(0), "yes", "no", "yes", "Gluten", "Crisp rice crepe, potato masala, chutneys", "", "", 1],
    ["Chicken Wings", 320, "Starters", "Starter", stations.find((s) => /fry/i.test(s)) ?? st(1), "no", "no", "yes", "", "", "", "", 2],
    ["Chocolate Brownie", 180, "Desserts", "Dessert", stations.find((s) => /cold|pastry/i.test(s)) ?? st(0), "yes", "no", "yes", "Nuts, Dairy, Gluten", "Warm, with ice cream", "", "", 3],
    ["Fresh Lime Soda", 110, "Drinks", "Drink", stations.find((s) => /bar/i.test(s)) ?? st(0), "yes", "no", "yes", "", "", "", "", 4],
  ]))
}

function ImportModal({ outlet, outletName, stations, dishes, initialFile, onClose, onDone }: {
  outlet: string; outletName: string; stations: string[]; dishes: Dish[]; initialFile?: File | null; onClose: () => void; onDone: () => void
}) {
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState("")
  const [update, setUpdate] = useState(true)
  const [guide, setGuide] = useState(false)
  const [res, setRes] = useState<{ created: number; updated: number; photos?: number; notes?: { line: number; item: string; note: string }[]; errors: { line: number; item: string; error: string }[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const template = () => downloadTemplate(stations)
  const exportMenu = () => downloadText(`${slug(outletName)}-menu.csv`, toCsv(HEADER, dishes.map((d) => [
    d.item_name, d.price, d.category, d.course, d.prep_station, yn(d.is_veg), yn(d.is_alcohol), yn(d.available),
    d.allergens, d.description, d.image && !d.image.startsWith("http") ? location.origin + d.image : d.image, d.image_credit, d.sort_order,
  ])))
  const readFile = async (f?: File | null) => {
    if (!f) return
    setRes(null); setErr("")
    try { setText(await readCsvFile(f)); setFileName(f.name) } catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { readFile(initialFile) }, [initialFile]) // a file dropped on the Menu page
  const drop = useFileDrop(readFile, true)
  const go = async () => {
    setBusy(true); setErr("")
    try { setRes(await call(`${P}.menu.import_csv`, { outlet, csv_text: text, update_existing: update ? 1 : 0 })) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  const lines = text.trim() ? text.trim().split(/\r?\n/).length - 1 : 0
  return (
    <div {...drop.handlers}>
    {drop.over && <DropOverlay label="Drop the CSV to load it" />}
    <Modal wide title={`Import a menu into ${outletName}`} onClose={onClose}
      footer={res ? <Button onClick={onDone}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button busy={busy} disabled={!lines} onClick={go}>Import {lines ? `${lines} dish${lines === 1 ? "" : "es"}` : ""}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line p-3">
          <p className="text-sm font-semibold">1. Get a spreadsheet</p>
          <p className="mt-0.5 text-xs text-mute">Open it in Excel or Google Sheets, fill one dish per row, save as CSV.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={template}><Download className="size-3.5" />Download template</Button>
            {dishes.length > 0 && <Button size="sm" variant="ghost" onClick={exportMenu}><Download className="size-3.5" />Current menu ({dishes.length})</Button>}
          </div>
        </div>
        <label className={cn("cursor-pointer rounded-xl border-2 border-dashed p-3 transition",
          drop.over ? "border-brand bg-brand-soft" : fileName ? "border-basil bg-basil-soft/50" : "border-line hover:border-ink-2")}>
          <p className="text-sm font-semibold">2. Upload it</p>
          <p className="mt-0.5 text-xs text-mute">{fileName ? <>Loaded <b className="text-ink">{fileName}</b> - drop another to replace it.</> : "Drag the CSV file anywhere onto this box, choose it, or paste below."}</p>
          <span className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-xs font-semibold text-paper"><Upload className="size-3.5" />Choose file</span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
        </label>
      </div>
      <Textarea className="min-h-40 font-mono text-xs" value={text} placeholder={HEADER.join(",")}
        onChange={(e) => { setText(e.target.value); setRes(null) }} aria-label="CSV contents" />
      <Check label="Update dishes that already exist (matched by name)" checked={update} onChange={setUpdate} />
      <div className="rounded-xl bg-paper">
        <button onClick={() => setGuide(!guide)} aria-expanded={guide} className="w-full px-3 py-2 text-left text-sm font-semibold">
          {guide ? "Hide" : "Show"} what each column means
        </button>
        {guide && (
          <div className="px-3 pb-3">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-line">
                {COLUMNS.map(([c, need, what]) => (
                  <tr key={c}><td className="py-1.5 pr-3 font-mono font-semibold">{c}</td><td className="pr-3 text-mute">{need}</td><td className="py-1.5">{what}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-mute">Your stations: {stations.join(", ")}. Change them in Setup.</p>
          </div>
        )}
      </div>
      {res && (
        <div className="rounded-lg bg-paper p-3 text-sm">
          <p className="font-semibold">{res.created} added, {res.updated} updated{res.photos ? `, ${res.photos} photo${res.photos === 1 ? "" : "s"} attached` : ""}{res.errors.length ? `, ${res.errors.length} skipped` : ""}.</p>
          {res.notes?.map((n) => <p key={n.line} className="text-mute">Line {n.line} ({n.item}): {n.note}</p>)}
          {res.errors.map((e) => <p key={e.line} className="text-chili">Line {e.line} ({e.item}): {e.error}</p>)}
        </div>
      )}
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
    </div>
  )
}

const canEditOf = (has: (...r: string[]) => boolean) => has(R.manager)

