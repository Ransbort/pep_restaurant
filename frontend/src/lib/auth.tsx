import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { call, logout, P } from "./api"

type Status = "loading" | "anon" | "authed"
interface Who { user: string; full_name: string; roles: string[]; is_admin?: boolean }
interface AuthValue {
  status: Status
  who: Who | null
  has: (...roles: string[]) => boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthValue | null>(null)
export const useAuth = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error("useAuth outside AuthProvider")
  return v
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading")
  const [who, setWho] = useState<Who | null>(null)
  const refresh = useCallback(async () => {
    try {
      const w = await call<Who>(`${P}.api.whoami`)
      if (w.user === "Guest") { setStatus("anon"); setWho(null) }
      else { setWho(w); setStatus("authed") }
    } catch (e) {
      if ((e as { network?: boolean }).network) { setTimeout(refresh, 4000); return }
      setStatus("anon"); setWho(null)
    }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const h = () => refresh()
    window.addEventListener("pep:auth-error", h)
    return () => window.removeEventListener("pep:auth-error", h)
  }, [refresh])
  const signOut = useCallback(async () => {
    await logout().catch(() => undefined)
    setStatus("anon"); setWho(null)
  }, [])
  const has = useCallback((...roles: string[]) =>
    !!who && (who.is_admin || roles.some((r) => who.roles.includes(r))), [who])
  return <Ctx.Provider value={{ status, who, has, refresh, signOut }}>{children}</Ctx.Provider>
}

export const R = {
  manager: "Restaurant Manager",
  captain: "Restaurant Captain",
  cashier: "Restaurant Cashier",
  kitchen: "Kitchen Staff",
}
