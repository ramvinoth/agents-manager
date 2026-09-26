import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test } from "node:test"
import ts from "typescript"
import * as selection from "./aiSelection.ts"

type Node = {type: string; props: Record<string, any>; children: unknown[]}
const settle = () => new Promise<void>(r => setImmediate(r))
function deferred() { let resolve!: (v: any) => void, reject!: (e: unknown) => void; const promise = new Promise<any>((r,j) => { resolve=r; reject=j }); return {promise, resolve, reject} }
function harness(localOnly = false) {
  const slots: any[] = [], cleanups: Function[] = [], pending: Function[] = []
  let cursor = 0, closed = 0
  const saves: any[] = [], discoveries: ReturnType<typeof deferred>[] = [], alerts: any[][] = [], results: selection.AIConfig[] = []
  const caps = {editable: true, customProviders: true, conversationModes: ["agent","chat"], efforts: [""], manualModelId: true}
  const config: selection.AIConfig = {revision: 2, configured: true, selection: {provider: "", model: {kind:"default"}, convMode:"agent", effort:""}, capabilities:caps}
  const react = {
    createElement: (type: string, props: any, ...children: unknown[]) => ({type,props: props || {},children}),
    useState(initial: any) { const i=cursor++; if (!(i in slots)) slots[i]=initial; return [slots[i], (v:any) => {slots[i]=typeof v === "function" ? v(slots[i]) : v}] },
    useRef(initial:any) { const i=cursor++; if (!(i in slots)) slots[i]={current:initial}; return slots[i] },
    useEffect(fn:Function, deps:any[]) { const i=cursor++; if (!slots[i] || deps.some((d,j)=>d!==slots[i][j])) {slots[i]=deps; pending.push(()=>{cleanups[i]?.(); cleanups[i]=fn()})} },
  }
  const modules: Record<string, any> = {
    react: {...react,default:react},
    "react-native": {...Object.fromEntries(["ActivityIndicator","FlatList","Modal","SafeAreaView","Text","TextInput","TouchableOpacity","View"].map(x=>[x,x])), Alert:{alert:(...args:any[])=>alerts.push(args)}},
    "../api/client":{api:{aiConfig:async()=>config,providerModels:()=>{const d=deferred();discoveries.push(d);return d.promise},aiSave:(...args:any[])=>{const d=deferred();saves.push({args,...d});return d.promise}}},
    "../lib/aiSelection":selection,"../lib/useTheme":{useTheme:()=>({})},"../screens/styles":{useStyles:()=>({})},
  }
  const js=ts.transpileModule(readFileSync(resolve(dirname(process.argv[1]),"../components/ProviderPicker.tsx"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
  const exports:any={};new Function("require","exports",js)((name:string)=>{assert.ok(name in modules,name);return modules[name]},exports)
  function render() {cursor=0;return exports.default({config,scope:{host:"local"},providers:[{id:"custom",name:"Custom"}],title:"Defaults",localOnly,onSave:(r:selection.AIConfig)=>results.push(r),onClose:()=>closed++})}
  function find(tree:any,id:string):Node|undefined {if (!tree || typeof tree!=="object")return; if(Array.isArray(tree)){for(const x of tree){const n=find(x,id);if(n)return n}return} if(tree.props?.testID===id)return tree;return find(tree.children,id)||find(tree.props?.ListHeaderComponent,id)}
  const node=(id:string)=>{const n=find(render(),id);assert.ok(n,id);return n}
  async function effects(){render();while(pending.length)pending.shift()!();await settle()}
  return {node,render,effects,saves,discoveries,alerts,results,closed:()=>closed}
}

test("editor stages rows, cancel has no write, failed save retains full ID and draft",async()=>{
  const h=harness();await h.effects()
  h.node("ai-model-manual").props.onChangeText("vendor/full-id")
  h.node("ai-cancel").props.onPress()
  assert.equal(h.saves.length,0);assert.equal(h.closed(),0)
  assert.equal(h.alerts[0][2][0].text,"Keep editing")
  const saving=h.node("ai-save").props.onPress();assert.equal(h.saves.length,1)
  assert.equal(h.saves[0].args[1],2)
  assert.deepEqual(h.saves[0].args[2].model,{kind:"id",id:"vendor/full-id"})
  h.saves[0].reject({status:409});await saving
  assert.equal(h.node("ai-model-manual").props.value,"vendor/full-id")
  assert.match(JSON.stringify(h.node("ai-error")),/draft is kept/)
  assert.equal(h.closed(),0)
})
test("obsolete provider discovery cannot replace current choices",async()=>{
  const h=harness();await h.effects()
  h.node("ai-provider-custom").props.onPress();await h.effects()
  h.discoveries[1].resolve({status:"ok",choices:[{id:"new",label:"new"}],models:["new"]});await settle()
  h.discoveries[0].resolve({status:"ok",choices:[{id:"stale",label:"stale"}],models:["stale"]});await settle()
  const findList=(n:any):any=>!n || typeof n!=="object" ? undefined : n.type==="FlatList"?n:Array.isArray(n)?n.map(findList).find(Boolean):findList(n.children)
  assert.deepEqual(findList(h.render()).props.data.map((r:any)=>r.id),["new"])
})
test("NewChat use selection is local-only and cancel discard writes nothing",async()=>{
  const h=harness(true);await h.effects();h.node("ai-model-manual").props.onChangeText("full/id")
  await h.node("ai-save").props.onPress();assert.equal(h.saves.length,0);assert.equal(h.results[0].selection.model?.kind,"id");assert.equal(h.closed(),1)
  const other=harness();await other.effects();other.node("ai-model-manual").props.onChangeText("discard")
  other.node("ai-cancel").props.onPress();other.alerts[0][2][1].onPress();assert.equal(other.closed(),1);assert.equal(other.saves.length,0)
})
