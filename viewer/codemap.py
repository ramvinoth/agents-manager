"""viewer.codemap — the Map lens: a project's code as a drill-down graph.

Pure: no database, no HTTP. tree-sitter parses each source file into its
symbols (classes, functions, methods) and its imports; imports resolve to
other files in the repo; `graph()` folds files into the view for one level
(a folder's children, or one file's insides) and `to_mermaid()` renders it.
The route owns caching (code_index table) and the live "touched" highlight.

tree-sitter is OPTIONAL: `available()` is False when the bindings or
grammars are missing, and the UI then says how to install them.
"""
import os
import posixpath
import re

# Never descend into these: vendored, generated or native build output.
SKIP_DIRS = {".git", "node_modules", "dist", "build", "ios", "android",
             "__pycache__", ".venv", "venv", ".next", ".expo", "target",
             ".playwright-mcp", "coverage", ".artifacts", "Pods"}
MAX_FILES = 4000           # a lens over a monorepo still answers in seconds
MAX_BYTES = 512 * 1024     # bigger is generated or vendored, not authored
MAX_NODES = 60             # more boxes than this is wallpaper, not a map
TOUCH_WINDOW = 15 * 60     # an agent's edit stays highlighted this long

_EXT = {".py": "python", ".js": "javascript", ".jsx": "javascript",
        ".mjs": "javascript", ".ts": "typescript", ".tsx": "tsx",
        ".java": "java", ".c": "c", ".h": "c",
        ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp"}
_JS = ("javascript", "typescript", "tsx")
_JS_EXTS = ("", ".ts", ".tsx", ".js", ".jsx", ".mjs",
            "/index.ts", "/index.tsx", "/index.js")

_parsers = None


def _load():
    """{lang: Parser}, or {} when tree-sitter is not installed."""
    global _parsers
    if _parsers is not None:
        return _parsers
    try:
        import tree_sitter as ts
        import tree_sitter_c, tree_sitter_cpp, tree_sitter_java
        import tree_sitter_javascript, tree_sitter_python, tree_sitter_typescript
        langs = {"python": tree_sitter_python.language(),
                 "javascript": tree_sitter_javascript.language(),
                 "typescript": tree_sitter_typescript.language_typescript(),
                 "tsx": tree_sitter_typescript.language_tsx(),
                 "java": tree_sitter_java.language(),
                 "c": tree_sitter_c.language(),
                 "cpp": tree_sitter_cpp.language()}
        _parsers = {k: ts.Parser(ts.Language(v)) for k, v in langs.items()}
    except Exception:   # missing package OR an ABI-incompatible grammar
        _parsers = {}
    return _parsers


def available():
    return bool(_load())


def language(path):
    return _EXT.get(posixpath.splitext(path)[1].lower())


# ── one file → symbols + raw imports ─────────────────────────────────────────

_CLASS = {"class_definition", "class_declaration", "interface_declaration",
          "enum_declaration", "class_specifier", "struct_specifier",
          "abstract_class_declaration"}
_FUNC = {"function_definition", "function_declaration", "method_definition",
         "method_declaration", "constructor_declaration",
         "generator_function_declaration"}


def _text(node):
    return node.text.decode("utf-8", "replace") if node is not None else ""


def _c_name(declarator):
    """A C/C++ function's name sits under nested declarators (pointer, ...)."""
    node = declarator
    while node is not None:
        if node.type in ("identifier", "field_identifier", "qualified_identifier",
                         "destructor_name", "operator_name"):
            return _text(node)
        node = node.child_by_field_name("declarator")
    return ""


def _symbols(root):
    """Classes plus the functions at the top level or directly in a class —
    a map shows structure, so nested helpers inside a function are skipped."""
    out = []

    def walk(node, parent, in_func):
        for child in node.children:
            t = child.type
            if t in _CLASS and child.child_by_field_name("body") is not None:
                name = _text(child.child_by_field_name("name"))
                if name:
                    out.append({"kind": "class", "name": name, "parent": parent,
                                "line": child.start_point[0] + 1})
                walk(child, name or parent, in_func)
            elif t in _FUNC:
                name = (_text(child.child_by_field_name("name"))
                        or _c_name(child.child_by_field_name("declarator")))
                if name and not in_func:
                    out.append({"kind": "method" if parent else "function",
                                "name": name.split("::")[-1], "parent": parent,
                                "line": child.start_point[0] + 1})
                walk(child, parent, True)
            elif t == "variable_declarator" and not in_func:
                value = child.child_by_field_name("value")
                if value is not None and value.type in ("arrow_function", "function_expression"):
                    out.append({"kind": "function", "parent": parent,
                                "name": _text(child.child_by_field_name("name")),
                                "line": child.start_point[0] + 1})
                walk(child, parent, True)
            else:
                walk(child, parent, in_func)

    walk(root, "", False)
    return out


def _imports(root, lang):
    """Module references as written ('./x', '..pkg.mod', 'a.b.C', 'x.h')."""
    out = []
    for node in root.children:
        t = node.type
        if lang == "python" and t == "import_statement":
            out += [_text(n.child_by_field_name("name") or n) for n in node.children
                    if n.type in ("dotted_name", "aliased_import")]
        elif lang == "python" and t == "import_from_statement":
            module = _text(node.child_by_field_name("module_name"))
            names = [_text(n.child_by_field_name("name") or n)
                     for n in node.children_by_field_name("name")]
            sep = "" if module.endswith(".") else "."
            # 'from pkg import mod' names a module; 'from mod import Cls' a
            # symbol — Resolver.resolve falls back one level for the latter.
            out += [module + sep + n for n in names] or [module]
        elif lang in _JS and t in ("import_statement", "export_statement"):
            source = node.child_by_field_name("source")
            if source is not None:
                out.append(_text(source).strip("'\"`"))
        elif lang == "java" and t == "import_declaration":
            m = re.match(r"import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;", _text(node))
            if m:
                out.append(m.group(1))
        elif lang in ("c", "cpp") and t == "preproc_include":
            path = node.child_by_field_name("path")
            if path is not None and path.type == "string_literal":
                out.append(_text(path).strip('"'))
    return out


def parse_file(path, src):
    """{symbols, imports} for one file's bytes; empty when unparseable."""
    parser = _load().get(language(path) or "")
    if parser is None:
        return {"symbols": [], "imports": []}
    root = parser.parse(src).root_node
    return {"symbols": _symbols(root), "imports": _imports(root, language(path))}


# ── raw import → repo file ───────────────────────────────────────────────────

class Resolver:
    """Maps an import string to a file in this repo (None = outside it)."""

    def __init__(self, files):
        self.files = set(files)
        self.by_name = {}
        for f in self.files:
            self.by_name.setdefault(posixpath.basename(f), []).append(f)

    def _suffix(self, tail):
        """The one file ending in `tail` (a/b/C.java). Ambiguous → None."""
        hits = [f for f in self.by_name.get(posixpath.basename(tail), [])
                if f == tail or f.endswith("/" + tail)]
        return hits[0] if len(hits) == 1 else None

    def _first(self, bases, exts):
        for base in bases:
            for ext in exts:
                cand = posixpath.normpath(base + ext)
                if cand in self.files:
                    return cand
        return None

    def resolve(self, raw, src):
        lang, here = language(src), posixpath.dirname(src)
        if lang in _JS:
            if raw.startswith("."):
                return self._first([posixpath.join(here, raw)], _JS_EXTS)
            if raw.startswith("@/"):   # the common tsconfig alias: <pkg>/src
                parts = here.split("/")
                roots = ["/".join(parts[:i]) for i in range(len(parts), -1, -1)]
                return self._first([posixpath.join(r, "src", raw[2:]) for r in roots], _JS_EXTS)
            return None
        if lang == "python":
            # 'from mod import Name' arrives as 'mod.Name': when Name is a
            # symbol rather than a submodule, the file is one level up.
            rest = raw.lstrip(".")
            dots = raw[:len(raw) - len(rest)]
            head = (dots + rest.rsplit(".", 1)[0]) if "." in rest else (dots if rest else "")
            return self._python(raw, here) or (self._python(head, here) if head else None)
        if lang == "java":
            return self._suffix(raw.replace(".", "/") + ".java")
        if lang in ("c", "cpp"):
            return (self._first([posixpath.join(here, raw)], ("",))
                    or self._suffix(raw))
        return None

    def _python(self, raw, here):
        dots = len(raw) - len(raw.lstrip("."))
        rel = raw[dots:].replace(".", "/")
        if not dots:
            return self._first([rel], (".py", "/__init__.py")) or self._suffix(rel + ".py")
        base = here
        for _ in range(dots - 1):
            base = posixpath.dirname(base)
        return self._first([posixpath.join(base, rel) if rel else base],
                           (".py", "/__init__.py"))


# ── the repo walk ────────────────────────────────────────────────────────────

def source_files(root):
    """{rel_path: 'mtime_ns:size'} for every mappable file under root."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            if not language(name):
                continue
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            if st.st_size > MAX_BYTES:
                continue
            out[os.path.relpath(full, root).replace(os.sep, "/")] = f"{st.st_mtime_ns}:{st.st_size}"
            if len(out) >= MAX_FILES:
                return out
    return out


# ── files → one level's graph ────────────────────────────────────────────────

def _child(rel, folder):
    """The direct child of `folder` that contains file `rel` (or None)."""
    prefix = folder + "/" if folder else ""
    if not rel.startswith(prefix):
        return None
    head, sep, _ = rel[len(prefix):].partition("/")
    return prefix + head + ("/" if sep else "")


def graph(index, level, path, touched=()):
    """The view for one level.

    index: {rel: {"symbols": [...], "deps": [rel, ...]}} (deps already resolved)
    level: "project" (== folder ""), "folder", or "file".
    Returns {nodes, edges, truncated}; a node id is a repo path, and folders
    end in "/" so a client can drill into them.
    """
    touched = set(touched)
    if level == "file":
        return _file_graph(index, path, touched)
    folder = "" if level == "project" else path.strip("/")
    nodes, edges = {}, {}
    for rel, entry in index.items():
        node = _child(rel, folder)
        if node is None:
            continue
        n = nodes.setdefault(node, {"id": node, "kind": "folder" if node.endswith("/") else "file",
                                    "label": posixpath.basename(node.rstrip("/")) + ("/" if node.endswith("/") else ""),
                                    "files": 0, "symbols": 0, "touched": False})
        n["files"] += 1
        n["symbols"] += len(entry.get("symbols", []))
        n["touched"] = n["touched"] or rel in touched
        for dep in entry.get("deps", []):
            target = _child(dep, folder)
            if target and target != node:
                edges[(node, target)] = edges.get((node, target), 0) + 1
    truncated = len(nodes) > MAX_NODES
    if truncated:   # keep the most connected; touched files always stay
        degree = {k: 0 for k in nodes}
        for (a, b), w in edges.items():
            degree[a] += w
            degree[b] += w
        keep = set(sorted(nodes, key=lambda k: (not nodes[k]["touched"], -degree[k]))[:MAX_NODES])
        nodes = {k: v for k, v in nodes.items() if k in keep}
        edges = {k: v for k, v in edges.items() if k[0] in keep and k[1] in keep}
    return {"nodes": sorted(nodes.values(), key=lambda n: (n["kind"] != "folder", n["id"])),
            "edges": [{"from": a, "to": b, "weight": w} for (a, b), w in sorted(edges.items())],
            "truncated": truncated}


def _file_graph(index, path, touched):
    """One file: its classes/functions, what it imports, who imports it."""
    entry = index.get(path)
    if entry is None:
        return {"nodes": [], "edges": [], "truncated": False}
    nodes = [{"id": path, "kind": "file", "label": posixpath.basename(path),
              "files": 1, "symbols": len(entry["symbols"]), "touched": path in touched}]
    edges = []
    for s in entry["symbols"]:
        sid = f"{path}#{s['parent'] + '.' if s['parent'] else ''}{s['name']}"
        nodes.append({"id": sid, "kind": s["kind"], "label": s["name"], "line": s["line"],
                      "files": 0, "symbols": 0, "touched": False})
        owner = f"{path}#{s['parent']}" if s["parent"] else path
        edges.append({"from": owner, "to": sid, "weight": 1, "kind": "contains"})
    users = sorted(r for r, e in index.items() if path in e.get("deps", []) and r != path)
    for rel in sorted(set(entry.get("deps", [])) - {path}) + users:
        if not any(n["id"] == rel for n in nodes):
            nodes.append({"id": rel, "kind": "file", "label": rel, "files": 1,
                          "symbols": len(index[rel]["symbols"]), "touched": rel in touched})
    edges += [{"from": path, "to": d, "weight": 1, "kind": "imports"}
              for d in sorted(set(entry.get("deps", [])) - {path})]
    edges += [{"from": u, "to": path, "weight": 1, "kind": "imports"} for u in users]
    truncated = len(nodes) > MAX_NODES * 2
    return {"nodes": nodes[:MAX_NODES * 2], "edges": edges, "truncated": truncated}


def _label(text):
    return re.sub(r'["<>]', "", text).replace("#", "")


def to_mermaid(g):
    """flowchart text for graph() output; touched nodes get the `hot` class."""
    ids = {n["id"]: f"n{i}" for i, n in enumerate(g["nodes"])}
    lines = ["flowchart LR"]
    for n in g["nodes"]:
        label = _label(n["label"])
        if n["kind"] == "folder":
            label += f"<br/>{n['files']} file{'' if n['files'] == 1 else 's'}"
            shape = f'{ids[n["id"]]}[["{label}"]]'
        elif n["kind"] == "file":
            shape = f'{ids[n["id"]]}["{label}"]'
        elif n["kind"] == "class":
            shape = f'{ids[n["id"]]}{{{{"{label}"}}}}'
        else:
            shape = f'{ids[n["id"]]}("{label}()")'
        lines.append("  " + shape)
    for e in g["edges"]:
        if e["from"] in ids and e["to"] in ids:
            arrow = "---" if e.get("kind") == "contains" else "-->"
            weight = f'|{e["weight"]}|' if e["weight"] > 1 else ""
            lines.append(f"  {ids[e['from']]} {arrow}{weight} {ids[e['to']]}")
    hot = [ids[n["id"]] for n in g["nodes"] if n["touched"]]
    if hot:
        lines.append("  classDef hot fill:#f59e0b,stroke:#b45309,color:#111")
        lines.append(f"  class {','.join(hot)} hot")
    return "\n".join(lines)


# ── live highlight: which files did an agent's turn just write? ──────────────

_WRITE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")


def edited_paths(event, root):
    """Repo-relative mappable paths written by the tool calls in one
    stream-json `assistant` event (others → []). Paths outside root are not
    this project's, so they are dropped."""
    if not isinstance(event, dict) or event.get("type") != "assistant":
        return []
    root = root.rstrip("/") + "/"
    out = []
    for block in (event.get("message") or {}).get("content") or []:
        if not isinstance(block, dict) or block.get("type") != "tool_use" \
                or block.get("name") not in _WRITE_TOOLS:
            continue
        path = os.path.normpath(str((block.get("input") or {}).get("file_path")
                                    or (block.get("input") or {}).get("notebook_path") or ""))
        if path.startswith(root) and language(path):
            out.append(path[len(root):])
    return out
