import type { ActorKind } from "@/lib/board"

/** An actor (lib/board formatActor) as a name, with an "agent" tag for sessions.
 *  Shared by card comments, note discussions and the audit log. */
export function ActorName({ name, kind }: { name: string; kind: ActorKind }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium text-foreground">
      {kind === "you" ? "you" : name}
      {kind === "agent" && <span className="rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">agent</span>}
    </span>
  )
}
