import { useCallback, useEffect, useMemo, useState } from "react"
import { CircleAlert, ExternalLink, RefreshCw, Wand2 } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { cn } from "../lib/cn"
import { Button, Check, Field, Input, Select, Tag, useToast } from "../components/ui"

const PEP_MODES = ["Cash", "Card", "UPI", "Wallet", "Other"]

interface Row { tax_label?: string; account?: string; pep_mode?: string; mode_of_payment?: string }
interface Settings {
  enabled?: number; posting_mode?: string; start_from?: string; company?: string; customer?: string; cost_center?: string
  item_mode?: string; sales_item?: string; item_group?: string; income_account?: string; service_charge_account?: string
  default_tax_account?: string; tax_accounts?: Row[]; payment_modes?: Row[]
}
interface Status {
  erpnext: boolean; settings: Settings | null; pending: number; tax_labels: string[]; currency: string
  failed: { name: string; paid_at: string; grand_total: number; erp_error: string }[]
  failed_shifts?: { name: string; closed_at: string; erp_error: string }[]
  recent: { invoice: string; bills: number; total: number; paid_at: string }[]
}
interface Options {
  erpnext: boolean; companies?: { name: string; default_currency: string }[]; company?: string
  income_accounts?: string[]; tax_accounts?: string[]; cost_centers?: string[]; modes_of_payment?: string[]
  customers?: string[]; items?: string[]
}

const opts = (list: string[] | undefined, blank = "Choose…") => [{ value: "", label: blank }, ...(list ?? []).map((v) => ({ value: v, label: v }))]

