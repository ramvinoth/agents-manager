"""Git integration: list the user's GitHub repos, clone one onto a host, and
report a working directory's repo/branch state.

Auth comes from the per-host env vars (viewer/hostenv.py) — the first of
GH_TOKEN / GITHUB_TOKEN / GIT_TOKEN set for the host. The token is never
written into a repo's .git/config: clones get a credential helper that reads
$GH_TOKEN at use time, falling back to ~/.claude/.viewer-git-token (0600,
written on the target host at clone time) so pushes work from terminals and
agent runs alike.
"""
import json
import os
import re
import shlex
import subprocess
import threading
import time
import urllib.request
import uuid
from pathlib import Path

from viewer.hostenv import host_env

TOKEN_KEYS = ("GH_TOKEN", "GITHUB_TOKEN", "GIT_TOKEN")
TOKEN_FILE = "~/.claude/.viewer-git-token"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def valid_branch(b):
    """Conservative subset of git-check-ref-format for a new branch name."""
    return (bool(re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", b))
            and not b.startswith(("-", "/", "."))
            and not b.endswith(("/", ".", ".lock"))
            and ".." not in b and "//" not in b and "@{" not in b)

# Reads $GH_TOKEN at fetch/push time (agent runs get it injected) with the
# clone-time token file as fallback — the secret itself never lands in .git/config.
CRED_HELPER = ('!f() { echo username=x-access-token; '
               'echo "password=${GH_TOKEN:-$(cat ' + TOKEN_FILE + ' 2>/dev/null)}"; }; f')

_REPOS_CACHE = {}   # hid -> {"at": ts, "data": [...]}
_REPOS_LOCK = threading.Lock()


def git_token(hid):
    """The GitHub token configured for a host, or ""."""
    env = host_env(hid)
    for k in TOKEN_KEYS:
        if env.get(k):
            return env[k]
    return ""


def list_repos(hid):
    """{"configured": bool, "repos": [...]} — the token owner's GitHub repos,
    newest-pushed first. Cached 60s per host (the dialog re-opens often)."""
    token = git_token(hid)
    if not token:
        return {"configured": False, "repos": []}
    with _REPOS_LOCK:
        cached = _REPOS_CACHE.get(hid)
        if cached and time.time() - cached["at"] < 60:
            return {"configured": True, "repos": cached["data"]}
    req = urllib.request.Request(
        "https://api.github.com/user/repos?per_page=100&sort=pushed",
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "claude-session-viewer"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    repos = [{"fullName": d.get("full_name", ""), "name": d.get("name", ""),
              "private": bool(d.get("private")), "defaultBranch": d.get("default_branch", "main"),
              "pushedAt": d.get("pushed_at", "")}
             for d in data if isinstance(d, dict) and d.get("full_name")]
    with _REPOS_LOCK:
        _REPOS_CACHE[hid] = {"at": time.time(), "data": repos}
    return {"configured": True, "repos": repos}


def _q_path(p):
    """Shell-quote a path, keeping a leading ~ expandable ("~/x" → "$HOME"/x)."""
    p = (p or "").strip()
    if p == "~":
        return '"$HOME"'
    if p.startswith("~/"):
        return '"$HOME"' + shlex.quote(p[1:])
    return shlex.quote(p)


# ----- Clone jobs (async, polled) --------------------------------------------
# A clone can take minutes on a big repo, so POST /api/git/clone starts a
# background job and returns its id; GET /api/git/clone/status reports phase +
# percent parsed live from `git clone --progress` output. Phase percents are
# mapped onto one monotonic 0–100 scale (receive dominates the wall clock).

CLONE_JOBS = {}   # jid -> {running, phase, percent, dir, error, started}
_JOBS_LOCK = threading.Lock()
CLONE_TIMEOUT = 900

_PHASE_SPANS = {  # phase -> (start, span) on the overall bar
    "Enumerating objects": (0, 3),
    "Counting objects": (3, 3),
    "Compressing objects": (6, 4),
    "Receiving objects": (10, 75),
    "Resolving deltas": (85, 10),
    "Updating files": (95, 5),
}
_PROG_RE = re.compile(r"(Enumerating objects|Counting objects|Compressing objects|"
                      r"Receiving objects|Resolving deltas|Updating files):\s*(?:(\d+)%)?")


def _job_update(jid, **kw):
    with _JOBS_LOCK:
        job = CLONE_JOBS.get(jid)
        if job:
            job.update(kw)


def _feed_progress(jid, text):
    """Parse git progress segments (\\r- or \\n-terminated) into the job's
    phase/percent. Percent only ever moves forward (progress re-prints jitter)."""
    best = None
    for m in _PROG_RE.finditer(text):
        phase, pct = m.group(1), int(m.group(2) or 0)
        start, span = _PHASE_SPANS[phase]
        best = (start + span * pct // 100, phase)
    if best is None:
        return
    with _JOBS_LOCK:
        job = CLONE_JOBS.get(jid)
        if job and best[0] >= job["percent"]:
            job["percent"], job["phase"] = best

def clone_status(jid):
    with _JOBS_LOCK:
        job = CLONE_JOBS.get(jid)
        return dict(job) if job else None


def start_clone(hid, repo, parent, branch=""):
    """Validate + kick off a background clone of owner/name into
    <parent>/<name> on the host, optionally checking out a NEW working branch
    off the default branch. Returns {"job": id} or {"error", "status"}."""
    if not REPO_RE.match(repo or ""):
        return {"error": "Bad repo — expected owner/name", "status": 400}
    branch = (branch or "").strip()
    if branch and not valid_branch(branch):
        return {"error": "Bad branch name", "status": 400}
    token = git_token(hid)
    if not token:
        return {"error": "No GitHub token for this host — add GH_TOKEN in the Env dialog", "status": 400}
    name = repo.split("/")[1]
    url = f"https://github.com/{repo}.git"

    jid = uuid.uuid4().hex[:12]
    with _JOBS_LOCK:
        # prune finished jobs no one polled away
        for k in [k for k, j in CLONE_JOBS.items()
                  if not j["running"] and time.time() - j["started"] > 900]:
            CLONE_JOBS.pop(k, None)
        CLONE_JOBS[jid] = {"running": True, "phase": "Starting", "percent": 0,
                           "dir": "", "error": "", "started": time.time()}

    if not hid or hid == "local":
        pdir = Path(os.path.expanduser(parent or "~")).resolve()
        target = pdir / name
        if target.exists() and any(target.iterdir()):
            with _JOBS_LOCK:
                CLONE_JOBS.pop(jid, None)
            return {"error": f"Already exists and isn't empty: {target}", "status": 409}
        pdir.mkdir(parents=True, exist_ok=True)
        tf = Path(os.path.expanduser(TOKEN_FILE))
        tf.parent.mkdir(parents=True, exist_ok=True)
        tf.write_text(token)
        os.chmod(tf, 0o600)
        threading.Thread(target=_clone_local, args=(jid, url, target, token, branch), daemon=True).start()
    else:
        threading.Thread(target=_clone_remote, args=(jid, hid, url, parent or "~", name, token, branch),
                         daemon=True).start()
    return {"job": jid}


def _clone_local(jid, url, target, token, branch=""):
    """`git clone --progress` locally, streaming stderr into the job; then
    checks out the new working branch when one was requested."""
    proc = None
    try:
        env = dict(os.environ, GH_TOKEN=token)
        proc = subprocess.Popen(["git", "clone", "--progress",
                                 "-c", "credential.helper=" + CRED_HELPER, url, str(target)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                bufsize=0, env=env)
        tail, deadline = b"", time.time() + CLONE_TIMEOUT
        while True:
            if time.time() > deadline:
                proc.kill()
                _job_update(jid, running=False, error="Clone timed out")
                return
            chunk = proc.stderr.read(4096)
            if not chunk:
                break
            _feed_progress(jid, chunk.decode("utf-8", "replace"))
            tail = (tail + chunk)[-2000:]
        rc = proc.wait(timeout=30)
        if rc != 0:
            err = _scrub(tail.decode("utf-8", "replace"), token)
            _job_update(jid, running=False, error=err or f"git clone failed (exit {rc})")
            return
        if branch:  # working branch off the freshly-cloned default branch
            p = subprocess.run(["git", "-C", str(target), "checkout", "-q", "-b", branch],
                               capture_output=True, text=True, timeout=30)
            if p.returncode != 0:
                _job_update(jid, running=False,
                            error=f"Cloned, but couldn't create branch {branch}: "
                                  + ((p.stderr or "").strip()[-200:] or f"exit {p.returncode}"))
                return
        _job_update(jid, running=False, percent=100, phase="Done", dir=str(target))
    except Exception as e:
        if proc:
            try:
                proc.kill()
            except OSError:
                pass
        _job_update(jid, running=False, error=_scrub(str(e), token) or "Clone failed")


def _clone_remote(jid, hid, url, parent, name, token, branch=""):
    """Clone on an SSH host, streaming the pty output into the job. Mirrors
    RemoteProc: hold the per-host lock for setup only, then read off-lock."""
    from viewer.remote import SSH
    tgt = _q_path(parent.rstrip("/") + "/" + name)
    cmd = ("umask 077; mkdir -p ~/.claude && printf %s " + shlex.quote(token) + " > " + TOKEN_FILE
           + " && export GH_TOKEN=" + shlex.quote(token)
           + " && if [ -e " + tgt + " ] && [ -n \"$(ls -A " + tgt + " 2>/dev/null)\" ];"
           + " then echo VIEWER_EXISTS; exit 9; fi"
           + " && mkdir -p " + _q_path(parent)
           + " && git clone --progress -c credential.helper=" + shlex.quote(CRED_HELPER)
           + " " + shlex.quote(url) + " " + tgt
           + " && cd " + tgt
           + (" && git checkout -q -b " + shlex.quote(branch) if branch else "")
           + " && pwd")
    try:
        with SSH.lock_for(hid):
            c = SSH.get(hid)
            chan = c["client"].get_transport().open_session()
            chan.settimeout(CLONE_TIMEOUT)
            chan.get_pty()
            chan.exec_command("bash -lc " + shlex.quote(cmd))
        tail = b""
        while True:
            try:
                chunk = chan.recv(4096)
            except Exception:
                break
            if not chunk:
                break
            _feed_progress(jid, chunk.decode("utf-8", "replace"))
            tail = (tail + chunk)[-2000:]
        rc = chan.recv_exit_status()
        lines = [ln.strip() for ln in tail.decode("utf-8", "replace").replace("\r", "\n").splitlines()
                 if ln.strip()]
        if any("VIEWER_EXISTS" in ln for ln in lines):
            _job_update(jid, running=False,
                        error=f"Already exists and isn't empty: {parent.rstrip('/')}/{name}")
            return
        if rc != 0 or not lines:
            err = _scrub("\n".join(lines[-4:]), token)
            _job_update(jid, running=False, error=err or f"git clone failed (exit {rc})")
            return
        _job_update(jid, running=False, percent=100, phase="Done", dir=lines[-1])
    except Exception as e:
        _job_update(jid, running=False, error=_scrub(str(e), token) or "Clone failed")


def _scrub(text, token):
    return (text or "").replace(token, "***").strip()[-500:]


# One shell round-trip: every field on a GIT| line so remote pty noise (\r,
# login-shell banners) can't break parsing. Exit 3/4 = not a dir / not a repo.
_STATUS_SH = (
    'cd {cwd} 2>/dev/null || exit 3; '
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 4; '
    'b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); '
    'r=$(git rev-parse --show-toplevel 2>/dev/null); '
    'u=$(git remote get-url origin 2>/dev/null); '
    'n=$(git status --porcelain 2>/dev/null | wc -l); '
    'a=$(git rev-list --count @{{u}}..HEAD 2>/dev/null || echo -); '
    'bd=$(git rev-list --count HEAD..@{{u}} 2>/dev/null || echo -); '
    'printf "GIT|%s|%s|%s|%s|%s|%s\\n" "$b" "$n" "$a" "$bd" "$u" "$r"'
)


def repo_status(hid, cwd):
    """{"repo": bool, name, branch, dirty, ahead, behind, remote, root} for a
    working directory on the host. ahead/behind are None with no upstream."""
    script = _STATUS_SH.format(cwd=_q_path(cwd))
    if not hid or hid == "local":
        p = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=15)
        rc, out = p.returncode, p.stdout
    else:
        from viewer.remote import remote_run_shell
        rc, out = remote_run_shell(hid, script, timeout=20)
    line = next((ln.strip() for ln in out.replace("\r", "").splitlines()
                 if ln.strip().startswith("GIT|")), "")
    if rc != 0 or not line:
        return {"repo": False}
    parts = line.split("|")
    if len(parts) < 7:
        return {"repo": False}
    _, branch, dirty, ahead, behind, remote, root = parts[:7]
    m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?/?$", remote)
    name = m.group(1) if m else (root.rstrip("/").rsplit("/", 1)[-1] if root else "")
    return {"repo": True, "branch": branch, "name": name, "remote": remote, "root": root,
            "dirty": int(dirty) if dirty.strip().isdigit() else 0,
            "ahead": int(ahead) if ahead.strip().isdigit() else None,
            "behind": int(behind) if behind.strip().isdigit() else None}
