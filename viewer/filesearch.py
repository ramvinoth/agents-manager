"""Fuzzy search over a project's files and folders — the composer's "#" picker.

`project_paths` lists the project (git's view when it is a repo, else a bounded
walk); it is stdlib-only and self-contained because remote hosts run its exact
source (inspect.getsource), so local and SSH results can never drift.
`rank` scores those paths fzf-style on the server, the same code for every host.
"""
import inspect
import json
from time import time as _now

from viewer.engine import get_host


def project_paths(root, cap=20000):
    """Project-relative paths under `root`: files as-is, folders with a
    trailing "/". Git repos list tracked + untracked-not-ignored files (so
    .gitignore'd build output stays out); other folders are walked, skipping
    dot-folders and the usual dependency/build folders. At most `cap` files."""
    import os
    import subprocess
    import time
    root = os.path.expanduser(root)
    deadline = time.time() + 4   # a huge non-repo folder (say ~) must not hang the picker
    skip = {"node_modules", "__pycache__", "dist", "build", "venv", ".venv", "target", "Pods"}
    files = []
    try:
        out = subprocess.run(
            ["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
            capture_output=True, timeout=8)
        if out.returncode == 0:
            files = [f for f in out.stdout.decode("utf-8", "replace").split("\0") if f][:cap]
    except Exception:
        files = []
    if not files:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in skip]
            rel = os.path.relpath(dirpath, root)
            for name in filenames:
                files.append(name if rel == "." else rel + "/" + name)
            if len(files) >= cap or time.time() > deadline:
                files = files[:cap]
                break
    dirs = set()
    for f in files:
        parts = f.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]) + "/")
    return sorted(dirs) + files


def _subseq(low, q, start, base):
    """Greedy left-to-right match of `q` in `low` from `start`: a score that
    rewards consecutive runs, starts of words and basename hits, or None."""
    score, last, run, pos = 0, -1, 0, start
    for ch in q:
        i = low.find(ch, pos)
        if i < 0:
            return None
        run = run + 1 if i == last + 1 else 0
        score += 1 + run * 4
        if i == 0 or low[i - 1] in "/._- ":
            score += 6
        if i >= base:
            score += 2
        last, pos = i, i + 1
    return score


def _score(path, q):
    """fzf-style score of query `q` (lowercase) against `path`, or None when
    `q` is not a subsequence of it. A match wholly inside the last segment
    beats one spread over folders; an exact substring there beats both;
    shorter paths win ties."""
    low = path.lower()
    base = low.rstrip("/").rfind("/") + 1
    inner = _subseq(low, q, base, base)
    score = inner + 25 if inner is not None else _subseq(low, q, 0, base)
    if score is None:
        return None
    name = low[base:]
    if q in name:
        score += 20 + (15 if name.startswith(q) else 0)
    elif q in low:
        score += 10
    return score - len(path) * 0.05


def rank(paths, query, limit=30):
    """Best `limit` paths for `query`; an empty query lists the top level."""
    q = "".join(query.lower().split())
    if not q:
        top = [p for p in paths if "/" not in p.rstrip("/")]
        return top[:limit]
    scored = [(s, p) for p in paths if (s := _score(p, q)) is not None]
    scored.sort(key=lambda sp: (-sp[0], sp[1]))
    return [p for _, p in scored[:limit]]


_CACHE = {}       # (host, root) -> (time, paths)
_TTL = 30         # seconds: typing a query re-ranks; new files show within this


def _listing(host, root):
    now = _now()
    hit = _CACHE.get((host, root))
    if hit and now - hit[0] < _TTL:
        return hit[1]
    h = get_host(host)
    if h.is_local:
        paths = project_paths(root)
    else:
        from viewer.remote import remote_run_python
        script = (inspect.getsource(project_paths)
                  + f"\nimport json\nprint(json.dumps(project_paths({root!r})))\n")
        paths = json.loads(remote_run_python(host, script))
    _CACHE[(host, root)] = (now, paths)
    return paths


def search(host, root, query, limit=30):
    """[{path, dir}] ranked for `query` inside the project at `root`."""
    return [{"path": p.rstrip("/"), "dir": p.endswith("/")}
            for p in rank(_listing(host or "local", root), query, limit)]
