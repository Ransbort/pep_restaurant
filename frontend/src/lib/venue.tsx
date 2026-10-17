import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { call, P } from "./api"
import { rememberAccent } from "./theme"

export interface Outlet {
  name: string; restaurant: string; outlet_name: string; outlet_type: string
  tax_rate: number; service_charge_rate: number; auto_kot: 0 | 1; qr_ordering: 0 | 1
}
export interface Restaurant {
  name: string; restaurant_name: string; currency: string; currency_symbol: string; tax_label: string
  prices_include_tax: 0 | 1; require_cashier_pin: 0 | 1; require_open_session: 0 | 1; logo?: string; accent_color?: string; prep_stations: string[]
  outlets: Outlet[]
}
interface VenueValue {
  loaded: boolean
  restaurants: Restaurant[]
  canSetup: boolean
  restaurant: Restaurant | null
  outlet: Outlet | null
  setRestaurant: (name: string) => void
  setOutlet: (name: string) => void
  reload: () => Promise<void>
}

const Ctx = createContext<VenueValue | null>(null)
export const useVenue = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error("useVenue outside VenueProvider")
  return v
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

export function VenueProvider({ children }: { children: ReactNode }) {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [canSetup, setCanSetup] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [rName, setRName] = useState<string | null>(store.get("pep.restaurant"))
  const [oName, setOName] = useState<string | null>(store.get("pep.outlet"))

  const reload = useCallback(async () => {
    const b = await call<{ restaurants: Restaurant[]; can_setup: boolean }>(`${P}.api.boot`)
    setRestaurants(b.restaurants)
    setCanSetup(b.can_setup)
    setLoaded(true)
  }, [])
  useEffect(() => { reload().catch(() => setLoaded(true)) }, [reload])

  const restaurant = useMemo(
    () => restaurants.find((r) => r.name === rName) ?? restaurants[0] ?? null, [restaurants, rName])
  const outlet = useMemo(
    () => restaurant?.outlets.find((o) => o.name === oName) ?? restaurant?.outlets[0] ?? null, [restaurant, oName])

  useEffect(() => {
    if (!restaurant) return
    setMoney(restaurant.currency, restaurant.currency_symbol)
    rememberAccent(restaurant.accent_color)
  }, [restaurant])

  const value: VenueValue = {
    loaded, restaurants, canSetup, restaurant, outlet, reload,
    setRestaurant: (n) => { setRName(n); store.set("pep.restaurant", n); setOName(null) },
    setOutlet: (n) => { setOName(n); store.set("pep.outlet", n) },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// ------------------------------------------------------------- money
let CUR = "INR"
let SYM = "₹"
export function setMoney(currency: string, symbol?: string) {
  CUR = currency || "INR"
  SYM = symbol || currency
}
export const sym = () => SYM
export function money(n: unknown, opts: { bare?: boolean } = {}) {
  const v = Number(n ?? 0)
  const a = Math.abs(v)
  let s: string
  try {
    s = a.toLocaleString(undefined, { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 })
  } catch { s = a.toFixed(2) }
  return `${v < 0 ? "−" : ""}${opts.bare ? "" : SYM}${s}`
}
export const currency = () => CUR
