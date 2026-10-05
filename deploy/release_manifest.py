"""Signed release manifests for the private update feed (Card 121).

The Mac signs; every customer box verifies before it downloads or installs
anything. The feed (release-feed/ Worker + R2) is untrusted transport: a
compromised bucket can withhold updates but cannot make a box install code the
release key did not sign.

Wire format of `latest.json`:
    {"manifest": "<canonical JSON string>", "sig": "<base64 ed25519 signature>"}
The signature covers the exact manifest bytes, so nothing is re-serialized
before verifying. The manifest carries: version, sha (git commit), bundle_sha256,
bundle_size, published_at.

CLI (stdlib + pynacl; runs under the release venv or /usr/bin/python3):
    release_manifest.py keygen  <secret-key-path>             → prints public key (b64)
    release_manifest.py sign    <secret-key-path> <ver> <sha> <bundle>   → latest.json on stdout
    release_manifest.py verify  <public-key-b64> [current-ver] < latest.json
        → prints "<ver> <sha> <bundle_sha256> <bundle_size>"; exit 3 if not newer than
          current-ver, exit 2 on any signature/shape failure.
"""
import base64
import hashlib
import json
import os
import re
import sys
import time

import nacl.exceptions
import nacl.signing

VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


class ManifestError(ValueError):
    pass


def version_tuple(ver):
    if not VERSION_RE.match(ver or ""):
        raise ManifestError(f"bad version {ver!r}")
    return tuple(int(p) for p in ver.split("."))


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build(version, sha, bundle_sha256, bundle_size, published_at=None):
    version_tuple(version)
    if not SHA_RE.match(sha):
        raise ManifestError(f"bad commit sha {sha!r}")
    if not HEX64_RE.match(bundle_sha256):
        raise ManifestError("bad bundle sha256")
    return {"version": version, "sha": sha, "bundle_sha256": bundle_sha256,
            "bundle_size": int(bundle_size),
            "published_at": int(published_at if published_at is not None else time.time())}


def sign(manifest, signing_key):
    text = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    sig = signing_key.sign(text.encode()).signature
    return {"manifest": text, "sig": base64.b64encode(sig).decode()}


def verify(envelope, public_key_b64):
    """Return the manifest dict iff the signature is valid and the shape is sane."""
    try:
        text, sig = envelope["manifest"], base64.b64decode(envelope["sig"], validate=True)
        key = nacl.signing.VerifyKey(base64.b64decode(public_key_b64, validate=True))
        key.verify(text.encode(), sig)
    except (KeyError, TypeError, ValueError, nacl.exceptions.CryptoError) as e:
        raise ManifestError(f"signature check failed: {e}") from None
    m = json.loads(text)
    # Re-validate the signed fields: a valid signature over garbage is still garbage.
    return build(m.get("version", ""), m.get("sha", ""), m.get("bundle_sha256", ""),
                 m.get("bundle_size", 0), m.get("published_at", 0))


def is_newer(candidate, current):
    return not current or version_tuple(candidate) > version_tuple(current)


def _main(argv):
    cmd, args = (argv[0] if argv else ""), argv[1:]
    if cmd == "keygen" and len(args) == 1:
        if os.path.exists(args[0]):
            raise SystemExit(f"refusing to overwrite existing key {args[0]}")
        sk = nacl.signing.SigningKey.generate()
        fd = os.open(args[0], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(base64.b64encode(bytes(sk)).decode() + "\n")
        print(base64.b64encode(bytes(sk.verify_key)).decode())
        return 0
    if cmd == "sign" and len(args) == 4:
        key_path, ver, sha, bundle = args
        with open(key_path) as f:
            sk = nacl.signing.SigningKey(base64.b64decode(f.read().strip()))
        m = build(ver, sha, file_sha256(bundle), os.path.getsize(bundle))
        print(json.dumps(sign(m, sk)))
        return 0
    if cmd == "verify" and len(args) in (1, 2):
        try:
            m = verify(json.load(sys.stdin), args[0])
        except (ManifestError, json.JSONDecodeError) as e:
            print(f"release_manifest: {e}", file=sys.stderr)
            return 2
        if not is_newer(m["version"], args[1] if len(args) == 2 else ""):
            return 3
        print(m["version"], m["sha"], m["bundle_sha256"], m["bundle_size"])
        return 0
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
