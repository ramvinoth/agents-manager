import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"
import path from "node:path"

const testPath = path.resolve(process.argv[1])
const require = createRequire(testPath)
const ts = require("typescript")
const source = ts.transpileModule(readFileSync(path.join(path.dirname(testPath), "audioSessionNative.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText

function fixture() {
  let backend: any
  let loaded!: (value: unknown) => void
  let update: (status: any) => void = () => {}
  let started = 0
  let unloaded = 0
  const sound = {
    setOnPlaybackStatusUpdate(fn: typeof update) { update = fn },
    async playAsync() { started++ },
    async unloadAsync() { unloaded++; update({ isLoaded: false }) },
    async setStatusAsync() {},
  }
  const Audio = { Sound: { createAsync(_uri: unknown, status: any, callback: typeof update) {
    if (callback) update = callback
    if (status.shouldPlay) started++
    return new Promise(resolve => { loaded = resolve })
  } } }
  vm.runInNewContext(source, {
    exports: {}, require: (name: string) => name === "expo-av" ? { Audio } : {
      AudioSession: class { constructor(b: any) { backend = b } },
    },
  })
  return { backend, load: () => loaded({ sound }), emit: (s: any) => update(s),
    started: () => started, unloaded: () => unloaded }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
async function main() {
{
  const f = fixture()
  const playing = f.backend.playToEnd("fixture.wav", {})
  const stopping = f.backend.stopPlayback()
  f.load()
  await Promise.all([playing, stopping])
  assert.equal(f.started(), 0, "stop during load must never start audio")
  assert.equal(f.unloaded(), 1, "cancel and finally share one unload")
}
{
  const f = fixture()
  const playing = f.backend.playToEnd("fixture.wav", {})
  f.load(); await tick()
  const rejected = assert.rejects(playing, /decode failed/)
  f.emit({ isLoaded: false, error: "decode failed" })
  await rejected
}
{
  const f = fixture()
  const playing = f.backend.playToEnd("fixture.wav", {})
  f.load(); await tick()
  await f.backend.stopPlayback()
  await playing
  assert.equal(f.started(), 1)
  assert.equal(f.unloaded(), 1)
}
{
  const f = fixture()
  const playing = f.backend.playToEnd("fixture.wav", {})
  f.load(); await tick()
  f.emit({ isLoaded: true, didJustFinish: true })
  await playing
  assert.equal(f.started(), 1)
  assert.equal(f.unloaded(), 1)
}
console.log("audioSessionNative: 4 playback lifecycle tests passed")
}
const watchdog = setTimeout(() => { console.error("Playback test did not settle"); process.exit(1) }, 5000)
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => clearTimeout(watchdog))
