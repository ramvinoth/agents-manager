"""A box's folders in an object store, so a sandbox run needs no machine of ours.

The box pulls its folder from the store when it starts and pushes its changes
when the turn ends; the viewer only hands it a short lived capability. Nothing
of the folder passes through the viewer.

Layout, per folder (a volume: the workspace or the memory):
  head.json      {"version": 1, "files": {path: [sha1, size, mode, segments]},
                  "packs": {pack_id: size}}
  packs/<id>     concatenated file contents; id is the pack's sha256
A segment is [pack_id, offset, length, compressed]. A file is one segment
unless it is larger than a pack, then a run of them. Symlinks are kept with
mode 0o120777 and their target as content.

Why packs: a code folder is thousands of small files. One object per file
would be thousands of requests per turn; a pack is one. A push uploads only
what changed since the pull (hashes are reused while a file's mtime and size
hold), so a typical turn writes one small pack and one head.

The head is committed with a compare and swap (If-Match on its etag). When
another box committed first, the two are merged three way against the pulled
head (sandbox_sync.plan_sync): a path only this box changed is taken, a path
both changed keeps the store's copy and is reported as a conflict.

Stdlib only: it ships into the box next to sandbox_sync.py and runs there as
`python3 box_store.py pull|push VOLUME ROOT`, reading OPT/store.json.
"""
import concurrent.futures
import hashlib
import json
import os
import stat
import sys
import tempfile
import urllib.error
import urllib.request
import zlib

try:
    from orchestrator.runtime.backends import sandbox_sync
except ImportError:          # in the box, beside sandbox_sync.py
    import sandbox_sync

OPT = os.path.dirname(os.path.abspath(__file__))
PACK_BYTES = 64 << 20        # a pack, and the largest segment
PROBE = 64 << 10             # bytes of a file tried before compressing it
RAW_RATIO = 0.9              # compressed over raw above this: store raw
PARALLEL = 4
WHOLE_PACK = 0.5             # need more than this share of a pack: fetch it whole
RANGE_GAP = 64 << 10         # ranges closer than this are fetched as one
COMPACT_PACKS = 16
COMPACT_LIVE = 0.5
TRIES = 5
LINK_MODE = stat.S_IFLNK | 0o777
EMPTY = 3                    # pull's exit code when the store has no folder yet


def empty_head():
    return {"version": 1, "files": {}, "packs": {}}


def key(entry):
    """What sync compares: content and mode."""
    return f"{entry[0]}:{entry[2]:o}"


def keys(head):
    return {path: key(e) for path, e in head["files"].items()}


class Conflict(Exception):
    """The head moved since it was read."""


class Store:
    """The Worker's /store routes for one volume."""

    def __init__(self, url, token, prefix, volume, opener=urllib.request.urlopen):
        self.base = f"{url.rstrip('/')}/store/{prefix}/{volume}"
        self.token, self.open = token, opener

    def _req(self, method, path, data=None, headers=()):
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Authorization": f"Bearer {self.token}", **dict(headers)})
        return self.open(req, timeout=300)

    def head(self):
        """(etag, head), or (None, None) when the volume is empty."""
        try:
            with self._req("GET", "/head") as r:
                return r.headers["ETag"], json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, None
            raise

    def commit(self, head, etag):
        """Write the head if it is still `etag` (None: if there is none yet).
        Returns the new etag; raises Conflict when another box got there first."""
        cond = ("If-Match", etag) if etag else ("If-None-Match", "*")
        body = json.dumps(head, separators=(",", ":")).encode()
        try:
            with self._req("PUT", "/head", body, [cond, ("Content-Type", "application/json")]) as r:
                return r.headers["ETag"]
        except urllib.error.HTTPError as e:
            if e.code == 412:
                raise Conflict() from e
            raise

    def get(self, pack, start=None, end=None):
        """A pack, or bytes [start, end) of it."""
        headers = [("Range", f"bytes={start}-{end - 1}")] if start is not None else []
        with self._req("GET", f"/pack/{pack}", headers=headers) as r:
            return r.read()

    def put(self, pack, data):
        with self._req("PUT", f"/pack/{pack}", data, [("Content-Length", str(len(data)))]):
            pass


# -- reading a folder ---------------------------------------------------------
def _content(path, st):
    if stat.S_ISLNK(st.st_mode):
        return os.readlink(path).encode("utf-8", "surrogateescape")
    with open(path, "rb") as f:
        return f.read()


