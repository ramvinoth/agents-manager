"""deploy/release_manifest.py: what a customer box accepts from the update feed.

Run with:  /usr/bin/python3 -m pytest tests/unit/test_release_manifest.py -v
"""
import base64
import importlib.util
import io
import json
import pathlib
import sys

import nacl.signing
import pytest

_P = pathlib.Path(__file__).resolve().parents[2] / "deploy" / "release_manifest.py"
_spec = importlib.util.spec_from_file_location("release_manifest", _P)
rm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rm)

SHA = "a" * 40
BSHA = "b" * 64


@pytest.fixture
def keys():
    sk = nacl.signing.SigningKey.generate()
    return sk, base64.b64encode(bytes(sk.verify_key)).decode()


def _env(sk, **over):
    m = rm.build("1.2.3", SHA, BSHA, 2048, published_at=1)
    m.update(over)
    return rm.sign(m, sk)


def test_round_trip(keys):
    sk, pk = keys
    assert rm.verify(_env(sk), pk)["version"] == "1.2.3"


def test_tampered_manifest_rejected(keys):
    sk, pk = keys
    env = _env(sk)
    env["manifest"] = env["manifest"].replace("1.2.3", "9.9.9")
    with pytest.raises(rm.ManifestError):
        rm.verify(env, pk)


def test_wrong_key_rejected(keys):
    sk, _ = keys
    other = base64.b64encode(bytes(nacl.signing.SigningKey.generate().verify_key)).decode()
    with pytest.raises(rm.ManifestError):
        rm.verify(_env(sk), other)


@pytest.mark.parametrize("env", [{}, {"manifest": "{}"}, {"manifest": "{}", "sig": "!!"}, None])
def test_malformed_envelope_rejected(keys, env):
    with pytest.raises(rm.ManifestError):
        rm.verify(env, keys[1])


def test_signed_garbage_fields_rejected(keys):
    sk, pk = keys
    bad = rm.sign({"version": "1.2.3; rm -rf /", "sha": SHA, "bundle_sha256": BSHA,
                   "bundle_size": 1, "published_at": 1}, sk)
    with pytest.raises(rm.ManifestError):
        rm.verify(bad, pk)


@pytest.mark.parametrize("cand,cur,newer", [
    ("1.0.10", "1.0.9", True), ("1.0.9", "1.0.10", False),
    ("1.0.2", "1.0.2", False), ("1.0.0", "", True)])
def test_is_newer_numeric(cand, cur, newer):
    assert rm.is_newer(cand, cur) is newer


def test_cli_verify_exit_codes(keys, monkeypatch, capsys):
    sk, pk = keys
    payload = json.dumps(_env(sk))
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert rm._main(["verify", pk, "1.2.2"]) == 0
    assert capsys.readouterr().out.split() == ["1.2.3", SHA, BSHA, "2048"]
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload))
    assert rm._main(["verify", pk, "1.2.3"]) == 3          # not newer → no update
    monkeypatch.setattr(sys, "stdin", io.StringIO(payload.replace("1.2.3", "1.2.4")))
    assert rm._main(["verify", pk, "1.2.2"]) == 2          # tampered


def test_cli_keygen_sign_verify(tmp_path, monkeypatch, capsys):
    key = tmp_path / "k"
    assert rm._main(["keygen", str(key)]) == 0
    pk = capsys.readouterr().out.strip()
    assert oct(key.stat().st_mode & 0o777) == "0o600"
    with pytest.raises(SystemExit):
        rm._main(["keygen", str(key)])                     # never overwrite a key
    bundle = tmp_path / "b.bundle"
    bundle.write_bytes(b"x" * 10)
    assert rm._main(["sign", str(key), "1.0.0", SHA, str(bundle)]) == 0
    monkeypatch.setattr(sys, "stdin", io.StringIO(capsys.readouterr().out))
    assert rm._main(["verify", pk]) == 0
    assert capsys.readouterr().out.split()[2] == rm.file_sha256(bundle)
