import { useEffect, useState } from "react"
import { Plus } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { useVenue } from "../lib/venue"
import { useAuth } from "../lib/auth"
import { LinkPicker } from "../components/LinkPicker"
import { Button, Check, Empty, Field, Input, Modal, PageHead, Select, Tag, Textarea, useToast } from "../components/ui"

type Doc = Record<string, string | number | null | undefined>

export default function Setup() {
  const { restaurants, restaurant, reload, setRestaurant } = useVenue()
  const { who } = useAuth()
  const toast = useToast()
  const [editR, setEditR] = useState<Doc | null>(null)
  const [editO, setEditO] = useState<Doc | null>(null)
  if (!who?.is_admin) return <Empty title="Only managers can change setup" />

  const openRestaurant = async (name?: string) => {
    if (!name) return setEditR({ restaurant_name: "", currency: "", tax_label: "GST", tax_split: "CGST:50\nSGST:50", require_open_session: 1, prices_include_tax: 0, require_cashier_pin: 0, pin_max_attempts: 5, pin_lock_minutes: 15, reservation_before_min: 60, reservation_after_min: 240, receipt_footer: "Thank you! Visit again.", prep_stations: "Kitchen\nGrill\nFryer\nBar\nCold" })
    try { setEditR(await call<Doc>(`${P}.api.get_restaurant`, { restaurant: name })) } catch (e) { toast(errText(e), "bad") }
  }
  const openOutlet = async (name?: string) => {
    if (!name) return setEditO({ outlet_name: "", outlet_type: "Restaurant", tax_rate: 5, service_charge_rate: 0, auto_kot: 0, qr_ordering: 1, tables: "T1:4\nT2:4\nT3:2" })
    try { setEditO(await call<Doc>(`${P}.api.get_outlet`, { outlet: name })) } catch (e) { toast(errText(e), "bad") }
  }

  return (
    <>
      <PageHead title="Setup" sub="Restaurants, their outlets, tables and tax." actions={<Button onClick={() => openRestaurant()}><Plus className="size-4" />Add restaurant</Button>} />
      {!restaurants.length && <Empty title="Set up your first restaurant" action={<Button onClick={() => openRestaurant()}>Add restaurant</Button>}>
        Give it a name and currency, then add an outlet - the dining room, a bar, a takeaway counter.</Empty>}
      <div className="space-y-5">
        {restaurants.map((r) => (
          <section key={r.name} className="rounded-2xl border border-line bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="wide text-xl font-extrabold">{r.restaurant_name} {restaurant?.name === r.name && <Tag tone="brand">Working here</Tag>}</h2>
                <p className="text-sm text-mute">{r.currency} · {r.tax_label}{r.prices_include_tax ? " included in prices" : " added to bills"} · {r.require_open_session ? "cash shift required" : "no shift needed"}{r.require_cashier_pin ? " · PIN on payments" : ""}</p>
              </div>
              <div className="flex gap-2">
                {restaurant?.name !== r.name && <Button size="sm" variant="ghost" onClick={() => setRestaurant(r.name)}>Work here</Button>}
                <Button size="sm" variant="outline" onClick={() => openRestaurant(r.name)}>Edit</Button>
                <Button size="sm" onClick={() => { setRestaurant(r.name); openOutlet() }}><Plus className="size-3.5" />Outlet</Button>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {r.outlets.map((o) => (
                <button key={o.name} onClick={() => { setRestaurant(r.name); openOutlet(o.name) }} className="rounded-xl border border-line p-3 text-left hover:border-ink-2">
                  <p className="font-semibold">{o.outlet_name} <span className="text-xs font-normal text-mute">{o.outlet_type}</span></p>
                  <p className="text-xs text-mute">Tax {o.tax_rate}%{o.service_charge_rate ? ` · service ${o.service_charge_rate}%` : ""}{o.auto_kot ? " · auto KOT" : ""}{o.qr_ordering ? " · QR ordering" : ""}</p>
                </button>
              ))}
              {!r.outlets.length && <p className="text-sm text-mute">No outlets yet.</p>}
            </div>
          </section>
        ))}
      </div>
      <section className="mt-6 rounded-2xl border border-line bg-card p-5 text-sm text-ink-2">
        <h2 className="mb-1 font-bold text-ink">Staff</h2>
        <p>Add people as Users in Desk (<a className="underline" href="/app/user">/app/user</a>) and give each one or more roles: <b>Restaurant Captain</b> (takes orders), <b>Restaurant Cashier</b> (takes payment, runs cash shifts), <b>Kitchen Staff</b> (kitchen screen, stock counts) or <b>Restaurant Manager</b> (everything). To limit someone to one restaurant, add a User Permission on <i>Restaurant</i>.</p>
      </section>

      {editR && <RestaurantModal doc={editR} onClose={() => setEditR(null)} onSaved={async (n) => { setEditR(null); await reload(); setRestaurant(n); toast("Saved") }} />}
      {editO && restaurant && <OutletModal doc={editO} restaurant={restaurant.name} onClose={() => setEditO(null)} onSaved={async () => { setEditO(null); await reload(); toast("Saved") }} />}
    </>
  )
}

