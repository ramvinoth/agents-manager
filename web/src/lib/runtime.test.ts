import { RUNTIME_OPTIONS, isRuntime, runtimeSaved, runtimeSummary } from "./runtime.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("options", RUNTIME_OPTIONS.map((o) => o.v), ["", "local", "sandbox"])
eq("known", isRuntime("sandbox"), true)
eq("unknown", isRuntime("moon"), false)
eq("empty is not a runtime", isRuntime(""), false)
eq("loading", runtimeSummary("", ""), "Loading…")
eq("default", runtimeSummary("", "local"), "Server (server default)")
eq("chosen", runtimeSummary("sandbox", "sandbox"), "Cloud sandbox")
eq("saved", runtimeSaved({ saved: true, runtime: "sandbox" }, "sandbox"), true)
eq("cleared", runtimeSaved({ saved: true, runtime: "" }, ""), true)
eq("old server omits runtime", runtimeSaved({ saved: true }, "sandbox"), false)
eq("mismatch", runtimeSaved({ saved: true, runtime: "local" }, "sandbox"), false)
eq("not saved", runtimeSaved({ error: "x" }, ""), false)
eq("null", runtimeSaved(null, ""), false)

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
