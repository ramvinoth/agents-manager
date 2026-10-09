import { lazy, Suspense, type ComponentProps, type ComponentType } from "react"

/** A dialog whose code downloads the first time it opens instead of shipping
 *  in the main bundle. Every dialog here is mounted only while open, so the
 *  cost is one short fetch on first open. Import dialogs from this file, never
 *  directly: one eager import anywhere pulls the module back into the main chunk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onDemand<C extends ComponentType<any>>(load: () => Promise<C>) {
  const Lazy = lazy(() => load().then((c) => ({ default: c })))
  return (props: ComponentProps<C>) => (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  )
}

export const KanbanDialog = onDemand(() => import("./kanban/KanbanDialog").then((m) => m.KanbanDialog))
export const NotesDialog = onDemand(() => import("./notes/NotesDialog").then((m) => m.NotesDialog))
export const InboxDialog = onDemand(() => import("./inbox/InboxDialog").then((m) => m.InboxDialog))
export const MapDialog = onDemand(() => import("./map/MapDialog").then((m) => m.MapDialog))
export const IntegrationsDialog = onDemand(() => import("./IntegrationsDialog").then((m) => m.IntegrationsDialog))
export const AuditDialog = onDemand(() => import("./AuditDialog").then((m) => m.AuditDialog))
export const AISelectionDialog = onDemand(() => import("./settings/AISelectionDialog").then((m) => m.AISelectionDialog))
export const PairPhoneDialog = onDemand(() => import("./PairPhoneDialog").then((m) => m.PairPhoneDialog))
export const HostDialog = onDemand(() => import("./HostDialog").then((m) => m.HostDialog))
export const EnvDialog = onDemand(() => import("./EnvDialog").then((m) => m.EnvDialog))
export const MarketplaceDialog = onDemand(() => import("./MarketplaceDialog").then((m) => m.MarketplaceDialog))
export const NewSessionDialog = onDemand(() => import("./NewSessionDialog").then((m) => m.NewSessionDialog))
