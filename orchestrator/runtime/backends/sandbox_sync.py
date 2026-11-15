"""Three way folder sync between this machine and a sandbox box.

A sandboxed run gets a copy of its folder; at the end of the turn the box's
changes come back. The base is the manifest taken when the copy went in, so
each side's change is measured against the same starting point: a file only
the box changed is applied, a file only this machine changed (another session
working the same folder meanwhile) is kept, and a file both changed is a
conflict that keeps the local copy and is logged.

Stdlib only, no orchestrator imports: the backend ships this same file into
the box and runs `python3 sandbox_sync.py manifest` there, so the box lists
and hashes files by exactly the rules this machine does.
"""
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile

# Folders that are rebuilt, not authored. Skipped when a folder has no git to
# say what matters; a git folder uses its own ignore rules instead.
SKIP_DIRS = frozenset({"node_modules", ".venv", "venv", "__pycache__", ".next",
                       "Pods", "DerivedData", ".mypy_cache", ".pytest_cache"})
SKIP_FILES = frozenset({".DS_Store"})
MAX_BYTES = 200 * 1024 * 1024


class TooBig(Exception):
    """The folder is larger than a sandbox copy should carry."""


def _git_files(root):
    """Tracked plus untracked, not ignored, then everything under .git."""
    out = subprocess.run(["git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z"],
                         capture_output=True, timeout=120, check=True).stdout
    names = [n for n in out.decode("utf-8", "surrogateescape").split("\0") if n]
    for d, _, files in os.walk(os.path.join(root, ".git")):
        rel = os.path.relpath(d, root)
        names += [os.path.join(rel, f) for f in files]
    return names


def _walked_files(root):
    names = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        rel = os.path.relpath(d, root)
        names += [f if rel == "." else os.path.join(rel, f) for f in files if f not in SKIP_FILES]
    return names


def list_files(root, cap=MAX_BYTES):
    """Every file a copy of `root` carries: relative paths of regular files and
    symlinks. Git aware when the folder is a repository, since a raw walk of a
    code folder is mostly build output (measured: 9.5 GB walked against 27 MB
    tracked). Raises TooBig past `cap`."""
    if not os.path.isdir(root):
        return []
    try:
        names = _git_files(root) if os.path.isdir(os.path.join(root, ".git")) else _walked_files(root)
    except (subprocess.SubprocessError, OSError):
        names = _walked_files(root)
    kept, total = [], 0
    for name in sorted(set(names)):
        path = os.path.join(root, name)
        if os.path.islink(path):
            kept.append(name)
        elif os.path.isfile(path):
            total += os.path.getsize(path)
            if total > cap:
                raise TooBig(f"{root} is over {cap // (1024 * 1024)} MB of files, too big for a sandbox copy")
            kept.append(name)
    return kept


def _sha1(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(root, paths):
    """{path: sha1} for each of `paths` that is a regular file under root.
    Symlinks are left out: they go into the box but never come back."""
    out = {}
    for name in paths:
        path = os.path.join(root, name)
        if os.path.isfile(path) and not os.path.islink(path):
            try:
                out[name] = _sha1(path)
            except OSError:
                pass
    return out


def current_manifest(root, base_paths):
    """The manifest a side holds now: the base's paths that still exist plus any
    file the listing finds. Hashing the base's paths directly means an edit to
    .gitignore never reads as every newly ignored file being deleted."""
    try:
        found = list_files(root, cap=float("inf"))
    except OSError:
        found = []
    return manifest(root, set(base_paths) | set(found))


def plan_sync(base, local_now, box_now):
    """What to do with this machine's copy after a box turn.

    Each argument maps path -> sha1, a missing path meaning no file. Returns
    (writes, deletes, conflicts), sorted path lists:
      box unchanged from base            -> nothing
      box equals local already           -> nothing
      local unchanged from base          -> take the box (write, or delete when gone)
      both changed, differently          -> conflict, keep local
    """
    writes, deletes, conflicts = [], [], []
    for path in sorted(set(base) | set(box_now)):
        b, x, l = base.get(path), box_now.get(path), local_now.get(path)
        if x == b or x == l:
            continue
        if l == b:
            (writes if x is not None else deletes).append(path)
        else:
            conflicts.append(path)
    return writes, deletes, conflicts


def write_tar(fileobj, root, paths):
    """Stream `paths` (relative to root) as an uncompressed tar."""
    with tarfile.open(fileobj=fileobj, mode="w|") as tar:
        for name in paths:
            try:
                tar.add(os.path.join(root, name), arcname=name, recursive=False)
            except OSError:
                pass


def extract_tar(fileobj, root, allowed=None):
    """Write each regular file of a tar stream under root, atomically, keeping
    its mode. `allowed` (a set of relative paths) limits what is written; None
    takes every file. A name that leaves root is refused. Returns the paths written."""
    root = os.path.realpath(root)
    written = []
    with tarfile.open(fileobj=fileobj, mode="r|") as tar:
        for member in tar:
            name = os.path.normpath(member.name)
            if not member.isfile() or (allowed is not None and name not in allowed):
                continue
            dest = os.path.realpath(os.path.join(root, name))
            if not dest.startswith(root + os.sep):
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            src = tar.extractfile(member)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".harman-sync.")
            try:
                with os.fdopen(fd, "wb") as f:
                    while chunk := src.read(1 << 20):
                        f.write(chunk)
                os.chmod(tmp, member.mode & 0o7777)
                os.replace(tmp, dest)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            written.append(name)
    return written


def delete_files(root, paths):
    for name in paths:
        try:
            os.unlink(os.path.join(root, name))
        except OSError:
            pass


if __name__ == "__main__":
    # In the box: `python3 sandbox_sync.py manifest ROOT` with the base's path
    # list as JSON on stdin prints that side's current manifest as JSON.
    if sys.argv[1:2] == ["manifest"] and len(sys.argv) == 3:
        json.dump(current_manifest(sys.argv[2], json.load(sys.stdin)), sys.stdout)
    else:
        sys.exit("usage: sandbox_sync.py manifest ROOT < base_paths.json")
