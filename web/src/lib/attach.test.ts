import assert from "node:assert/strict"
import { uniqueName, withAttachments } from "./attach.ts"

assert.equal(uniqueName("My Clip (1).mov", 5), "5-My_Clip_1_.mov")
assert.equal(uniqueName("../../etc/passwd", 5), "5-etc_passwd")
assert.equal(uniqueName("...", 7), "7-file")
assert.equal(withAttachments("", ["/a"]), "(File attached at /a)")
assert.equal(withAttachments("hi \n", ["/a", "/b"]), "hi\n\n(File attached at /a)\n\n(File attached at /b)")
console.log("attach ok")