/** Settings → Accounting: map the restaurant to ERPNext and watch postings. */
export default function Accounting() {
  const { restaurant } = useVenue()
  const toast = useToast()
  const [st, setSt] = useState<Status | null>(null)
  const [op, setOp] = useState<Options | null>(null)
  const [v, setV] = useState<Settings>({})
  const [busy, setBusy] = useState("")
  const [err, setErr] = useState("")

  const load = useCallback(async () => {
    if (!restaurant) return
    const s = await call<Status>(`${P}.accounting.status`, { restaurant: restaurant.name })
    setSt(s)
    if (!s.erpnext) return
    setV(s.settings ?? { posting_mode: "Per shift", item_mode: "Single item", item_group: "Pep Restaurant" })
    setOp(await call<Options>(`${P}.accounting.options`, { company: s.settings?.company }))
  }, [restaurant])
  useEffect(() => { load().catch((e) => setErr(errText(e))) }, [load])

  const set = (k: keyof Settings, val: unknown) => setV((x) => ({ ...x, [k]: val }))
  const pickCompany = async (company: string) => {
    set("company", company)
    setOp(await call<Options>(`${P}.accounting.options`, { company }))
  }
  const taxRows = useMemo(() => (st?.tax_labels ?? []).map((lbl) => ({
    tax_label: lbl, account: v.tax_accounts?.find((r) => r.tax_label?.toLowerCase() === lbl.toLowerCase())?.account ?? "",
  })), [st, v.tax_accounts])
  const modeOf = (m: string) => v.payment_modes?.find((r) => r.pep_mode === m)?.mode_of_payment ?? ""
  const setTax = (label: string, account: string) =>
    set("tax_accounts", [...taxRows.filter((r) => r.tax_label !== label), { tax_label: label, account }])
  const setMode = (m: string, mop: string) =>
    set("payment_modes", [...(v.payment_modes ?? []).filter((r) => r.pep_mode !== m), ...(mop ? [{ pep_mode: m, mode_of_payment: mop }] : [])])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr("")
    try { await fn() } catch (e) { setErr(errText(e)) } finally { setBusy("") }
  }
  const save = () => run("save", async () => {
    await call(`${P}.accounting.save_settings`, { restaurant: restaurant!.name, values: { ...v, tax_accounts: taxRows } })
    toast(v.enabled ? "Accounting saved - sales will post to ERPNext" : "Accounting settings saved")
    await load()
  })
  const quick = () => run("quick", async () => {
    if (!v.company) throw new Error("Pick the company first.")
    const d = await call<Settings>(`${P}.accounting.quick_setup`, { restaurant: restaurant!.name, company: v.company })
    // suggestions fill only what's still empty - never overwrite a choice
    setV((x) => {
      const out: Settings = { ...x }
      for (const [k, val] of Object.entries(d) as [keyof Settings, unknown][]) {
        const cur = x[k]
        if (val && (!cur || (Array.isArray(cur) && !cur.length))) (out as Record<string, unknown>)[k] = val
      }
      return out
    })
    setOp(await call<Options>(`${P}.accounting.options`, { company: v.company }))
    toast("Suggested settings filled in - check them, then save")
  })
  const postNow = () => run("post", async () => {
    const r = await call<{ posted: string[]; failed: number }>(`${P}.accounting.retry`, { restaurant: restaurant!.name })
    toast(r.posted.length ? `Posted ${r.posted.length} invoice${r.posted.length === 1 ? "" : "s"}` : r.failed ? "Nothing posted - see the errors below" : "Nothing waiting to post")
    await load()
  })

  if (!restaurant || !st) return null
  if (!st.erpnext) {
    return (
      <section className="rounded-2xl border border-line bg-card p-5">
        <h2 className="text-base font-bold">Accounting</h2>
        <p className="mt-1 text-sm text-mute">ERPNext isn't installed on this site, so sales stay in Pep Restaurant only (bills, payments and cash shifts are all in Desk under Pep Order, Pep Cashier Transaction and Pep Cashier Session). Install ERPNext on this site to post sales to your books.</p>
      </section>
    )
  }
  const failedCount = st.failed.length + (st.failed_shifts?.length ?? 0)
  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-bold">Accounting (ERPNext)</h2>
          <p className="text-sm text-mute">Post {restaurant.restaurant_name}'s paid bills to ERPNext as Sales Invoices, with the tenders as payments.</p>
        </div>
        <div className="flex items-center gap-2">
          {st.settings?.enabled ? <Tag tone="go">Posting on</Tag> : <Tag>Off</Tag>}
          {st.pending > 0 && <Tag tone="warn">{st.pending} waiting</Tag>}
          {failedCount > 0 && <Tag tone="bad">{failedCount} failed</Tag>}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <Check label="Post sales to ERPNext" checked={!!v.enabled} onChange={(x) => set("enabled", x ? 1 : 0)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="When to post">
            <div className="flex gap-1 rounded-lg bg-line/60 p-1">
              {[["Per shift", "One invoice per shift"], ["Per bill", "One invoice per bill"]].map(([id, label]) => (
                <button key={id} onClick={() => set("posting_mode", id)} className={cn("flex-1 rounded-md px-3 py-1.5 text-sm font-semibold", v.posting_mode === id && "bg-card shadow-sm")}>{label}</button>
              ))}
            </div>
          </Field>
          <Field label="Post bills paid from" hint="Earlier bills are never posted.">
            <Input type="date" value={v.start_from ?? ""} onChange={(e) => set("start_from", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Company">
            <Select value={v.company ?? ""} onChange={(e) => pickCompany(e.target.value)}
              options={opts(op?.companies?.map((c) => c.name))} />
          </Field>
          <Button variant="outline" busy={busy === "quick"} onClick={quick}><Wand2 className="size-4" />Fill in suggested settings</Button>
        </div>
        {op?.companies?.find((c) => c.name === v.company && c.default_currency !== st.currency) && (
          <p className="flex items-center gap-1.5 text-sm font-medium text-chili"><CircleAlert className="size-4" />This company keeps its books in {op.companies.find((c) => c.name === v.company)?.default_currency}, but the restaurant bills in {st.currency}.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Walk-in customer" hint="Every restaurant sale is invoiced to this customer.">
            <Select value={v.customer ?? ""} onChange={(e) => set("customer", e.target.value)} options={opts(op?.customers)} />
          </Field>
          <Field label="Cost center"><Select value={v.cost_center ?? ""} onChange={(e) => set("cost_center", e.target.value)} options={opts(op?.cost_centers)} /></Field>
          <Field label="Food & beverage income account"><Select value={v.income_account ?? ""} onChange={(e) => set("income_account", e.target.value)} options={opts(op?.income_accounts)} /></Field>
          <Field label="Service charge account" hint="Blank books service charge to the income account.">
            <Select value={v.service_charge_account ?? ""} onChange={(e) => set("service_charge_account", e.target.value)} options={opts([...(op?.income_accounts ?? []), ...(op?.tax_accounts ?? [])], "Same as income")} />
          </Field>
        </div>

        <div className="rounded-xl bg-paper p-3">
          <p className="text-sm font-semibold">What is sold</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <Field label="Items on the invoice">
              <Select value={v.item_mode ?? "Single item"} onChange={(e) => set("item_mode", e.target.value)} options={[
                { value: "Single item", label: "One sales item for everything" },
                { value: "One item per dish", label: "Each dish as its own item" }]} />
            </Field>
            {v.item_mode === "One item per dish"
              ? <Field label="Item group" hint="Dish items (non-stock, code PEP-MI-…) are created on first sale."><Input value={v.item_group ?? ""} onChange={(e) => set("item_group", e.target.value)} /></Field>
              : <Field label="Sales item" hint="A non-stock Item."><Select value={v.sales_item ?? ""} onChange={(e) => set("sales_item", e.target.value)} options={opts(op?.items)} /></Field>}
          </div>
        </div>

        <div className="rounded-xl bg-paper p-3">
          <p className="text-sm font-semibold">Tax</p>
          <p className="text-xs text-mute">Each tax line on your bills ({st.tax_labels.join(", ")}) posts to its own account, for the exact amount the till charged.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {taxRows.map((r) => (
              <Field key={r.tax_label} label={`${r.tax_label} account`}>
                <Select value={r.account} onChange={(e) => setTax(r.tax_label!, e.target.value)} options={opts(op?.tax_accounts)} />
              </Field>
            ))}
            <Field label="Any other tax line"><Select value={v.default_tax_account ?? ""} onChange={(e) => set("default_tax_account", e.target.value)} options={opts(op?.tax_accounts, "None")} /></Field>
          </div>
        </div>

        <div className="rounded-xl bg-paper p-3">
          <p className="text-sm font-semibold">Payments</p>
          <p className="text-xs text-mute">Which ERPNext Mode of Payment each tender becomes. The Mode of Payment's account for this company receives the money.</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            {PEP_MODES.map((m) => (
              <Field key={m} label={m}>
                <Select value={modeOf(m)} onChange={(e) => setMode(m, e.target.value)} options={opts(op?.modes_of_payment, "Not used")} />
              </Field>
            ))}
          </div>
        </div>

        {err && <p className="text-sm font-medium text-chili">{err}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {!!st.settings?.enabled && <Button variant="outline" busy={busy === "post"} onClick={postNow}><RefreshCw className="size-4" />Post waiting bills now</Button>}
          <Button busy={busy === "save"} onClick={save}>Save accounting</Button>
        </div>

        {(failedCount > 0 || st.recent.length > 0) && (
          <div className="grid gap-4 border-t border-line pt-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-bold">Didn't post</h3>
              {!failedCount && <p className="text-sm text-mute">Nothing failed.</p>}
              <div className="space-y-2">
                {st.failed_shifts?.map((f) => (
                  <div key={f.name} className="rounded-lg bg-chili-soft p-2 text-sm"><b>Shift {f.closed_at?.slice(0, 16)}</b><p className="text-chili">{f.erp_error}</p></div>
                ))}
                {st.failed.map((f) => (
                  <div key={f.name} className="rounded-lg bg-chili-soft p-2 text-sm"><b>{f.name}</b> · {money(f.grand_total)}<p className="text-chili">{f.erp_error}</p></div>
                ))}
              </div>
              {failedCount > 0 && <p className="mt-2 text-xs text-mute">Fix the setting it names, save, then click Post waiting bills now.</p>}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-bold">Recent invoices</h3>
              <div className="divide-y divide-line rounded-lg border border-line text-sm">
                {st.recent.map((r) => (
                  <a key={r.invoice} href={`/app/sales-invoice/${encodeURIComponent(r.invoice)}`} target="_blank" rel="noreferrer"
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-paper">
                    <span className="font-semibold">{r.invoice} <ExternalLink className="inline size-3" /></span>
                    <span className="text-mute">{r.bills} bill{r.bills === 1 ? "" : "s"} · <span className="num font-semibold text-ink">{money(r.total)}</span></span>
                  </a>
                ))}
                {!st.recent.length && <p className="px-3 py-2 text-mute">Nothing posted yet.</p>}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
