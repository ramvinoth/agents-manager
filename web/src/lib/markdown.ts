// Markdown → HTML — ported from the vanilla MarkdownRenderer. Returns an HTML
// string rendered via dangerouslySetInnerHTML inside a .markdown-content box.

const KEYWORDS: Record<string, string> = {
  js: "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,switch,case,break,default,null,undefined,true,false",
  javascript:
    "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,switch,case,break,default,null,undefined,true,false",
  python:
    "def,class,return,if,elif,else,for,while,import,from,as,try,except,finally,with,yield,lambda,pass,break,continue,True,False,None,and,or,not,in,is,self,async,await,raise",
  py: "def,class,return,if,elif,else,for,while,import,from,as,try,except,finally,with,yield,lambda,pass,break,continue,True,False,None,and,or,not,in,is,self,async,await,raise",
  bash: "if,then,else,fi,for,do,done,while,case,esac,function,return,local,export,echo,cd,grep,find,cat,mkdir,rm,sudo,git,docker",
  sh: "if,then,else,fi,for,do,done,while,case,esac,function,return,local,export,echo,cd,grep,find,cat,mkdir,rm,sudo,git,docker",
  ts: "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,interface,type,enum,extends,implements,null,undefined,true,false",
  typescript:
    "const,let,var,function,return,if,else,for,while,class,import,export,from,async,await,new,this,try,catch,throw,interface,type,enum,extends,implements,null,undefined,true,false",
}

export function esc(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function highlightCode(code: string, lang: string): string {
  if (!lang || lang === "text" || lang === "plaintext") return code
  const kws = KEYWORDS[lang]?.split(",") || []
  if (!kws.length) return code
  const tokens: string[] = []
  let rem = code
  while (rem.length > 0) {
    let m: RegExpMatchArray | null
    if ((m = rem.match(/^(["'`])(?:(?!\1|\\).|\\.)*\1/))) {
      tokens.push(`<span class="sh-string">${m[0]}</span>`)
      rem = rem.slice(m[0].length)
      continue
    }
    if ((m = rem.match(/^(\/\/.*|#.*)/))) {
      tokens.push(`<span class="sh-comment">${m[0]}</span>`)
      rem = rem.slice(m[0].length)
      continue
    }
    if ((m = rem.match(/^\b\d+\.?\d*\b/))) {
      tokens.push(`<span class="sh-number">${m[0]}</span>`)
      rem = rem.slice(m[0].length)
      continue
    }
    if ((m = rem.match(/^\b[a-zA-Z_]\w*\b/))) {
      tokens.push(kws.includes(m[0]) ? `<span class="sh-keyword">${m[0]}</span>` : m[0])
      rem = rem.slice(m[0].length)
      continue
    }
    tokens.push(rem[0])
    rem = rem.slice(1)
  }
  return tokens.join("")
}

function buildTable(rows: string[][]): string {
  if (!rows.length) return ""
  let h = "<table><thead><tr>" + rows[0].map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>"
  for (let i = 1; i < rows.length; i++)
    h += "<tr>" + rows[i].map((c) => `<td>${c}</td>`).join("") + "</tr>"
  return h + "</tbody></table>"
}

function renderTables(h: string): string {
  const lines = h.split("\n")
  const result: string[] = []
  let inTable = false
  let rows: string[][] = []
  for (const line of lines) {
    if (line.match(/^\|(.+)\|$/)) {
      if (line.match(/^\|[\s\-:|]+\|$/)) continue
      if (!inTable) {
        inTable = true
        rows = []
      }
      rows.push(
        line
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim())
      )
    } else {
      if (inTable) {
        result.push(buildTable(rows))
        inTable = false
        rows = []
      }
      result.push(line)
    }
  }
  if (inTable) result.push(buildTable(rows))
  return result.join("\n")
}

function renderInline(text: string): string {
  let h = esc(text)
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>")
  h = h.replace(/^#### (.+)$/gm, "<h4>$1</h4>")
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>")
  h = h.replace(/^## (.+)$/gm, "<h2>$1</h2>")
  h = h.replace(/^# (.+)$/gm, "<h1>$1</h1>")
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>")
  h = h.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
  h = h.replace(/^---$/gm, "<hr>")
  // Links: allowlist safe schemes (esc has already neutralised quotes/angle
  // brackets, so no attribute breakout) — block javascript:/data:/etc.
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
    const url = String(href).trim()
    const safe = /^(https?:\/\/|mailto:|\/|#)/i.test(url) ? url : "#"
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  h = h.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>")
  h = h.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
  h = h.replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
  h = renderTables(h)
  h = h.replace(/^(?!<[hupblotra]|<li|<hr|<blockquote|<pre|<code|\s*$)(.+)$/gm, "<p>$1</p>")
  h = h.replace(/<p>\s*<\/p>/g, "")
  return h
}

export function renderMarkdown(text: string): string {
  if (!text || typeof text !== "string") return ""
  const parts: Array<{ type: "text" | "code"; content: string; lang?: string }> = []
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIdx)
      parts.push({ type: "text", content: text.slice(lastIdx, match.index) })
    parts.push({ type: "code", lang: match[1], content: match[2].trim() })
    lastIdx = match.index + match[0].length
  }
  if (lastIdx < text.length) parts.push({ type: "text", content: text.slice(lastIdx) })
  return parts
    .map((part) => {
      if (part.type === "code") {
        return `<pre><code class="language-${part.lang}">${highlightCode(
          esc(part.content),
          part.lang || ""
        )}</code></pre>`
      }
      return renderInline(part.content)
    })
    .join("")
}
