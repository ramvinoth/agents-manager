"""`agents auto-update` (deploy/agents): what a customer box does with what the
private feed serves. The success path is `agents update`, covered elsewhere;
these pin the refusals — nothing unsigned, tampered, or already-failed gets
staged. Hermetic: a throwaway HM_PREFIX and a loopback feed.

Run with:  /usr/bin/python3 -m pytest tests/unit/test_auto_update.py -v
"""
import base64
import functools
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading

import nacl.signing
import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
SHA = "c" * 40
TOKEN = "t" * 40


@pytest.fixture
def box(tmp_path):
    """A fake /opt/agents with release 1.0.0 current, plus a feed serving tmp_path/feed."""
    sk = nacl.signing.SigningKey.generate()
    rel = tmp_path / "prefix" / "releases" / "1.0.0"
    (rel / "deploy").mkdir(parents=True)
    for f in ("release_manifest.py", "lib.sh"):
        shutil.copy(REPO / "deploy" / f, rel / "deploy" / f)
    (rel / "deploy" / "release-pubkey.txt").write_text(base64.b64encode(bytes(sk.verify_key)).decode())
    (rel / ".venv" / "bin").mkdir(parents=True)
    os.symlink(sys.executable, rel / ".venv" / "bin" / "python")
    os.symlink("releases/1.0.0", tmp_path / "prefix" / "current")
    shim = tmp_path / "bin"; shim.mkdir()
    (shim / "flock").write_text("#!/bin/sh\nexit 0\n"); (shim / "flock").chmod(0o755)
    feed = tmp_path / "feed"; (feed / "bundles").mkdir(parents=True)

    class H(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                self.send_error(401); return
            super().do_GET()
        def log_message(self, *a): pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(H, directory=str(feed)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    (tmp_path / "prefix" / "update.env").write_text(
        f"AGENTS_FEED_TOKEN={TOKEN}\nAGENTS_FEED_URL=http://127.0.0.1:{srv.server_port}\n")

    def publish(ver, bundle=b"bundle-bytes", key=sk, tamper=None):
        (feed / "bundles" / f"{ver}.bundle").write_bytes(bundle)
        m = {"version": ver, "sha": SHA, "bundle_sha256": hashlib.sha256(bundle).hexdigest(),
             "bundle_size": len(bundle), "published_at": 1}
        text = json.dumps(m, sort_keys=True, separators=(",", ":"))
        env = {"manifest": text, "sig": base64.b64encode(key.sign(text.encode()).signature).decode()}
        if tamper:
            env["manifest"] = tamper(env["manifest"])
        (feed / "latest.json").write_text(json.dumps(env))

    def run():
        env = dict(os.environ, HM_PREFIX=str(tmp_path / "prefix"),
                   PATH=f"{shim}:{os.environ['PATH']}", PORT="1")
        p = subprocess.run(["bash", str(REPO / "deploy" / "agents"), "auto-update"],
                           env=env, capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout + p.stderr

    yield type("Box", (), {"publish": staticmethod(publish), "run": staticmethod(run),
                           "prefix": tmp_path / "prefix"})
    srv.shutdown()


def test_no_token_is_a_silent_noop(box):
    (box.prefix / "update.env").unlink()
    rc, out = box.run()
    assert rc == 0 and "auto-update off" in out


def test_up_to_date(box):
    box.publish("1.0.0")
    rc, out = box.run()
    assert rc == 0 and "up to date" in out


def test_tampered_manifest_rejected(box):
    box.publish("1.0.1", tamper=lambda t: t.replace("1.0.1", "1.0.2"))
    rc, out = box.run()
    assert rc != 0 and "REJECTED" in out
    assert not (box.prefix / "releases" / "1.0.2").exists()


def test_foreign_key_rejected(box):
    box.publish("1.0.1", key=nacl.signing.SigningKey.generate())
    rc, out = box.run()
    assert rc != 0 and "REJECTED" in out


def test_swapped_bundle_discarded(box, tmp_path):
    box.publish("1.0.1")
    (tmp_path / "feed" / "bundles" / "1.0.1.bundle").write_bytes(b"evil-bytes!!")
    rc, out = box.run()
    assert rc != 0 and "does not match the signed manifest" in out
    assert not list((box.prefix / "downloads").glob("*"))
    assert not (box.prefix / "releases" / "1.0.1").exists()


def test_bad_token_refused(box):
    (box.prefix / "update.env").write_text(
        (box.prefix / "update.env").read_text().replace(TOKEN, "wrong"))
    box.publish("1.0.1")
    rc, out = box.run()
    assert rc != 0 and "token refused" in out


def test_failed_version_not_retried(box):
    box.publish("1.0.1")
    (box.prefix / ".auto-update-failed").write_text("1.0.1\n")
    rc, out = box.run()
    assert rc == 0 and "skipping 1.0.1" in out


def test_script_uses_its_own_lib_not_currents(box, tmp_path):
    """A newer release's `agents` must source the lib.sh shipped beside it: the
    running release's lib.sh predates functions it calls (1.0.2 -> 1.0.4 died on
    `hm_wait_quiet: command not found` after provisioning, before the swap)."""
    old_lib = box.prefix / "current" / "deploy" / "lib.sh"
    old_lib.write_text("# an older release's library: defines none of today's hm_* functions\n")
    env = dict(os.environ, HM_PREFIX=str(box.prefix), PORT="1",
               PATH=f"{tmp_path / 'bin'}:{os.environ['PATH']}")
    p = subprocess.run(["bash", str(REPO / "deploy" / "agents"), "status"],
                       env=env, capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stdout + p.stderr
    assert "current:  1.0.0" in p.stdout
