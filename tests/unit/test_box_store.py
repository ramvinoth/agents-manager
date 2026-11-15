"""Unit tests for backends.box_store: a box pulling and pushing its folder
through the object store, against an in-memory store with the Worker's rules
(content addressed packs, a head written by compare and swap)."""
import hashlib
import json
import os

import pytest

from orchestrator.runtime.backends import box_store as bs


class FakeStore:
    """The Worker's /store routes for one volume, in memory."""

    def __init__(self):
        self.packs, self.head_doc, self.etag, self.n = {}, None, None, 0
        self.gets = []

    def head(self):
        return (self.etag, json.loads(self.head_doc)) if self.head_doc else (None, None)

    def commit(self, head, etag):
        if etag != self.etag:
            raise bs.Conflict()
        self.n += 1
        self.head_doc, self.etag = json.dumps(head), f'"e{self.n}"'
        return self.etag

    def get(self, pack, start=None, end=None):
        self.gets.append((pack, start, end))
        data = self.packs[pack]
        return data if start is None else data[start:end]

    def put(self, pack, data):
        assert hashlib.sha256(data).hexdigest() == pack
        self.packs[pack] = data


def _write(root, name, data, mode=0o644):
    path = os.path.join(root, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    os.chmod(path, mode)


def _read(root, name):
    with open(os.path.join(root, name), "rb") as f:
        return f.read()


@pytest.fixture
def boxes(tmp_path):
    """Two box folders with their own state files."""
    out = []
    for n in ("a", "b"):
        root = tmp_path / n
        root.mkdir()
        out.append((str(root), str(tmp_path / f"{n}.state.json")))
    return out


def test_empty_store_pull_reports_empty_and_push_seeds_it(boxes):
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    assert bs.pull(store, a, sa) == bs.EMPTY
    _write(a, "src/x.txt", "hello")
    _write(a, "run.sh", "#!/bin/sh\n", 0o755)
    _write(a, "empty", b"")
    os.symlink("src/x.txt", os.path.join(a, "link"))
    r = bs.push(store, a, sa)
    assert r["pushed"] == 4 and r["conflicts"] == []
    assert bs.pull(store, b, sb) == 0
    assert _read(b, "src/x.txt") == b"hello" and _read(b, "empty") == b""
    assert os.stat(os.path.join(b, "run.sh")).st_mode & 0o777 == 0o755
    assert os.readlink(os.path.join(b, "link")) == "src/x.txt"


def test_unchanged_push_commits_nothing(boxes):
    store, (a, sa), _ = FakeStore(), *boxes
    bs.pull(store, a, sa)
    _write(a, "x", "1")
    bs.push(store, a, sa)
    etag = store.etag
    assert bs.push(store, a, sa)["pushed"] == 0 and store.etag == etag


def test_a_turn_uploads_only_what_changed(boxes):
    store, (a, sa), _ = FakeStore(), *boxes
    bs.pull(store, a, sa)
    for i in range(20):
        _write(a, f"f{i}", f"file {i}" * 100)
    bs.push(store, a, sa)
    before = dict(store.packs)
    _write(a, "f3", "edited")
    assert bs.push(store, a, sa)["pushed"] == 1
    new = set(store.packs) - set(before)
    assert len(new) == 1 and len(store.packs[new.pop()]) < 100


def test_delete_reaches_the_store(boxes):
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    bs.pull(store, a, sa)
    _write(a, "keep", "k")
    _write(a, "gone", "g")
    bs.push(store, a, sa)
    os.unlink(os.path.join(a, "gone"))
    assert bs.push(store, a, sa)["deleted"] == 1
    bs.pull(store, b, sb)
    assert sorted(os.listdir(b)) == ["keep"]


def test_two_boxes_merge_and_a_clash_keeps_the_store_copy(boxes):
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    bs.pull(store, a, sa)
    _write(a, "shared", "base")
    _write(a, "only_a", "a0")
    bs.push(store, a, sa)
    bs.pull(store, b, sb)
    _write(a, "shared", "from a")
    _write(a, "only_a", "a1")
    _write(b, "shared", "from b")
    _write(b, "new_b", "b")
    assert bs.push(store, b, sb)["conflicts"] == []
    logs = []
    r = bs.push(store, a, sa, log=logs.append)
    assert r["conflicts"] == ["shared"] and logs
    head = json.loads(store.head_doc)["files"]
    assert set(head) == {"shared", "only_a", "new_b"}
    c = os.path.join(os.path.dirname(a), "c")
    bs.pull(store, c, c + ".state")
    assert _read(c, "shared") == b"from b" and _read(c, "only_a") == b"a1"


def test_large_file_spans_packs_and_small_reads_use_ranges(boxes, monkeypatch):
    monkeypatch.setattr(bs, "PACK_BYTES", 4096)
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    bs.pull(store, a, sa)
    big = os.urandom(10_000)
    _write(a, "big", big)
    bs.push(store, a, sa)
    assert len(store.packs) == 3
    bs.pull(store, b, sb)
    assert _read(b, "big") == big
    far = 110 + bs.RANGE_GAP + 1
    assert bs._ranges([["p", 100, 10, 0], ["p", far, 10, 0]], 10 * far) == [(100, 110), (far, far + 10)]
    assert bs._ranges([["p", 100, 10, 0], ["p", 200, 10, 0]], 10 * far) == [(100, 210)]
    assert bs._ranges([["p", 0, 900, 0]], 1000) == [(0, 1000)]


def test_compressible_files_are_stored_compressed(boxes):
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    bs.pull(store, a, sa)
    _write(a, "log", "same line\n" * 10_000)
    bs.push(store, a, sa)
    assert sum(map(len, store.packs.values())) < 10_000
    bs.pull(store, b, sb)
    assert _read(b, "log") == b"same line\n" * 10_000


def test_pack_count_stays_bounded_over_many_turns(boxes):
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    bs.pull(store, a, sa)
    seen = []
    for i in range(3 * bs.COMPACT_PACKS):
        _write(a, f"f{i}", f"v{i}")
        bs.push(store, a, sa)
        seen.append(len(json.loads(store.head_doc)["packs"]))
    assert max(seen) == bs.COMPACT_PACKS + 1 and 1 in seen[bs.COMPACT_PACKS:]
    bs.pull(store, b, sb)
    assert _read(b, "f0") == b"v0" and len(os.listdir(b)) == 3 * bs.COMPACT_PACKS


def test_pull_refuses_a_path_outside_the_folder(boxes):
    store, (a, sa), (b, sb) = FakeStore(), *boxes
    data = b"x"
    pack = hashlib.sha256(data).hexdigest()
    store.put(pack, data)
    entry = [hashlib.sha1(data).hexdigest(), 1, 0o100644, [[pack, 0, 1, 0]]]
    store.commit({"version": 1, "files": {"../evil": entry}, "packs": {pack: 1}}, None)
    with pytest.raises(ValueError, match="outside"):
        bs.pull(store, b, sb)
    assert not os.path.exists(os.path.join(os.path.dirname(b), "evil"))


def test_pull_refuses_content_that_does_not_match_its_hash(boxes):
    store, _, (b, sb) = FakeStore(), *boxes
    data = b"tampered"
    pack = hashlib.sha256(data).hexdigest()
    store.put(pack, data)
    entry = [hashlib.sha1(b"original").hexdigest(), 8, 0o100644, [[pack, 0, 8, 0]]]
    store.commit({"version": 1, "files": {"f": entry}, "packs": {pack: 8}}, None)
    with pytest.raises(ValueError, match="hash"):
        bs.pull(store, b, sb)
