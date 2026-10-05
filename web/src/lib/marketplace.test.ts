import assert from "node:assert/strict"
import { filledValues, installNote, missingInput } from "./marketplace.ts"

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
console.log("marketplace: ok")
