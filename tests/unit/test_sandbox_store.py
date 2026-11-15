"""Unit tests for backends.sandbox_store: picking a folder strategy, the
capability the Worker checks, and the cloud strategy's stage and home steps
against a fake box."""
import base64
import hashlib
import hmac
import json
import subprocess
import time

import pytest

from orchestrator import db
from orchestrator.runtime.backends import sandbox_store as ss
from orchestrator.runtime.backends.box_store import EMPTY

SECRET = "test-secret"


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def worker_allows(token, tenant, path, secret=SECRET, now=None):
    """The Worker's capAllows (sandbox/cloudflare/src/store.ts), in Python."""
    parts = token.split(".")
    if len(parts) != 2:
        return False
    payload, sig = parts
    key = hmac.new(secret.encode(), b"store-cap", hashlib.sha256).digest()
    if not hmac.compare_digest(hmac.new(key, payload.encode(), hashlib.sha256).digest(), _unb64(sig)):
        return False
    cap = json.loads(_unb64(payload))
    return (cap["exp"] > (now or time.time()) and cap["t"] == tenant
            and cap["s"].startswith(f"{tenant}/") and cap["s"].endswith("/") and path.startswith(cap["s"]))


def test_capability_opens_only_its_own_folder():
    token = ss.capability(SECRET, "acme", "acme/proj-1/")
    assert worker_allows(token, "acme", "acme/proj-1/")
    assert not worker_allows(token, "acme", "acme/proj-10/")
    assert not worker_allows(token, "other", "acme/proj-1/")
    assert not worker_allows(token, "acme", "acme/proj-1/", secret="wrong")


def test_capability_expires():
    token = ss.capability(SECRET, "acme", "acme/p/", now=1000)
    assert worker_allows(token, "acme", "acme/p/", now=1000 + ss.CAP_SECONDS - 1)
    assert not worker_allows(token, "acme", "acme/p/", now=1000 + ss.CAP_SECONDS)


def test_a_tampered_capability_is_refused():
    payload, sig = ss.capability(SECRET, "acme", "acme/p/").split(".")
    wider = base64.urlsafe_b64encode(json.dumps({"t": "acme", "s": "acme/", "exp": 2**40}).encode())
    assert not worker_allows(wider.rstrip(b"=").decode() + "." + sig, "acme", "acme/other/")


def test_folder_slug_is_route_safe_and_distinct():
    a, b = ss.folder_slug("/w/my app"), ss.folder_slug("/w/my-app")
    assert a != b
    for slug in (a, b, ss.folder_slug("/" + "x" * 500)):
        assert len(slug) <= 255 and all(c.isalnum() or c == "-" for c in slug)


def test_current_follows_the_setting(monkeypatch):
    monkeypatch.setattr(db, "setting_get", lambda *a: None)
    assert ss.current().name == "viewer"
    monkeypatch.setattr(db, "setting_get", lambda *a: "cloud")
    assert ss.current().name == "cloud"
    monkeypatch.setattr(db, "setting_get", lambda *a: "s3")
    with pytest.raises(RuntimeError, match="sandbox_storage"):
        ss.current()


def test_a_planned_part_keeps_its_strategy():
    assert ss.of({"store": "cloud"}) is ss.STORES["cloud"]
    assert ss.of({}) is ss.STORES["viewer"]


class FakeBox:
    name = "box-1"

    def __init__(self, results):
        self.results, self.calls = list(results), []

    def store(self, verb, part):
        self.calls.append(("store", verb, part["volume"]))
        return self.results.pop(0)

    def put_paths(self, dest, root, paths):
        self.calls.append(("put_paths", dest, sorted(paths)))

    def put_opt(self, files):
        self.calls.append(("put_opt", json.loads(files["store.json"])))


def _done(rc=0, out=b"", err=b""):
    return subprocess.CompletedProcess([], rc, out, err)


@pytest.fixture
def cloud(monkeypatch, tmp_path):
    monkeypatch.setattr(ss, "_cloudflare_config",
                        lambda: {"url": "https://box.example/", "secret": SECRET, "tenant": "acme"})
    (tmp_path / "a.txt").write_text("a")
    part = ss.CloudFolders().plan(str(tmp_path), "/work", "ws", "/w/proj", lambda *a: None)
    return ss.CloudFolders(), part


def test_cloud_plan_and_credentials(cloud):
    strategy, part = cloud
    assert part["url"] == "https://box.example" and part["prefix"].startswith("acme/")
    store = json.loads(strategy.credentials(part)["store.json"])
    assert store["prefix"] == part["prefix"]
    assert worker_allows(store["token"], "acme", part["prefix"] + "/")


def test_cloud_plan_refuses_a_bad_tenant(monkeypatch):
    monkeypatch.setattr(ss, "_cloudflare_config", lambda: {"url": "https://x", "secret": SECRET, "tenant": "a/b"})
    with pytest.raises(RuntimeError, match="tenant"):
        ss.CloudFolders().plan("/tmp", "/work", "ws", "/w", lambda *a: None)


def test_cloud_stage_seeds_an_empty_store_from_this_machine(cloud):
    strategy, part = cloud
    box = FakeBox([_done(EMPTY)])
    strategy.stage(box, part)
    assert box.calls == [("store", "pull", "ws"), ("put_paths", "/work", ["a.txt"])]


def test_cloud_stage_uses_the_store_copy_when_there_is_one(cloud):
    strategy, part = cloud
    box = FakeBox([_done(0)])
    strategy.stage(box, part)
    assert box.calls == [("store", "pull", "ws")]


def test_cloud_stage_failure_names_the_folder(cloud):
    strategy, part = cloud
    with pytest.raises(RuntimeError, match="ws folder failed: boom"):
        strategy.stage(FakeBox([_done(1, err=b"boom")]), part)


def test_cloud_home_mints_a_fresh_capability_then_pushes(cloud, capsys):
    strategy, part = cloud
    box = FakeBox([_done(0, out=json.dumps({"pushed": 1, "deleted": 0, "conflicts": ["x"]}).encode())])
    strategy.home(box, "workspace", part)
    assert box.calls[0][0] == "put_opt" and box.calls[1] == ("store", "push", "ws")
    assert "workspace x changed in the store meanwhile" in capsys.readouterr().out


def test_cloud_home_failure_raises(cloud):
    strategy, part = cloud
    with pytest.raises(RuntimeError, match="pushing the workspace folder failed"):
        strategy.home(FakeBox([_done(2, err=b"net down")]), "workspace", part)
