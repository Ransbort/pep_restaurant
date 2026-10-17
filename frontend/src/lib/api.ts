// Thin client for Restaurant's whitelisted API (session-cookie auth).

function csrfToken(): string | undefined {
  const t = (window as unknown as { csrf_token?: string }).csrf_token
  return t && t !== "None" ? t : undefined
}

export class ApiError extends Error {
  status?: number
  code?: string
  network?: boolean
}

/** A readable message out of a Frappe error body. */
function messageOf(body: string, fallback: string): string {
  try {
    const j = JSON.parse(body)
    if (j._server_messages) {
      const msgs = JSON.parse(j._server_messages) as string[]
      const last = msgs.map((m) => {
        try { return JSON.parse(m).message as string } catch { return m }
      }).filter(Boolean).pop()
      if (last) return stripHtml(last)
    }
    if (j.exception) return stripHtml(String(j.exception).replace(/^[\w.]+(Error|Exception):\s*/, ""))
    if (j.message) return stripHtml(String(j.message))
  } catch { /* not JSON */ }
  return fallback
}

export function stripHtml(s: string): string {
  let out = s, prev
  do { prev = out; out = out.replace(/<[^<>]*>/g, "") } while (out !== prev)
  return out.replace(/[<>]/g, "").trim()
}

async function doFetch(path: string, init?: RequestInit, guest = false) {
  const token = guest ? undefined : csrfToken()
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { "X-Frappe-CSRF-Token": token } : {}) },
      credentials: guest ? "omit" : "include",
    })
  } catch {
    const e = new ApiError("Can't reach the server. Check the connection - we'll keep trying.")
    e.network = true
    window.dispatchEvent(new Event("pep:offline"))
    throw e
  }
  window.dispatchEvent(new Event("pep:online"))
  if (!res.ok) {
    const body = await res.text()
    if ((res.status === 401 || res.status === 403) && !path.includes("/login") && !path.includes(".whoami") && !guest)
      window.dispatchEvent(new Event("pep:auth-error"))
    const msg = messageOf(body, `Request failed (${res.status})`)
    const e = new ApiError(msg)
    e.status = res.status
    const m = msg.match(/^([A-Z_]{4,}):/)
    if (m) e.code = m[1]
    throw e
  }
  return res.json()
}

export async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const data = await doFetch(`/api/method/${method}`, { method: "POST", body: JSON.stringify(params) })
  // Frappe omits "message" when the method returns None
  return (data.message ?? null) as T
}

/** allow_guest endpoints, without the staff session (no stale CSRF). */
export async function callGuest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const data = await doFetch(`/api/method/${method}`, { method: "POST", body: JSON.stringify(params) }, true)
  return (data.message ?? null) as T
}

export async function login(usr: string, pwd: string) {
  await doFetch("/api/method/login", { method: "POST", body: JSON.stringify({ usr, pwd }) })
}
export async function logout() {
  await doFetch("/api/method/logout", { method: "POST" })
}

export async function uploadImage(file: File): Promise<string> {
  const token = csrfToken()
  const fd = new FormData()
  fd.append("file", file, file.name)
  fd.append("is_private", "0")
  const res = await fetch("/api/method/upload_file", {
    method: "POST", body: fd, credentials: "include",
    headers: token ? { "X-Frappe-CSRF-Token": token } : undefined,
  })
  if (!res.ok) throw new ApiError(messageOf(await res.text(), "Upload failed"))
  return (await res.json()).message.file_url as string
}

export const P = "pep_restaurant"
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
