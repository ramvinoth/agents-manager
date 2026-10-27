"""/api/fs/download local leg (viewer/routes/fs.py): streamed, one HTTP Range
honoured (so the browser's PDF viewer fetches only the pages it shows), and
?inline=1 renders only safe types inline — never HTML or SVG."""
from viewer.routes.fs import _parse_range
from test_fs_zip_routes import _Handler, _Req


class _RangeHandler(_Handler):
    """Request headers in self.headers (as http.server has them), response
    headers in self.out."""
    def __init__(self, request_headers):
        super().__init__()
        self.headers = request_headers
        self.out = {}

    def send_header(self, k, v):
        self.out[k] = v


def _get(tmp_path, name="doc.pdf", data=b"0123456789", rng=None, inline=False):
    f = tmp_path / name
    f.write_bytes(data)
    h = _RangeHandler({"Range": rng} if rng else {})
    q = {"path": [str(f)]}
    if inline:
        q["inline"] = ["1"]
    h._g_fs_download(_Req(q))
    return h


def test_parse_range():
    assert _parse_range(None, 10) is None
    assert _parse_range("bytes=2-5", 10) == (2, 5)
    assert _parse_range("bytes=5-", 10) == (5, 9)
    assert _parse_range("bytes=-3", 10) == (7, 9)
    assert _parse_range("bytes=8-100", 10) == (8, 9)
    assert _parse_range("bytes=10-", 10) is False
    assert _parse_range("bytes=-0", 10) is False
    assert _parse_range("bytes=0-1,4-5", 10) is None  # multi-range → whole file
    assert _parse_range("bytes=5-2", 10) is None
    assert _parse_range("items=0-1", 10) is None


def test_full_download_streams_whole_file_as_attachment(tmp_path):
    h = _get(tmp_path)
    assert h.status == 200 and h.wfile.getvalue() == b"0123456789"
    assert h.out["Accept-Ranges"] == "bytes" and h.out["Content-Length"] == "10"
    assert h.out["Content-Type"] == "application/octet-stream"
    assert h.out["Content-Disposition"].startswith("attachment;")


def test_range_returns_206_with_only_those_bytes(tmp_path):
    h = _get(tmp_path, rng="bytes=2-5")
    assert h.status == 206 and h.wfile.getvalue() == b"2345"
    assert h.out["Content-Range"] == "bytes 2-5/10" and h.out["Content-Length"] == "4"


def test_range_past_end_is_416(tmp_path):
    h = _get(tmp_path, rng="bytes=50-")
    assert h.status == 416 and h.out["Content-Range"] == "bytes */10" and h.wfile.getvalue() == b""


def test_inline_pdf_gets_its_type(tmp_path):
    h = _get(tmp_path, inline=True)
    assert h.out["Content-Type"] == "application/pdf"
    assert h.out["Content-Disposition"].startswith("inline;")
    assert h.out["X-Content-Type-Options"] == "nosniff"


def test_inline_is_pdf_only(tmp_path):
    for name in ("page.html", "pic.svg", "pic.png"):
        h = _get(tmp_path, name=name, data=b"<script>alert(1)</script>", inline=True)
        assert h.out["Content-Type"] == "application/octet-stream"
        assert h.out["Content-Disposition"].startswith("attachment;")


def test_empty_file(tmp_path):
    h = _get(tmp_path, data=b"")
    assert h.status == 200 and h.out["Content-Length"] == "0" and h.wfile.getvalue() == b""
