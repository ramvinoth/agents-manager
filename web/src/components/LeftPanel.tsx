import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SessionList } from "./SessionList"
import { SettingsPanel } from "./SettingsPanel"
import { StatsPanel } from "./StatsPanel"
import { useStore } from "@/store"

// The LHS tab set (Projects | Settings | Stats). Reused by the desktop sidebar and
// the mobile drawer. Profile lives in the header's account menu (ProfileDialog).
export function LeftPanel() {
  const lhsTab = useStore((s) => s.lhsTab)
  const setLhsTab = useStore((s) => s.setLhsTab)
  return (
    <Tabs
      value={["settings", "stats"].includes(lhsTab) ? lhsTab : "projects"}
      onValueChange={setLhsTab}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <TabsList className="m-2">
        <TabsTrigger value="projects">Projects</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="stats">Stats</TabsTrigger>
      </TabsList>
      <TabsContent value="projects" className="min-h-0 flex-1">
        <SessionList />
      </TabsContent>
      <TabsContent value="settings" className="min-h-0 flex-1">
        <SettingsPanel />
      </TabsContent>
      <TabsContent value="stats" className="min-h-0 flex-1">
        <StatsPanel />
      </TabsContent>
    </Tabs>
  )
}
