"""Local-disk zip legs of viewer/routes/fs.py: /api/fs/compress (writes the
archive next to the items) and /api/fs/download-zip (streams it). Both walk
the selection with the same _zip_local, so a directory keeps its relative
paths in either. tmp dir only — no drive, no SSH.
"""
import io
import json
import zipfile

from viewer.routes.fs import FsMixin


class _Handler(FsMixin):
    def __init__(self, body=None):
        self.sent = None
        self.wfile = io.BytesIO()
        self.headers = {}
        self._body = body

    def send_json(self, data, status=200):
        self.sent = (data, status)

    def read_body(self):
        return self._body

    def send_response(self, status):
        self.status = status

    def send_header(self, k, v):
        self.headers[k] = v

    def end_headers(self):
        pass


class _Req:
    def __init__(self, query=None, host="local"):
        self.query = query or {}
        self.host = host


def _tree(tmp_path):
    (tmp_path / "a.txt").write_text("A")
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "n.md").write_text("N")
    return ["a.txt", "d"]


def test_compress_writes_archive_beside_items(tmp_path):
    names = _tree(tmp_path)
    h = _Handler({"path": str(tmp_path), "names": names, "archive": "bundle"})
    h._p_fs_compress(_Req())
    data, status = h.sent
    assert status == 200 and data["created"].endswith("/bundle.zip")
    assert sorted(zipfile.ZipFile(data["created"]).namelist()) == ["a.txt", "d/n.md"]


def test_compress_never_overwrites_an_existing_archive(tmp_path):
    names = _tree(tmp_path)
    (tmp_path / "bundle.zip").write_bytes(b"keep")
    h = _Handler({"path": str(tmp_path), "names": names, "archive": "bundle"})
    h._p_fs_compress(_Req())
    assert h.sent[0]["created"].endswith("/bundle 2.zip")
    assert (tmp_path / "bundle.zip").read_bytes() == b"keep"


def test_download_zip_streams_the_same_layout(tmp_path):
    names = _tree(tmp_path)
    h = _Handler()
    h._g_fs_download_zip(_Req({"path": [str(tmp_path)], "names": [json.dumps(names)]}))
    assert h.status == 200 and h.headers["Content-Type"] == "application/zip"
    assert 'filename="Archive.zip"' in h.headers["Content-Disposition"]
    z = zipfile.ZipFile(io.BytesIO(h.wfile.getvalue()))
    assert sorted(z.namelist()) == ["a.txt", "d/n.md"]
    assert not list(tmp_path.glob("*.zip"))  # built in a temp location, not here


def test_download_zip_rejects_a_missing_directory(tmp_path):
    h = _Handler()
    h._g_fs_download_zip(_Req({"path": [str(tmp_path / "nope")], "names": ['["x"]']}))
    assert h.sent == ({"error": "Target is not a directory"}, 400)
