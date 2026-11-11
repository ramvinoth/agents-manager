"""TOML read/write for agent configs (Codex keeps ~/.codex/config.toml).

`tomllib` is stdlib only from Python 3.11; on an older python3 (a Linux box
may still have 3.9) the read side comes from the `tomli` backport — same API,
same module surface. Writing has no stdlib equivalent on any version; `tomli_w`
is always the writer. Both are listed in deploy/requirements.txt.
"""
try:
    import tomllib as _reader
except ModuleNotFoundError:
    import tomli as _reader
import tomli_w as _writer

loads = _reader.loads
dumps = _writer.dumps
