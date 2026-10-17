/** Appearance (light / dark / follow the device) is a per-device choice;
 *  the accent colour belongs to the restaurant and comes from the server.
 *  Both are applied to <html> so every screen - and the guest QR menu -
 *  picks them up without a re-render. */

export type Appearance = "light" | "dark" | "system"
export type KitchenMode = "dark" | "app"

export const DEFAULT_ACCENT = "#f2a900"
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Saffron", hex: "#f2a900" },
  { name: "Paprika", hex: "#e4572e" },
  { name: "Chili", hex: "#c62f3a" },
  { name: "Berry", hex: "#b03a7a" },
  { name: "Plum", hex: "#6d3fb3" },
  { name: "Ocean", hex: "#2563b0" },
  { name: "Teal", hex: "#0f8b8d" },
  { name: "Basil", hex: "#1f7a4c" },
  { name: "Lime", hex: "#8bc34a" },
  { name: "Charcoal", hex: "#3b4757" },
]

const KEY = "pep.appearance"
const KDS_KEY = "pep.kds.mode"
const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } }

const media = () => window.matchMedia?.("(prefers-color-scheme: dark)")

export function getAppearance(): Appearance {
  const v = get(KEY)
  return v === "light" || v === "dark" || v === "system" ? v : "system"
}

export function isDark(a: Appearance = getAppearance()) {
  return a === "dark" || (a === "system" && !!media()?.matches)
}

function paint() {
  const dark = isDark()
  document.documentElement.classList.toggle("dark", dark)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0c0f13" : "#1d2733")
}

export function setAppearance(a: Appearance) {
  set(KEY, a)
  paint()
  window.dispatchEvent(new Event("pep:theme"))
}

export function getKitchenMode(): KitchenMode {
  return get(KDS_KEY) === "app" ? "app" : "dark"
}
export function setKitchenMode(m: KitchenMode) {
  set(KDS_KEY, m)
  window.dispatchEvent(new Event("pep:theme"))
}

/** Valid #rgb / #rrggbb, normalised to #rrggbb, or null. */
export function normHex(v: string | null | undefined): string | null {
  const m = (v || "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return null
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]
  return `#${h.toLowerCase()}`
}

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** Dark or white text on the accent - whichever contrasts more. */
export function onAccent(hex: string) {
  const L = luminance(hex)
  const vsWhite = 1.05 / (L + 0.05)
  const vsInk = (L + 0.05) / (luminance("#1d2733") + 0.05)
  return vsInk >= vsWhite ? "#1d2733" : "#ffffff"
}

export function applyAccent(hex?: string | null) {
  const h = normHex(hex) ?? DEFAULT_ACCENT
  const root = document.documentElement.style
  root.setProperty("--accent", h)
  root.setProperty("--on-accent", onAccent(h))
}

export function initTheme() {
  paint()
  applyAccent(get("pep.accent"))
  media()?.addEventListener?.("change", () => getAppearance() === "system" && paint())
}

/** Remember the last restaurant accent so the next load paints it before
 *  the boot call returns (no flash of the default colour). */
export function rememberAccent(hex?: string | null) {
  const h = normHex(hex) ?? DEFAULT_ACCENT
  set("pep.accent", h)
  applyAccent(h)
}
