import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { Printer } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { useVenue } from "../lib/venue"
import { Button, Empty, PageHead, useToast } from "../components/ui"

interface Target { outlet: string; outlet_name: string; qr_ordering: 0 | 1; tables: { table: string; seats: number | null; area: string | null }[] }

export const menuUrl = (outlet: string, table?: string) =>
  `${location.origin}/restaurant/menu/${encodeURIComponent(outlet)}${table ? `?table=${encodeURIComponent(table)}` : ""}`

function Qr({ url, size = 148 }: { url: string; size?: number }) {
  const [src, setSrc] = useState("")
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: size * 2, errorCorrectionLevel: "M" }).then(setSrc) }, [url, size])
  return src ? <img src={src} width={size} height={size} alt={`QR code for ${url}`} /> : <div style={{ width: size, height: size }} />
}

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string))

/** Print one table card on its own page, through a hidden iframe (popups get
 *  blocked on tills). The QR is redrawn large so it stays sharp on paper. */
async function printCard(title: string, sub: string, url: string) {
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 900, errorCorrectionLevel: "M" })
  document.querySelectorAll("iframe[data-pep-qr]").forEach((n) => n.remove())
  const f = document.createElement("iframe")
  f.setAttribute("data-pep-qr", "1")
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0"
  document.body.appendChild(f)
  const w = f.contentWindow
  if (!w) return
  w.document.open()
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><style>
    @page { size: A6 portrait; margin: 8mm }
    * { box-sizing: border-box; margin: 0 }
    html, body { height: 100%; background: #fff; color: #1d2733; font-family: Archivo, "Segoe UI", Arial, sans-serif }
    body { display: flex; align-items: center; justify-content: center }
    .card { width: 100%; max-width: 90mm; border: 2px solid #1d2733; border-radius: 6mm; padding: 6mm 5mm; text-align: center }
    h1 { font-size: 30pt; font-weight: 800; line-height: 1.05 }
    .sub { font-size: 9pt; margin: 1.5mm 0 4mm }
    img { width: 62mm; height: 62mm; display: block; margin: 0 auto }
    .cta { font-size: 11pt; font-weight: 700; margin-top: 4mm }
    .url { font-size: 6.5pt; color: #6b7686; margin-top: 2mm; word-break: break-all }
  </style></head><body><div class="card"><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div>
    <img src="${qr}" alt=""><div class="cta">Scan to see the menu and order</div>
    <div class="url">${esc(url.replace(/^https?:\/\//, ""))}</div></div></body></html>`)
  w.document.close()
  const go = () => { try { w.focus(); w.print() } catch { /* ignore */ } }
  const img = w.document.querySelector("img")
  if (img && !img.complete) img.onload = () => setTimeout(go, 50)
  else setTimeout(go, 150)
  setTimeout(() => f.remove(), 60_000)
}

export default function QrCodes() {
  const { restaurant } = useVenue()
  const toast = useToast()
  const [targets, setTargets] = useState<Target[]>([])
  const [only, setOnly] = useState<string>("")
  useEffect(() => {
    if (restaurant) call<Target[]>(`${P}.api.qr_targets`, { restaurant: restaurant.name }).then((t) => { setTargets(t); setOnly(t[0]?.outlet ?? "") }).catch((e) => toast(errText(e), "bad"))
  }, [restaurant, toast])
  const t = targets.find((x) => x.outlet === only)
  return (
    <>
      <div className="no-print">
        <PageHead title="Table QR codes" sub="Guests scan, browse the menu and order. Every QR order waits for a captain to confirm it. Hover a card (or tap its code) to print just that one."
          actions={<Button onClick={() => window.print()}><Printer className="size-4" />Print sheet</Button>} />
        <div className="mb-4 flex flex-wrap gap-1.5">
          {targets.map((x) => (
            <button key={x.outlet} onClick={() => setOnly(x.outlet)} className={"rounded-lg px-3 py-1.5 text-sm font-semibold " + (only === x.outlet ? "bg-ink text-paper" : "bg-card")}>{x.outlet_name}</button>
          ))}
        </div>
        {t && !t.qr_ordering && <p className="mb-3 rounded-lg bg-amber-soft px-3 py-2 text-sm text-amber-deep">Ordering is off for this outlet - guests can browse the menu but not order. Turn it on in Setup.</p>}
      </div>
      {!t ? <Empty title="No outlets yet" /> : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 print:grid-cols-3">
          <Card title={t.outlet_name} sub="Menu (no table)" url={menuUrl(t.outlet)} />
          {t.tables.map((tb) => <Card key={tb.table} title={tb.table} sub={[t.outlet_name, tb.area].filter(Boolean).join(" · ")} url={menuUrl(t.outlet, tb.table)} />)}
        </div>
      )}
    </>
  )
}

function Card({ title, sub, url }: { title: string; sub: string; url: string }) {
  const print = () => { void printCard(title, sub, url) }
  return (
    <div className="group relative flex break-inside-avoid flex-col items-center rounded-2xl border-2 border-[#1d2733] bg-white p-4 text-center text-[#1d2733]">
      <p className="wide text-3xl font-extrabold">{title}</p>
      <p className="mb-2 text-xs">{sub}</p>
      {/* tapping the code prints it too - touch screens have no hover */}
      <button type="button" onClick={print} aria-label={`Print the QR card for ${title}`} className="rounded-md">
        <Qr url={url} />
      </button>
      <p className="mt-2 text-sm font-semibold">Scan to see the menu and order</p>
      <a href={url} target="_blank" rel="noreferrer" className="no-print relative z-10 mt-1 break-all text-[10px] text-mute underline">{url.replace(/^https?:\/\//, "")}</a>
      <div className="no-print pointer-events-none absolute inset-0 flex items-center justify-center rounded-[14px] bg-[#1d2733]/45 opacity-0 backdrop-blur-[2px] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        <button type="button" onClick={print} tabIndex={-1}
          className="pointer-events-auto inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-base font-bold text-[#1d2733] shadow-xl hover:scale-[1.03]">
          <Printer className="size-5" />Print {title}
        </button>
      </div>
    </div>
  )
}
