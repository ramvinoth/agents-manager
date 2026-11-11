"""The file browser on a remote host over SFTP: list, mkdir, upload, rename,
compress, delete, download."""
import json
import posixpath
import time
from orchestrator.remote.transport import SSH, remote_run_python


def _safe_seg(name) -> bool:
    """A single, safe path segment (no separators, NUL, or dot-only). Guards remote
    create/rename against a client filename escaping the browsed dir (e.g.
    '../.ssh/authorized_keys' or an absolute path)."""
    return isinstance(name, str) and bool(name) and "/" not in name and "\0" not in name and name not in (".", "..")


def _remote_expand(home, raw):
    """SFTP has no ~ expansion; map ~, ~/x, and '' to absolute remote paths."""
    raw = (raw or "~").strip()
    if raw in ("~", ""):
        return home
    if raw.startswith("~/"):
        return home.rstrip("/") + "/" + raw[2:]
    return raw


def remote_fs(hid, raw, show_hidden=False):
    import stat as statmod
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        try:
            p = sftp.normalize(_remote_expand(c["home"], raw))
        except IOError:
            return {"error": "Not a directory"}
        entries = []
        truncated = False
        try:
            for attr in sftp.listdir_attr(p):
                name = attr.filename
                if not show_hidden and name.startswith("."):
                    continue
                is_dir = statmod.S_ISDIR(attr.st_mode)
                entries.append({"name": name, "dir": is_dir,
                                "size": 0 if is_dir else attr.st_size, "mtime": attr.st_mtime})
                if len(entries) >= 800:
                    truncated = True
                    break
        except IOError as e:
            return {"error": str(e)}
        parent = posixpath.dirname(p) if p != "/" else None
        return {"path": p, "parent": parent, "entries": entries, "home": c["home"], "truncated": truncated}


def remote_mkdir(hid, path, name):
    if not _safe_seg(name):
        return {"error": "invalid folder name"}
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        base = sftp.normalize(_remote_expand(c["home"], path))
        target = posixpath.join(base, name)
        try:
            sftp.mkdir(target)
        except IOError as e:
            return {"error": "Folder already exists or cannot be created: " + str(e)}
        return {"created": target}


def remote_delete(hid, fpath):
    """Move a remote file/dir into ~/.viewer-trash (reversible), not rm -rf."""
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        target = sftp.normalize(_remote_expand(c["home"], fpath))
        if target in ("/", c["home"]):
            return {"error": "Refusing to delete this path"}
        trash = posixpath.join(c["home"], ".viewer-trash")
        try:
            sftp.mkdir(trash)
        except IOError:
            pass
        dest = posixpath.join(trash, posixpath.basename(target))
        try:
            sftp.stat(dest)
            dest = dest + "." + str(int(time.time()))
        except IOError:
            pass
        try:
            sftp.rename(target, dest)
        except IOError as e:
            return {"error": f"Cannot delete: {e}"}
        return {"deleted": target, "trash": dest}


def remote_read_bytes(hid, fpath):
    """Read a remote file into memory (≤200MB) → {"bytes","name"} or {"error"}."""
    import stat as statmod
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        target = sftp.normalize(_remote_expand(c["home"], fpath))
        try:
            st = sftp.stat(target)
            if statmod.S_ISDIR(st.st_mode):
                return {"error": "Is a directory"}
            if st.st_size > 200 * 1024 * 1024:  # 200 MB limit
                return {"error": "File too large (> 200 MB)"}
            with sftp.open(target, "rb") as f:
                f.prefetch(st.st_size)
                content = f.read()
            return {"bytes": content, "name": posixpath.basename(target)}
        except IOError as e:
            return {"error": f"Cannot download: {e}"}


def remote_upload(hid, path, files):
    """Write uploaded (name, bytes) pairs into a remote directory via SFTP."""
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        base = sftp.normalize(_remote_expand(c["home"], path))
        uploaded = []
        for fn, content in files:
            if not _safe_seg(fn):
                uploaded.append({"name": fn, "error": "invalid filename"})
                continue
            target = posixpath.join(base, fn)
            try:
                with sftp.open(target, "wb") as f:
                    f.write(content)
                uploaded.append({"name": fn, "size": len(content), "path": target})
            except Exception as e:
                uploaded.append({"name": fn, "error": str(e)})
        return {"uploaded": uploaded}


