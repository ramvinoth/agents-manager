// The side menu's contents: every destination that is not a daily bottom tab.
// One list, so the menu, its tests and the e2e specs agree on what exists.
import type { IconName } from "../components/Icon"

/** Root-stack routes the menu may open — each takes no params. */
export type MenuRoute = "Files" | "Notes" | "Agents" | "Org" | "Integrations" | "Capabilities" | "Audit"
export type MenuItem = { route: MenuRoute; label: string; hint: string; icon: IconName }
export type MenuSection = { title: string; items: MenuItem[] }

export const MENU_SECTIONS: MenuSection[] = [
  {
    title: "Workspace",
    items: [
      { route: "Files", label: "Files", hint: "This machine and connected drives", icon: "folder" },
      { route: "Notes", label: "Notes", hint: "Research, decisions, journals", icon: "book" },
      { route: "Org", label: "Company & boards", hint: "Projects, people, the work board", icon: "clipboard" },
      { route: "Agents", label: "Agents", hint: "Start an agent from a template", icon: "sparkle" },
    ],
  },
  {
    title: "Connect",
    items: [
      { route: "Integrations", label: "Integrations", hint: "Google, Dropbox, OneDrive — what agents may use", icon: "cloud" },
      { route: "Capabilities", label: "Skills & tools", hint: "Skills and MCP tools your agents have", icon: "tool" },
    ],
  },
  {
    title: "Oversight",
    items: [
      { route: "Audit", label: "Activity", hint: "Every action agents took, and who allowed it", icon: "shield" },
    ],
  },
]
