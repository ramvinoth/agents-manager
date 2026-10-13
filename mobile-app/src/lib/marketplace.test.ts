import { test } from "node:test"
import assert from "node:assert/strict"
import { filledValues, installNote, missingInput, signinRedirectProblem, scopes } from "./marketplace.ts"

const KEY = { name: "API_KEY", description: "", secret: true, required: true, default: "" }
const DIR = { name: "DIR", description: "", secret: false, required: false, default: "" }

test("a required input left blank (or whitespace) blocks install; optional ones never do", () => {
  assert.equal(missingInput([KEY, DIR], { API_KEY: "  " })?.name, "API_KEY")
  assert.equal(missingInput([KEY, DIR], { API_KEY: "k" }), null)
})

test("only filled inputs are sent, trimmed", () => {
  assert.deepEqual(filledValues({ API_KEY: " k ", DIR: "" }), { API_KEY: "k" })
})

test("the badge says how an entry runs, or that it can't be installed here", () => {
  const base = { id: "a/b", title: "b", description: "", repo: "" }
  assert.equal(installNote("mcp", { ...base, install: "remote" }), "Hosted")
  assert.equal(installNote("mcp", { ...base, install: "npm" }), "npm")
  assert.equal(installNote("mcp", { ...base, install: null }), "Not installable here")
  assert.equal(installNote("skills", { ...base, license: "MIT" }), "MIT")
  assert.equal(installNote("skills", base), "skill")
})

test("a project install is offered only when the session's folder is known", () => {
  assert.deepEqual(scopes(), ["global"])
  assert.deepEqual(scopes("/repo"), ["global", "project"])
})

test("a this-chat install is offered only for an open local Claude chat", () => {
  assert.deepEqual(scopes("/repo", true), ["global", "project", "chat"])
  assert.deepEqual(scopes(undefined, true), ["global", "chat"])
})

test("from an agent's editor the install lands on that agent only", () => {
  assert.deepEqual(scopes("/repo", true, true), ["agent"])
})

test("a featured plugin says who publishes it", () => {
  assert.equal(installNote("mcp", { id: "m/w", title: "w", description: "", repo: "", install: "remote", featured: true, publisher: "Microsoft" }), "Featured · Microsoft")
})

test("a pasted sign-in address must be whole and carry its code", () => {
  assert.equal(signinRedirectProblem(""), "Paste the address first.")
  assert.match(signinRedirectProblem("localhost:12798/callback")!, /web address/)
  assert.match(signinRedirectProblem("http://localhost:12798/callback?state=s")!, /no sign-in code/)
  assert.equal(signinRedirectProblem("http://localhost:12798/callback?error=access_denied&error_description=Admin%20consent%20required"), "Admin consent required")
  assert.equal(signinRedirectProblem(" http://localhost:12798/callback?code=abc&state=s "), null)
})
