/**
 * MermaidView — render a Mermaid diagram inside a WebView, with a toolbar to
 * toggle between the rendered diagram and its source code, Copy, and Download.
 *
 * React Native can't run Mermaid natively (it needs a DOM), so the diagram is drawn
 * in a WebView (mermaid.js from CDN → SVG), auto-sized to the SVG height posted back
 * over the RN↔web bridge. "Code" mode shows the raw ```mermaid source in a wrapping
 * code block (multiline, so it never collapses to an empty overlay), and Copy puts
 * the source on the clipboard. Download rasterises the SVG to a PNG inside the
 * WebView, ships the base64 back over the bridge, writes it to a temp file, and
 * opens the OS share sheet. A failed diagram shows "Diagram error" in the WebView;
 * the user can still switch to Code and copy it.
 *
 * Expand opens the same diagram full screen in a second, zoomable WebView: the
 * viewport allows pinch-zoom (WKWebView redraws the SVG sharp at every scale) and
 * scrolling pans. Tapping the inline diagram opens it too.
 *
 * The mermaid source is injected as a JSON string (not interpolated into markup) so
 * diagram text can't break out of the template or inject script.
 */
import React, { useMemo, useRef, useState } from "react"
import { Modal, Pressable, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { WebView } from "react-native-webview"
import * as Clipboard from "expo-clipboard"
import * as FileSystem from "expo-file-system"
import * as Sharing from "expo-sharing"
import { useTheme } from "../lib/useTheme"
import { showActions } from "../lib/actionSheet"

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"

// zoomable: the full-screen variant — pinch-zoom allowed, page scrolls, the
// diagram is centred in the viewport. Inline it is fixed-scale and auto-sized.
function buildHtml(src: string, dark: boolean, textColor: string, zoomable = false): string {
  const srcLiteral = JSON.stringify(src)
  const theme = dark ? "dark" : "default"
  const viewport = zoomable ? "maximum-scale=8, user-scalable=yes" : "maximum-scale=1"
  const page = zoomable ? "min-height:100vh;align-items:center;padding:12px;box-sizing:border-box;" : "padding:4px 0;"
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, ${viewport}"/>
<style>
  html,body{margin:0;padding:0;background:transparent;color:${textColor};
    font-family:-apple-system,system-ui,sans-serif;${zoomable ? "" : "overflow:hidden;"}}
  #d{display:flex;justify-content:center;${page}}
  #d svg{max-width:100%;height:auto;}
  .err{color:#c0392b;font-size:12px;white-space:pre-wrap;padding:8px;}
</style></head><body>
<div id="d"></div>
<script src="${MERMAID_CDN}"></script>
<script>
  var SRC = ${srcLiteral};
  var DARK_BG = "#0d1117";
  function post(o){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(o)); }catch(e){} }
  // Common mermaid options. htmlLabels:false uses native <text> instead of
  // <foreignObject> HTML — the latter taints a <canvas>, which made PNG export
  // throw and silently fall back to SVG.
  function mmInit(themeName){
    mermaid.initialize({ startOnLoad:false, securityLevel:"strict", theme:themeName,
      fontFamily:"inherit", flowchart:{ htmlLabels:false }, htmlLabels:false });
  }
  // Render a fresh DARK diagram from source, with a full-bleed dark background
  // rect inserted, so exports read well standalone regardless of the app theme.
  function renderDark(cb){
    mmInit("dark");
    mermaid.render("gexp", SRC).then(function(r){
      var svg = r.svg.replace(/(<svg\\b[^>]*>)/, '$1<rect x="0" y="0" width="100%" height="100%" fill="' + DARK_BG + '"/>');
      // restore the display theme for any later on-screen renders
      mmInit(${JSON.stringify(theme)});
      cb(svg);
    }).catch(function(){ cb(null); });
  }
  // Download bridge: rasterise a fresh DARK diagram to a PNG data URL, sized off
  // the intrinsic viewBox and over-sampled 3x for crisp text.
  window.__exportPng = function(){
    renderDark(function(darkSvg){
      if(!darkSvg){ post({type:"png", error:"render"}); return; }
      try {
        var doc = new DOMParser().parseFromString(darkSvg, "image/svg+xml");
        var svg = doc.documentElement;
        var vbAttr = (svg.getAttribute("viewBox")||"").split(/[\\s,]+/).map(Number);
        var w = Math.max(1, Math.ceil((vbAttr[2]) || Number(svg.getAttribute("width")) || 800));
        var h = Math.max(1, Math.ceil((vbAttr[3]) || Number(svg.getAttribute("height")) || 600));
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        var xml = new XMLSerializer().serializeToString(svg);
        var svg64 = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
        var img = new Image();
        var scale = 3;
        img.onload = function(){
          try {
            var c = document.createElement("canvas");
            c.width = w*scale; c.height = h*scale;
            var ctx = c.getContext("2d");
            ctx.fillStyle = DARK_BG; ctx.fillRect(0,0,c.width,c.height);
            ctx.drawImage(img,0,0,c.width,c.height);
            post({type:"png", data:c.toDataURL("image/png").split(",")[1]});
          } catch(e){ post({type:"png", error:String(e)}); }
        };
        img.onerror = function(){ post({type:"png", error:"img-load"}); };
        img.src = svg64;
      } catch(e){ post({type:"png", error:String(e)}); }
    });
  };
  // Export the raw vector SVG — dark-themed, with the dark background rect.
  window.__exportSvg = function(){
    renderDark(function(darkSvg){
      if(!darkSvg){ post({type:"svg", error:"render"}); return; }
      var withNs = darkSvg.indexOf("xmlns=") >= 0 ? darkSvg
        : darkSvg.replace(/<svg\\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
      post({type:"svg", data:withNs});
    });
  };
  (function(){
    try {
      mmInit(${JSON.stringify(theme)});
      mermaid.render("g", SRC).then(function(r){
        document.getElementById("d").innerHTML = r.svg;
        requestAnimationFrame(function(){ post({type:"height", h:document.body.scrollHeight || 40}); });
      }).catch(function(e){
        document.getElementById("d").innerHTML = '<div class="err">Diagram error</div>';
        post({type:"height", h:48});
      });
    } catch(e) {
      document.getElementById("d").innerHTML = '<div class="err">Diagram error</div>';
      post({type:"height", h:48});
    }
  })();
</script></body></html>`
}

export default function MermaidView({
  source,
  dark,
  textColor,
}: {
  source: string
  dark: boolean
  textColor: string
}) {
  const t = useTheme()
  const webRef = useRef<WebView>(null)
  const [height, setHeight] = useState(60)
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const html = useMemo(() => buildHtml(source, dark, textColor), [source, dark, textColor])

  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(source)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* best-effort */
    }
  }

  const onDownload = () => {
    if (saving) return
    // Let the user pick the format. PNG saves to Photos everywhere; SVG is the
    // lossless vector (opens in Files/Safari/email, but not the Photos gallery).
    showActions("Download diagram", [
      { text: "PNG (image)", onPress: () => exportAs("png") },
      { text: "SVG (vector)", onPress: () => exportAs("svg") },
    ])
  }

  const exportAs = (fmt: "png" | "svg") => {
    if (saving) return
    setSaving(true)
    const fn = fmt === "png" ? "__exportPng" : "__exportSvg"
    webRef.current?.injectJavaScript(`window.${fn} && window.${fn}(); true;`)
    // Safety: clear the spinner if the bridge never answers.
    setTimeout(() => setSaving(false), 8000)
  }

  const savePng = async (b64: string) => {
    try {
      const dir = FileSystem.cacheDirectory || ""
      const uri = `${dir}mermaid-${Date.now()}.png`
      await FileSystem.writeAsStringAsync(uri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", UTI: "public.png" })
      }
    } catch {
      /* best-effort */
    } finally {
      setSaving(false)
    }
  }

  const saveSvg = async (xml: string) => {
    try {
      const dir = FileSystem.cacheDirectory || ""
      const uri = `${dir}mermaid-${Date.now()}.svg`
      await FileSystem.writeAsStringAsync(uri, xml, {
        encoding: FileSystem.EncodingType.UTF8,
      })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "image/svg+xml", UTI: "public.svg-image" })
      }
    } catch {
      /* best-effort */
    } finally {
      setSaving(false)
    }
  }

  const onMessage = (e: { nativeEvent: { data: string } }) => {
    let msg: any
    try {
      msg = JSON.parse(e.nativeEvent.data)
    } catch {
      return
    }
    if (msg?.type === "height") {
      const h = Number(msg.h)
      if (!Number.isNaN(h) && h > 0) setHeight(Math.min(h + 8, 1200))
    } else if (msg?.type === "png") {
      if (msg.data) savePng(String(msg.data))
      else setSaving(false)
    } else if (msg?.type === "svg") {
      if (msg.data) saveSvg(String(msg.data))
      else setSaving(false)
    }
  }

  const btn = {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.chipBg,
  } as const
  const btnLabel = { fontSize: 12, color: t.textMuted } as const

  return (
    <View>
      {/* Toolbar: Expand + Diagram/Code toggle + Copy + Download. */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6, marginBottom: 4 }}>
        {showCode ? null : (
          <Pressable testID="mermaid-expand" onPress={() => setExpanded(true)} style={btn}>
            <Text style={btnLabel}>Expand</Text>
          </Pressable>
        )}
        <Pressable testID="mermaid-toggle" onPress={() => setShowCode((v) => !v)} style={btn}>
          <Text style={btnLabel}>{showCode ? "Diagram" : "Code"}</Text>
        </Pressable>
        <Pressable testID="mermaid-copy" onPress={onCopy} style={btn}>
          <Text style={{ ...btnLabel, color: copied ? t.success : t.textMuted }}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
        <Pressable testID="mermaid-download" onPress={onDownload} style={btn} disabled={saving}>
          <Text style={btnLabel}>{saving ? "Saving…" : "Download"}</Text>
        </Pressable>
      </View>

      {/* The WebView is always mounted (so Download can rasterise even in Code
          view), but collapsed to zero height when showing code — this avoids the
          "empty overlay" that a horizontally-scrolled multiline Text produced. */}
      <View style={showCode ? { height: 0, overflow: "hidden" } : { height, width: "100%" }}>
        {/* A transparent tap layer over the fixed-scale diagram: one tap opens the
            zoomable full-screen view (the inline WebView has nothing to scroll). */}
        <Pressable
          testID="mermaid-tap"
          accessibilityLabel="Open diagram full screen"
          onPress={() => setExpanded(true)}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}
        />
        <WebView
          ref={webRef}
          originWhitelist={["*"]}
          source={{ html }}
          style={{ backgroundColor: "transparent", flex: 1 }}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          onMessage={onMessage}
        />
      </View>

      {showCode ? (
        <View style={{ backgroundColor: t.codeBg, borderRadius: 8, padding: 10 }}>
          <Text selectable style={{ fontFamily: "Menlo", fontSize: 13, color: t.codeText }}>
            {source}
          </Text>
        </View>
      ) : null}

      {expanded ? (
        <DiagramModal source={source} dark={dark} textColor={textColor} onClose={() => setExpanded(false)} />
      ) : null}
    </View>
  )
}

/** Full-screen, pinch-zoomable diagram. Mounted only while open. */
function DiagramModal({
  source,
  dark,
  textColor,
  onClose,
}: {
  source: string
  dark: boolean
  textColor: string
  onClose: () => void
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const html = useMemo(() => buildHtml(source, dark, textColor, true), [source, dark, textColor])
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={["portrait", "landscape"]}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 }}>
          <Text style={{ flex: 1, fontSize: 13, color: t.textMuted }}>Pinch to zoom · drag to move</Text>
          <Pressable testID="mermaid-close" onPress={onClose} hitSlop={12}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: t.accent }}>Done</Text>
          </Pressable>
        </View>
        <WebView
          testID="mermaid-zoom"
          originWhitelist={["*"]}
          source={{ html }}
          style={{ flex: 1, backgroundColor: "transparent" }}
          scrollEnabled
          bounces={false}
        />
      </View>
    </Modal>
  )
}
