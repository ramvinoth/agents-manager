import { RefreshCw, Loader2, Cog, UserRound, Sparkles, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useStore } from "@/store"

function Group({
  icon: Icon,
  title,
  items,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  items: string[]
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <Badge variant="secondary" className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">
          {items.length}
        </Badge>
      </div>
      {items.length ? (
        <ul className="space-y-1.5">
          {items.map((t, i) => (
            <li
              key={i}
              className="flex gap-2 rounded-md border border-border bg-card/40 p-2 text-xs leading-relaxed"
            >
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0">{t}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground/70">None found.</p>
      )}
    </section>
  )
}

export function AnalyticsPanel() {
  const currentSessionPath = useStore((s) => s.currentSessionPath)
  const analysis = useStore((s) => s.analysis)
  const loading = useStore((s) => s.analysisLoading)
  const error = useStore((s) => s.analysisError)
  const analyzeSession = useStore((s) => s.analyzeSession)

  if (!currentSessionPath) {
    return <div className="p-4 text-xs text-muted-foreground">Load a session to analyze it.</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3.5" /> Analysis
        </span>
        {analysis && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-xs"
            onClick={() => analyzeSession(true)}
            disabled={loading}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} /> Re-run
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Analyzing with Claude… (~20–30s)
          </div>
        ) : error ? (
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" /> {error}
            </div>
            <Button size="sm" variant="outline" onClick={() => analyzeSession(true)}>
              Retry
            </Button>
          </div>
        ) : !analysis ? (
          <div className="flex flex-col items-start gap-3 py-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Extract the assumptions Claude made and the decisions you made in this session — a
              checklist to review.
            </p>
            <Button size="sm" className="gap-1.5" onClick={() => analyzeSession(false)}>
              <Sparkles className="size-3.5" /> Analyze session
            </Button>
            <p className="text-[10px] leading-relaxed text-muted-foreground/60">
              Runs Claude locally · ~20–30s · re-runs automatically every 10 messages
            </p>
          </div>
        ) : (
          <div className="space-y-5 pt-1">
            <div className="text-[10px] text-muted-foreground/60">
              Extracted by Claude{analysis.at ? ` · at ${analysis.at} messages` : ""}
            </div>
            <Group icon={Cog} title="Assumptions Claude made" items={analysis.assumptions} />
            <Group icon={UserRound} title="Decisions you made" items={analysis.decisions} />
          </div>
        )}
      </div>
    </div>
  )
}
