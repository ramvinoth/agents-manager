"""viewer.noteexport — one note as a Markdown, Word (.docx) or PDF file.

The owner's knowledge must leave the app in the formats people actually send.
Markdown is the note itself. For Word and PDF the body is parsed once into
blocks (headings, paragraphs, lists, checklists, quotes, code, tables) and
rendered twice: as a .docx written directly (a zip of WordprocessingML, no
pandoc or python-docx to install on a customer box), and as HTML that headless
Chrome prints to PDF, where mermaid diagrams render as drawn diagrams. In
Word a mermaid block stays as its source code; Word has no way to draw it.
"""
import html
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import zipfile
from glob import glob
from io import BytesIO
from xml.sax.saxutils import escape as xesc

FORMATS = {
    "md": ("text/markdown; charset=utf-8", "md"),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    "pdf": ("application/pdf", "pdf"),
}
MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"


class ExportUnavailable(Exception):
    """This machine cannot produce the format (PDF needs Chrome or Chromium)."""


# ── parse ────────────────────────────────────────────────────────────────────
_LI = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_TASK = re.compile(r"^\[([ xX])\]\s+(.*)$")
_ROW = re.compile(r"^\s*\|.*\|\s*$")
_SEP = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")


def _cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse(body):
    """Markdown → blocks: ("h", level, text) ("p", text) ("li", depth, marker, text)
    ("quote", text) ("code", lang, text) ("table", rows) ("hr",). `marker` is
    "•", "1." or a checkbox ("☐"/"☑")."""
    lines = (body or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out, para, i = [], [], 0

    def flush():
        if para:
            out.append(("p", " ".join(s.strip() for s in para)))
            para.clear()

    while i < len(lines):
        line = lines[i]
        fence = re.match(r"^\s*(```+|~~~+)\s*(\S*)", line)
        if fence:
            flush()
            mark, code = fence.group(1), []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(mark):
                code.append(lines[i]); i += 1
            out.append(("code", fence.group(2).lower(), "\n".join(code)))
            i += 1
            continue
        if not line.strip():
            flush(); i += 1; continue
        h = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
        if h:
            flush(); out.append(("h", len(h.group(1)), h.group(2))); i += 1; continue
        if re.match(r"^\s*([-*_])(\s*\1){2,}\s*$", line):
            flush(); out.append(("hr",)); i += 1; continue
        if _ROW.match(line) and i + 1 < len(lines) and _SEP.match(lines[i + 1]):
            flush()
            rows = [_cells(line)]
            i += 2
            while i < len(lines) and _ROW.match(lines[i]):
                rows.append(_cells(lines[i])); i += 1
            out.append(("table", rows))
            continue
        if line.lstrip().startswith(">"):
            flush()
            q = []
            while i < len(lines) and lines[i].lstrip().startswith(">"):
                q.append(re.sub(r"^\s*>\s?", "", lines[i])); i += 1
            out.append(("quote", " ".join(s.strip() for s in q if s.strip())))
            continue
        li = _LI.match(line)
        if li:
            flush()
            depth = len(li.group(1).expandtabs(4)) // 2
            marker, text = li.group(2), li.group(3)
            task = _TASK.match(text)
            if task:
                marker, text = ("☑" if task.group(1) != " " else "☐"), task.group(2)
            elif marker[0].isdigit():
                marker = marker[:-1] + "."
            else:
                marker = "•"
            out.append(("li", min(depth, 4), marker, text))
            i += 1
            continue
        para.append(line)
        i += 1
    flush()
    return out


_INLINE = re.compile(
    r"(?P<code>`[^`]+`)"
    r"|\[\[(?P<wl>[^\]|#]+)(?:#[^\]|]*)?(?:\|(?P<wla>[^\]]+))?\]\]"
    r"|\[(?P<lt>[^\]]+)\]\((?P<lu>[^)\s]+)\)"
    r"|\*\*(?P<b>.+?)\*\*(?!\*)|__(?P<b2>.+?)__(?!_)"
    r"|(?<![\w*])\*(?P<i>[^*\s][^*]*?)\*(?!\*)|(?<!\w)_(?P<i2>[^_\s][^_]*?)_(?!\w)"
    r"|~~(?P<s>.+?)~~"
)


def runs(text):
    """Inline markdown → [(text, styles ⊆ {"b","i","s","code"}, url or None)].
    [[Note]] links become their shown text: outside the app there is no note to open."""
    out, pos = [], 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            out.append((text[pos:m.start()], frozenset(), None))
        g = m.groupdict()
        if g["code"]:
            out.append((g["code"][1:-1], frozenset({"code"}), None))
        elif g["wl"]:
            out.append(((g["wla"] or g["wl"]).strip(), frozenset({"b"}), None))
        elif g["lt"]:
            out.append((g["lt"], frozenset(), g["lu"]))
        else:
            style = "b" if (g["b"] or g["b2"]) else "s" if g["s"] else "i"
            inner = g["b"] or g["b2"] or g["i"] or g["i2"] or g["s"]
            out += [(t, s | {style}, u) for t, s, u in runs(inner)]
        pos = m.end()
    if pos < len(text):
        out.append((text[pos:], frozenset(), None))
    return out


# ── HTML (the PDF's source) ──────────────────────────────────────────────────
def _html_inline(text):
    parts = []
    for t, s, url in runs(text):
        h = html.escape(t)
        if "code" in s: h = f"<code>{h}</code>"
        if "b" in s: h = f"<strong>{h}</strong>"
        if "i" in s: h = f"<em>{h}</em>"
        if "s" in s: h = f"<s>{h}</s>"
        if url and re.match(r"^(https?:|mailto:)", url):
            h = f'<a href="{html.escape(url)}">{h}</a>'
        parts.append(h)
    return "".join(parts)


_CSS = """
@page { size: A4; margin: 18mm 16mm; }
body { font: 11pt/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f1f1f; }
h1.title { font-size: 22pt; margin: 0 0 2pt; }
.meta { color: #6b6b6b; font-size: 9pt; margin-bottom: 16pt; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.3em 0 .4em; page-break-after: avoid; }
h1 { font-size: 18pt; } h2 { font-size: 15pt; border-bottom: 1px solid #ddd; padding-bottom: 2pt; }
h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11.5pt; }
p, blockquote, pre, table, .li { margin: 0 0 .7em; }
.li { display: flex; gap: .5em; margin-bottom: .25em; }
.li .m { flex: none; min-width: 1.1em; color: #555; }
blockquote { border-left: 3px solid #ccc; padding-left: 10pt; color: #555; }
code { font: 9.5pt Menlo, Consolas, monospace; background: #f3f3f3; padding: 0 2pt; border-radius: 3px; }
pre { background: #f6f6f6; padding: 8pt; border-radius: 4px; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
pre.mermaid { background: none; text-align: center; }
table { border-collapse: collapse; width: 100%; font-size: 10pt; }
th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #f3f3f3; }
hr { border: 0; border-top: 1px solid #ddd; margin: 1em 0; }
a { color: #1a5fb4; }
"""


def to_html(title, meta, body):
    blocks, out = parse(body), []
    for b in blocks:
        k = b[0]
        if k == "h":
            out.append(f"<h{b[1]}>{_html_inline(b[2])}</h{b[1]}>")
        elif k == "p":
            out.append(f"<p>{_html_inline(b[1])}</p>")
        elif k == "li":
            out.append(f'<div class="li" style="margin-left:{b[1] * 1.4}em"><span class="m">{b[2]}</span>'
                       f"<span>{_html_inline(b[3])}</span></div>")
        elif k == "quote":
            out.append(f"<blockquote>{_html_inline(b[1])}</blockquote>")
        elif k == "code":
            cls = ' class="mermaid"' if b[1] == "mermaid" else ""
            inner = html.escape(b[2]) if b[1] == "mermaid" else f"<code>{html.escape(b[2])}</code>"
            out.append(f"<pre{cls}>{inner}</pre>")
        elif k == "table":
            head, *rest = b[1]
            rows = "".join("<tr>" + "".join(f"<td>{_html_inline(c)}</td>" for c in r) + "</tr>" for r in rest)
            out.append("<table><thead><tr>" + "".join(f"<th>{_html_inline(c)}</th>" for c in head)
                       + f"</tr></thead><tbody>{rows}</tbody></table>")
        elif k == "hr":
            out.append("<hr/>")
    mermaid = any(b[0] == "code" and b[1] == "mermaid" for b in blocks)
    script = (f'<script src="{MERMAID_CDN}"></script><script>mermaid.initialize({{startOnLoad:true,'
              'securityLevel:"strict",theme:"default"}});</script>') if mermaid else ""
    return (f'<!DOCTYPE html><html><head><meta charset="utf-8"/><title>{html.escape(title)}</title>'
            f"<style>{_CSS}</style></head><body><h1 class=\"title\">{html.escape(title)}</h1>"
            f'<div class="meta">{html.escape(meta)}</div>{"".join(out)}{script}</body></html>')


# ── PDF ──────────────────────────────────────────────────────────────────────
def find_chrome():
    """A Chrome/Chromium binary on THIS machine, or None."""
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        if shutil.which(name):
            return shutil.which(name)
    for p in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium", "/snap/bin/chromium"):
        if os.path.exists(p):
            return p
    for root in ("~/.cache/ms-playwright", "~/Library/Caches/ms-playwright"):
        root = os.path.expanduser(root)
        hits = sorted(glob(root + "/chromium-*/chrome-linux/chrome")
                      + glob(root + "/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"))
        if hits:
            return hits[-1]
    return None


def _complete(path):
    with open(path, "rb") as f:
        f.seek(max(0, os.path.getsize(path) - 32))
        return b"%%EOF" in f.read()


def to_pdf(title, meta, body, chrome=None):
    chrome = chrome or find_chrome()
    if not chrome:
        raise ExportUnavailable("PDF export needs Chrome or Chromium on the Harman server")
    with tempfile.TemporaryDirectory(prefix="harman-pdf-") as d:
        src, dst = os.path.join(d, "note.html"), os.path.join(d, "note.pdf")
        with open(src, "w", encoding="utf-8") as f:
            f.write(to_html(title, meta, body))
        # A private profile so this never collides with the owner's own Chrome
        # or the viewer's CDP browser; virtual time lets mermaid finish drawing.
        cmd = [chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               f"--user-data-dir={d}/profile", "--no-pdf-header-footer", "--virtual-time-budget=8000",
               f"--print-to-pdf={dst}", "file://" + src]
        # Chrome writes the PDF and then may never exit (on macOS its updater
        # keeps the process alive), so wait for the file to stop growing and
        # end the whole process group ourselves.
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            deadline, last = time.time() + 60, -1
            while time.time() < deadline:
                size = os.path.getsize(dst) if os.path.exists(dst) else -1
                if size > 0 and size == last and _complete(dst):
                    break
                if proc.poll() is not None and size <= 0:
                    break
                last = size
                time.sleep(0.5)
        finally:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()
        if not os.path.exists(dst) or not _complete(dst):
            raise ExportUnavailable("Chrome could not print the PDF")
        with open(dst, "rb") as f:
            return f.read()


# ── DOCX ─────────────────────────────────────────────────────────────────────
def _wruns(text, bold=False):
    out = []
    for t, s, url in runs(text):
        # Word rejects run properties out of schema order: rStyle, b, i, strike, color, u.
        rpr = ('<w:rStyle w:val="CodeChar"/>' if "code" in s else "") \
            + ("<w:b/>" if bold or "b" in s else "") + ("<w:i/>" if "i" in s else "") \
            + ("<w:strike/>" if "s" in s else "") \
            + ('<w:color w:val="1A5FB4"/><w:u w:val="single"/>' if url else "")
        shown = t + (f" ({url})" if url and url != t and re.match(r"^(https?:|mailto:)", url) else "")
        out.append(f'<w:r>{f"<w:rPr>{rpr}</w:rPr>" if rpr else ""}'
                   f'<w:t xml:space="preserve">{xesc(shown)}</w:t></w:r>')
    return "".join(out)


def _wp(content, style=None, ind=None):
    ppr = (f'<w:pStyle w:val="{style}"/>' if style else "") + (ind or "")
    return f'<w:p>{f"<w:pPr>{ppr}</w:pPr>" if ppr else ""}{content}</w:p>'


def to_docx(title, meta, body):
    parts = [_wp(_wruns(title), "Title"), _wp(_wruns(meta), "Subtitle")]
    for b in parse(body):
        k = b[0]
        if k == "h":
            parts.append(_wp(_wruns(b[2]), f"Heading{min(b[1], 4)}"))
        elif k == "p":
            parts.append(_wp(_wruns(b[1])))
        elif k == "li":
            left = 360 + b[1] * 360
            ind = f'<w:spacing w:after="60"/><w:ind w:left="{left}" w:hanging="360"/>'
            parts.append(_wp(f'<w:r><w:t xml:space="preserve">{xesc(b[2])}</w:t></w:r><w:r><w:tab/></w:r>'
                             + _wruns(b[3]), ind=ind))
        elif k == "quote":
            parts.append(_wp(_wruns(b[1]), "Quote"))
        elif k == "code":
            lines = b[2].split("\n")
            content = "".join(
                ("<w:r><w:br/></w:r>" if n else "") + f'<w:r><w:t xml:space="preserve">{xesc(ln)}</w:t></w:r>'
                for n, ln in enumerate(lines))
            parts.append(_wp(content, "Code"))
        elif k == "table":
            ncol = max(len(r) for r in b[1])
            shade = '<w:shd w:val="clear" w:fill="F3F3F3"/>'
            rows = []
            for n, r in enumerate(b[1]):
                cells = "".join(
                    f'<w:tc><w:tcPr>{shade if n == 0 else ""}</w:tcPr>'
                    f'{_wp(_wruns(c, bold=n == 0))}</w:tc>'
                    for c in r + [""] * (ncol - len(r)))
                rows.append(f"<w:tr>{cells}</w:tr>")
            border = "".join(f'<w:{e} w:val="single" w:sz="4" w:color="BBBBBB"/>'
                             for e in ("top", "left", "bottom", "right", "insideH", "insideV"))
            parts.append(f'<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>{border}</w:tblBorders>'
                         f'</w:tblPr><w:tblGrid>{"<w:gridCol/>" * ncol}</w:tblGrid>{"".join(rows)}</w:tbl>'
                         + _wp(""))
        elif k == "hr":
            parts.append(_wp("", ind='<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>'))
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
           + "".join(parts) +
           '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" '
           'w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>')
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CONTENT_TYPES)
        z.writestr("_rels/.rels", _RELS)
        z.writestr("word/_rels/document.xml.rels", _DOC_RELS)
        z.writestr("word/styles.xml", _STYLES)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/></Relationships>')
