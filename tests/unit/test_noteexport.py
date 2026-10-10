"""noteexport — one note as Markdown, Word or PDF. Parsing and the .docx are
pure; PDF needs Chrome, so it is only checked for the no-Chrome answer."""
import zipfile
from io import BytesIO
from xml.dom import minidom

import pytest

from viewer import noteexport as ne

BODY = """Intro with **bold**, *italic*, `code`, [[Plan|the plan]] and [site](https://x.io).

## Section
- one
  - nested
1. first
- [x] done
- [ ] todo

> quoted
> line

| A | B |
|---|---|
| 1 | <2> & 3 |

```mermaid
graph TD; A-->B
```
---
"""


def test_parse_blocks():
    kinds = [b[0] for b in ne.parse(BODY)]
    assert kinds == ["p", "h", "li", "li", "li", "li", "li", "quote", "table", "code", "hr"]
    lis = [b for b in ne.parse(BODY) if b[0] == "li"]
    assert [(d, m) for _, d, m, _ in lis] == [(0, "•"), (1, "•"), (0, "1."), (0, "☑"), (0, "☐")]
    assert ne.parse(BODY)[7] == ("quote", "quoted line")
    assert ne.parse("```\nunclosed")[0] == ("code", "", "unclosed")


def test_inline_runs_and_wikilinks():
    r = ne.runs("a **b *c*** [[Plan|shown]] [t](https://u)")
    assert ("b ", frozenset({"b"}), None) in r
    assert ("c", frozenset({"b", "i"}), None) in r
    assert ("shown", frozenset({"b"}), None) in r
    assert ("t", frozenset(), "https://u") in r
    assert ne.runs("snake_case_name stays") == [("snake_case_name stays", frozenset(), None)]


def test_html_escapes_and_drops_unsafe_links():
    h = ne.to_html("<T>", "m", "[x](javascript:alert(1)) <b>raw</b>\n\n```mermaid\nA-->B\n```")
    assert "javascript:" not in h and "&lt;b&gt;raw" in h and "&lt;T&gt;" in h
    assert 'class="mermaid"' in h and "mermaid.min.js" in h
    assert "mermaid.min.js" not in ne.to_html("t", "m", "no diagram")


def test_docx_is_a_valid_word_package():
    data = ne.to_docx("Title & <x>", "Note · meta", BODY)
    z = zipfile.ZipFile(BytesIO(data))
    assert {"[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml",
            "word/_rels/document.xml.rels"} <= set(z.namelist())
    for name in z.namelist():
        minidom.parseString(z.read(name))          # every part is well-formed XML
    doc = z.read("word/document.xml").decode()
    assert "Title &amp; &lt;x&gt;" in doc and "&lt;2&gt; &amp; 3" in doc
    assert 'w:val="Heading2"' in doc and "<w:tblGrid>" in doc and "graph TD; A--&gt;B" in doc


def test_export_md_names_and_formats(monkeypatch):
    d, ctype, name = ne.export({"title": 'a/b: "c"', "body": "text"}, "md")
    assert d == b"# a/b: \"c\"\n\ntext" and ctype.startswith("text/markdown") and name == "a b c.md"
    assert ne.export({"title": "", "body": "# Own heading\nx"}, "md")[0] == b"# Own heading\nx"
    assert ne.export({"title": " ", "body": ""}, "docx")[2] == "Untitled note.docx"
    with pytest.raises(ValueError):
        ne.export({"title": "t"}, "rtf")
    monkeypatch.setattr(ne, "find_chrome", lambda: None)
    with pytest.raises(ne.ExportUnavailable):
        ne.export({"title": "t", "body": ""}, "pdf")