def scan(root, known, cache):
    """{path: (sha1, size, mode, mtime_ns)} for what root holds now: the listed
    files plus any `known` path still there (so a .gitignore edit is never read
    as a delete). A hash is reused while mtime and size hold (`cache`)."""
    out = {}
    names = set(known)
    try:
        names.update(sandbox_sync.list_files(root, cap=float("inf")))
    except OSError:
        pass
    for name in sorted(names):
        path = os.path.join(root, name)
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode):
            mode = LINK_MODE
        elif stat.S_ISREG(st.st_mode):
            mode = stat.S_IFREG | (st.st_mode & 0o7777)
        else:
            continue
        hit = cache.get(name)
        if hit and hit[1] == st.st_size and hit[3] == st.st_mtime_ns:
            out[name] = (hit[0], st.st_size, mode, st.st_mtime_ns)
            continue
        try:
            sha = hashlib.sha1(_content(path, st)).hexdigest()
        except OSError:
            continue
        out[name] = (sha, st.st_size, mode, st.st_mtime_ns)
    return out


# -- writing packs ------------------------------------------------------------
def _squeeze(data):
    """(bytes, compressed): zlib level 1 when a probe says it pays."""
    if len(data) < 512:
        return data, 0
    probe = data[:PROBE]
    if len(zlib.compress(probe, 1)) > RAW_RATIO * len(probe):
        return data, 0
    packed = zlib.compress(data, 1)
    return (packed, 1) if len(packed) < len(data) else (data, 0)


class Packer:
    """Fills packs with file contents and uploads each as it closes, a few at once."""

    def __init__(self, store, pool):
        self.store, self.pool = store, pool
        self.buf, self.sealed, self.uploads = bytearray(), {}, []
        self.pending = []           # segments of the open pack, pack id still unknown

    def add(self, data):
        """Segments for `data`, their pack ids filled in when their pack seals."""
        segs = []           # an empty file needs no bytes in any pack
        for at in range(0, len(data), PACK_BYTES):
            body, z = _squeeze(data[at:at + PACK_BYTES])
            if self.buf and len(self.buf) + len(body) > PACK_BYTES:
                self.seal()
            seg = [None, len(self.buf), len(body), z]
            self.buf += body
            self.pending.append(seg)
            segs.append(seg)
        return segs

    def seal(self):
        if not self.buf:
            return
        data = bytes(self.buf)
        pack = hashlib.sha256(data).hexdigest()
        for seg in self.pending:
            seg[0] = pack
        self.sealed[pack] = len(data)
        self.uploads.append(self.pool.submit(self.store.put, pack, data))
        self.buf, self.pending = bytearray(), []

    def finish(self):
        self.seal()
        for f in self.uploads:
            f.result()
        return self.sealed


# -- pull ---------------------------------------------------------------------
def _safe(root, name):
    dest = os.path.realpath(os.path.join(root, os.path.dirname(name)))
    if os.path.isabs(name) or not (dest == root or dest.startswith(root + os.sep)):
        raise ValueError(f"refusing a path outside the folder: {name!r}")
    return os.path.join(dest, os.path.basename(name))


