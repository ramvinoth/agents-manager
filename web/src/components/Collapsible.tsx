import { useMemo, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { collapsePreview } from "@/lib/collapse"
import { cn } from "@/lib/utils"

/**
 * WhatsApp-style "Show more" for a long message.
 *
 * Owns only the collapse decision and the toggle affordance — `children`
 * receives the text to render, so a plain-text bubble and a Markdown bubble
 * share this logic instead of each growing their own copy.
 *
 * Expansion is one-way: once the reader has asked for the rest, a re-render (a
 * streaming tick, a filter toggle) must not snap it shut under them.
 *
 * `fadeTo` must match the surface behind the text — the gradient blends the
 * clipped last line into its own background, so a mismatch shows as a grey band.
 */
export function Collapsible({
  text,
  fadeTo = "var(--background)",
  children,
}: {
  text: string
  fadeTo?: string
  children: (shown: string) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const { collapsed, preview, hiddenLines } = useMemo(() => collapsePreview(text), [text])
  const showToggle = collapsed && !expanded
  return (
    <div>
      {/* The fade is positioned on the text box alone — on the outer box it
          would sit over the button's gap and shade barely one line. */}
      <div className={cn(showToggle && "relative")}>
        {children(showToggle ? preview : text)}
        {showToggle && (
          // Sits over the last ~3 lines so the cut reads as "continues" rather
          // than "ended". pointer-events-none keeps the text under it selectable.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-20"
            style={{ backgroundImage: `linear-gradient(to bottom, transparent, ${fadeTo})` }}
          />
        )}
      </div>
      {collapsed && (
        // Its own pill, a clear gap below the text, so it reads as a control and
        // not as the message's last line.
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          style={{ backgroundColor: fadeTo }}
          className="relative mt-3 flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs font-medium text-primary shadow-xs hover:bg-accent"
        >
          {showToggle ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          {showToggle ? `Show more${hiddenLines ? ` · ${hiddenLines} lines` : ""}` : "Show less"}
        </button>
      )}
    </div>
  )
}
