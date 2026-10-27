// Editor-style syntax highlighting for the file preview, via highlight.js core
// plus only the languages in HIGHLIGHT_LANGS. Import this module dynamically
// (await import("@/lib/highlight")) so the main bundle does not carry it.
import hljs from "highlight.js/lib/core"
import type { LanguageFn } from "highlight.js"
import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import cpp from "highlight.js/lib/languages/cpp"
import css from "highlight.js/lib/languages/css"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import go from "highlight.js/lib/languages/go"
import graphql from "highlight.js/lib/languages/graphql"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import less from "highlight.js/lib/languages/less"
import lua from "highlight.js/lib/languages/lua"
import makefile from "highlight.js/lib/languages/makefile"
import markdown from "highlight.js/lib/languages/markdown"
import perl from "highlight.js/lib/languages/perl"
import php from "highlight.js/lib/languages/php"
import python from "highlight.js/lib/languages/python"
import r from "highlight.js/lib/languages/r"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import scss from "highlight.js/lib/languages/scss"
import sql from "highlight.js/lib/languages/sql"
import swift from "highlight.js/lib/languages/swift"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import type { HighlightLang } from "./fileTree"

// Typed by HighlightLang, so a language added to HIGHLIGHT_LANGS without a
// grammar here fails to compile.
const GRAMMARS: Record<HighlightLang, LanguageFn> = { bash, c, cpp, css, dockerfile, go, graphql, ini, java, javascript, json, kotlin, less, lua, makefile, markdown, perl, php, python, r, ruby, rust, scss, sql, swift, typescript, xml, yaml }
for (const [name, fn] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, fn)

/** `code` as escaped HTML with hljs-* token spans. */
export function highlight(code: string, lang: HighlightLang): string {
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
}
