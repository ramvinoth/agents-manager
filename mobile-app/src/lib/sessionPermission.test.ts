import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import ts from "typescript"

const settle = () => new Promise<void>(r => setImmediate(r))
function deferred() { let resolve!: (v: any) => void, reject!: (e: unknown) => void; const promise = new Promise<any>((r,j) => { resolve=r; reject=j }); return {promise, resolve, reject} }
function harness() {
  const slots: any[] = [], cleanups: any[] = [], pending: Function[] = []
  let cursor = 0
  const reads: any[] = [], writes: any[] = [], deviceWrites: any[] = []
  let params = {host:"local",path:"project/session-1.jsonl",sessionId:"session-1",agent:"claude"}
  const react = {
    createElement:(type:any,props:any,...children:any[])=>({type,props:props||{},children}),
    useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==="function"?initial():initial;return [slots[i],(v:any)=>{slots[i]=typeof v==="function"?v(slots[i]):v}]},
    useRef(initial:any){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i]},
    useEffect(fn:Function,deps:any[]){const i=cursor++;if(!slots[i]||deps.some((d,j)=>d!==slots[i][j])){slots[i]=deps;pending.push(()=>{cleanups[i]?.();cleanups[i]=fn()})}},
  }
  const modules:Record<string,any> = {
    react:{...react,default:react},
    "react-native":Object.fromEntries(["ActivityIndicator","ScrollView","Switch","Text","TextInput","TouchableOpacity","View"].map(x=>[x,x])),
    "../api/client":{api:{sessionDetail:(...args:any[])=>{const d=deferred();reads.push({args,...d});return d.promise},sessionModeSet:(...args:any[])=>{const d=deferred();writes.push({args,...d});return d.promise},sessionMeta:async()=>({}),sessionSummary:async()=>null,capabilities:async()=>({skills:[],mcp:[]}),loops:async()=>[],providers:async()=>({providers:[]}),aiConfig:async()=>({capabilities:{},selection:{}})}},
    "../state/config":{composerPrefs:()=>({mode:"bypassPermissions"}),setComposerPrefs:(v:any)=>deviceWrites.push(v),notifyEveryReply:()=>false},
    "../lib/aiSelection":{aiSummary:()=>"AI",aiError:(e:any)=>e.message},
    "../lib/avatars":{AVATARS:[]},"../lib/interval":{},"../lib/stats":{},"../lib/thread":{},
    "../lib/useTheme":{useTheme:()=>({})},"./styles":{useStyles:()=>({})},
    ...Object.fromEntries(["Avatar","Icon","JobScheduler","ProviderPicker"].map(x=>[`../components/${x}`,{default:x}])),
  }
  const js=ts.transpileModule(readFileSync(resolve(dirname(process.argv[1]),"../screens/SessionProfileScreen.tsx"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
  const exports:any={};new Function("require","exports",js)((name:string)=>{assert.ok(name in modules,name);return modules[name]},exports)
  function render(){cursor=0;return exports.default({route:{params},navigation:{}})}
  function find(tree:any,id:string):any {if(!tree||typeof tree!=="object")return;if(Array.isArray(tree))return tree.map(x=>find(x,id)).find(Boolean);return tree.props?.testID===id?tree:find(tree.children,id)}
  const node=(id:string)=>{const n=find(render(),id);assert.ok(n,id);return n}
  async function effects(){render();while(pending.length)pending.shift()!();await settle()}
  return {node,render,effects,reads,writes,deviceWrites,change:(p:Partial<typeof params>)=>{params={...params,...p}},unmount:()=>cleanups.forEach(fn=>fn?.())}
}

test("permission client uses existing authority endpoints and canonical target",async()=>{
  const calls:any[]=[]
  const source=readFileSync(resolve(dirname(process.argv[1]),"../api/client.ts"),"utf8")
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText
  const exports:any={}
  const modules:Record<string,any>={"../state/config":{serverUrl:()=>"https://fixture.invalid",token:()=>"test"},"../lib/model":{},"../lib/audit":{}}
  new Function("require","exports","fetch",js)((name:string)=>modules[name],exports,async(url:string,options:any)=>{
    calls.push({url,...options});return {ok:true,text:async()=>"{}"}
  })
  await exports.api.sessionDetail("remote", "p/session-1.jsonl")
  await exports.api.sessionModeSet("session-1","bypass")
  const url=new URL(calls[0].url)
  assert.equal(url.pathname,"/api/session-detail")
  assert.equal(url.searchParams.get("host"),"remote")
  assert.equal(url.searchParams.get("id"),"p/session-1.jsonl")
  assert.equal(new URL(calls[1].url).pathname,"/api/session/mode")
  assert.equal(calls[1].method,"POST")
  assert.deepEqual(JSON.parse(calls[1].body),{for_session:"session-1",mode:"bypass"})
})

test("profile saves canonical server policy, not device preference, only after ACK",async()=>{
  const h=harness();await h.effects()
  assert.equal(h.reads.length,1,"permission mode must be read from server")
  assert.equal(h.node("sp-mode-bypass").props.disabled,true)
  h.reads[0].resolve({session:"session-1",meta:{permission_mode:"acceptEdits"}});await settle()
  assert.equal(h.node("sp-mode-acceptEdits").props.accessibilityState.selected,true)
  const press=h.node("sp-mode-bypass").props.onPress
  const saving=press();press()
  assert.equal(h.writes.length,1)
  assert.deepEqual(h.writes[0].args,["session-1","bypass"])
  assert.equal(h.node("sp-mode-bypass").props.accessibilityState.selected,false)
  h.writes[0].resolve({session:"session-1",permission_mode:"bypass"});await saving
  assert.equal(h.node("sp-mode-bypass").props.accessibilityState.selected,true)
  assert.deepEqual(h.deviceWrites,[])
})

test("failed, queued and mismatched saves retain confirmed policy and allow retry",async()=>{
  const h=harness();await h.effects();h.reads[0].resolve({session:"session-1",meta:{permission_mode:"default"}});await settle()
  for(const result of [{error:"invalid"},{queued:true,approval:"a1"},{denied:true,reason:"Denied"},{session:"other",permission_mode:"bypass"}]){
    const saving=h.node("sp-mode-bypass").props.onPress();h.writes.at(-1).resolve(result);await saving
    assert.equal(h.node("sp-mode-default").props.accessibilityState.selected,true)
    assert.ok(h.node("sp-mode-error").children.join(""))
    assert.equal(h.node("sp-mode-bypass").props.disabled,false)
  }
  const saving=h.node("sp-mode-bypass").props.onPress();h.writes.at(-1).reject(new Error("Offline"));await saving
  assert.match(h.node("sp-mode-error").children.join(""),/Offline/)
})

test("unset policy is not inferred from composer preference; read failures retry",async()=>{
  const h=harness();await h.effects();h.reads[0].reject(new Error("Offline"));await settle()
  assert.equal(h.node("sp-mode-bypass").props.disabled,true)
  h.node("sp-mode-retry").props.onPress();await h.effects()
  h.reads[1].resolve({session:"session-1",meta:{permission_mode:""}});await settle()
  assert.equal(h.node("sp-mode-bypass").props.accessibilityState.selected,false)
  assert.match(JSON.stringify(h.render()),/No saved policy/)
})

test("path-only sessions use the server-resolved identity when saving",async()=>{
  const h=harness();h.change({sessionId:""});await h.effects()
  assert.deepEqual(h.reads[0].args,["local","project/session-1.jsonl"])
  h.reads[0].resolve({session:"session-1",meta:{permission_mode:""}});await settle()
  const saving=h.node("sp-mode-bypass").props.onPress()
  assert.deepEqual(h.writes[0].args,["session-1","bypass"])
  h.writes[0].resolve({session:"session-1",permission_mode:"bypass"});await saving
  h.unmount()
})

test("scope changes ignore old reads and writes; other harnesses have no controls",async()=>{
  const h=harness();await h.effects();h.reads[0].resolve({session:"session-1",meta:{permission_mode:"default"}});await settle()
  const saving=h.node("sp-mode-bypass").props.onPress()
  h.change({host:"remote",path:"p/session-2.jsonl",sessionId:"session-2"});await h.effects()
  h.reads[1].resolve({session:"session-2",meta:{permission_mode:"plan"}});await settle()
  h.writes[0].resolve({session:"session-1",permission_mode:"bypass"});await saving
  assert.equal(h.node("sp-mode-plan").props.accessibilityState.selected,true)
  h.change({sessionId:"session-3"});await h.effects()
  h.change({sessionId:"session-4"});await h.effects()
  h.reads[3].resolve({session:"session-4",meta:{permission_mode:"default"}});await settle()
  h.reads[2].resolve({session:"session-3",meta:{permission_mode:"bypass"}});await settle()
  assert.equal(h.node("sp-mode-default").props.accessibilityState.selected,true)
  h.change({agent:"codex"});await h.effects()
  assert.doesNotMatch(JSON.stringify(h.render()),/sp-mode-bypass/)
  h.unmount()
})
