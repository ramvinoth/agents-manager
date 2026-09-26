import { describeLocation, isLiveLocation, vendorLabel, HOST_LOCATION } from "./location.ts"
import type { Drive } from "./types.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const D = (id: string, label: string, kind = "google"): Drive =>
  ({ id, label, kind, status: "active", hidden: false, authorized: true })
const drives = [D("dr-1", "Ram's Drive"), D("dr-2", "Work", "dropbox")]

eq("host location shows the host label", describeLocation(HOST_LOCATION, drives, "This machine"), "This machine")
eq("drive location shows the drive label", describeLocation("dr-2", drives, "This machine"), "Work")
eq("a removed drive falls back to the host label", describeLocation("dr-gone", drives, "This machine"), "This machine")

eq("host is always live", isLiveLocation(HOST_LOCATION, []), true)
eq("known drive is live", isLiveLocation("dr-1", drives), true)
eq("removed drive is not live", isLiveLocation("dr-1", []), false)

eq("known vendor gets a product name", vendorLabel("google"), "Google Drive")
eq("unknown vendor shows its kind", vendorLabel("box"), "box")

console.log(`location: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
