"""viewer.history — the full chat history of a trimmed Claude transcript.

Local Claude runs set CLAUDE_CODE_TRANSCRIPT_LOCAL_GC=1: after a compaction the
CLI rewrites the transcript as a NEW file holding only what a resume needs (a
few metadata rows and the post-compaction conversation), so a 2 GB chat
resumes from under a megabyte. The rows it drops are gone from that file, but
the owner still scrolls up through them in the app. This module keeps them:

  ~/.claude/session-history/<project-dir>/<sid>.jsonl        the archive: every
        row a trim dropped, in transcript order (append-only)
  ~/.claude/session-history/<project-dir>/<sid>.pending.<ns> hardlinks to the
        transcript taken before a trim can happen (the PreCompact hook, and
        each spawn). A hardlink freezes the old file: the CLI writes the
        trimmed transcript as a new inode, the link keeps the old one.
  ~/.claude/session-history/<project-dir>/<sid>.meta.json    {"archive_size",
        "done"}: the committed archive length (a crash mid-append is cut back
        to it) and pendings already folded (a crash before unlink).

settle() folds the pendings: for each snapshot, the rows the NEXT file (the
next snapshot, or the live transcript) no longer holds are the rows that trim
dropped, appended to the archive. The app reads one virtual file — the archive
followed by the live transcript — through HistoryView, with byte offsets
tagged by a generation so an offset taken before a trim is recognised as
stale and the client reloads (see encode/decode).

The directory sits outside ~/.claude/projects, so the CLI's own cleanup and
the session listing never see it, and on the same filesystem, so hardlinks
work. Stdlib only: the PreCompact hook runs this file as a script.
"""
import collections
import contextlib
import hashlib
import json
import os
import sys
import threading
import time
import zlib
from pathlib import Path

GC_ENV = "CLAUDE_CODE_TRANSCRIPT_LOCAL_GC"

_GEN_BITS = 40                  # virtual offsets below 1 TiB
_GEN_MOD = 8191                 # gen * 2**40 stays under 2**53 (JS safe integer)
_VMASK = (1 << _GEN_BITS) - 1
_SYNC_FOLD_BYTES = 64 << 20     # a read folds inline below this; above, in a thread
_COPY = 8 << 20


def history_dir(live):
    """The history folder for a transcript at <projects>/<project-dir>/<sid>.jsonl."""
    live = Path(live)
    return live.parent.parent.parent / "session-history" / live.parent.name


def _paths(live):
    live = Path(live)
    d = history_dir(live)
    sid = live.stem
    return d, d / f"{sid}.jsonl", d / f"{sid}.meta.json", d / f"{sid}.lock", sid


def _pendings(live, before_ns=None):
    """Snapshot paths, oldest first. before_ns leaves out ones taken later."""
    d, _, _, _, sid = _paths(live)
    out = []
    try:
        names = os.listdir(d)
    except FileNotFoundError:
        return []
    prefix = f"{sid}.pending."
    for n in names:
        if n.startswith(prefix) and n[len(prefix):].isdigit():
            ns = int(n[len(prefix):])
            if before_ns is None or ns < before_ns:
                out.append((ns, d / n))
    return [p for _, p in sorted(out)]


def snapshot(live):
    """Hardlink the transcript as a pending snapshot. Returns the link or None.
    Cheap (no data copied); called by the PreCompact hook and before a spawn."""
    live = Path(live)
    d = history_dir(live)
    try:
        d.mkdir(parents=True, exist_ok=True)
        link = d / f"{live.stem}.pending.{time.time_ns()}"
        os.link(live, link)
        return link
    except OSError:
        return None


def _read_meta(meta):
    try:
        m = json.loads(meta.read_text())
        return {"archive_size": int(m.get("archive_size", 0)), "done": list(m.get("done") or [])}
    except (OSError, ValueError, TypeError):
        return {"archive_size": 0, "done": []}


def _write_meta(meta, m):
    tmp = meta.with_name(meta.name + ".tmp")
    with open(tmp, "w") as f:
        json.dump(m, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, meta)


def _digest(line):
    return hashlib.blake2b(line.rstrip(b"\n"), digest_size=16).digest()


