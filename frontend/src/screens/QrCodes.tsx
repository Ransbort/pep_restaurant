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
        <PageHead title="Table QR codes" sub="Guests scan, browse the menu and order. Every QR order waits for a captain to confirm it."
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
  return (
    <div className="flex break-inside-avoid flex-col items-center rounded-2xl border-2 border-ink bg-white p-4 text-center text-[#1d2733]">
      <p className="wide text-3xl font-extrabold">{title}</p>
      <p className="mb-2 text-xs">{sub}</p>
      <Qr url={url} />
      <p className="mt-2 text-sm font-semibold">Scan to see the menu and order</p>
      <a href={url} target="_blank" rel="noreferrer" className="no-print mt-1 break-all text-[10px] text-mute underline">{url.replace(/^https?:\/\//, "")}</a>
    </div>
  )
}
