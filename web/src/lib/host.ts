// Display label for a host id — centralizes a ternary that was duplicated
// across the header, panels, and dialogs. `localLabel` is a parameter so
// standalone chips read "This machine" while mid-sentence uses ("… on this
// machine") stay lowercase, without changing any visible text.
export function describeHost(
  host: string,
  hosts: { id: string; label?: string }[],
  localLabel = "This machine",
): string {
  if (host === "local") return localLabel
  return hosts.find((h) => h.id === host)?.label || host
}
