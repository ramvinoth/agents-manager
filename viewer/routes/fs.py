"""viewer.routes.fs — FsMixin route + business methods."""
import json
import os
import re
import shutil
import time
from pathlib import Path
from viewer.engine import (
    get_host,
)
from viewer.remote import (
    content_disposition, remote_build_zip, remote_compress, remote_delete, remote_mkdir, remote_read_bytes, remote_rename, remote_unlink, remote_upload,
)

# Files that hold credentials/secrets — never downloadable through the FS browser
# even though the browser is otherwise full-filesystem by design. Matched by exact
# basename (covers the local box and any remote host, since secrets share names).
_SECRET_BASENAMES = frozenset({
    ".viewer-hosts.json",      # SSH host passwords
    ".viewer-providers.json",  # provider API keys
    ".credentials.json",       # ~/.claude credentials
})


def _is_secret_path(name: str) -> bool:
    """True if `name` (a path or basename) names a known secret file, or lives
    directly under ~/.claude as a dotfile (credentials/config live there)."""
    base = os.path.basename(name.rstrip("/"))
    if base in _SECRET_BASENAMES:
        return True
    # ~/.claude/.<anything> — the credentials + settings dotfiles.
    norm = os.path.normpath(os.path.expanduser(name))
    claude = os.path.normpath(os.path.expanduser("~/.claude"))
    return os.path.dirname(norm) == claude and base.startswith(".")


