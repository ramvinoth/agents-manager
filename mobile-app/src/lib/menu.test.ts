import { MENU_SECTIONS } from "./menu.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const routes = MENU_SECTIONS.flatMap((s) => s.items.map((i) => i.route))
eq("each destination listed once", routes.length, new Set(routes).size)
eq("files, notes, agents moved off the tab bar into the menu", ["Files", "Notes", "Agents"].every((r) => routes.includes(r as never)), true)
eq("no section is empty", MENU_SECTIONS.every((s) => s.items.length > 0), true)
eq("every item explains itself", MENU_SECTIONS.every((s) => s.items.every((i) => i.label && i.hint)), true)

console.log(`menu: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
