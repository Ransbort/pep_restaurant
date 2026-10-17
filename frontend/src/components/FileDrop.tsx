import { useRef, useState } from "react"
import { Upload } from "lucide-react"
import { isFileDrag } from "../lib/csv"

/** Drag-and-drop for files. A depth counter keeps the highlight steady while
 *  the pointer crosses child elements (each fires its own enter/leave). */
export function useFileDrop(onFile: (f: File) => void, enabled: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const handlers = enabled ? {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); e.stopPropagation(); depth.current += 1; setOver(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault(); e.stopPropagation()
      depth.current = 0; setOver(false)
      const f = e.dataTransfer.files[0]
      if (f) onFile(f)
    },
  } : {}
  return { over, handlers }
}

export function DropOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-none fixed inset-3 z-[70] flex items-center justify-center rounded-2xl border-4 border-dashed border-brand bg-brand-soft/85">
      <p className="flex items-center gap-2 rounded-xl bg-card px-5 py-3 text-lg font-bold shadow-xl"><Upload className="size-5" />{label}</p>
    </div>
  )
}