class FsMixin:
    def _g_fs_download(self, req):
        fpath = (req.query.get("path") or [""])[0]
        if not fpath:
            self.send_error(400, "Missing path")
            return
        if _is_secret_path(fpath):
            self.send_json({"error": "Forbidden: secret file"}, status=403)
            return
        if req.host != "local":
            try:
                r = remote_read_bytes(req.host, fpath)
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
                return
            if r.get("error"):
                self.send_json({"error": r["error"]}, status=400)
                return
            data, name = r["bytes"], r["name"]
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", content_disposition(name))
            self.end_headers()
            self.wfile.write(data)
            return
        try:
            target = Path(os.path.expanduser(fpath)).resolve()
            if not target.is_file():
                self.send_error(404, "File not found or is a directory")
                return
            # Stream file with proper Content-Disposition header
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(target.stat().st_size))
            self.send_header("Content-Disposition", content_disposition(target.name))
            self.end_headers()
            with open(target, "rb") as f:
                self.wfile.write(f.read())
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def _p_fs_mkdir(self, req):
        # One handler for both hosts. (Previously two separate /api/fs/mkdir
        # blocks: the local one re-read the already-consumed body and hung.)
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        name = (body.get("name") or "").strip()
        if not name or "/" in name or "\0" in name or name in (".", ".."):
            self.send_json({"error": "Invalid folder name"}, status=400)
            return
        hh = body.get("host", "local")
        if hh != "local":
            try:
                self.send_json(remote_mkdir(hh, body.get("path") or "~", name))
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        try:
            base = Path(os.path.expanduser(body.get("path") or "~")).resolve()
            if not base.is_dir():
                self.send_json({"error": "Parent is not a directory"}, status=404)
                return
            target = base / name
            target.mkdir(exist_ok=False)
        except FileExistsError:
            self.send_json({"error": "Folder already exists"}, status=409)
            return
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"created": str(target)})

    def _g_fs_download_zip(self, req):
        """Bundle several items from one directory into a single streamed .zip.

        The archive is built in a temp location (never in the browsed dir) and
        removed afterwards. `names` is a JSON array in the query string.
        """
        path = (req.query.get("path") or ["~"])[0]
        try:
            names = json.loads((req.query.get("names") or ["[]"])[0])
        except Exception:
            names = []
        archive = (req.query.get("archive") or [""])[0].strip()
        if not isinstance(names, list) or not names:
            self.send_json({"error": "No items to download"}, status=400)
            return
        for n in names:
            if not isinstance(n, str) or "/" in n or "\0" in n or n in (".", ".."):
                self.send_json({"error": "Invalid item name"}, status=400)
                return
            if _is_secret_path(os.path.join(path, n)):
                self.send_json({"error": "Forbidden: secret file"}, status=403)
                return
        arcname = archive or ((names[0] + ".zip") if len(names) == 1 else "Archive.zip")
        if not arcname.endswith(".zip"):
            arcname += ".zip"

        if req.host != "local":
            try:
                r = remote_build_zip(req.host, path, names)
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
                return
            if r.get("error"):
                self.send_json({"error": r["error"]}, status=400)
                return
            tmp = r["tmp"]
            try:
                rb = remote_read_bytes(req.host, tmp)
                if rb.get("error"):
                    self.send_json({"error": rb["error"]}, status=400)
                    return
                data = rb["bytes"]
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", content_disposition(arcname))
                self.end_headers()
                self.wfile.write(data)
            finally:
                try:
                    remote_unlink(req.host, tmp)
                except Exception:
                    pass
            return

        import tempfile
        import zipfile
        tmp_path = None
        try:
            base = Path(os.path.expanduser(path)).resolve()
            if not base.is_dir():
                self.send_json({"error": "Target is not a directory"}, status=400)
                return
            fd, tmp_path = tempfile.mkstemp(suffix=".zip")
            os.close(fd)
            with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as z:
                for n in names:
                    src = base / n
                    if src.is_dir():
                        for f in src.rglob("*"):
                            if f.is_file():
                                z.write(f, f.relative_to(base))
                    elif src.is_file():
                        z.write(src, src.relative_to(base))
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(os.path.getsize(tmp_path)))
            self.send_header("Content-Disposition", content_disposition(arcname))
            self.end_headers()
            with open(tmp_path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except Exception as e:
            try:
                self.send_json({"error": str(e)}, status=500)
            except Exception:
                pass
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    def _p_fs_rename(self, req):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        hh = body.get("host", "local")
        fpath = (body.get("path") or "").strip()
        name = (body.get("name") or "").strip()
        if not fpath or not name or "/" in name or "\0" in name or name in (".", ".."):
            self.send_json({"error": "Invalid name"}, status=400)
            return
        if hh != "local":
            try:
                self.send_json(remote_rename(hh, fpath, name))
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        try:
            target = Path(os.path.expanduser(fpath)).resolve()
            if not target.exists():
                self.send_json({"error": "File not found"}, status=404)
                return
            dest = target.parent / name
            if dest.exists():
                self.send_json({"error": "A file with that name already exists"}, status=409)
                return
            target.rename(dest)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"renamed": str(dest)})

    def _p_fs_delete(self, req):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        hh = body.get("host", "local")
        fpath = (body.get("path") or "").strip()
        if not fpath or fpath in ("/", "~", "."):
            self.send_json({"error": "Cannot delete system paths"}, status=400)
            return
        if hh != "local":
            try:
                self.send_json(remote_delete(hh, fpath))
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        try:
            target = Path(os.path.expanduser(fpath)).resolve()
            if target in (Path.home(), Path(target.anchor)):
                self.send_json({"error": "Refusing to delete this path"}, status=400)
                return
            if not target.exists():
                self.send_json({"error": "File not found"}, status=404)
                return
            # Move to a viewer trash dir (reversible) rather than rm -rf.
            trash = Path.home() / ".claude" / ".viewer-trash" / "fs"
            trash.mkdir(parents=True, exist_ok=True)
            dest = trash / target.name
            if dest.exists():
                dest = trash / f"{target.name}.{int(time.time())}"
            shutil.move(str(target), str(dest))
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"deleted": str(target), "trash": str(dest)})

    def _p_fs_compress(self, req):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        hh = body.get("host", "local")
        path = body.get("path") or "~"
        names = body.get("names") or []
        archive = (body.get("archive") or "").strip()
        if not names:
            self.send_json({"error": "No items to compress"}, status=400)
            return
        for n in names:
            if not isinstance(n, str) or "/" in n or "\0" in n or n in (".", ".."):
                self.send_json({"error": "Invalid item name"}, status=400)
                return
        if archive and ("/" in archive or "\0" in archive):
            self.send_json({"error": "Invalid archive name"}, status=400)
            return
        if hh != "local":
            try:
                self.send_json(remote_compress(hh, path, names, archive))
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        try:
            import zipfile
            base = Path(os.path.expanduser(path)).resolve()
            if not base.is_dir():
                self.send_json({"error": "Target is not a directory"}, status=400)
                return
            arc = archive or ((names[0] + ".zip") if len(names) == 1 else "Archive.zip")
            if not arc.endswith(".zip"):
                arc += ".zip"
            stem = arc[:-4]
            dest = base / arc
            i = 2
            while dest.exists():
                dest = base / f"{stem} {i}.zip"
                i += 1
            with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
                for n in names:
                    src = base / n
                    if src.is_dir():
                        for f in src.rglob("*"):
                            if f.is_file():
                                z.write(f, f.relative_to(base))
                    elif src.is_file():
                        z.write(src, src.relative_to(base))
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        self.send_json({"created": str(dest)})

    def _p_fs_upload(self, req):
        # Multipart form-data upload: files go to a target directory (local or SSH).
        host = req.host
        path = req.query.get("path", ["~"])[0] or "~"
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_json({"error": "Expected multipart/form-data"}, status=400)
            return
        boundary = content_type.split("boundary=")[-1].strip()
        if not boundary:
            self.send_json({"error": "Missing boundary"}, status=400)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(length)
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)
            return
        # Parse the multipart body once into (filename, bytes) pairs.
        files = []
        for part in data.split(b"--" + boundary.encode()):
            if not part or part == b"--\r\n" or part == b"--":
                continue
            if b"\r\n\r\n" not in part:
                continue
            headers_part, content = part.split(b"\r\n\r\n", 1)
            # Strip ONLY the single trailing CRLF delimiter before the boundary —
            # rstrip would eat real newline bytes at the end of the uploaded file.
            if content.endswith(b"\r\n"):
                content = content[:-2]
            m = re.search(r'filename="?([^"\r\n]+)"?', headers_part.decode(errors="ignore"))
            if not m:
                continue
            filename = m.group(1).strip().split("/")[-1].split("\\")[-1]
            if not filename:
                continue
            files.append((filename, content))
        if not files:
            self.send_json({"error": "No files found in upload"}, status=400)
            return
        if host != "local":
            try:
                self.send_json(remote_upload(host, path, files))
            except Exception as e:
                self.send_json({"error": f"SSH: {e}"}, status=502)
            return
        try:
            base = Path(os.path.expanduser(path)).resolve()
            if not base.is_dir():
                self.send_json({"error": "Target is not a directory"}, status=400)
                return
            uploaded = []
            for filename, content in files:
                try:
                    target_file = base / filename
                    target_file.write_bytes(content)
                    uploaded.append({"name": filename, "size": len(content), "path": str(target_file)})
                except Exception as e:
                    uploaded.append({"name": filename, "error": str(e)})
            self.send_json({"uploaded": uploaded})
        except Exception as e:
            self.send_json({"error": str(e)}, status=500)

    def _g_fs(self, req):
        raw = (req.query.get("path") or ["~"])[0]
        show_hidden = (req.query.get("hidden") or ["0"])[0] == "1"
        try:
            self.send_host_result(get_host(req.host).fs_list(raw, show_hidden))
        except Exception as e:
            self.send_json({"error": f"SSH: {e}"}, status=502)

