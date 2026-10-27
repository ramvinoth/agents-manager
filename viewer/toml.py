"""TOML read/write for agent configs (Codex keeps ~/.codex/config.toml).

`tomllib` is stdlib only from Python 3.11; the server runs on the system
python (3.9 on macOS) and the test interpreter is 3.10, so the read side comes
from the `tomli` backport there — same API, same module surface. Writing has
no stdlib equivalent on any version; `tomli_w` is always the writer. Both are
listed in deploy/install.sh PY_DEPS.
"""
try:
    import tomllib as _reader
except ModuleNotFoundError:
    import tomli as _reader
import tomli_w as _writer

loads = _reader.loads
dumps = _writer.dumps