def _place(root, name, entry, data):
    if hashlib.sha1(data).hexdigest() != entry[0]:
        raise ValueError(f"{name}: content does not match its hash")
    dest = _safe(root, name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = os.path.join(os.path.dirname(dest), f".harman-store.{os.getpid()}.{os.path.basename(dest)}")
    try:
        if entry[2] == LINK_MODE:
            os.symlink(data.decode("utf-8", "surrogateescape"), tmp)
        else:
            with open(tmp, "wb") as f:
                f.write(data)
            os.chmod(tmp, entry[2] & 0o7777)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _ranges(segs, size):
    """The byte ranges of one pack to fetch for these segments."""
    need = sum(s[2] for s in segs)
    if need > WHOLE_PACK * size:
        return [(0, size)]
    spans = sorted((s[1], s[1] + s[2]) for s in segs)
    out = [list(spans[0])]
    for a, b in spans[1:]:
        if a - out[-1][1] <= RANGE_GAP:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [tuple(r) for r in out]


def fetch(store, head, names, pool):
    """{path: bytes} for these paths of the head, each pack read once."""
    by_pack = {}
    for name in names:
        for seg in head["files"][name][3]:
            by_pack.setdefault(seg[0], []).append(seg)
    jobs = {}
    for pack, segs in by_pack.items():
        for a, b in _ranges(segs, head["packs"][pack]):
            whole = (a, b) == (0, head["packs"][pack])
            jobs[(pack, a)] = pool.submit(store.get, pack, *(() if whole else (a, b)))
    chunks = {k: (k[1], f.result()) for k, f in jobs.items()}
    starts = {}
    for (pack, a) in chunks:
        starts.setdefault(pack, []).append(a)

    def piece(seg):
        pack, off, length, z = seg
        a = max(s for s in starts[pack] if s <= off)
        base, data = chunks[(pack, a)]
        body = data[off - base:off - base + length]
        return zlib.decompress(body) if z else body

    return {name: b"".join(piece(s) for s in head["files"][name][3]) for name in names}


def _batches(head, names):
    """Paths in runs of about PACK_BYTES * PARALLEL, so a pull holds a bounded
    amount in memory however large the folder."""
    run, size = [], 0
    for name in names:
        run.append(name)
        size += head["files"][name][1]
        if size >= PACK_BYTES * PARALLEL:
            yield run
            run, size = [], 0
    if run:
        yield run


def pull(store, root, state_path):
    """Fill root from the store. Returns EMPTY when the store has no folder yet."""
    etag, head = store.head()
    os.makedirs(root, exist_ok=True)
    root = os.path.realpath(root)
    if head is None:
        _save(state_path, None, empty_head(), {})
        return EMPTY
    names = sorted(head["files"])
    with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
        for run in _batches(head, names):
            for name, data in fetch(store, head, run, pool).items():
                _place(root, name, head["files"][name], data)
    _save(state_path, etag, head, scan(root, names, {}))
    return 0


# -- push ---------------------------------------------------------------------
def _locations(head):
    return {e[0]: e[3] for e in head["files"].values()}


def _live_share(head):
    total = sum(head["packs"].values())
    live = sum(s[2] for e in head["files"].values() for s in e[3])
    return live / total if total else 1.0


def push(store, root, state_path, log=print):
    """Commit root's changes since the pull. Returns a summary dict."""
    state = _load(state_path)
    base, theirs, etag = state["head"], state["head"], state["etag"]
    root = os.path.realpath(root)
    now = scan(root, base["files"], state["stat"])
    mine = {p: f"{v[0]}:{v[2]:o}" for p, v in now.items()}
    packed = {}                 # sha1: segments this push uploaded
    with concurrent.futures.ThreadPoolExecutor(PARALLEL) as pool:
        packer = Packer(store, pool)
        for attempt in range(TRIES):
            # Reuse only bytes the current head still holds: a pack it dropped
            # may already be collected.
            known = {**_locations(theirs), **packed}
            compact = len(theirs["packs"]) > COMPACT_PACKS or _live_share(theirs) < COMPACT_LIVE
            if compact:
                known = dict(packed)

            def entry(name):
                path = os.path.join(root, name)
                data = _content(path, os.lstat(path))
                sha, mode = hashlib.sha1(data).hexdigest(), now[name][2]
                if sha not in known:
                    known[sha] = packed[sha] = packer.add(data)
                return [sha, len(data), mode, known[sha]]

            writes, deletes, clash = sandbox_sync.plan_sync(keys(base), keys(theirs), mine)
            files = dict(theirs["files"])
            for name in writes:
                files[name] = entry(name)
            for name in deletes:
                files.pop(name, None)
            if compact:
                # Repack what this box holds as the store does; old packs then
                # fall out of use and the Worker collects them.
                for name, e in list(files.items()):
                    if name not in writes and mine.get(name) == key(e):
                        files[name] = entry(name)
            sizes = {**theirs["packs"], **packer.finish()}
            new = {"version": 1, "files": files,
                   "packs": {s[0]: sizes[s[0]] for e in files.values() for s in e[3]}}
            if not (writes or deletes or new["packs"] != theirs["packs"]):
                break
            try:
                etag, theirs = store.commit(new, etag), new
                break
            except Conflict:
                if attempt == TRIES - 1:
                    raise
                etag, theirs = store.head()
                theirs = theirs or empty_head()
    for name in clash:
        log(f"conflict: {name} changed here and in the store, kept the store's copy")
    _save(state_path, etag, theirs, now)
    return {"pushed": len(writes), "deleted": len(deletes), "conflicts": clash, "head": etag}


# -- state between pull and push ----------------------------------------------
def _save(path, etag, head, scanned):
    data = {"etag": etag, "head": head, "stat": {p: list(v) for p, v in scanned.items()}}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".store-state.")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _load(path):
    with open(path) as f:
        return json.load(f)


def main(argv):
    if len(argv) != 4 or argv[1] not in ("pull", "push"):
        sys.exit("usage: box_store.py pull|push VOLUME ROOT")
    _, verb, volume, root = argv
    with open(os.path.join(OPT, "store.json")) as f:
        cfg = json.load(f)
    store = Store(cfg["url"], cfg["token"], cfg["prefix"], volume)
    state = os.path.join(OPT, f"store-{volume}.state.json")
    if verb == "pull":
        return pull(store, root, state)
    json.dump(push(store, root, state, log=lambda m: print(m, file=sys.stderr)), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
