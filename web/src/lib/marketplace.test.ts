import assert from "node:assert/strict"
import { filledValues, installNote, missingInput, signinRedirectProblem } from "./marketplace.ts"

const KEY = { name: "API_KEY", description: "", secret: true, required: true, default: "" }
const DIR = { name: "DIR", description: "", secret: false, required: false, default: "" }
assert.equal(missingInput([KEY, DIR], { API_KEY: "  " })?.name, "API_KEY")
assert.equal(missingInput([KEY, DIR], { API_KEY: "k" }), null)
assert.deepEqual(filledValues({ API_KEY: " k ", DIR: "" }), { API_KEY: "k" })
const base = { id: "a/b", title: "b", description: "", repo: "" }
assert.equal(installNote("mcp", { ...base, install: "remote" }), "Hosted")
assert.equal(installNote("mcp", { ...base, install: "pypi" }), "pypi")
assert.equal(installNote("mcp", { ...base, install: null }), "Not installable here")
assert.equal(installNote("skills", { ...base, license: "MIT" }), "MIT")
assert.equal(installNote("mcp", { id: "m/w", title: "w", description: "", repo: "", install: "remote", featured: true, publisher: "Microsoft" }), "Featured · Microsoft")
assert.equal(signinRedirectProblem(""), "Paste the address first.")
assert.match(signinRedirectProblem("localhost:12798/callback")!, /web address/)
assert.match(signinRedirectProblem("http://localhost:12798/callback?state=s")!, /no sign-in code/)
assert.equal(signinRedirectProblem("http://localhost:12798/callback?error=access_denied&error_description=Admin%20consent%20required"), "Admin consent required")
assert.equal(signinRedirectProblem(" http://localhost:12798/callback?code=abc&state=s "), null)
console.log("marketplace: ok")