def _line_counts(f):
    """How often each line (by digest) occurs in an open binary file. Counted,
    not a set: the CLI repeats byte-identical rows ("mode", "atis-latch")."""
    f.seek(0)
    return collections.Counter(_digest(line) for line in f if line.strip())


def _lines_with_newline(f):
    for line in f:
        yield line if line.endswith(b"\n") else line + b"\n"


def _fold_one(pending, nxt, archive, meta, m):
    """Append the rows of `pending` that `nxt` (an open file) no longer holds,
    then commit the meta and drop the snapshot."""
    keep = _line_counts(nxt)
    with open(archive, "ab") as out:
        out.truncate(m["archive_size"])
        out.seek(m["archive_size"])
        buf = []
        size = 0
        with open(pending, "rb") as src:
            for line in _lines_with_newline(src):
                if not line.strip():
                    continue
                h = _digest(line)
                if keep[h]:
                    keep[h] -= 1        # this copy survives in the next file
                    continue
                buf.append(line)
                size += len(line)
                if size >= _COPY:
                    out.write(b"".join(buf))
                    buf, size = [], 0
        out.write(b"".join(buf))
        out.flush()
        os.fsync(out.fileno())
        new_size = out.tell()
    m = {"archive_size": new_size, "done": m["done"] + [pending.name]}
    _write_meta(meta, m)
    _unlink(pending)
    return m


def _unlink(p):
    try:
        os.unlink(p)
    except FileNotFoundError:
        pass


def _ino(p):
    try:
        return os.stat(p).st_ino
    except FileNotFoundError:
        return None


