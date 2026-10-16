/** 80mm thermal printing for KOT tickets and bills, via a hidden iframe
 *  (popups get blocked on a till; an iframe does not). Works with any
 *  OS-installed thermal driver, 80mm or 58mm. */
import { money } from "./venue"

const CSS = `
  @page { size: 80mm auto; margin: 0 }
  * { margin: 0; padding: 0; box-sizing: border-box }
  body { width: 72mm; margin: 0 auto; padding: 3mm 1mm 14mm; font: 13px/1.35 "Courier New", monospace; color: #000 }
  .c { text-align: center } .b { font-weight: 700 } .xl { font-size: 22px } .lg { font-size: 15px } .sm { font-size: 11px }
  .rule { border-top: 2px dashed #000; margin: 6px 0 }
  .row { display: flex; justify-content: space-between; gap: 8px }
  table { width: 100%; border-collapse: collapse } td { padding: 2px 0; vertical-align: top }
  .r { text-align: right; white-space: nowrap } .q { width: 26px; font-weight: 700 }
  .ins { font-size: 12px; font-weight: 700; padding-left: 26px }
`
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string))
const amt = (n: unknown) => money(n, { bare: true })
const when = (d?: string) => (d ? new Date(d.replace(" ", "T")) : new Date())
  .toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })

export function printHtml(title: string, body: string) {
  document.querySelectorAll("iframe[data-pep-print]").forEach((n) => n.remove())
  const f = document.createElement("iframe")
  f.setAttribute("data-pep-print", "1")
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0"
  document.body.appendChild(f)
  const w = f.contentWindow
  if (!w) return
  w.document.open()
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`)
  w.document.close()
  setTimeout(() => { try { w.focus(); w.print() } catch { /* ignore */ } }, 200)
  setTimeout(() => f.remove(), 60_000)
}

export interface KotTicket {
  kot_no: number | null; round?: number; label: string; order: string; order_type?: string | null
  customer?: string | null; address?: string | null; allergy_note?: string | null; nc?: boolean; nc_by?: string | null
  course?: string | null; at?: string
  items: { item_name: string; qty: number; instructions?: string | null; station?: string | null }[]
}

export function printKot(outletName: string, t: KotTicket, reprint = false) {
  const rows = t.items.map((it) =>
    `<tr><td class="q">${Math.round(it.qty)}×</td><td class="b">${esc(it.item_name)}${it.station ? ` <span class="sm">[${esc(it.station)}]</span>` : ""}</td></tr>` +
    (it.instructions ? `<tr><td></td><td class="ins">» ${esc(it.instructions)}</td></tr>` : "")).join("")
  printHtml(`KOT ${t.kot_no}`, `
    <div class="c b lg">${esc(outletName)}</div>
    <div class="c xl b">KOT #${t.kot_no ?? "-"}${t.round && t.round > 1 ? ` · R${t.round}` : ""}${reprint ? " (REPRINT)" : ""}</div>
    ${t.course ? `<div class="c b">${esc(t.course).toUpperCase()} COURSE</div>` : ""}
    ${t.nc ? `<div class="c b lg">*** NC - NO CHARGE ***</div>${t.nc_by ? `<div class="c sm">auth: ${esc(t.nc_by)}</div>` : ""}` : ""}
    <div class="rule"></div>
    <div class="row"><span class="b lg">${esc(t.label)}</span><span class="sm">${esc(t.order_type || "")}</span></div>
    <div class="row sm"><span>${esc(t.order)}</span><span>${when(t.at)}</span></div>
    ${t.customer ? `<div class="sm">For: ${esc(t.customer)}</div>` : ""}
    ${t.address ? `<div class="sm">To: ${esc(t.address)}</div>` : ""}
    ${t.allergy_note ? `<div class="b">!! ALLERGY: ${esc(t.allergy_note)}</div>` : ""}
    <div class="rule"></div><table>${rows}</table><div class="rule"></div>
    <div class="c sm">${t.items.length} line${t.items.length === 1 ? "" : "s"}</div>`)
}

export interface BillData {
  order: string; kot_no: number | null; restaurant_name: string; address?: string; phone?: string; tax_id?: string
  footer?: string; outlet_name: string; label: string; order_type: string; guests?: number; captain?: string; created: string
  customer_name?: string; customer_phone?: string; delivery_address?: string
  items: { item_name: string; qty: number; rate: number; amount: number }[]
  subtotal: number; discount_amount: number; discount_reason?: string; service_charge_rate: number; service_charge: number
  taxable: number; tax_label: string; tax_rate: number; prices_include_tax: 0 | 1
  tax_parts: { label: string; rate: number; amount: number }[]; tax_amount: number; grand_total: number
  paid: 0 | 1; payment_mode?: string; tenders: { mode: string; amount: number }[]
  nc: 0 | 1; nc_authorized_by?: string; nc_note?: string
}

export function printBill(b: BillData) {
  const rows = b.items.map((it) =>
    `<tr><td>${esc(it.item_name)}<div class="sm">${Math.round(it.qty * 100) / 100} × ${amt(it.rate)}</div></td><td class="r">${amt(it.amount)}</td></tr>`).join("")
  const line = (l: string, v: unknown, cls = "") => `<div class="row ${cls}"><span>${l}</span><span>${amt(v)}</span></div>`
  printHtml(`Bill ${b.order}`, `
    <div class="c b lg">${esc(b.restaurant_name)}</div>
    ${b.address ? `<div class="c sm">${esc(b.address)}</div>` : ""}
    ${b.phone ? `<div class="c sm">${esc(b.phone)}</div>` : ""}
    ${b.tax_id ? `<div class="c sm">${esc(b.tax_label)} No: ${esc(b.tax_id)}</div>` : ""}
    <div class="c b" style="margin-top:4px">${b.paid ? "TAX INVOICE" : "BILL"}${b.nc ? " · NC" : ""}</div>
    <div class="rule"></div>
    <div class="row sm"><span>${esc(b.order)}</span><span>${when(b.created)}</span></div>
    <div class="row sm"><span>${esc(b.outlet_name)} · ${esc(b.label)}</span><span>${b.guests ? `${b.guests} pax` : ""}</span></div>
    ${b.customer_name ? `<div class="sm">${esc(b.customer_name)} ${esc(b.customer_phone || "")}</div>` : ""}
    <div class="rule"></div><table>${rows}</table><div class="rule"></div>
    ${line("Subtotal", b.subtotal)}
    ${b.discount_amount ? line(`Discount${b.discount_reason ? ` (${esc(b.discount_reason)})` : ""}`, -b.discount_amount) : ""}
    ${b.service_charge ? line(`Service charge ${b.service_charge_rate}%`, b.service_charge) : ""}
    ${b.prices_include_tax ? `<div class="sm">Prices include ${esc(b.tax_label)}:</div>` : ""}
    ${b.tax_parts.map((p) => line(`${esc(p.label)} ${p.rate}%`, p.amount, b.prices_include_tax ? "sm" : "")).join("")}
    <div class="rule"></div>
    <div class="row b xl"><span>TOTAL</span><span>${money(b.grand_total)}</span></div>
    ${b.paid ? `<div class="rule"></div>${b.tenders.map((t) => line(`Paid · ${esc(t.mode)}`, t.amount, "sm")).join("")}` : ""}
    ${b.nc ? `<div class="c sm">Complimentary · auth ${esc(b.nc_authorized_by || "")}</div>` : ""}
    <div class="rule"></div>
    <div class="c sm">${esc(b.footer || "Thank you!")}</div>`)
}
