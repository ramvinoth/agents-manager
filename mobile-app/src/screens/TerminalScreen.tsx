import React, { useEffect, useRef } from "react"
import { KeyboardAvoidingView, Platform } from "react-native"
import { WebView, type WebViewMessageEvent } from "react-native-webview"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import type { RootStackParamList } from "../../App"
import { attachTerminal, detachTerminal, sendTerminal } from "../lib/terminalSession"

type Props = NativeStackScreenProps<RootStackParamList, "Terminal">

/**
 * Terminal = xterm.js in a WebView, but the WebSocket lives in RN.
 *
 * Why the split: a browser WebSocket (inside the WebView) can't set an
 * Authorization header, so it couldn't authenticate to /api/terminal/ws. RN's
 * WebSocket *can* send headers, so RN owns the socket and bridges bytes to/from
 * the WebView over postMessage.
 *
 * The socket itself lives in lib/terminalSession (a module singleton) so it
 * SURVIVES NAVIGATION: leaving to Files/Chat and coming back reuses the same PTY
 * and replays buffered scrollback into a fresh xterm — the shell doesn't die.
 * (Full app close still reaps the PTY server-side; that would need a reattachable
 * server session.)
 *
 * NOTE: xterm is loaded from a CDN here; for production, bundle it as an asset so
 * the terminal works offline/air-gapped.
 */

const HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css"/>
<script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<style>
  html,body{height:100%;margin:0;background:#000;overflow:hidden}
  #wrap{display:flex;flex-direction:column;height:100%}
  #t{flex:1;min-height:0}
  /* Key bar: a horizontally-scrollable strip of special keys the iOS keyboard lacks. */
  #bar{display:flex;gap:6px;padding:6px 8px;background:#161616;border-top:1px solid #2a2a2a;
       overflow-x:auto;-webkit-overflow-scrolling:touch;white-space:nowrap}
  .k{flex:0 0 auto;min-width:42px;height:34px;border-radius:7px;border:1px solid #333;background:#242424;
     color:#e8e8e8;font:600 13px -apple-system,system-ui,sans-serif;display:inline-flex;align-items:center;
     justify-content:center;padding:0 10px;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
  .k:active{background:#333}
  /* Sticky modifier states: armed = next key gets the modifier; locked = stays until untapped. */
  .k.armed{background:#3a3320;border-color:#c8842e;color:#ffcf8f}
  .k.locked{background:#4a2f12;border-color:#ff9d3c;color:#ff9d3c}
</style></head>
<body><div id="wrap"><div id="t"></div>
<div id="bar">
  <div class="k" data-seq="\\x1b">Esc</div>
  <div class="k" data-seq="\\t">Tab</div>
  <div class="k" data-mod="ctrl">Ctrl</div>
  <div class="k" data-mod="alt">Alt</div>
  <div class="k" data-seq="\\x1b[D">←</div>
  <div class="k" data-seq="\\x1b[A">↑</div>
  <div class="k" data-seq="\\x1b[B">↓</div>
  <div class="k" data-seq="\\x1b[C">→</div>
  <div class="k" data-seq="\\x1b[H">Home</div>
  <div class="k" data-seq="\\x1b[F">End</div>
  <div class="k" data-seq="\\x1b[5~">PgUp</div>
  <div class="k" data-seq="\\x1b[6~">PgDn</div>
  <div class="k" data-lit="/">/</div>
  <div class="k" data-lit="-">-</div>
  <div class="k" data-lit="|">|</div>
  <div class="k" data-lit="~">~</div>
</div></div>
<script>
  var term = new Terminal({ fontSize: 13, convertEol: true })
  var fit = new FitAddon.FitAddon()
  term.loadAddon(fit); term.open(document.getElementById('t')); fit.fit()
  function post(o){ window.ReactNativeWebView.postMessage(JSON.stringify(o)) }
  function send(d){ post({ t: 'i', d: d }) }
  post({ t: 'size', cols: term.cols, rows: term.rows })

  // Sticky modifier state: 0=off, 1=armed (one-shot), 2=locked. Ctrl/Alt transform
  // the NEXT character so touch users can send Ctrl+C, Alt+b, etc.
  var mod = { ctrl: 0, alt: 0 }
  function modBtn(name){ return document.querySelector('.k[data-mod="'+name+'"]') }
  function paintMod(name){
    var b = modBtn(name); b.classList.remove('armed','locked')
    if (mod[name]===1) b.classList.add('armed'); else if (mod[name]===2) b.classList.add('locked')
  }
  function cycleMod(name){ mod[name] = (mod[name]+1)%3; paintMod(name) }
  function clearOneShot(){ if(mod.ctrl===1){mod.ctrl=0;paintMod('ctrl')} if(mod.alt===1){mod.alt=0;paintMod('alt')} }

  // Apply armed/locked modifiers to a single typed character, then clear one-shots.
  function applyMods(ch){
    var out = ch
    if (mod.ctrl && ch.length===1){
      var c = ch.toLowerCase().charCodeAt(0)
      if (c>=97 && c<=122) out = String.fromCharCode(c-96)      // Ctrl-A..Z
      else if (ch==='[') out='\\x1b'; else if (ch===' ') out='\\x00'
    }
    if (mod.alt && out.length>=1) out = '\\x1b' + out           // Alt = ESC prefix
    clearOneShot()
    return out
  }

  // Keyboard input flows through here so modifiers can transform it.
  term.onData(function(d){
    if ((mod.ctrl||mod.alt) && d.length===1) send(applyMods(d))
    else { send(d); if (d.length===1) clearOneShot() }
  })

  // Key-bar taps. Sequences/literals also honor an armed Ctrl/Alt.
  // CRITICAL: a tap on a bar button must NOT blur xterm's hidden textarea, or
  // iOS dismisses the keyboard (the Termius/VNC gotcha). We handle the action on
  // pointerdown and preventDefault there — that suppresses the focus shift (and
  // the synthetic click) while keeping the keyboard up. Then refocus the terminal.
  function onKey(e){
    var k = e.target.closest('.k'); if(!k) return
    e.preventDefault()  // don't let the button steal focus from the terminal
    if (k.dataset.mod){ cycleMod(k.dataset.mod); term.focus(); return }
    var lit = k.dataset.lit
    if (lit != null){ send((mod.ctrl||mod.alt) ? applyMods(lit) : lit); term.focus(); return }
    var seq = JSON.parse('"' + k.dataset.seq + '"')  // decode \\x1b etc.
    send(seq); if (!k.dataset.mod) clearOneShot()
    term.focus()
  }
  var bar = document.getElementById('bar')
  // pointerdown (not click) so we act before focus can shift; preventDefault above
  // keeps the keyboard up. One listener — touch generates pointer events too, so a
  // touchstart listener as well would double-fire each key.
  bar.addEventListener('pointerdown', onKey)

  window.addEventListener('resize', function(){ fit.fit(); post({ t: 'r', cols: term.cols, rows: term.rows }) })
  window.__recv = function(b64){
    var bin = atob(b64), arr = new Uint8Array(bin.length)
    for (var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i)
    term.write(arr)
  }
</script></body></html>`

export default function TerminalScreen({ route }: Props) {
  const { host } = route.params
  const webref = useRef<WebView>(null)
  // The per-mount writer identity — used to attach/detach the singleton cleanly.
  const writer = useRef<(b64: string) => void>((b64) => {
    webref.current?.injectJavaScript(`window.__recv(${JSON.stringify(b64)});true;`)
  })

  // Detach (but do NOT close) the socket when navigating away, so the PTY lives on.
  useEffect(() => {
    const w = writer.current
    return () => detachTerminal(w)
  }, [])

  function onMessage(e: WebViewMessageEvent) {
    let msg: { t: string; cols?: number; rows?: number; d?: string }
    try {
      msg = JSON.parse(e.nativeEvent.data)
    } catch {
      return
    }
    if (msg.t === "size") {
      // Attach to (or open) the shared session, then replay buffered scrollback
      // into this freshly-mounted xterm so it looks like we never left.
      const replay = attachTerminal(host, msg.cols || 80, msg.rows || 24, writer.current)
      for (const b64 of replay) writer.current(b64)
      return
    }
    // Input `{t:"i",d}` and resize `{t:"r",cols,rows}` are already in the server's
    // wire format — forward verbatim to the PTY.
    sendTerminal(e.nativeEvent.data)
  }

  return (
    // Shrink the WebView above the iOS keyboard so its bottom key bar stays
    // visible instead of being buried behind the keyboard. `padding` behavior
    // resizes the container; xterm's fit addon then reflows on the resize event.
    // The offset accounts for the navigation header height (~92pt on iOS).
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#000" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 92 : 0}
    >
      <WebView
        ref={webref}
        originWhitelist={["*"]}
        source={{ html: HTML }}
        onMessage={onMessage}
        // xterm needs JS; keep the bridge tight.
        javaScriptEnabled
      />
    </KeyboardAvoidingView>
  )
}
