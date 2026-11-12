"""Session summaries and the cwd/project a session belongs to."""
import json
import threading
from pathlib import Path

from orchestrator.remote import SSH, remote_full_path, remote_run_python
from orchestrator.runtime.titles import _HOME_ENC
from orchestrator.sessions import compute_session_summary, last_cwd_in_file


def _session_project(jsonl_file):
    """The folder a chat belongs to: the cwd its transcript records (the last
    one, as resume uses). Claude's project-dir name is only a fallback: it
    encodes '/', ' ' and other characters all as '-', so decoding it guesses
    wrong for any folder with a space or a dash in its name."""
    try:
        with open(jsonl_file, "rb") as fh:
            cwd = last_cwd_in_file(fh)
        if cwd:
            return cwd
    except OSError:
        pass
    pdir = jsonl_file.parent.name
    if pdir.startswith(_HOME_ENC + "-"):
        pdir = "~/" + pdir[len(_HOME_ENC) + 1:]
    return pdir.replace("--", "/").replace("-", "/")


def extract_cwd(session_file):
    """Find the working directory recorded in the session."""
    try:
        with open(session_file, "r") as f:
            for i, line in enumerate(f):
                if i > 100:
                    break
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("cwd"):
                    return obj["cwd"]
    except Exception:
        pass
    return str(Path.home())


def remote_session_summary(hid, rel):
    """Full-session stats for a remote session, computed ON the host via
    remote_run_python. Never pull the file over SFTP for this: a 25 MB session
    means minutes of 32 KB round-trips while holding the host op-lock, which
    starves every other request for that host ("host connection is busy").
    The host runs the same compute_session_summary source (inspect.getsource),
    so local and remote output cannot drift. Cached by (mtime, size)."""
    full = remote_full_path(hid, rel)
    if not full:
        return None
    with SSH.lock_for(hid):
        c = SSH.get(hid)
        home = c["home"]
        try:
            st = c["sftp"].stat(full)
        except IOError:
            return None
    key = (hid, full)
    hit = REMOTE_SUMMARY_CACHE.get(key, st.st_mtime, st.st_size)
    if hit is not None:
        return hit
    import inspect
    script = ("import json, sys\n"
              + inspect.getsource(compute_session_summary)
              + "P = json.loads(%r)\n" % json.dumps({"path": full, "home": home})
              + r"""
try:
    with open(P["path"], errors="replace") as fh:
        lines = fh.read().splitlines()
except OSError:
    print("null"); sys.exit()
cwd = P["home"]
for line in lines[:200]:
    try:
        o = json.loads(line)
    except Exception:
        continue
    if o.get("cwd"):
        cwd = o["cwd"]; break
print(json.dumps(compute_session_summary(lines, cwd)))
""")
    txt = remote_run_python(hid, script)
    try:
        data = json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return None
    if data:
        REMOTE_SUMMARY_CACHE.put(key, st.st_mtime, st.st_size, data)
    return data


class StatCache:
    """Cache keyed on an opaque key, invalidated when the source file's
    (mtime, size) change. FIFO-capped at `cap` entries. Replaces three
    hand-rolled dicts that all did this identically."""
    def __init__(self, cap=50):
        self._d = {}
        self._cap = cap
        # Shared across worker threads; without this, put()'s pop(next(iter(...)))
        # can race a concurrent get()/put() → "dict changed size during iteration".
        self._lock = threading.Lock()

    def get(self, key, mtime, size):
        with self._lock:
            c = self._d.get(key)
            if c is not None and c["mtime"] == mtime and c["size"] == size:
                return c["data"]
            return None

    def put(self, key, mtime, size, data):
        with self._lock:
            self._d[key] = {"mtime": mtime, "size": size, "data": data}
            if len(self._d) > self._cap:
                self._d.pop(next(iter(self._d)))


REMOTE_SUMMARY_CACHE = StatCache()   # (hid, path) invalidated by (mtime, size)
