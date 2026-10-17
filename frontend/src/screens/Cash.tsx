import { useCallback, useEffect, useState } from "react"
import { call, errText, P } from "../lib/api"
import { money, useVenue } from "../lib/venue"
import { usePinned } from "../components/PinGate"
import { cn } from "../lib/cn"
import { Button, Field, Input, Modal, PageHead, Tag, Textarea, useToast } from "../components/ui"

interface Txn { name: string; kind: string; mode: string; amount: number; order?: string; reference?: string; posted_at: string }
interface Session {
  name: string; status: string; opened_at: string; closed_at?: string; opening_float: number; system_cash: number; system_card: number
  system_upi: number; system_other: number; paid_outs: number; drops: number; expected_cash: number; counted_cash?: number; variance?: number
  user?: string; transactions?: Txn[]
}

export default function Cash() {
  const { restaurant } = useVenue()
  const toast = useToast()
  const pinned = usePinned()
  const [sess, setSess] = useState<Session | null | undefined>(undefined)
  const [past, setPast] = useState<Session[]>([])
  const [float, setFloat] = useState("")
  const [modal, setModal] = useState<null | "out" | "drop" | "close">(null)
  const [view, setView] = useState<Session | null>(null)

  const load = useCallback(async () => {
    if (!restaurant) return
    setSess(await call<Session | null>(`${P}.cashier.current_session`, { restaurant: restaurant.name }))
    setPast(await call<Session[]>(`${P}.cashier.list_sessions`, { restaurant: restaurant.name }))
  }, [restaurant])
  useEffect(() => { load().catch((e) => toast(errText(e), "bad")) }, [load, toast])

  if (!restaurant || sess === undefined) return null
  const open = async () => {
    try { setSess(await call<Session>(`${P}.cashier.open_session`, { restaurant: restaurant.name, opening_float: Number(float) || 0 })); toast("Shift open"); load() }
    catch (e) { toast(errText(e), "bad") }
  }

  return (
    <>
      <PageHead title="Cash" sub={sess ? `Shift open since ${sess.opened_at.slice(11, 16)}` : "No shift open"} />
      {!sess ? (
        <div className="max-w-md rounded-2xl border border-line bg-card p-5">
          <h2 className="wide text-lg font-extrabold">Open your shift</h2>
          <p className="mt-1 text-sm text-mute">Count the cash in the drawer before the first bill. Every payment you take lands in this shift.</p>
          <Field label="Opening float" className="mt-4"><Input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="0" /></Field>
          <Button className="mt-4 w-full" size="lg" onClick={open}>Open shift</Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Cash in drawer (expected)" value={sess.expected_cash} big />
            <Stat label="Card" value={sess.system_card} />
            <Stat label="UPI" value={sess.system_upi} />
            <Stat label="Wallet / other" value={sess.system_other} />
          </div>
          <div className="mt-3 rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink-2">
            Float {money(sess.opening_float)} + cash taken {money(sess.system_cash)} − paid out {money(sess.paid_outs)} − dropped {money(sess.drops)} = <b className="text-ink">{money(sess.expected_cash)}</b>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setModal("out")}>Paid out</Button>
            <Button variant="outline" onClick={() => setModal("drop")}>Safe drop</Button>
            <Button variant="ink" onClick={() => setModal("close")}>Close shift</Button>
          </div>
          <Txns rows={sess.transactions ?? []} />
        </>
      )}

      <h2 className="mb-2 mt-8 text-sm font-bold">Past shifts</h2>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card text-sm">
        {past.filter((p) => p.status === "Closed").map((p) => (
          <button key={p.name} onClick={async () => setView(await call<Session>(`${P}.cashier.session_report`, { session: p.name }))} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-paper">
            <span className="flex-1"><span className="font-semibold">{p.opened_at.slice(0, 16)}</span><span className="block text-xs text-mute">{p.user}</span></span>
            <span className="num">{money(p.system_cash + p.system_card + p.system_upi + p.system_other)}</span>
            <Tag tone={Math.abs(p.variance ?? 0) < 0.01 ? "go" : "bad"}>{Math.abs(p.variance ?? 0) < 0.01 ? "Balanced" : `${(p.variance ?? 0) > 0 ? "+" : ""}${money(p.variance)}`}</Tag>
          </button>
        ))}
        {!past.some((p) => p.status === "Closed") && <p className="px-4 py-3 text-mute">No closed shifts yet.</p>}
      </div>

      {(modal === "out" || modal === "drop") && sess && (
        <DrawerModal kind={modal} onClose={() => setModal(null)} onSubmit={async (amount, reason) => {
          await pinned((pin) => call(`${P}.cashier.${modal === "out" ? "paid_out" : "cash_drop"}`, { restaurant: restaurant.name, amount, pin, ...(modal === "out" ? { reason } : { note: reason }) }))
          setModal(null); load()
        }} />
      )}
      {modal === "close" && sess && <CloseModal sess={sess} onClose={() => setModal(null)} onSubmit={async (counted, notes) => {
        const r = await pinned((pin) => call<Session>(`${P}.cashier.close_session`, { session: sess.name, counted_cash: counted, notes, pin }))
        setModal(null); setView(r); load()
      }} />}
      {view && (
        <Modal wide title={`Shift report · ${view.opened_at.slice(0, 16)}`} onClose={() => setView(null)} footer={<Button onClick={() => window.print()}>Print</Button>}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Expected cash" value={view.expected_cash} />
            <Stat label="Counted" value={view.counted_cash ?? 0} />
            <Stat label="Variance" value={view.variance ?? 0} tone={Math.abs(view.variance ?? 0) < 0.01 ? "go" : "bad"} />
            <Stat label="Card" value={view.system_card} /><Stat label="UPI" value={view.system_upi} /><Stat label="Other" value={view.system_other} />
          </div>
          <Txns rows={view.transactions ?? []} />
        </Modal>
      )}
    </>
  )
}

