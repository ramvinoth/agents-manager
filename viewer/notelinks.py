"""notelinks — the connections between notes, derived from their bodies.

Notes link the way Obsidian notes do: `[[Title]]`, `[[Title|shown text]]`,
`[[Title#Heading]]`, and tag themselves with `#tag`. The body IS the source of
truth — there is no link table to drift out of sync, and a vault export is
lossless. This module is pure (no db): parse a body, index a corpus by title,
build the graph, rewrite links on a rename, and lay a corpus out as Obsidian
files. Text inside code (fenced or `inline`) is never a link or a tag.

Clients mirror only `norm` (web/mobile lib/noteLinks.ts); every tie-break
(duplicate titles) is decided here and shipped to them as the `index`.
"""
import re

# [[target#heading|alias]] — target may not contain [ ] | # or a newline.
WIKILINK = re.compile(r"\[\[([^\[\]|#\n]*)(#[^\[\]|\n]*)?(\|[^\[\]\n]*)?\]\]")
# #tag at line start or after whitespace/"("; not a digit first (so "#1" and
# "issue #42" stay text); stops at whitespace and punctuation except - _ /.
TAG = re.compile(r"(?:(?<=\s)|(?<=\()|^)#(?![0-9])([^\s!\"#$%&'()*+,.:;<=>?@\[\]^`{|}~\\]+)",
                 re.MULTILINE)
_FENCE = re.compile(r"^\s*(```|~~~)")
_INLINE_CODE = re.compile(r"(`+)[^`]*?\1")
_CONTEXT_MAX = 160


def norm(title):
    """How a link names a note: case-insensitive, whitespace-collapsed."""
    return " ".join(str(title or "").split()).lower()


def _prose_lines(body):
    """(line_no, line) for every line outside fenced code, inline code
    blanked out (same length, so offsets stay valid)."""
    fenced = None
    for i, line in enumerate(str(body or "").replace("\r\n", "\n").split("\n")):
        m = _FENCE.match(line)
        if m:
            fenced = None if fenced == m.group(1) else (fenced or m.group(1))
            continue
        if fenced:
            continue
        yield i, _INLINE_CODE.sub(lambda c: " " * len(c.group(0)), line)


def parse(body):
    """{"links": [{"target", "heading", "alias", "context"}], "tags": [...]}.
    Tags are lower-cased and de-duplicated in first-seen order."""
    links, tags = [], []
    for _, line in _prose_lines(body):
        for m in WIKILINK.finditer(line):
            target = m.group(1).strip()
            if not target:
                continue          # [[#Heading]] — a link within the note itself
            links.append({"target": target,
                          "heading": (m.group(2) or "")[1:].strip(),
                          "alias": (m.group(3) or "")[1:].strip(),
                          "context": _context(line)})
        for m in TAG.finditer(line):
            tag = m.group(1).rstrip("/-").lower()
            if tag and tag not in tags:
                tags.append(tag)
    return {"links": links, "tags": tags}


def _context(line):
    s = line.strip()
    return s if len(s) <= _CONTEXT_MAX else s[:_CONTEXT_MAX - 1] + "…"


def index(notes):
    """{project_id: {norm(title): note_id}} — which note a link resolves to.
    Links resolve inside the note's own project. On a duplicate title the live
    note wins over an archived one, then the most recently edited, then the
    lowest id — deterministic, so every client resolves alike."""
    ranked = sorted(notes, key=lambda n: (bool(n.get("archived")), -(n.get("updated_at") or 0), n["id"]))
    out = {}
    for n in ranked:
        key = norm(n.get("title"))
        if key:
            out.setdefault(n.get("project_id"), {}).setdefault(key, n["id"])
    return out


def graph(notes):
    """The connected graph of a corpus: nodes (every live note, plus archived
    notes something still links to), resolved edges with the linking line as
    context, ghost targets (linked but not written yet) and tag counts."""
    idx = index(notes)
    edges, ghosts, tag_count, parsed = [], {}, {}, {}
    for n in notes:
        parsed[n["id"]] = p = parse(n.get("body"))
        for t in p["tags"]:
            if not n.get("archived"):
                tag_count[t] = tag_count.get(t, 0) + 1
    linked = set()
    for n in notes:
        if n.get("archived"):
            continue
        seen = set()
        for link in parsed[n["id"]]["links"]:
            key = norm(link["target"])
            target = idx.get(n.get("project_id"), {}).get(key)
            if target is None:
                g = ghosts.setdefault((n.get("project_id"), key),
                                      {"title": link["target"], "project_id": n.get("project_id"), "from": []})
                if n["id"] not in g["from"]:
                    g["from"].append(n["id"])
                continue
            if (target, link["heading"]) in seen:
                continue
            seen.add((target, link["heading"]))
            linked.add(target)
            edges.append({"source": n["id"], "target": target, "heading": link["heading"],
                          "context": link["context"]})
    nodes = [{"id": n["id"], "title": n.get("title") or "", "kind": n.get("kind"),
              "project_id": n.get("project_id"), "archived": bool(n.get("archived")),
              "pinned": bool(n.get("pinned")), "tags": parsed[n["id"]]["tags"],
              "updated_at": n.get("updated_at")}
             for n in notes if not n.get("archived") or n["id"] in linked]
    return {"nodes": nodes, "edges": edges,
            "ghosts": list(ghosts.values()),
            "tags": [{"tag": t, "count": c} for t, c in sorted(tag_count.items(), key=lambda x: (-x[1], x[0]))],
            "index": {("" if pid is None else str(pid)): m for pid, m in idx.items()}}


