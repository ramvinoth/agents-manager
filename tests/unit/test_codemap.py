"""viewer.codemap — the Map lens's pure core: parse, resolve, fold, render.

Parsing needs the optional tree-sitter grammars (deploy/codemap-requirements.txt);
those cases skip where they are not installed. Resolution, folding, rendering
and the edit detector are pure and always run.
"""
import pytest

from viewer import codemap

needs_ts = pytest.mark.skipif(not codemap.available(), reason="tree-sitter grammars not installed")


def _names(parsed):
    return [(s["kind"], s["parent"], s["name"]) for s in parsed["symbols"]]


@needs_ts
def test_python_symbols_and_imports():
    src = (b"from . import x\nfrom viewer.routes import fs as f, db\nimport os.path\n"
           b"class A(B):\n    def m(self):\n        def inner(): pass\n"
           b"@dec\ndef g(): pass\n")
    p = codemap.parse_file("viewer/a.py", src)
    assert _names(p) == [("class", "", "A"), ("method", "A", "m"), ("function", "", "g")]
    assert ".x" in p["imports"] and "viewer.routes.fs" in p["imports"] and "os.path" in p["imports"]


@needs_ts
def test_tsx_symbols_and_imports():
    src = (b'import { a } from "@/lib/api"\nimport X from "./X"\nexport * from "../y"\n'
           b"export class K { m() { return 1 } }\nexport function F() { const h = () => 1 }\n"
           b"const G = () => null\n")
    p = codemap.parse_file("web/src/c/A.tsx", src)
    assert _names(p) == [("class", "", "K"), ("method", "K", "m"), ("function", "", "F"),
                         ("function", "", "G")]
    assert p["imports"] == ["@/lib/api", "./X", "../y"]


@needs_ts
def test_java_c_cpp():
    j = codemap.parse_file("a/X.java", b"import a.b.C;\nimport static a.b.D.*;\nclass X { void m(){} }\n")
    assert _names(j) == [("class", "", "X"), ("method", "X", "m")] and j["imports"] == ["a.b.C", "a.b.D"]
    c = codemap.parse_file("s/x.c", b'#include "x.h"\n#include <stdio.h>\nint *f(int a){return 0;}\n')
    assert _names(c) == [("function", "", "f")] and c["imports"] == ["x.h"]
    cc = codemap.parse_file("s/k.cpp", b"class K { void m(); };\nvoid K::m(){}\n")
    assert ("class", "", "K") in _names(cc) and ("function", "", "m") in _names(cc)


def test_unknown_language_is_empty():
    assert codemap.parse_file("README.md", b"# hi") == {"symbols": [], "imports": []}


def test_resolver():
    r = codemap.Resolver(["viewer/db.py", "viewer/routes/fs.py", "viewer/routes/__init__.py",
                          "viewer/__init__.py", "web/src/lib/api.ts", "web/src/c/X.tsx",
                          "j/a/b/C.java", "s/x.h"])
    assert r.resolve("viewer.db", "viewer/engine.py") == "viewer/db.py"
    assert r.resolve("viewer.db.Thing", "viewer/engine.py") == "viewer/db.py"   # from mod import Name
    assert r.resolve("..db", "viewer/routes/fs.py") == "viewer/db.py"
    assert r.resolve(".fs", "viewer/routes/new.py") == "viewer/routes/fs.py"
    assert r.resolve("os", "viewer/db.py") is None                               # stdlib: outside
    assert r.resolve("@/lib/api", "web/src/c/X.tsx") == "web/src/lib/api.ts"
    assert r.resolve("../lib/api", "web/src/c/X.tsx") == "web/src/lib/api.ts"
    assert r.resolve("react", "web/src/c/X.tsx") is None
    assert r.resolve("a.b.C", "j/Main.java") == "j/a/b/C.java"
    assert r.resolve("x.h", "s/x.c") == "s/x.h"


INDEX = {
    "server.py": {"symbols": [], "deps": ["viewer/db.py"]},
    "viewer/db.py": {"symbols": [{"kind": "function", "name": "f", "parent": "", "line": 3}], "deps": []},
    "viewer/routes/fs.py": {"symbols": [{"kind": "class", "name": "M", "parent": "", "line": 1},
                                        {"kind": "method", "name": "g", "parent": "M", "line": 2}],
                            "deps": ["viewer/db.py"]},
    "web/src/a.ts": {"symbols": [], "deps": []},
}