function Stat({ label, value, big, tone }: { label: string; value: number; big?: boolean; tone?: "go" | "bad" }) {
  return (
    <div className={cn("rounded-xl border border-line bg-card p-4", big && "bg-ink text-paper")}>
      <p className={cn("text-xs", big ? "text-paper/70" : "text-mute")}>{label}</p>
      <p className={cn("wide num mt-1 text-2xl font-extrabold", tone === "go" && "text-basil", tone === "bad" && "text-chili")}>{money(value)}</p>
    </div>
  )
}

function Txns({ rows }: { rows: Txn[] }) {
  return (
    <>
      <h2 className="mb-2 mt-6 text-sm font-bold">This shift's movements</h2>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card text-sm">
        {rows.map((t) => (
          <div key={t.name} className="flex items-center gap-3 px-4 py-2">
            <span className="w-12 text-xs text-mute">{t.posted_at.slice(11, 16)}</span>
            <Tag tone={t.kind === "Payment" ? "go" : "warn"}>{t.kind}</Tag>
            <span className="flex-1 truncate text-ink-2">{t.mode} · {t.reference}</span>
            <span className={cn("num font-semibold", t.kind !== "Payment" && "text-chili")}>{t.kind === "Payment" ? "" : "−"}{money(t.amount)}</span>
          </div>
        ))}
        {!rows.length && <p className="px-4 py-3 text-mute">Nothing yet.</p>}
      </div>
    </>
  )
}

function DrawerModal({ kind, onClose, onSubmit }: { kind: "out" | "drop"; onClose: () => void; onSubmit: (amount: number, reason: string) => Promise<void> }) {
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState(kind === "drop" ? "Safe drop" : "")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  return (
    <Modal title={kind === "out" ? "Pay out cash" : "Move cash to the safe"} onClose={onClose}
      footer={<Button busy={busy} onClick={async () => { setBusy(true); setErr(""); try { await onSubmit(Number(amount), reason) } catch (e) { setErr(errText(e)) } finally { setBusy(false) } }}>Record</Button>}>
      <Field label="Amount"><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label={kind === "out" ? "What for?" : "Note"}><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === "out" ? "Ice, gas cylinder, plumber…" : ""} /></Field>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function CloseModal({ sess, onClose, onSubmit }: { sess: Session; onClose: () => void; onSubmit: (counted: number, notes: string) => Promise<void> }) {
  const [counted, setCounted] = useState("")
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [revealed, setRevealed] = useState(false)
  const variance = counted === "" ? null : Number(counted) - sess.expected_cash
  return (
    <Modal title="Close shift" onClose={onClose}
      footer={<Button busy={busy} disabled={counted === ""} onClick={async () => { setBusy(true); setErr(""); try { await onSubmit(Number(counted), notes) } catch (e) { setErr(errText(e)) } finally { setBusy(false) } }}>Close shift</Button>}>
      <p className="text-sm text-mute">Count the drawer first, then type the total. The expected figure stays hidden until you've counted.</p>
      <Field label="Cash counted"><Input inputMode="decimal" value={counted} onChange={(e) => { setCounted(e.target.value); setRevealed(false) }} /></Field>
      {counted !== "" && (
        revealed
          ? <p className={cn("rounded-lg px-3 py-2 text-sm font-semibold", Math.abs(variance!) < 0.01 ? "bg-basil-soft text-basil" : "bg-chili-soft text-chili")}>
              Expected {money(sess.expected_cash)} · {Math.abs(variance!) < 0.01 ? "balanced" : `${variance! > 0 ? "over" : "short"} by ${money(Math.abs(variance!))}`}
            </p>
          : <Button variant="outline" size="sm" onClick={() => setRevealed(true)}>Compare with expected</Button>
      )}
      <Field label="Notes" hint="Required when the count doesn't match."><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}