function useForm(doc: Doc) {
  const [v, setV] = useState<Doc>(doc)
  useEffect(() => setV(doc), [doc])
  const text = (k: string) => ({ value: (v[k] ?? "") as string, onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) })
  const check = (k: string) => ({ checked: !!Number(v[k]), onChange: (x: boolean) => setV({ ...v, [k]: x ? 1 : 0 }) })
  return { v, setV, text, check }
}

function RestaurantModal({ doc, onClose, onSaved }: { doc: Doc; onClose: () => void; onSaved: (name: string) => void }) {
  const { v, setV, text, check } = useForm(doc)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const save = async () => {
    setBusy(true); setErr("")
    try { const r = await call<{ name: string }>(`${P}.api.save_restaurant`, v); onSaved(r.name) } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal wide title={v.name ? `Edit ${doc.restaurant_name}` : "Add a restaurant"} onClose={onClose} footer={<Button busy={busy} onClick={save}>Save restaurant</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint={v.name && v.restaurant_name !== doc.restaurant_name ? "Renaming keeps every outlet, order and setting with it." : undefined}><Input {...text("restaurant_name")} /></Field>
        <Field label="Currency" hint="Search by code: GHS, USD, NGN…"><LinkPicker kind="currency" value={(v.currency as string) || ""} onChange={(c) => setV({ ...v, currency: c })} placeholder="Pick a currency" /></Field>
        <Field label="Phone"><Input {...text("phone")} /></Field>
        <Field label="Tax ID" hint="Printed on bills (GSTIN, VAT no.)."><Input {...text("tax_id")} /></Field>
      </div>
      <Field label="Address"><Textarea className="min-h-14" {...text("address")} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tax name on bills"><Input {...text("tax_label")} /></Field>
        <Field label="Tax split" hint="One per line as LABEL:SHARE%, e.g. CGST:50 and SGST:50. Leave blank for one line."><Textarea className="min-h-14" {...text("tax_split")} /></Field>
      </div>
      <div className="space-y-2">
        <Check label="Menu prices already include tax" {...check("prices_include_tax")} />
        <Check label="Cashiers must open a cash shift before taking payment" {...check("require_open_session")} />
        <Check label="Ask for the cashier's PIN on payments and cash moves" {...check("require_cashier_pin")} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Show a reservation on the floor from (minutes before)"><Input inputMode="numeric" {...text("reservation_before_min")} /></Field>
        <Field label="…until (minutes after)"><Input inputMode="numeric" {...text("reservation_after_min")} /></Field>
      </div>
      <Field label="Bill footer"><Input {...text("receipt_footer")} /></Field>
      <Field label="Kitchen stations"
        hint="One per line, in the order cooks see them. Each dish is cooked at one station, and a kitchen screen can show just one station - put a tablet at each. A station with dishes on it can't be removed until they move.">
        <Textarea className="min-h-32 font-mono text-sm" {...text("prep_stations")} placeholder={"Kitchen\nGrill\nBar"} />
      </Field>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}

function OutletModal({ doc, restaurant, onClose, onSaved }: { doc: Doc; restaurant: string; onClose: () => void; onSaved: () => void }) {
  const { v, text, check } = useForm(doc)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const save = async () => {
    setBusy(true); setErr("")
    try { await call(`${P}.api.save_outlet`, { ...v, restaurant }); onSaved() } catch (e) { setErr(errText(e)) } finally { setBusy(false) }
  }
  return (
    <Modal wide title={v.name ? `Edit ${doc.outlet_name}` : "Add an outlet"} onClose={onClose} footer={<Button busy={busy} onClick={save}>Save outlet</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input {...text("outlet_name")} placeholder="Main dining, Rooftop bar…" /></Field>
        <Field label="Type"><Select options={["Restaurant", "Bar", "Cafe", "Takeaway Counter", "Cloud Kitchen", "Other"]} {...text("outlet_type")} /></Field>
        <Field label="Tax rate %"><Input inputMode="decimal" {...text("tax_rate")} /></Field>
        <Field label="Service charge %"><Input inputMode="decimal" {...text("service_charge_rate")} /></Field>
      </div>
      <Field label="Tables" hint='One per line. "[Patio]" starts an area, "T4:6" is table T4 with 6 seats.'>
        <Textarea className="min-h-36 font-mono text-sm" {...text("tables")} />
      </Field>
      <div className="space-y-2">
        <Check label="Auto KOT - sending also starts the ticket at the pass and prints the slip" {...check("auto_kot")} />
        <Check label="Guests can order from the table QR code" {...check("qr_ordering")} />
        <Check label="Disabled" {...check("disabled")} />
      </div>
      {err && <p className="text-sm text-chili">{err}</p>}
    </Modal>
  )
}
