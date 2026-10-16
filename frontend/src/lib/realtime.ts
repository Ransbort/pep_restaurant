import { useEffect, useRef } from "react"

/** Re-run `onChange` whenever something at the restaurant changes. Prefers
 *  Frappe's socket; falls back to polling while the tab is visible. */
export function useLive(onChange: () => void, pollMs = 20000) {
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    let last = 0
    const fire = () => {
      const now = Date.now()
      if (now - last < 800) return
      last = now
      cb.current()
    }
    const timer = setInterval(() => document.visibilityState === "visible" && fire(), pollMs)
    let socket: { close: () => void } | null = null
    let closed = false
    void import("socket.io-client").then(({ io }) => {
      if (closed) return
      const s = io(`${location.origin}/${location.hostname}`, {
        path: "/socket.io", withCredentials: true, reconnectionAttempts: 3, timeout: 4000,
      })
      s.on("pep_changed", fire)
      socket = s
    }).catch(() => undefined)
    const onVis = () => document.visibilityState === "visible" && fire()
    document.addEventListener("visibilitychange", onVis)
    return () => {
      closed = true
      socket?.close()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [pollMs])
}
