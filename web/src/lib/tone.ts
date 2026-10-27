/**
 * Status tones: the one place a semantic state (approved, blocked, waiting…)
 * becomes a colour. Every badge, strip and chip that paints a status reads
 * from here, so the palette is defined once and stays in sync with the
 * --success/--warning/--info/--destructive tokens in index.css.
 */
export type Tone = "success" | "warning" | "danger" | "info" | "accent" | "neutral"

export const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-info/15 text-info",
  accent: "bg-primary/15 text-primary",
  neutral: "bg-muted text-muted-foreground",
}

/** Board column name → tone. Unknown columns are neutral. */
const COLUMN_TONE: Record<string, Tone> = {
  review: "warning",
  "needs-info": "info",
  approved: "success",
  done: "success",
  declined: "danger",
  blocked: "danger",
  doing: "accent",
}

export function columnTone(name: string): Tone {
  return COLUMN_TONE[name.trim().toLowerCase()] ?? "neutral"
}
