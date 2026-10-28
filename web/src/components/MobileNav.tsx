import { Menu } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { LeftPanel } from "./LeftPanel"

// Drawer access to the left rail on narrow screens (it is hidden below md).

/** < md: opens Projects/Settings/Stats from the left. Controlled by the
 *  Header so its chat-context label can open the same drawer. */
export function MobileLeftNav({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 shrink-0 md:hidden" aria-label="Open projects">
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-80 gap-0 p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Projects, Files, Settings, Stats</SheetTitle>
        </SheetHeader>
        <div className="h-full pt-2">
          <LeftPanel />
        </div>
      </SheetContent>
    </Sheet>
  )
}
