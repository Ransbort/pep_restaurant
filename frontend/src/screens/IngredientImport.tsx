import { useEffect, useState } from "react"
import { Download, Upload } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { downloadText, readCsvFile, slug, toCsv } from "../lib/csv"
import { useVenue } from "../lib/venue"
import { cn } from "../lib/cn"
import { Button, Check, Field, Modal, Select, Textarea } from "../components/ui"
import { DropOverlay, useFileDrop } from "../components/FileDrop"
import type { Ingredient } from "./Recipes"

export const ING_COLUMNS: [string, string, string][] = [
  ["ingredient_name", "Required", "What the kitchen calls it. An ingredient with the same name is updated, not duplicated."],
  ["uom", "Optional", "kg, g, L, ml, pc, bottle, packet or dozen (kgs, litre, pcs… also work). Blank means kg."],
  ["category", "Optional", "Dairy, Meat, Veg, Dry, Bar…"],
  ["cost_per_unit", "Optional", "What one unit costs you, no currency sign: 380 or 12.50. Used for food cost %."],
  ["is_active", "Optional", "yes / no. Blank means yes."],
  ["opening_stock", "Optional", "How much is on the shelf at the outlet you pick, in the ingredient's unit. Only used the first time."],
  ["par_level", "Optional", "At or below this, the ingredient shows as Low at that outlet."],
]
const HEADER = ING_COLUMNS.map(([c]) => c)

export function downloadIngredientTemplate() {
  downloadText("pep-ingredients-template.csv", toCsv(HEADER, [
    ["Chicken", "kg", "Meat", 85, "yes", 12, 4],
    ["Rice", "kg", "Dry", 22, "yes", 25, 8],
    ["Palm Oil", "L", "Dry", 45, "yes", 6, 2],
    ["Ripe Plantain", "pc", "Veg", 4, "yes", 60, 20],
    ["Club Beer", "bottle", "Bar", 14, "yes", 48, 24],
  ]))
}

export function exportIngredients(restaurantName: string, rows: Ingredient[]) {
  downloadText(`${slug(restaurantName)}-ingredients.csv`, toCsv(HEADER, rows.map((r) => [
    r.ingredient_name, r.uom, r.category, r.cost_per_unit, r.is_active ? "yes" : "no", "", "",
  ])))
}

interface Result {
  created: number; updated: number; opening: number
  errors: { line: number; item: string; error: string }[]; notes: { line: number; item: string; note: string }[]
}

export function IngredientImportModal({ restaurant, existing, initialFile, onClose, onDone }: {
  restaurant: string; existing: Ingredient[]; initialFile?: File | null; onClose: () => void; onDone: () => void
}) {
  const { restaurant: venue, outlet: current } = useVenue()
  const outlets = venue?.outlets ?? []
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState("")
  const [outlet, setOutlet] = useState(current?.name ?? outlets[0]?.name ?? "")
  const [update, setUpdate] = useState(true)
  const [guide, setGuide] = useState(false)
  const [res, setRes] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const readFile = async (f?: File | null) => {
    if (!f) return
    setRes(null); setErr("")
    try { setText(await readCsvFile(f)); setFileName(f.name) } catch (e) { setErr(errText(e)) }
  }
  useEffect(() => { readFile(initialFile) }, [initialFile])
  const drop = useFileDrop(readFile, true)

  const header = (text.trim().split(/\r?\n/)[0] ?? "").toLowerCase()
  const hasStock = /opening_stock|par_level/.test(header)
  const lines = text.trim() ? text.trim().split(/\r?\n/).length - 1 : 0
  const outletName = outlets.find((o) => o.name === outlet)?.outlet_name ?? ""

  const go = async () => {
    setBusy(true); setErr("")
    try {
      setRes(await call<Result>(`${P}.inventory.import_ingredients`, {
        restaurant, csv_text: text, outlet: hasStock ? outlet : undefined, update_existing: update ? 1 : 0,
      }))
    } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }

  return (
    <div {...drop.handlers}>
      {drop.over && <DropOverlay label="Drop the CSV to load it" />}
      <Modal wide title="Import ingredients" onClose={onClose}
        footer={res ? <Button onClick={onDone}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy} disabled={!lines} onClick={go}>Import {lines ? `${lines} ingredient${lines === 1 ? "" : "s"}` : ""}</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line p-3">
            <p className="text-sm font-semibold">1. Get a spreadsheet</p>
            <p className="mt-0.5 text-xs text-mute">Fill one ingredient per row in Excel or Google Sheets, then save as CSV.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={downloadIngredientTemplate}><Download className="size-3.5" />Download template</Button>
              {existing.length > 0 && <Button size="sm" variant="ghost" onClick={() => exportIngredients(venue?.restaurant_name ?? "restaurant", existing)}>
                <Download className="size-3.5" />Current list ({existing.length})</Button>}
            </div>
          </div>
          <label className={cn("cursor-pointer rounded-xl border-2 border-dashed p-3 transition",
            drop.over ? "border-brand bg-brand-soft" : fileName ? "border-basil bg-basil-soft/50" : "border-line hover:border-ink-2")}>
            <p className="text-sm font-semibold">2. Upload it</p>
            <p className="mt-0.5 text-xs text-mute">{fileName ? <>Loaded <b className="text-ink">{fileName}</b> - drop another to replace it.</> : "Drag the CSV anywhere onto this box, choose it, or paste below."}</p>
            <span className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-2.5 text-xs font-semibold text-paper"><Upload className="size-3.5" />Choose file</span>
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => readFile(e.target.files?.[0])} />
          </label>
        </div>
        <Textarea className="min-h-40 font-mono text-xs" value={text} placeholder={HEADER.join(",")}
          onChange={(e) => { setText(e.target.value); setRes(null) }} aria-label="CSV contents" />
        {hasStock && (
          <Field label="Opening stock and par levels are for" hint="Stock is kept per outlet. Opening stock is only added where the outlet has no stock history yet.">
            <Select value={outlet} onChange={(e) => setOutlet(e.target.value)} options={outlets.map((o) => ({ value: o.name, label: o.outlet_name }))} />
          </Field>
        )}
        <Check label="Update ingredients that already exist (matched by name)" checked={update} onChange={setUpdate} />
        <div className="rounded-xl bg-paper">
          <button onClick={() => setGuide(!guide)} aria-expanded={guide} className="w-full px-3 py-2 text-left text-sm font-semibold">
            {guide ? "Hide" : "Show"} what each column means
          </button>
          {guide && (
            <table className="mx-3 mb-3 w-[calc(100%-1.5rem)] text-xs">
              <tbody className="divide-y divide-line">
                {ING_COLUMNS.map(([c, need, what]) => (
                  <tr key={c}><td className="py-1.5 pr-3 font-mono font-semibold">{c}</td><td className="pr-3 text-mute">{need}</td><td className="py-1.5">{what}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {res && (
          <div className="rounded-lg bg-paper p-3 text-sm">
            <p className="font-semibold">
              {res.created} added, {res.updated} updated{res.opening ? `, opening stock set for ${res.opening} at ${outletName}` : ""}
              {res.errors.length ? `, ${res.errors.length} skipped` : ""}.
            </p>
            {res.notes.map((n) => <p key={n.line} className="text-mute">Line {n.line} ({n.item}): {n.note}</p>)}
            {res.errors.map((e) => <p key={e.line} className="text-chili">Line {e.line} ({e.item}): {e.error}</p>)}
          </div>
        )}
        {err && <p className="text-sm text-chili">{err}</p>}
      </Modal>
    </div>
  )
}
