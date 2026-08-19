# Design: LaTeX / math equation rendering (app + web, user + AI text)

Status: DESIGN ONLY — no code yet. For review.
Goal: real typeset math (fractions, integrals, subscripts, Greek) in message
bodies, for BOTH user-typed text AND AI responses, in BOTH the mobile app and the
web UI. Engine: KaTeX (fast, no MathJax bloat, SSR-able).

## 1. Current state (why nothing renders today)

Two independent markdown stacks, neither has math:
- **Mobile** `mobile-app/src/lib/markdown.ts` → parses to native RN components
  (Markdown.tsx). Handles bold/italic/code/links/lists/tables/quotes/hr + mermaid
  fences (rendered in a WebView). NO `$`/`$$`/`\(`/`\[` handling → math falls
  through to plain text, and single-underscore math (`A_k`) can even mis-parse as
  *italic*.
- **Web** `web/src/lib/markdown.ts` → renders to HTML segments (Transcript.tsx).
  Same feature set, mermaid via `MermaidDiagram.tsx`. No math either.

Both already funnel EVERY message body (user + assistant) through one `Markdown`
component per platform, so adding math in the shared spot covers both roles for
free — no per-role work.

## 2. Delimiters (shared contract)

Recognize the standard set, matched BEFORE other inline parsing so `_`/`*` inside
math don't mis-trigger italic/bold:
- Inline: `$…$` and `\(…\)`
- Display (block, centered): `$$…$$` and `\[…\]`

Rules: a `$` must not be preceded/followed by a digit-with-no-space in a way that
eats currency ("it cost $5 and $6" must NOT become math). Use the common heuristic:
`$` opens math only if the closing `$` exists on the same line/paragraph and the
content contains a math-ish char OR the pair is `$$`. Escaped `\$` is literal.
This lives in ONE place per platform's parser and is unit-tested with currency +
formula cases.

## 3. Parser changes (both platforms, mirrored)

Add a math token type:
- Mobile: new Span `{ t: "math"; s: string; display: boolean }` and, for a block
  on its own line, a MdBlock `{ t: "mathblock"; text: string }`.
- Web: new MarkdownSegment `{ kind: "math"; tex: string; display: boolean }`.

The inline regex gets a math alternative FIRST in the alternation so it wins over
`_italic_`/`*bold*`. Display math (`$$`/`\[`) is detected at the block scanner
(like a code fence) so it renders centered on its own line.

## 4. Rendering

### 4a. Web (straightforward — DOM + KaTeX)
- Add deps: `katex` + its CSS. (No react-katex needed; call `katex.renderToString(tex,
  {displayMode, throwOnError:false})` and inject the returned HTML.)
- Transcript.tsx: a `math` segment → `<span dangerouslySetInnerHTML={katexHtml}/>`
  (KaTeX output is trusted HTML from our own lib, not user script — safe). Display
  math → block-level, centered. Import `katex/dist/katex.min.css` once.
- `throwOnError:false` → a malformed formula renders in KaTeX's error style (red),
  never blanks the message.

### 4b. Mobile (WebView, reuse the MermaidView pattern)
RN can't run KaTeX natively (needs a DOM), exactly like Mermaid. Reuse the existing
`react-native-webview` (already a dep) pattern from MermaidView.tsx:
- New `MathView.tsx`: a WebView that loads KaTeX from CDN (mirror MERMAID_CDN),
  renders the tex, and posts its rendered height back over the bridge to auto-size
  — identical mechanism to MermaidView's SVG-height postback.
- tex injected as `JSON.stringify` (never interpolated) — same script-safety
  property MermaidView documents.
- **Perf note (the real design tension):** one WebView per inline `$x$` is far too
  heavy (a WebView is ~a browser tab). Two options — DECISION NEEDED (§7):
  - (i) **One WebView per message** that renders the whole markdown+math to HTML
    with KaTeX inline — richest, but replaces the native Markdown renderer for any
    message containing math (bigger change, loses native text selection).
  - (ii) **Inline unicode-ish fallback for `$…$`, WebView only for display `$$…$$`**
    — keep the fast native renderer for text + inline symbols (convert simple
    `A_k`, `\omega`, `^2` to Unicode Aₖ/ω/²), spin a WebView only for real block
    equations. Cheaper, keeps selection, but inline complex math is approximate.
- CDN dependency: KaTeX from jsDelivr like Mermaid. Offline → math shows source
  (acceptable, matches Mermaid's "Diagram error" degrade).

## 5. Scope: user text too

User messages already render through the same `Markdown` component, so typing
`$E=mc^2$` in the composer renders once sent. No extra work — but note the composer
input itself stays plain text (you type LaTeX, see it typeset in the bubble). That's
the expected chat-app behavior (like Discord/Slack code, or iMessage).

## 6. Phasing

1. Web first (cheapest, no WebView perf question): parser math tokens + KaTeX +
   Transcript render + unit tests (currency vs formula). Web is live via the tunnel
   → testable immediately, proves the delimiter/parse rules before mobile.
2. Mobile: parser mirror + MathView.tsx (per §7 decision) + wire into Markdown.tsx.
   tsc + tests → one TestFlight build.
3. Polish: copy-formula-as-LaTeX (mirror MermaidView's Copy), error styling parity.

## 7. Decisions needed before mobile code

- **Mobile inline-math strategy** — (i) whole-message WebView (richest, loses native
  selection) vs (ii) native+Unicode inline, WebView for display-only (fast, keeps
  selection, inline complex math approximate). Recommend (ii) for v1.
- **KaTeX source** — CDN (matches Mermaid, needs network) vs bundle katex assets in
  the app (offline, +~300KB). Recommend CDN for parity/simplicity in v1.

## 8. Risks / honest notes

- **Delimiter false positives** (currency `$5`) are the classic KaTeX-in-chat bug —
  the §2 heuristic + unit tests are non-negotiable, tested on both platforms.
- Two parsers must stay in sync — same risk the codebase already carries for
  markdown generally; mitigated by mirroring the token types and sharing test cases.
- Not a release blocker; net-new capability.
