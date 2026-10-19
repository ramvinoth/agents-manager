import { Menu, PanelRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { LeftPanel } from "./LeftPanel"
import { RhsPanel } from "./RhsPanel"

// Drawer access to the side panels on narrow screens (the sidebars are hidden
// below md/lg). Each trigger sits on the side its drawer opens from, where the
// wide-screen toggle for the same panel sits in the Header.

/** < md: opens Projects/Settings/Stats from the left. */
export function MobileLeftNav() {
  return (
    <Sheet>
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

/** < lg: opens Skills/MCP/Plugins from the right. */
export function MobileRightNav() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 shrink-0 lg:hidden" aria-label="Open skills">
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
  )
}