@contextlib.contextmanager
def _locked(lock, blocking=True):
    """Hold the per-chat fold lock; yields False when blocking=False and it is taken.
    POSIX flock, or msvcrt's byte lock on Windows (the viewer imports there too)."""
    with open(lock, "a+b") as lk:
        try:
            if os.name == "nt":
                import msvcrt
                lk.seek(0)
                msvcrt.locking(lk.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lk, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except OSError:
            if blocking:
                raise
            yield False                 # someone else is folding this chat
            return
        yield True


def settle(live, blocking=True):
    """Fold every pending snapshot into the archive. Returns False when another
    fold holds the lock (blocking=False) or the transcript is gone."""
    live = Path(live)
    d, archive, meta, lock, _ = _paths(live)
    if not d.is_dir():
        return True
    with _locked(lock, blocking) as got:
        if not got:
            return False
        m = _read_meta(meta)
        # Snapshots folded before a crash took their unlink with it.
        for p in _pendings(live):
            if p.name in m["done"]:
                _unlink(p)
        cutoff = time.time_ns()
        try:
            lf = open(live, "rb")       # this inode is "now", whatever trims next
        except FileNotFoundError:
            return False
        with lf:
            live_ino = os.fstat(lf.fileno()).st_ino
            pend = _pendings(live, before_ns=cutoff)
            for i, p in enumerate(pend):
                last = i == len(pend) - 1
                p_ino = _ino(p)
                if p_ino is None:
                    continue
                if last and p_ino == live_ino:
                    break               # nothing trimmed yet; a trim may still come
                if not last and p_ino == _ino(pend[i + 1]):
                    _unlink(p)          # the later link is the same file, grown
                    continue
                if last:
                    m = _fold_one(p, lf, archive, meta, m)
                else:
                    with open(pend[i + 1], "rb") as nf:
                        m = _fold_one(p, nf, archive, meta, m)
            alive = {p.name for p in _pendings(live)}
            if any(n not in alive for n in m["done"]):
                m = {"archive_size": m["archive_size"], "done": [n for n in m["done"] if n in alive]}
                _write_meta(meta, m)
    return True


def finish_run(live, before_ns):
    """At the end of a run: fold what its trims dropped, then drop its snapshots
    of the untouched transcript, so none linger while the chat is idle (a rewind
    or fork may then rewrite the file without a snapshot misreading it).
    before_ns is when the run ended: a snapshot the NEXT run took since is its
    guard against its own trim and stays."""
    live = Path(live)
    settle(live)
    d, _, _, lock, _ = _paths(live)
    if not d.is_dir():
        return
    with _locked(lock):
        ino = _ino(live)
        for p in _pendings(live, before_ns=before_ns):
            if _ino(p) == ino:
                _unlink(p)


_bg = set()
_bg_lock = threading.Lock()


def settle_soon(live):
    """Fold in a background thread unless one is already folding this chat."""
    key = str(live)
    with _bg_lock:
        if key in _bg:
            return
        _bg.add(key)

    def run():
        try:
            settle(live)
        finally:
            with _bg_lock:
                _bg.discard(key)
    threading.Thread(target=run, daemon=True, name="history-settle").start()


def _unsettled_bytes(live):
    """Bytes waiting in snapshots that differ from the live transcript (0 when
    nothing was trimmed since the last fold)."""
    ino = _ino(live)
    return sum(p.stat().st_size for p in _pendings(live) if _ino(p) not in (None, ino))


def archive_size(live):
    _, archive, meta, _, _ = _paths(live)
    if not archive.exists():
        return 0
    return min(_read_meta(meta)["archive_size"], archive.stat().st_size)


# ----- offsets ------------------------------------------------------------- #
# A virtual offset v into archive+live is sent as gen * 2**40 + v. gen 0 is a
# chat that was never trimmed, so its offsets are the plain file offsets the
# clients always had. Otherwise gen follows (live inode, archive size), both of
# which change at every trim and fold, so an offset taken before one decodes
# as stale and the client reloads. v = 0 (the top) is always 0.

def generation(live_ino, a_size):
    if a_size == 0:
        return 0
    return 1 + zlib.crc32(f"{live_ino}:{a_size}".encode()) % _GEN_MOD


def encode(gen, v):
    return 0 if v == 0 else gen * (1 << _GEN_BITS) + v


def decode(gen, off):
    """The virtual offset an encoded one names, or None when it is stale."""
    if off <= 0:
        return 0
    if off >> _GEN_BITS != gen:
        return None
    return off & _VMASK


class HistoryView:
    """One read-only, seekable binary file over archive[:archive_size] + live.
    Works with read_back_f and anything else that seeks and reads."""

    def __init__(self, live):
        self.live = Path(live)
        waiting = _unsettled_bytes(self.live)
        if waiting:
            if waiting <= _SYNC_FOLD_BYTES:
                settle(self.live, blocking=False)
            else:
                settle_soon(self.live)  # the first fold of a huge chat: seconds
        _, archive, meta, _, _ = _paths(self.live)
        self._lf = open(self.live, "rb")
        st = os.fstat(self._lf.fileno())
        self.a_size = archive_size(self.live)
        self._af = open(archive, "rb") if self.a_size else None
        self.gen = generation(st.st_ino, self.a_size)
        self.size = self.a_size + st.st_size
        self._pos = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        self._lf.close()
        if self._af:
            self._af.close()

    def seek(self, pos, whence=0):
        if whence == 2:
            pos = self.size + pos
        elif whence == 1:
            pos = self._pos + pos
        self._pos = max(0, pos)
        return self._pos

    def tell(self):
        return self._pos

    def read(self, n=-1):
        # Bounded by the size at open: a run appending meanwhile never makes
        # one response longer than the size it announced.
        if n is None or n < 0:
            n = self.size - self._pos
        n = min(n, self.size - self._pos)
        out = []
        while n > 0:
            if self._pos < self.a_size:
                self._af.seek(self._pos)
                chunk = self._af.read(min(n, self.a_size - self._pos))
            else:
                self._lf.seek(self._pos - self.a_size)
                chunk = self._lf.read(n)
            if not chunk:
                break
            out.append(chunk)
            self._pos += len(chunk)
            n -= len(chunk)
        return b"".join(out)

    def at_line_start(self, v):
        """Whether virtual offset v starts a line (a guard on stale offsets)."""
        if v <= 0:
            return True
        if v > self.size:
            return False
        self.seek(v - 1)
        return self.read(1) == b"\n"

    def lines(self):
        """Every line of the history, in order."""
        self.seek(0)
        rest = b""
        while True:
            chunk = self.read(_COPY)
            if not chunk:
                break
            parts = (rest + chunk).split(b"\n")
            rest = parts.pop()
            yield from parts
        if rest:
            yield rest


def _hook():
    """PreCompact hook: snapshot the transcript before the CLI trims it. Never
    fails the compaction (exit 2 would block it), whatever goes wrong."""
    try:
        data = json.load(sys.stdin)
        path = data.get("transcript_path")
        if path and os.path.isfile(path):
            snapshot(path)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    _hook()
