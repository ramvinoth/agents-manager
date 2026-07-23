import { Menu, PanelRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { LeftPanel } from "./LeftPanel"
import { RhsPanel } from "./RhsPanel"

// Drawer access to the side panels on narrow screens (the sidebars are hidden
// below md/lg). The left button (< md) opens Sessions/Settings/Stats; the right
// button (< lg) opens Skills/MCP.
export function MobileNav() {
  return (
    <>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 md:hidden" aria-label="Open sessions">
            <Menu className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-80 gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Sessions, Settings, Stats</SheetTitle>
          </SheetHeader>
          <div className="h-full pt-2">
            <LeftPanel />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7 lg:hidden" aria-label="Open skills">
            <PanelRight className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="right" className="w-80 gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Skills and MCP servers</SheetTitle>
          </SheetHeader>
          <div className="h-full pt-2">
            <RhsPanel />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