def test_graph_project_level_folds_folders():
    g = codemap.graph(INDEX, "project", "", touched=["viewer/routes/fs.py"])
    ids = {n["id"]: n for n in g["nodes"]}
    assert set(ids) == {"server.py", "viewer/", "web/"}
    assert ids["viewer/"]["files"] == 2 and ids["viewer/"]["touched"]
    assert g["edges"] == [{"from": "server.py", "to": "viewer/", "weight": 1}]   # intra-folder hidden


def test_graph_folder_and_file_levels():
    g = codemap.graph(INDEX, "folder", "viewer")
    assert {n["id"] for n in g["nodes"]} == {"viewer/db.py", "viewer/routes/"}
    assert g["edges"] == [{"from": "viewer/routes/", "to": "viewer/db.py", "weight": 1}]
    f = codemap.graph(INDEX, "file", "viewer/db.py")
    ids = [n["id"] for n in f["nodes"]]
    assert ids[0] == "viewer/db.py" and "viewer/db.py#f" in ids
    assert {"from": "viewer/routes/fs.py", "to": "viewer/db.py", "weight": 1, "kind": "imports"} in f["edges"]
    m = codemap.graph(INDEX, "file", "viewer/routes/fs.py")
    assert {"from": "viewer/routes/fs.py#M", "to": "viewer/routes/fs.py#M.g", "weight": 1,
            "kind": "contains"} in m["edges"]


def test_graph_caps_nodes_keeping_touched():
    index = {f"d/f{i}.py": {"symbols": [], "deps": []} for i in range(codemap.MAX_NODES + 10)}
    g = codemap.graph(index, "folder", "d", touched=["d/f69.py"])
    assert g["truncated"] and len(g["nodes"]) == codemap.MAX_NODES
    assert any(n["id"] == "d/f69.py" for n in g["nodes"])


def test_mermaid_shapes_and_highlight():
    out = codemap.to_mermaid(codemap.graph(INDEX, "project", "", touched=["server.py"]))
    assert out.startswith("flowchart LR")
    assert '[["viewer/<br/>2 files"]]' in out
    assert "classDef hot" in out and "class n2 hot" in out
    assert '"' not in codemap._label('a"b<c>')


def test_edited_paths():
    ev = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Edit", "input": {"file_path": "/r/viewer/db.py"}},
        {"type": "tool_use", "name": "Write", "input": {"file_path": "/r/../etc/x.py"}},
        {"type": "tool_use", "name": "Read", "input": {"file_path": "/r/a.py"}},
        {"type": "tool_use", "name": "Write", "input": {"file_path": "/r/notes.md"}},
        {"type": "text", "text": "hi"}]}}
    assert codemap.edited_paths(ev, "/r") == ["viewer/db.py"]
    assert codemap.edited_paths({"type": "result"}, "/r") == []
    assert codemap.edited_paths("garbage", "/r") == []


def test_source_files_skips_vendored(tmp_path):
    (tmp_path / "a.py").write_text("x = 1")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "b.js").write_text("")
    (tmp_path / "README.md").write_text("")
    assert list(codemap.source_files(str(tmp_path))) == ["a.py"]


def test_agent_plugin_dir_is_path_safe():
    from viewer.config import agent_plugin_dir
    assert agent_plugin_dir("software-engineer").name == "software-engineer"
    assert agent_plugin_dir("product-manager") is not None
    for bad in ("", "../etc", "a/b", "Nope", "no-such-plugin", "-x"):
        assert agent_plugin_dir(bad) is None


def test_code_map_tool_routes_to_a_registered_get():
    from viewer import server, viewer_mcp
    assert viewer_mcp._TOOLS["code_map"] == ("GET", "/api/org/map")
    assert server.SessionViewerHandler.GET_ROUTES["/api/org/map"] == "_g_org_map"
    assert viewer_mcp._PROJECT_DEFAULT["code_map"] == "project"