_DOC_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
    'Target="styles.xml"/></Relationships>')


def _style(sid, name, ppr="", rpr="", kind="paragraph"):
    return (f'<w:style w:type="{kind}" w:styleId="{sid}"><w:name w:val="{name}"/><w:basedOn w:val="Normal"/>'
            f'<w:qFormat/><w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>')


_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>'
    '<w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="288" '
    'w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + _style("Title", "Title", '<w:spacing w:after="40"/>', '<w:b/><w:sz w:val="44"/>')
    + _style("Subtitle", "Subtitle", '<w:spacing w:after="320"/>', '<w:color w:val="6B6B6B"/><w:sz w:val="18"/>')
    + _style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>',
             '<w:b/><w:sz w:val="36"/>')
    + _style("Heading2", "heading 2", '<w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" '
             'w:color="DDDDDD"/></w:pBdr><w:spacing w:before="320" w:after="100"/><w:outlineLvl w:val="1"/>',
             '<w:b/><w:sz w:val="30"/>')
    + _style("Heading3", "heading 3", '<w:keepNext/><w:spacing w:before="260" w:after="80"/><w:outlineLvl w:val="2"/>',
             '<w:b/><w:sz w:val="26"/>')
    + _style("Heading4", "heading 4", '<w:keepNext/><w:spacing w:before="220" w:after="60"/><w:outlineLvl w:val="3"/>',
             '<w:b/><w:sz w:val="23"/>')
    + _style("Quote", "Quote", '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" '
             'w:color="CCCCCC"/></w:pBdr><w:ind w:left="360"/>', '<w:i/><w:color w:val="555555"/>')
    + _style("Code", "Code", '<w:shd w:val="clear" w:fill="F6F6F6"/>'
             '<w:spacing w:after="160" w:line="240" w:lineRule="auto"/>',
             '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Consolas"/><w:sz w:val="18"/>')
    + '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/>'
      '<w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Consolas"/><w:sz w:val="19"/>'
      '<w:shd w:val="clear" w:fill="F0F0F0"/></w:rPr></w:style>'
    + '</w:styles>')


def file_name(title, ext):
    """A safe download name from the note title."""
    stem = re.sub(r'[\\/:*?"<>|#%\x00-\x1f\s]+', " ", title or "").strip(" .")[:80].strip() or "Note"
    return f"{stem}.{ext}"


def export(note, fmt, meta=""):
    """(bytes, content-type, file name) for one note. Raises ValueError on an
    unknown format, ExportUnavailable when this machine cannot make it."""
    if fmt not in FORMATS:
        raise ValueError("format is md, docx or pdf")
    title = (note.get("title") or "").strip() or "Untitled note"
    body = note.get("body") or ""
    ctype, ext = FORMATS[fmt]
    if fmt == "md":
        data = (f"# {title}\n\n{body}" if not body.lstrip().startswith("# ") else body).encode("utf-8")
    elif fmt == "docx":
        data = to_docx(title, meta, body)
    else:
        data = to_pdf(title, meta, body)
    return data, ctype, file_name(title, ext)
