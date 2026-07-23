import { Badge } from "@/components/ui/badge"
import { fmtDuration, fmtTokens } from "@/lib/format"
import { useStore } from "@/store"

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function TokenChart({ timeline }: { timeline: { input: number; output: number }[] }) {
  if (!timeline?.length) return <div className="h-12 rounded bg-muted/40" />
  const w = 240
  const h = 48
  let cum = 0
  const pts = timeline.map((t) => (cum += t.output))
  const max = Math.max(...pts, 1)
  const step = w / Math.max(pts.length - 1, 1)
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - (v / max) * h).toFixed(1)}`).join(" ")
  const area = `${line} L ${w} ${h} L 0 ${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none" style={{ height: 48 }}>
      <path d={area} className="fill-primary/15" />
      <path d={line} className="fill-none stroke-primary" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function StatsPanel() {
  const s = useStore((st) => st.fullSummary)
  if (!s) return <div className="p-4 text-xs text-muted-foreground">Loading stats…</div>

  const tools = Object.entries(s.tools || {}).sort((a, b) => b[1] - a[1])
  const toolTotal = tools.reduce((a, [, c]) => a + c, 0)
  const dur = s.startTime && s.endTime ? new Date(s.endTime).getTime() - new Date(s.startTime).getTime() : 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-4 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="User messages" value={s.userMessages} />
          <Stat label="Assistant" value={s.assistantMessages} />
          <Stat label="Input tokens" value={fmtTokens(s.totalInput)} />
          <Stat label="Output tokens" value={fmtTokens(s.totalOutput)} />
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Output tokens over time</div>
          <TokenChart timeline={s.tokenTimeline || []} />
        </div>

        {dur > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Duration</span>
            <span className="tabular-nums">{fmtDuration(dur)}</span>
          </div>
        )}

        {s.models?.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Models</div>
            <div className="flex flex-wrap gap-1">
              {s.models.map((m) => (
                <Badge key={m} variant="secondary" className="text-[10px]">
                  {m.replace("claude-", "")}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {tools.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Tools · {toolTotal}</div>
            <div className="space-y-1">
              {tools.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span>{name}</span>
                  <span className="tabular-nums text-muted-foreground">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
