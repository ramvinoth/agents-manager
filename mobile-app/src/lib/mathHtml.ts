/** CDN-backed display math. Untrusted TeX is data, never HTML or executable JS. */
export function buildMathHtml(tex: string, textColor: string): string {
  const literal = JSON.stringify(tex).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  const color = /^#[0-9a-f]{3,8}$/i.test(textColor) ? textColor : "#222222"
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css"/>
<style>html,body{margin:0;padding:0;background:transparent;color:${color};font-family:monospace;}
#d{padding:6px 2px;overflow-x:auto;white-space:pre-wrap;}.katex{font-size:1.1em;}</style>
</head><body><div id="d"></div>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script>
var tex=${literal};var d=document.getElementById('d');
function size(){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(String(document.body.scrollHeight||40));}
try{if(window.katex)katex.render(tex,d,{displayMode:true,throwOnError:false,trust:false,maxSize:20,maxExpand:1000,output:'html'});else d.textContent=tex;}
catch(e){d.textContent=tex;}
size();window.addEventListener('load',size);if(document.fonts)document.fonts.ready.then(size);
</script></body></html>`
}
