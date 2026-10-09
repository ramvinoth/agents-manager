import { isTransportError, userError } from "./errors.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.error(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
}
const err = (message: string, status?: number) => Object.assign(new Error(message), { status })

eq("server text passes", userError(err("Not a directory", 404), "this folder"), "Not a directory")
eq("bare 500", userError(err("HTTP 500", 500), "the board"), "Couldn't load the board. Try again.")
eq("bare 404", userError(err("HTTP 404", 404), "notes"), "This server doesn't support notes yet. Update Harman on the server.")
eq("bare 403", userError(err("HTTP 403", 403), "files"), "You don't have access to files.")
eq("401", userError(err("HTTP 401", 401), "x"), "Your sign-in expired. Reload the page and sign in again.")
eq("chrome offline", userError(new TypeError("Failed to fetch"), "x"), "Can't reach the Harman server. Check your connection and try again.")
eq("safari offline", userError(new TypeError("Load failed"), "x"), "Can't reach the Harman server. Check your connection and try again.")
eq("html as json", userError(new SyntaxError("Unexpected token '<', \"<!DOCTYPE\"... is not valid JSON"), "your inbox"), "Couldn't load your inbox. Try again.")
eq("verb", userError(err("HTTP 502", 502), "your message", "send"), "Couldn't send your message. Try again.")
eq("garbage", userError(undefined, "files"), "Couldn't load files. Try again.")
eq("string server text", userError("Name taken", "x"), "Name taken")
eq("transport needs no status", isTransportError(err("Failed to fetch", 502)), false)

console.log(`errors: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
