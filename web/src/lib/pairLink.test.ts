import { buildPairLink, unreachableReason } from "./pairLink.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

eq("link encodes url, drops trailing slash", buildPairLink(" https://agents.suhai.ai/ ", "abc_-1"),
  "agents://pair?url=https%3A%2F%2Fagents.suhai.ai&code=abc_-1")
eq("tailnet ip is fine", unreachableReason("http://100.64.0.2:8091"), "")
eq("domain is fine", unreachableReason("https://agents.suhai.ai"), "")
eq("localhost flagged", unreachableReason("http://localhost:8091") !== "", true)
eq("127.x flagged", unreachableReason("http://127.0.0.1:8091") !== "", true)
eq("ipv6 loopback flagged", unreachableReason("http://[::1]:8091") !== "", true)
eq("garbage flagged", unreachableReason("not a url") !== "", true)
eq("non-http flagged", unreachableReason("ftp://x") !== "", true)

console.log(`pairLink: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
