"""Tests for viewer/filesearch.py and /api/fs/search — the composer's "#"
file picker. Local disk is a tmp dir; the remote leg runs the shipped
script source through a local python (no SSH)."""
import json
import subprocess
import sys

from viewer import filesearch
from viewer.routes.fs import FsMixin


def _tree(root, paths):
    for p in paths:
        f = root / p
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")


def test_walk_lists_files_and_folders_skipping_dependency_dirs(tmp_path):
    _tree(tmp_path, ["a.txt", "src/lib/files.ts", "node_modules/x/i.js", ".git/HEAD", "dist/o.js"])
    paths = filesearch.project_paths(str(tmp_path))
    assert "a.txt" in paths and "src/lib/files.ts" in paths
    assert "src/" in paths and "src/lib/" in paths
    assert not any(p.startswith(("node_modules", ".git", "dist")) for p in paths)


def test_git_repo_respects_gitignore(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    _tree(tmp_path, ["keep.py", "out/gen.py", "docs/My Notes.md"])
    (tmp_path / ".gitignore").write_text("out/\n")
    paths = filesearch.project_paths(str(tmp_path))
    assert "keep.py" in paths and "docs/My Notes.md" in paths and "docs/" in paths
    assert not any(p.startswith("out") for p in paths)


def test_rank_prefers_basename_and_word_starts():
    paths = ["src/", "src/components/Composer.tsx", "web/src/composer/README.md",
             "docs/compose-notes.md", "lib/c/o/m/p.ts"]
    assert filesearch.rank(paths, "composer")[0] == "src/components/Composer.tsx"
    assert filesearch.rank(paths, "zzz") == []
    assert "lib/c/o/m/p.ts" in filesearch.rank(paths, "comp")  # subsequence across segments


def test_rank_empty_query_lists_top_level():
    assert filesearch.rank(["a/", "a/b.txt", "c.md"], "") == ["a/", "c.md"]


def test_remote_script_is_self_contained(tmp_path):
    _tree(tmp_path, ["x/y.txt"])
    import inspect
    script = (inspect.getsource(filesearch.project_paths)
              + f"\nimport json\nprint(json.dumps(project_paths({str(tmp_path)!r})))\n")
    out = subprocess.run([sys.executable, "-I", "-"], input=script.encode(), capture_output=True, check=True)
    assert json.loads(out.stdout) == ["x/", "x/y.txt"]


class _Handler(FsMixin):
    def send_json(self, data, status=200):
        self.sent = (data, status)


class _Req:
    def __init__(self, query):
        self.query = query
        self.host = "local"


def test_route_returns_ranked_results_and_hides_secrets(tmp_path):
    filesearch._CACHE.clear()
    _tree(tmp_path, ["notes/plan.md", ".credentials.json", "readme.md"])
    h = _Handler()
    h._g_fs_search(_Req({"cwd": [str(tmp_path)], "q": ["plan"]}))
    data, status = h.sent
    assert status == 200 and data["results"][0] == {"path": "notes/plan.md", "dir": False}
    h._g_fs_search(_Req({"cwd": [str(tmp_path)], "q": ["cred"]}))
    assert h.sent[0]["results"] == []


def test_route_needs_cwd():
    h = _Handler()
    h._g_fs_search(_Req({"q": ["x"]}))
    assert h.sent[1] == 400
