import { fmtBytes } from "./format.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

// A 9 KB markdown file used to read "0.0 MB".
eq("zero", fmtBytes(0), "0 B")
eq("bytes", fmtBytes(512), "512 B")
eq("small KB", fmtBytes(9067), "8.9 KB")
eq("large KB", fmtBytes(250 * 1024), "250 KB")
eq("MB", fmtBytes(3 * 1048576), "3.0 MB")
eq("invalid", fmtBytes(-1), "")

console.log(`${pass} passing${fail ? `, ${fail} FAILING` : ""}`)
if (fail) process.exit(1)
