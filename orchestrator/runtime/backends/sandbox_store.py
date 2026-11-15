"""Where a sandbox run's folders live between turns: one strategy per store.

A run copies two folders into its box (the workspace and the chat's memory)
and keeps what the agent changed. The server setting `sandbox_storage` picks
how:

  viewer  the folders live on this machine. The box is filled from them and
          its changes are synced back three way (backends.sandbox_sync). The
          default, and what a local install uses.
  cloud   the folders live in an object store behind the sandbox Worker
          (backends.box_store, sandbox/cloudflare). The box pulls and pushes
          them itself with a short lived capability; nothing of the folder
          passes through this machine, which is what lets a run happen with
          no machine of the owner's behind it. This machine's copy is only
          the seed the first time a folder reaches the store.

Each strategy answers three questions for one folder (a part of the plan):
plan (what to remember so the work can come home, even after a restart),
stage (fill the box) and home (bring the box's changes back).
"""
import base64
import hashlib
import hmac
import json
import os
import re
import time

from orchestrator import db
from orchestrator.runtime.backends import sandbox_sync
from orchestrator.runtime.backends.box_store import EMPTY
from orchestrator.runtime.backends.sandbox_drivers import _cloudflare_config

# A capability lasts one pull or one push: it is minted again before each.
CAP_SECONDS = 2 * 3600
CAP_CONTEXT = b"store-cap"
TENANT_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def capability(secret, tenant, scope, now=None):
    """A token the Worker accepts for paths under `scope` until it expires.
    Signed with a key derived from the box secret, so the secret itself never
    enters a box."""
    payload = _b64(json.dumps({"t": tenant, "s": scope, "exp": int((now or time.time()) + CAP_SECONDS)},
                              separators=(",", ":")).encode())
    key = hmac.new(secret.encode(), CAP_CONTEXT, hashlib.sha256).digest()
    return payload + "." + _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest())


def folder_slug(cwd):
    """A store name for a folder: readable, bounded, and distinct even when
    two paths read the same once punctuation is replaced."""
    readable = re.sub(r"[^A-Za-z0-9-]", "-", cwd)[-200:]
    return f"{readable}-{hashlib.sha1(cwd.encode('utf-8', 'surrogateescape')).hexdigest()[:8]}"


class LocalFolders:
    """The folders live here; the box gets a copy and the changes come back."""
    name = "viewer"

    def plan(self, local, box, volume, cwd, route):
        paths = sandbox_sync.list_files(local)
        return {"store": self.name, "local": local, "box": box, "paths": paths,
                "base": sandbox_sync.manifest(local, paths)}

    def credentials(self, part):
        return {}

    def stage(self, box, part):
        box.put_paths(part["box"], part["local"], part["paths"])

    def home(self, box, key, part):
        local, root, base = part["local"], part["box"], part["base"]
        writes, deletes, conflicts = sandbox_sync.plan_sync(
            base, sandbox_sync.current_manifest(local, base), box.manifest(root, base))
        os.makedirs(local, exist_ok=True)
        box.fetch(root, writes, local)
        sandbox_sync.delete_files(local, deletes)
        for path in conflicts:
            print(f"  ⚠ sandbox {box.name}: {key} {path} changed here and in the box, kept this machine's copy",
                  flush=True)


class CloudFolders:
    """The folders live in the Worker's object store; the box moves them."""
    name = "cloud"

    def plan(self, local, box, volume, cwd, route):
        cfg = _cloudflare_config()
        tenant = cfg.get("tenant") or "owner"
        if not TENANT_RE.match(tenant):
            raise RuntimeError("The sandbox config's tenant must be letters, digits, '-' or '_'.")
        from orchestrator.runtime.backends.sandbox import reach
        return {"store": self.name, "local": local, "box": box, "volume": volume,
                "url": reach(cfg["url"].rstrip("/"), route), "prefix": f"{tenant}/{folder_slug(cwd)}"}

    def credentials(self, part):
        """store.json for the box: where the store is and a fresh capability."""
        cfg = _cloudflare_config()
        tenant = part["prefix"].split("/", 1)[0]
        token = capability(cfg["secret"], tenant, part["prefix"] + "/")
        return {"store.json": json.dumps({"url": part["url"], "token": token,
                                          "prefix": part["prefix"]}).encode()}

    def stage(self, box, part):
        r = box.store("pull", part)
        if r.returncode == EMPTY:
            # First run for this folder: this machine's copy seeds the store.
            box.put_paths(part["box"], part["local"], sandbox_sync.list_files(part["local"]))
        elif r.returncode:
            raise RuntimeError(f"pulling the {part['volume']} folder failed: {_tail(r.stderr)}")

    def home(self, box, key, part):
        box.put_opt(self.credentials(part))
        r = box.store("push", part)
        if r.returncode:
            raise RuntimeError(f"pushing the {key} folder failed: {_tail(r.stderr)}")
        result = json.loads(r.stdout)
        for path in result["conflicts"]:
            print(f"  ⚠ sandbox {box.name}: {key} {path} changed in the store meanwhile, kept the store's copy",
                  flush=True)


def _tail(err):
    text = (err or b"").decode("utf-8", "replace").strip()
    return text[-500:] or "no output"


STORES = {s.name: s for s in (LocalFolders(), CloudFolders())}


def current():
    """The strategy new runs use."""
    name = db.setting_get("sandbox_storage", "viewer") or "viewer"
    if name not in STORES:
        raise RuntimeError(f"sandbox_storage must be one of {', '.join(STORES)}, not {name!r}.")
    return STORES[name]


def of(part):
    """The strategy a planned part was made with (plans outlive a setting change)."""
    return STORES[part.get("store", "viewer")]
