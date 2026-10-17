import { useEffect, useState } from "react"
import { Check, Monitor, Moon, Sun } from "lucide-react"
import { call, errText, P } from "../lib/api"
import { useVenue } from "../lib/venue"
import { useAuth } from "../lib/auth"
import { cn } from "../lib/cn"
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, applyAccent, getAppearance, getKitchenMode, normHex, onAccent, rememberAccent,
  setAppearance, setKitchenMode, type Appearance, type KitchenMode,
} from "../lib/theme"
import { Button, Input, PageHead, Tag, useToast } from "../components/ui"

const MODES: { id: Appearance; label: string; icon: typeof Sun; hint: string }[] = [
  { id: "light", label: "Light", icon: Sun, hint: "Bright rooms and daytime service" },
  { id: "dark", label: "Dark", icon: Moon, hint: "Dim dining rooms and late shifts" },
  { id: "system", label: "Match device", icon: Monitor, hint: "Follows this device's setting" },
]

export default function Settings() {
  const { restaurant, reload } = useVenue()
  const { who } = useAuth()
  const toast = useToast()
  const [mode, setMode] = useState<Appearance>(getAppearance())
  const [kds, setKds] = useState<KitchenMode>(getKitchenMode())
  const saved = normHex(restaurant?.accent_color) ?? DEFAULT_ACCENT
  const [accent, setAccent] = useState(saved)
  const [hexText, setHexText] = useState(saved)
  const [busy, setBusy] = useState(false)
  const canBrand = !!who?.is_admin
  const dirty = accent !== saved

  useEffect(() => { setAccent(saved); setHexText(saved) }, [saved])
  // live preview while choosing; put the saved colour back if they leave unsaved
  useEffect(() => { applyAccent(accent) }, [accent])
  useEffect(() => () => applyAccent(normHex(localStorage.getItem("pep.accent")) ?? DEFAULT_ACCENT), [])

  const pick = (hex: string) => { setAccent(hex); setHexText(hex) }
  const save = async () => {
    if (!restaurant) return
    setBusy(true)
    try {
      const r = await call<{ accent_color: string }>(`${P}.api.set_accent`, { restaurant: restaurant.name, accent_color: accent })
      rememberAccent(r.accent_color)
      await reload()
      toast("Colour theme saved for everyone at " + restaurant.restaurant_name)
    } catch (e) { toast(errText(e), "bad") } finally { setBusy(false) }
  }

  return (
    <>
      <PageHead title="Settings" sub="How Pep looks on this device, and your restaurant's colour." />
      <div className="space-y-6">
        <section className="rounded-2xl border border-line bg-card p-5">
          <h2 className="text-base font-bold">Appearance</h2>
          <p className="text-sm text-mute">Saved on this device only, so the bar tablet can be dark while the front desk stays light.</p>
          <div role="radiogroup" aria-label="Appearance" className="mt-4 grid gap-3 sm:grid-cols-3">
            {MODES.map(({ id, label, icon: Icon, hint }) => (
              <button key={id} role="radio" aria-checked={mode === id} onClick={() => { setMode(id); setAppearance(id) }}
                className={cn("group rounded-xl border-2 p-3 text-left transition", mode === id ? "border-ink" : "border-line hover:border-ink-2")}>
                <ModePreview mode={id} />
                <span className="mt-3 flex items-center gap-2 font-semibold"><Icon className="size-4" />{label}
                  {mode === id && <Check className="ml-auto size-4" />}</span>
                <span className="block text-xs text-mute">{hint}</span>
              </button>
            ))}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-paper px-4 py-3">
            <div>
              <p className="text-sm font-semibold">Kitchen screen</p>
              <p className="text-xs text-mute">Most kitchens keep it dark so it doesn't glare across the pass.</p>
            </div>
            <div className="flex gap-1 rounded-lg bg-line/60 p-1">
              {([["dark", "Always dark"], ["app", "Same as above"]] as [KitchenMode, string][]).map(([id, label]) => (
                <button key={id} onClick={() => { setKds(id); setKitchenMode(id) }}
                  className={cn("rounded-md px-3 py-1.5 text-sm font-semibold", kds === id && "bg-card shadow-sm")}>{label}</button>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-line bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-bold">Colour theme</h2>
              <p className="text-sm text-mute">
                {restaurant?.restaurant_name}'s accent colour, used on every till and on the guest QR menu.
                {!canBrand && " Only a manager can change it."}
              </p>
            </div>
            {dirty && <Tag tone="brand">Previewing</Tag>}
          </div>

          <div className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-10" role="radiogroup" aria-label="Accent colour">
            {ACCENT_PRESETS.map((p) => (
              <button key={p.hex} role="radio" aria-checked={accent === p.hex} aria-label={p.name} title={p.name}
                disabled={!canBrand} onClick={() => pick(p.hex)}
                className={cn("flex aspect-square items-center justify-center rounded-xl ring-offset-2 ring-offset-card transition disabled:cursor-not-allowed",
                  accent === p.hex ? "ring-3 ring-ink" : "hover:scale-105")}
                style={{ background: p.hex, color: onAccent(p.hex) }}>
                {accent === p.hex && <Check className="size-5" />}
              </button>
            ))}
          </div>

          {canBrand && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="color" value={accent} onChange={(e) => pick(e.target.value)} className="size-10 cursor-pointer rounded-lg border border-line bg-card p-0.5" aria-label="Pick any colour" />
                Custom
              </label>
              <Input className="!w-32 font-mono" value={hexText} maxLength={7}
                onChange={(e) => { setHexText(e.target.value); const h = normHex(e.target.value); if (h) setAccent(h) }} aria-label="Hex colour" />
            </div>
          )}

          <ThemePreview />

          {canBrand && (
            <div className="mt-4 flex justify-end gap-2">
              {dirty && <Button variant="ghost" onClick={() => pick(saved)}>Reset</Button>}
              <Button variant="brand" busy={busy} disabled={!dirty} onClick={save}>Save colour theme</Button>
            </div>
          )}
        </section>
      </div>
    </>
  )
}

/** A miniature till, painted with the live tokens, so the choice is seen in context. */
function ThemePreview() {
  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-line" aria-hidden>
      <div className="flex">
        <div className="hidden w-32 shrink-0 space-y-1.5 bg-chrome p-3 sm:block">
          <div className="h-2 w-16 rounded bg-white/50" />
          <div className="mt-3 rounded-md bg-brand px-2 py-1.5 text-[11px] font-bold text-on-brand">Floor</div>
          <div className="px-2 py-1 text-[11px] text-white/70">Kitchen</div>
          <div className="px-2 py-1 text-[11px] text-white/70">Cash</div>
        </div>
        <div className="flex-1 bg-paper p-3">
          <div className="grid grid-cols-4 gap-2">
            {[["T1", "bg-card border-line text-ink", "Free"], ["T2", "bg-sky-soft border-sky/40 text-sky", "Ordering"],
              ["T3", "bg-amber-soft border-amber text-amber-deep", "In kitchen"], ["T4", "bg-basil border-basil text-white", "Ready"]].map(([t, c, s]) => (
              <div key={t} className={cn("rounded-lg border-2 p-2", c)}>
                <p className="wide text-sm font-extrabold">{t}</p><p className="text-[10px] font-semibold opacity-80">{s}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-lg border-2 border-dashed border-brand bg-brand-soft/40 p-2 text-[11px] font-bold text-brand-deep">Not sent yet · 2 × Paneer Tikka</div>
          <div className="mt-3 flex gap-2">
            <span className="flex-1 rounded-lg bg-brand py-2 text-center text-xs font-bold text-on-brand">Send to kitchen</span>
            <span className="flex-1 rounded-lg bg-basil py-2 text-center text-xs font-bold text-white">Take payment</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function ModePreview({ mode }: { mode: Appearance }) {
  const Light = () => (
    <div className="flex h-full bg-[#f3f5f7]"><div className="w-1/4 bg-[#1d2733]" /><div className="flex-1 space-y-1 p-1.5">
      <div className="h-1.5 w-2/3 rounded bg-[#1d2733]/70" /><div className="h-4 rounded bg-white" /><div className="h-4 rounded bg-white" /></div></div>
  )
  const Dark = () => (
    <div className="flex h-full bg-[#12161c]"><div className="w-1/4 bg-[#0c0f13]" /><div className="flex-1 space-y-1 p-1.5">
      <div className="h-1.5 w-2/3 rounded bg-[#eef1f5]/70" /><div className="h-4 rounded bg-[#1b212a]" /><div className="h-4 rounded bg-[#1b212a]" /></div></div>
  )
  return (
    <div className="h-16 overflow-hidden rounded-lg border border-line">
      {mode === "light" ? <Light /> : mode === "dark" ? <Dark /> : (
        <div className="grid h-full grid-cols-2"><Light /><Dark /></div>
      )}
    </div>
  )
}
