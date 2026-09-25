import React, { useEffect, useMemo, useRef, useState } from "react"
import { Text, View } from "react-native"
import { WebView } from "react-native-webview"
import { buildMathHtml } from "../lib/mathHtml"

/** Display math uses CDN KaTeX; offline/load failures retain readable source. */
export default function MathView({ tex, textColor }: { tex: string; textColor: string }) {
  const html = useMemo(() => buildMathHtml(tex, textColor), [tex, textColor])
  return <Equation key={html} html={html} tex={tex} textColor={textColor} />
}

function Equation({ html, tex, textColor }: { html: string; tex: string; textColor: string }) {
  const [height, setHeight] = useState(44)
  const [failed, setFailed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    timer.current = setTimeout(() => setFailed(true), 4000)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [])
  if (failed) return <Text selectable style={{ color: textColor, fontFamily: "Menlo", paddingVertical: 6 }}>{tex}</Text>
  return (
    <View style={{ height, marginVertical: 2 }}>
      <WebView
        originWhitelist={["*"]}
        source={{ html }}
        scrollEnabled
        style={{ backgroundColor: "transparent", height }}
        onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        onError={() => setFailed(true)}
        onMessage={(event) => {
          const value = Number(event.nativeEvent.data)
          if (!Number.isFinite(value) || value <= 0) return
          if (timer.current) clearTimeout(timer.current)
          setHeight(Math.min(value + 4, 400))
        }}
      />
    </View>
  )
}
