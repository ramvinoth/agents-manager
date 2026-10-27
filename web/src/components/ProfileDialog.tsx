import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ProfilePanel } from "./ProfilePanel"

/** The account menu's Profile: the web's orchestration control point in a modal. */
export function ProfileDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-2 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Profile</DialogTitle>
          <DialogDescription className="sr-only">Automation, loops, AI defaults and devices</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <ProfilePanel />
        </div>
      </DialogContent>
    </Dialog>
  )
}