def remote_rename(hid, fpath, name):
    """Rename a remote file/dir within its parent directory."""
    if not _safe_seg(name):
        return {"error": "invalid name"}
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        target = sftp.normalize(_remote_expand(c["home"], fpath))
        dest = posixpath.join(posixpath.dirname(target), name)
        try:
            try:
                sftp.stat(dest)
                return {"error": "A file with that name already exists"}
            except IOError:
                pass
            sftp.rename(target, dest)
        except IOError as e:
            return {"error": f"Cannot rename: {e}"}
        return {"renamed": dest}


def remote_compress(hid, path, names, archive):
    """Zip named items inside a remote directory (via python3 on the host)."""
    params_lit = repr(json.dumps({"base": path, "names": names, "archive": archive or ""}))
    script = (
        "import os, json, zipfile, posixpath\n"
        "P = json.loads(" + params_lit + ")\n"
        "base = os.path.expanduser(P['base']); names = P['names']; arc = P['archive']\n"
        "if not arc: arc = (names[0] + '.zip') if len(names) == 1 else 'Archive.zip'\n"
        "if not arc.endswith('.zip'): arc += '.zip'\n"
        "stem = arc[:-4]; dest = posixpath.join(base, arc); i = 2\n"
        "while os.path.exists(dest):\n"
        "    dest = posixpath.join(base, stem + ' ' + str(i) + '.zip'); i += 1\n"
        "try:\n"
        "    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:\n"
        "        for n in names:\n"
        "            src = posixpath.join(base, n)\n"
        "            if os.path.isdir(src):\n"
        "                for root, dirs, files in os.walk(src):\n"
        "                    for f in files:\n"
        "                        full = os.path.join(root, f)\n"
        "                        z.write(full, os.path.relpath(full, base))\n"
        "            elif os.path.isfile(src):\n"
        "                z.write(src, os.path.relpath(src, base))\n"
        "    print(json.dumps({'created': dest}))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'error': str(e)}))\n"
    )
    txt = remote_run_python(hid, script)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "Compress failed: " + txt[-200:]}


def remote_build_zip(hid, path, names):
    """Zip named items into a TEMP file on the host → {"tmp"} or {"error"}.

    Used for download-as-zip: the archive never lands in the browsed dir; the
    caller streams it back and deletes it via remote_unlink.
    """
    params_lit = repr(json.dumps({"base": path, "names": names}))
    script = (
        "import os, json, zipfile, posixpath, tempfile\n"
        "P = json.loads(" + params_lit + ")\n"
        "base = os.path.expanduser(P['base']); names = P['names']\n"
        "fd, tmp = tempfile.mkstemp(suffix='.zip'); os.close(fd)\n"
        "try:\n"
        "    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:\n"
        "        for n in names:\n"
        "            src = posixpath.join(base, n)\n"
        "            if os.path.isdir(src):\n"
        "                for root, dirs, files in os.walk(src):\n"
        "                    for f in files:\n"
        "                        full = os.path.join(root, f)\n"
        "                        z.write(full, os.path.relpath(full, base))\n"
        "            elif os.path.isfile(src):\n"
        "                z.write(src, os.path.relpath(src, base))\n"
        "    print(json.dumps({'tmp': tmp}))\n"
        "except Exception as e:\n"
        "    os.path.exists(tmp) and os.unlink(tmp)\n"
        "    print(json.dumps({'error': str(e)}))\n"
    )
    txt = remote_run_python(hid, script)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "Zip failed: " + txt[-200:]}


def remote_unlink(hid, path):
    with SSH.sftp(hid) as sftp:
        try:
            sftp.remove(path)
        except IOError:
            pass


def content_disposition(name):
    """RFC 5987 attachment header that survives non-ASCII filenames.

    Python's http.server latin-1-encodes header values, so a raw Unicode
    filename (e.g. the U+202F narrow no-break space macOS uses in screenshot
    names) raises UnicodeEncodeError mid-response and the browser reports a
    failed download. Emit an ASCII fallback plus a percent-encoded UTF-8
    filename* that modern browsers prefer.
    """
    from urllib.parse import quote
    fallback = name.encode("ascii", "ignore").decode("ascii").replace('"', "").replace("\\", "").strip() or "download"
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (fallback, quote(name))
