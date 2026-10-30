import { chatPluginsApply, pluginScopeNote } from "./chatPlugins.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
function ok(label: string, cond: boolean) {
  if (cond) pass++
  else { fail++; console.log(`FAIL ${label}`) }
}

const local = { host: "local", agent: "claude", session: "-Users-x/abc.jsonl" }
eq("local claude chat applies", chatPluginsApply(local), true)
eq("local claude chat has no note", pluginScopeNote(local), null)
eq("no open chat", chatPluginsApply({ ...local, session: "" }), false)
ok("no open chat says open one", /Open one/.test(pluginScopeNote({ ...local, session: null }) ?? ""))
ok("remote says another machine", /another machine/.test(pluginScopeNote({ ...local, host: "box1" }) ?? ""))
eq("codex", pluginScopeNote({ ...local, agent: "codex" }), "Codex chats don't load plugins. Plugins apply to Claude chats on this Mac.")
ok("copilot", /^Copilot chats/.test(pluginScopeNote({ ...local, agent: "copilot" }) ?? ""))
ok("remote codex names the agent first", /^Codex/.test(pluginScopeNote({ host: "box1", agent: "codex", session: "s" }) ?? ""))
ok("unknown agent still explains", /^gemini chats/.test(pluginScopeNote({ ...local, agent: "gemini" }) ?? ""))

console.log(`chatPlugins: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
