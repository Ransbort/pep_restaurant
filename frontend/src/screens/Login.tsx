import { useState } from "react"
import { Navigate, useLocation, useNavigate } from "react-router-dom"
import { errText, login } from "../lib/api"
import { useAuth } from "../lib/auth"
import { Button, Field, Input } from "../components/ui"

export default function Login() {
  const { status, refresh } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const [usr, setUsr] = useState("")
  const [pwd, setPwd] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const from = (loc.state as { from?: string } | null)?.from || "/"
  if (status === "authed") return <Navigate to={from} replace />
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr("")
    try {
      await login(usr.trim(), pwd)
      // a fresh session needs a fresh CSRF token: reload the served shell
      if (location.pathname.startsWith("/restaurant")) { location.href = "/restaurant" + (from === "/" ? "" : from); return }
      await refresh()
      nav(from, { replace: true })
    } catch (e) {
      setErr(/401|Invalid|Incorrect/i.test(errText(e)) ? "That email and password don't match." : errText(e))
    } finally { setBusy(false) }
  }
  return (
    <div className="grid min-h-full md:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-ink p-10 text-white md:flex">
        <div className="flex items-center gap-2.5">
          <img src={import.meta.env.BASE_URL + "pep-mark.svg"} alt="" className="size-9" />
          <span className="wide text-lg font-bold">Pep Restaurant</span>
        </div>
        <div>
          <p className="wide max-w-md text-5xl font-extrabold leading-[1.02] tracking-tight">
            Table 4 wants the bill.<br /><span className="text-saffron">Table 7 just sat down.</span>
          </p>
          <p className="mt-5 max-w-sm text-white/65">Tables, tickets, the pass and the till - on one screen your floor can keep up with.</p>
        </div>
        <div className="grid grid-cols-6 gap-2 opacity-90" aria-hidden>
          {["#2563b0", "#f2a900", "#ffffff22", "#1f7a4c", "#ffffff22", "#6d3fb3", "#ffffff22", "#f2a900", "#ffffff22", "#ffffff22", "#2563b0", "#1f7a4c"].map((c, i) => (
            <div key={i} className="h-10 rounded-lg" style={{ background: c }} />
          ))}
        </div>
      </div>
      <form onSubmit={submit} className="flex flex-col justify-center px-6 py-12 sm:px-14">
        <div className="mx-auto w-full max-w-sm space-y-4">
          <div className="mb-6 md:hidden"><img src={import.meta.env.BASE_URL + "pep-mark.svg"} alt="Pep Restaurant" className="size-10" /></div>
          <h1 className="wide text-2xl font-extrabold">Sign in to start your shift</h1>
          <Field label="Email or username"><Input autoComplete="username" value={usr} onChange={(e) => setUsr(e.target.value)} required /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required /></Field>
          {err && <p className="text-sm font-medium text-chili">{err}</p>}
          <Button type="submit" size="lg" className="w-full" busy={busy}>Sign in</Button>
        </div>
      </form>
    </div>
  )
}
