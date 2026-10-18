"""viewer.project_plugins — apps that live beside a project's sessions.

A project plugin is an outside app that shares a project's folder with Harman:
the owner opens it from the project's pinned rows (next to Tasks, Notes, Inbox
and Map) and every local Claude run in that folder gets the app's own Claude
Code plugin (its skills and MCP server), so agents operate it too. Harman only
knows the contract — label, icon, the env that turns it on, where the app's
plugin folder is, and how to mint the URL the owner's browser opens. The app's
behaviour stays in the app.

A plugin is *available* when its env is set (viewer/.apns.env); unset, it does
not exist here: no row, no tools. Everything is local-only, because the app's
plugin folder and server live on this machine.
"""
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote, urlparse

import viewer.config  # noqa: F401 — loads viewer/.apns.env, where the plugins' env lives

TIMEOUT = 10
LOOPBACK = ("localhost", "127.0.0.1", "::1")


class PluginError(Exception):
    """A sentence for the owner plus the HTTP status to answer with."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def _env(name):
    return (os.environ.get(name) or "").strip()


def local_folder(cwd):
    """A project folder on this machine as one absolute path, or None. The
    session list names folders "~/x"; an agent's run knows them as "/Users/u/x".
    Both must key the app's one project for that folder."""
    path = os.path.expanduser((cwd or "").strip()).rstrip("/")
    return path if path.startswith("/") else None


class ProjectPlugin:
    """The contract one app fills in. `icon` is a lucide name the web registry maps."""
    id = label = icon = description = ""
    required_env = ()   # every one set → available

    def available(self):
        return all(_env(k) for k in self.required_env) and self.plugin_dir() is not None

    def plugin_dir(self):
        """The app's Claude Code plugin folder, when it ships one."""
        raise NotImplementedError

    def open_url(self, cwd, origin):
        """The URL the owner's browser opens for this project folder; `origin`
        is the address the browser reached Harman on."""
        raise NotImplementedError

    def row(self):
        return {"id": self.id, "label": self.label, "icon": self.icon, "description": self.description}


class Sift(ProjectPlugin):
    """Sift, the PDF reader with a workspace. SIFT_URL is where this server
    reaches it; SIFT_PUBLIC_URL (optional) is where the owner's browser does —
    it must be the same site as Harman's address, or the browser keeps Sift's
    sign-in cookie out of the frame. SIFT_EMAIL is the Sift account Harman's
    owner and agents share, so both see one project per folder."""

    id, label, icon = "sift", "Sift", "BookOpenText"
    description = "Read, mark and link this folder's documents on a workspace."
    required_env = ("SIFT_URL", "SIFT_SERVICE_TOKEN", "SIFT_EMAIL", "SIFT_ROOT")

    def plugin_dir(self):
        root = _env("SIFT_ROOT")
        path = Path(root).expanduser() / "plugin" if root else None
        return path if path and (path / ".claude-plugin" / "plugin.json").is_file() else None

    def _call(self, path, body):
        req = urllib.request.Request(
            _env("SIFT_URL").rstrip("/") + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + _env("SIFT_SERVICE_TOKEN")})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                said = json.loads(e.read()).get("error") or ""
            except Exception:
                said = ""
            raise PluginError("Sift refused: " + (said or f"HTTP {e.code}."))
        except (urllib.error.URLError, OSError):
            raise PluginError("Sift is not running at SIFT_URL.")

    def public_base(self, origin):
        """Sift's address as the browser sees it: SIFT_PUBLIC_URL, else SIFT_URL's
        port on the host the browser reached Harman on — which only works when
        that host is this machine, so a public origin without SIFT_PUBLIC_URL is
        refused rather than handed a frame that cannot sign in."""
        public = _env("SIFT_PUBLIC_URL")
        if public:
            return public.rstrip("/")
        seen = urlparse(origin or "")
        if (seen.hostname or "") not in LOOPBACK:
            raise PluginError("Sift is only reachable from this computer. Set SIFT_PUBLIC_URL to open it here.", 409)
        port = urlparse(_env("SIFT_URL")).port
        host = f"[{seen.hostname}]" if ":" in seen.hostname else seen.hostname
        return f"{seen.scheme}://{host}" + (f":{port}" if port else "")

    def open_url(self, cwd, origin):
        base = self.public_base(origin)
        email = _env("SIFT_EMAIL")
        project = self._call("/api/service/project",
                             {"email": email, "folder": cwd, "name": Path(cwd).name or cwd})
        ticket = self._call("/api/service/ticket", {"email": email})["ticket"]
        return f"{base}/api/enter?ticket={quote(ticket)}&next={quote('/p/' + project['id'])}"


REGISTRY = (Sift(),)


def available():
    """The project plugins turned on on this machine."""
    return [p for p in REGISTRY if p.available()]


def get(plugin_id):
    return next((p for p in available() if p.id == plugin_id), None)


def plugin_dirs():
    """Every available project plugin's Claude Code plugin folder: each local
    run gets them all (engine, beside config.session_plugin_dirs), so agents
    can use the app."""
    return [p.plugin_dir() for p in available()]
