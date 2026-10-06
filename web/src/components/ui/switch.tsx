import { cn } from "@/lib/utils"

/** The app's on/off switch — a pill built from a plain button (no Radix
 *  Switch primitive is installed). One component, so every toggle looks and
 *  announces itself (role="switch", aria-checked) the same way. */
export function Switch({
  on,
  disabled,
  onClick,
  label,
  testId,
}: {
  on: boolean
  disabled?: boolean
  onClick: () => void
  label?: string
  testId?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50",
        on ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform",
          on ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
  )
}