def rename(body, old, new):
    """Point every link to `old` at `new` instead, keeping its #heading and
    |alias — what Obsidian does on a rename. Code is left untouched. Returns
    the body unchanged when nothing matched (callers compare to skip a write)."""
    key, new = norm(old), " ".join(str(new or "").split())
    if not key or not new or norm(new) == key or "[[" in new or "]]" in new:
        return body
    lines = str(body or "").replace("\r\n", "\n").split("\n")
    changed = False
    for i, masked in _prose_lines(body):
        if "[[" not in masked:
            continue
        line, out, last = lines[i], [], 0
        for m in WIKILINK.finditer(masked):
            # Masking keeps offsets, so the same span of the real line is the link.
            real = WIKILINK.fullmatch(line, m.start(), m.end())
            if real and norm(real.group(1)) == key:
                out.append(line[last:m.start()])
                out.append("[[" + new + (real.group(2) or "") + (real.group(3) or "") + "]]")
                last = m.end()
        if last:
            out.append(line[last:])
            lines[i] = "".join(out)
            changed = True
    return "\n".join(lines) if changed else body


def owner_of(notes, project_id, title, exclude_id):
    """The id of another note in the project that already answers to `title`
    (a rename must not steal links that legitimately point at it), else None."""
    key = norm(title)
    for n in notes:
        if n["id"] != exclude_id and n.get("project_id") == project_id and norm(n.get("title")) == key:
            return n["id"]
    return None


# Characters Obsidian (and Windows/macOS file systems) refuse in a file name,
# plus the link syntax itself — a file named "a#b" could never be linked to.
_UNSAFE = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f]')


def _stem(title, taken):
    """A file name stem for `title`, unique case-insensitively in `taken`
    (Obsidian resolves [[links]] by name across folders, so names must not
    collide anywhere in the vault)."""
    base = " ".join(_UNSAFE.sub(" ", str(title or "")).split()).strip(" .")[:120] or "Untitled"
    stem, n = base, 1
    while stem.lower() in taken:
        n += 1
        stem = f"{base} {n}"
    taken.add(stem.lower())
    return stem


def _yaml_str(s):
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def vault(notes, projects=None, now=None):
    """The corpus as an Obsidian vault: {relative path: markdown text}.

    One .md per note named after its title, YAML frontmatter carrying what the
    file name cannot (id, kind, tags, dates, the exact title as an alias),
    archived notes under Archive/, each project in its own folder when the
    export spans several. Where a file name had to differ from the title
    (unsafe characters, a duplicate), every link to that note is rewritten to
    the file name with the original text kept as the shown alias — so every
    link that resolved here resolves identically in Obsidian."""
    import datetime as _dt
    projects = projects or {}
    multi = len({n.get("project_id") for n in notes}) > 1
    idx, taken, stems = index(notes), set(), {}
    for n in sorted(notes, key=lambda n: (bool(n.get("archived")), n["id"])):
        stems[n["id"]] = _stem(n.get("title") or _first_line(n.get("body")), taken)

    def iso(ts):
        return _dt.datetime.fromtimestamp(ts or 0, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    folders, ftaken = {}, set()
    for pid in sorted({n.get("project_id") for n in notes}, key=lambda p: (p is None, p or 0)):
        label = projects.get(pid) or ("No project" if pid is None else f"Project {pid}")
        folders[pid] = _stem(label, ftaken) + "/" if multi else ""
    out = {}
    for n in notes:
        pid, body = n.get("project_id"), str(n.get("body") or "")
        targets = idx.get(pid, {})

        def relink(m, targets=targets):
            target = targets.get(norm(m.group(1)))
            if target is None or stems[target] == m.group(1).strip():
                return m.group(0)
            alias = m.group(3) or "|" + m.group(1).strip() + (m.group(2) or "")
            return "[[" + stems[target] + (m.group(2) or "") + alias + "]]"

        lines = body.replace("\r\n", "\n").split("\n")
        for i, masked in _prose_lines(body):
            if "[[" in masked:
                spans = [m.span() for m in WIKILINK.finditer(masked)]
                line = lines[i]
                for s, e in reversed(spans):
                    line = line[:s] + WIKILINK.sub(relink, line[s:e]) + line[e:]
                lines[i] = line
        tags = parse(body)["tags"]
        front = ["---", f"id: {n['id']}", f"kind: {n.get('kind') or 'note'}"]
        if n.get("title"):
            front.append(f"aliases: [{_yaml_str(n['title'])}]")
        if tags:
            front.append("tags: [" + ", ".join(_yaml_str(t) for t in tags) + "]")
        front += [f"created: {iso(n.get('created_at'))}", f"updated: {iso(n.get('updated_at'))}"]
        if n.get("created_by"):
            front.append(f"author: {_yaml_str(n['created_by'])}")
        if n.get("pinned"):
            front.append("pinned: true")
        if n.get("archived"):
            front.append("archived: true")
        front.append("---")
        folder = folders[pid]
        if n.get("archived"):
            folder += "Archive/"
        out[f"{folder}{stems[n['id']]}.md"] = "\n".join(front) + "\n" + "\n".join(lines)
    return out


def _first_line(body):
    for line in str(body or "").split("\n"):
        s = line.lstrip("#>-*[] x\t").strip()
        if s:
            return s
    return ""
