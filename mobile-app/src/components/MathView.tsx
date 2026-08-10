/**
 * MathView — render a DISPLAY equation ($$…$$ / \[…\]) as full-fidelity KaTeX
 * inside a WebView, mirroring MermaidView: KaTeX from CDN → HTML, auto-sized to the
 * rendered height posted back over the RN↔web bridge. Inline math never reaches
 * here (it's Unicode-rendered natively in Markdown.tsx); only block equations do.
 *
 * CDN (not bundled) for parity with MermaidView and to avoid vendoring ~20 KaTeX
 * font files + a build step. Offline, the equation degrades to its LaTeX source
 * shown in monospace — the same graceful-degrade contract Mermaid uses. A malformed
 * formula renders KaTeX's error text (throwOnError:false) rather than blanking.
 *
 * The TeX is injected as a JSON string (never interpolated into markup) so formula
 * text can't break out of the template or inject script.
 */
import React, { useMemo, useRef, useState } from "react"
import { Text, View } from "react-native"
import { WebView } from "react-native-webview"

const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css"
const KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js"

function buildHtml(tex: string, dark: boolean, textColor: string): string {
  const texLiteral = JSON.stringify(tex)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<link rel="stylesheet" href="${KATEX_CSS}"/>
<style>
  html,body{margin:0;padding:0;background:transparent;color:${textColor};
    font-family:-apple-system,system-ui,sans-serif;overflow:hidden;}
  #d{display:flex;justify-content:center;padding:6px 2px;}
  .katex{color:${textColor};font-size:1.1em;}
  .err{color:#c0392b;font-size:12px;white-space:pre-wrap;padding:8px;}
</style></head><body>
<div id="d"></div>
<script src="${KATEX_JS}"></script>
<script>
  var tex = ${texLiteral};
  function post(h){ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(String(h)); }
  function draw(){
    try {
      if (!window.katex) { document.getElementById('d').textContent = tex; }
      else katex.render(tex, document.getElementById('d'), { displayMode:true, throwOnError:false, output:'html' });
    } catch(e) {
      document.getElementById('d').innerHTML = '<div class="err">'+ (tex||'') +'</div>';
    }
    // Report height so RN can size the WebView to the equation.
    setTimeout(function(){ post(document.body.scrollHeight || 40); }, 30);
  }
  if (document.readyState !== 'loading') draw(); else document.addEventListener('DOMContentLoaded', draw);
  window.addEventListener('load', draw);
</script>
</body></html>`
}

export default function MathView({ tex, dark, textColor }: { tex: string; dark: boolean; textColor: string }) {
  const [height, setHeight] = useState(44)
  const [failed, setFailed] = useState(false)
  const html = useMemo(() => buildHtml(tex, dark, textColor), [tex, dark, textColor])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // If the WebView never posts a height (offline + JS blocked, or a load error),
  // fall back to the raw LaTeX in monospace so the equation is still legible.
  const armFallback = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setFailed(true), 4000)
  }

  if (failed) {
    return (
      <View style={{ paddingVertical: 6 }}>
        <Text selectable style={{ color: textColor, fontFamily: "Menlo", fontSize: 13 }}>{tex}</Text>
      </View>
    )
  }
  return (
    <View style={{ height, marginVertical: 2 }}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        scrollEnabled={false}
        style={{ backgroundColor: "transparent", height }}
        onLoadStart={armFallback}
        onMessage={(e) => {
          if (timer.current) clearTimeout(timer.current)
          const h = parseInt(e.nativeEvent.data, 10)
          if (h > 0) setHeight(Math.min(h + 4, 400))
        }}
      />
    </View>
  )
}
