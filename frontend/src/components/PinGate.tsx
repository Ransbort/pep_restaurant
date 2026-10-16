import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"
import { Delete } from "lucide-react"
import { ApiError, call, errText, P } from "../lib/api"
import { Button, Modal } from "./ui"

type Mode = "enter" | "enroll"
interface Pending { mode: Mode; resolve: (pin: string | null) => void; error?: string }

const Ctx = createContext<<T>(fn: (pin?: string) => Promise<T>) => Promise<T>>(async (fn) => fn())

/** Wrap a money action: when the server asks for the cashier PIN (or for one
 *  to be set), show the pad and retry with it. */
export const usePinned = () => useContext(Ctx)

export function PinProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const ask = (mode: Mode, error?: string) =>
    new Promise<string | null>((resolve) => setPending({ mode, resolve, error }))

  const run = useCallback(async <T,>(fn: (pin?: string) => Promise<T>): Promise<T> => {
    let pin: string | undefined
    for (let i = 0; i < 4; i++) {
      try {
        return await fn(pin)
      } catch (e) {
        const code = (e as ApiError).code
        const msg = errText(e)
        if (code === "PIN_NOT_SET" || code === "PIN_MUST_RESET") {
          const p = await ask("enroll")
          if (!p) throw e
          pin = p
          continue
        }
        if (code === "PIN_REQUIRED" || msg.startsWith("Wrong cashier PIN")) {
          const p = await ask("enter", code === "PIN_REQUIRED" ? undefined : msg)
          if (!p) throw e
          pin = p
          continue
        }
        throw e
      }
    }
    return fn(pin)
  }, [])

  return (
    <Ctx.Provider value={run}>
      {children}
      {pending && (
        <PinPad
          mode={pending.mode}
          error={pending.error}
          onDone={(p) => { pending.resolve(p); setPending(null) }}
        />
      )}
    </Ctx.Provider>
  )
}

function PinPad({ mode, error, onDone }: { mode: Mode; error?: string; onDone: (pin: string | null) => void }) {
  const [pin, setPin] = useState("")
  const [first, setFirst] = useState<string | null>(null)
  const [err, setErr] = useState(error ?? "")
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const press = (d: string) => setPin((p) => (p.length < 6 ? p + d : p))
  const submit = async () => {
    if (pin.length < 4 || lock.current) return
    if (mode === "enter") return onDone(pin)
    if (!first) { setFirst(pin); setPin(""); return }
    if (first !== pin) { setErr("The two PINs don't match. Start again."); setFirst(null); setPin(""); return }
    lock.current = true
    setBusy(true)
    try {
      await call(`${P}.authz.set_my_pin`, { pin })
      onDone(pin)
    } catch (e) { setErr(errText(e)); setFirst(null); setPin("") } finally { setBusy(false); lock.current = false }
  }
  const title = mode === "enter" ? "Enter your cashier PIN" : first ? "Type the new PIN again" : "Set your cashier PIN"
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      {mode === "enroll" && !first && <p className="text-sm text-mute">4 to 6 digits. You'll use it to confirm payments and cash moves.</p>}
      <div className="flex justify-center gap-2 py-2" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className={"size-3.5 rounded-full " + (i < pin.length ? "bg-ink" : "bg-line")} />
        ))}
      </div>
      {err && <p className="text-center text-sm font-medium text-chili">{err}</p>}
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} onClick={() => press(d)} className="h-14 rounded-xl border border-line text-xl font-bold hover:bg-paper">{d}</button>
        ))}
        <button onClick={() => setPin("")} className="h-14 rounded-xl text-sm text-mute">Clear</button>
        <button onClick={() => press("0")} className="h-14 rounded-xl border border-line text-xl font-bold hover:bg-paper">0</button>
        <button aria-label="Delete digit" onClick={() => setPin((p) => p.slice(0, -1))} className="flex h-14 items-center justify-center rounded-xl text-mute"><Delete /></button>
      </div>
      <Button className="w-full" size="lg" busy={busy} disabled={pin.length < 4} onClick={submit}>
        {mode === "enter" ? "Confirm" : first ? "Save PIN" : "Next"}
      </Button>
    </Modal>
  )
}
