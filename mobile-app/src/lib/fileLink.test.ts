import { fileLinkPath, splitPath } from "./fileLink.ts"

let pass = 0, fail = 0
function eq(label: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++
  else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}
const cwd = "/srv/repo"
eq("relative", fileLinkPath("docs/report.md", cwd), "/srv/repo/docs/report.md")
eq("dot relative", fileLinkPath("./docs/report.md", cwd), "/srv/repo/docs/report.md")
eq("parent", fileLinkPath("../other/x.md", cwd), "/srv/other/x.md")
eq("parent never above root", fileLinkPath("../../../../x", cwd), "/x")
eq("trailing slash cwd", fileLinkPath("a.md", "/srv/repo/"), "/srv/repo/a.md")
eq("absolute", fileLinkPath("/etc/hosts", cwd), "/etc/hosts")
eq("home", fileLinkPath("~/notes/a.md", cwd), "~/notes/a.md")
eq("home parent stays in home", fileLinkPath("~/../a", cwd), "~/a")
eq("file url", fileLinkPath("file:///srv/a%20b.md", cwd), "/srv/a b.md")
eq("angle brackets", fileLinkPath("<docs/a b.md>", cwd), "/srv/repo/docs/a b.md")
eq("line anchor dropped", fileLinkPath("src/x.ts#L12", cwd), "/srv/repo/src/x.ts")
eq("relative without cwd", fileLinkPath("docs/a.md", undefined), null)
eq("absolute without cwd", fileLinkPath("/a.md", null), "/a.md")
eq("https", fileLinkPath("https://example.com/a.md", cwd), null)
eq("mailto", fileLinkPath("mailto:a@b.c", cwd), null)
eq("javascript", fileLinkPath("javascript:alert(1)", cwd), null)
eq("protocol-relative", fileLinkPath("//example.com/x", cwd), null)
eq("anchor", fileLinkPath("#section", cwd), null)
eq("empty", fileLinkPath("  ", cwd), null)
eq("split", splitPath("/srv/repo/a.md"), { dir: "/srv/repo", name: "a.md" })
eq("split root", splitPath("/a.md"), { dir: "/", name: "a.md" })

console.log(`fileLink: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
