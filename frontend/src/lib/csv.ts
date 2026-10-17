/** CSV out of rows, quoted where needed, with a UTF-8 BOM so Excel opens
 *  currency symbols and accented names correctly. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "menu"

/** True while the user is dragging files (not text or a link) over the page. */
export const isFileDrag = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")

/** Read a dropped or chosen CSV as text. Excel on Windows often saves "CSV"
 *  in the old Windows-1252 encoding rather than UTF-8; fall back to it so
 *  names like "Café" don't arrive garbled. Excel workbooks are refused with
 *  instructions, since they aren't text. */
export async function readCsvFile(f: File): Promise<string> {
  const name = f.name.toLowerCase()
  if (/\.(xlsx|xlsm|xls|ods|numbers)$/.test(name))
    throw new Error("That's a spreadsheet file, not a CSV. In Excel use File → Save As → CSV UTF-8 (or in Google Sheets File → Download → CSV), then drop the .csv here.")
  if (!/\.(csv|txt|tsv)$/.test(name) && f.type && !/csv|text/.test(f.type))
    throw new Error(`${f.name} isn't a CSV file.`)
  if (f.size > 5 * 1024 * 1024) throw new Error("That file is over 5 MB - a menu CSV is usually a few KB. Is it the right file?")
  const buf = await f.arrayBuffer()
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder("windows-1252").decode(buf)
  }
}
