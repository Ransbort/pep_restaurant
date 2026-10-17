import { useEffect, useState, type ReactNode } from "react"
import { NavLink } from "react-router-dom"
import { BarChart3, BookOpen, ChefHat, CookingPot, LayoutGrid, LogOut, Package, Palette, QrCode, Settings, Wallet, WifiOff } from "lucide-react"
import { R, useAuth } from "../lib/auth"
import { useVenue } from "../lib/venue"
import { cn } from "../lib/cn"

const NAV = [
  { to: "/till", label: "Floor", icon: LayoutGrid, roles: [R.captain, R.cashier] },
  { to: "/kitchen", label: "Kitchen", icon: ChefHat, roles: [R.kitchen, R.captain, R.cashier] },
  { to: "/cash", label: "Cash", icon: Wallet, roles: [R.cashier] },
  { to: "/reports", label: "Reports", icon: BarChart3, roles: [R.cashier] },
  { to: "/dishes", label: "Menu", icon: BookOpen, roles: [R.manager] },
  { to: "/recipes", label: "Recipes", icon: CookingPot, roles: [R.cashier, R.kitchen] },
  { to: "/stock", label: "Stock", icon: Package, roles: [R.cashier, R.kitchen] },
  { to: "/qr", label: "QR codes", icon: QrCode, roles: [R.manager] },
  { to: "/setup", label: "Setup", icon: Settings, roles: [R.manager] },
  { to: "/settings", label: "Settings", icon: Palette, roles: [R.captain, R.cashier, R.kitchen, R.manager] },
]

export function VenuePicker({ dark }: { dark?: boolean }) {
  const { restaurants, restaurant, outlet, setRestaurant, setOutlet } = useVenue()
  if (!restaurant) return null
  const cls = cn("w-full truncate rounded-md border px-2 py-1.5 text-xs font-semibold",
    dark ? "border-white/15 bg-white/5 text-white" : "border-line bg-card")
  return (
    <div className="space-y-1.5">
      {restaurants.length > 1 && (
        <select aria-label="Restaurant" className={cls} value={restaurant.name} onChange={(e) => setRestaurant(e.target.value)}>
          {restaurants.map((r) => <option key={r.name} value={r.name}>{r.restaurant_name}</option>)}
        </select>
      )}
      {restaurant.outlets.length > 0 && (
        <select aria-label="Outlet" className={cls} value={outlet?.name} onChange={(e) => setOutlet(e.target.value)}>
          {restaurant.outlets.map((o) => <option key={o.name} value={o.name}>{o.outlet_name}</option>)}
        </select>
      )}
    </div>
  )
}

function Offline() {
  const [off, setOff] = useState(false)
  useEffect(() => {
    const a = () => setOff(true), b = () => setOff(false)
    window.addEventListener("pep:offline", a); window.addEventListener("pep:online", b)
    return () => { window.removeEventListener("pep:offline", a); window.removeEventListener("pep:online", b) }
  }, [])
  if (!off) return null
  return (
    <div className="fixed inset-x-0 top-0 z-[70] flex items-center justify-center gap-2 bg-chili py-1.5 text-xs font-semibold text-white">
      <WifiOff className="size-3.5" /> Offline - changes will fail until the connection is back
    </div>
  )
}

export default function Shell({ children, bare }: { children: ReactNode; bare?: boolean }) {
  const { has, who, signOut } = useAuth()
  const { restaurant } = useVenue()
  const items = NAV.filter((n) => has(...n.roles))
  return (
    <div className="flex h-full">
      <Offline />
      <aside className="no-print hidden w-[188px] shrink-0 flex-col border-r border-white/5 bg-chrome px-3 py-4 text-white md:flex">
        <div className="mb-4 flex items-center gap-2 px-1">
          <img src={import.meta.env.BASE_URL + "pep-mark.svg"} alt="" className="size-7" />
          <span className="wide truncate text-sm font-bold">{restaurant?.restaurant_name ?? "Pep Restaurant"}</span>
        </div>
        <VenuePicker dark />
        <nav className="mt-4 flex-1 space-y-0.5">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium",
              isActive ? "bg-brand text-on-brand" : "text-white/75 hover:bg-white/10 hover:text-white")}>
              <Icon className="size-4" /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 pt-3">
          <p className="truncate px-1 text-xs text-white/60">{who?.full_name}</p>
          <button onClick={signOut} className="mt-1 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-xs text-white/70 hover:text-white">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <main className={cn("min-w-0 flex-1 pb-16 md:pb-0", bare ? "h-full overflow-hidden" : "overflow-auto")}>
        <div className="border-b border-line bg-card px-4 py-2 md:hidden"><VenuePicker /></div>
        {bare ? children : <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">{children}</div>}
      </main>
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 flex overflow-x-auto border-t border-line bg-card md:hidden">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => cn(
            "flex min-w-16 flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
            isActive ? "text-ink" : "text-mute")}>
            <Icon className="size-5" /> {label}
          </NavLink>
        ))}
        <button onClick={signOut} className="flex min-w-16 flex-col items-center gap-0.5 py-2 text-[11px] text-mute"><LogOut className="size-5" />Out</button>
      </nav>
    </div>
  )
}
