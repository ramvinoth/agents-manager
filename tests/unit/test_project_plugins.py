"""Project plugins (viewer.project_plugins): an app sharing a project's folder
turns on with its env, hands every local run its Claude Code plugin, and opens
for the owner signed in at that folder's project. Hermetic: env and the app's
HTTP calls are patched; the plugin folder is a tmp dir."""
import io
import json
import unittest
import urllib.error
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from viewer import project_plugins
from viewer.project_plugins import PluginError, Sift


class TestSift(unittest.TestCase):
    def setUp(self):
        tmp = TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "plugin" / ".claude-plugin").mkdir(parents=True)
        (self.root / "plugin" / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "sift"}))
        self.env = {"SIFT_URL": "http://127.0.0.1:8120", "SIFT_SERVICE_TOKEN": "t",
                    "SIFT_EMAIL": "a@example.com", "SIFT_ROOT": str(self.root)}
        patch.dict("os.environ", self.env, clear=False).start()
        self.addCleanup(patch.stopall)
        self.calls = []

        def call(_self, path, body):
            self.calls.append((path, body))
            return {"id": "p-1", "name": "x"} if path == "/api/service/project" else {"ticket": "a b"}
        patch.object(Sift, "_call", call).start()

    def test_available_needs_every_env_and_the_plugin_folder(self):
        self.assertEqual([p.id for p in project_plugins.available()], ["sift"])
        self.assertEqual(project_plugins.plugin_dirs(), [self.root / "plugin"])
        for key in self.env:
            with patch.dict("os.environ", {key: " "}):
                self.assertEqual(project_plugins.available(), [], key)
                self.assertEqual(project_plugins.plugin_dirs(), [])
        (self.root / "plugin" / ".claude-plugin" / "plugin.json").unlink()
        self.assertIsNone(project_plugins.get("sift"))

    def test_open_url_lands_on_the_folders_project_signed_in(self):
        url = Sift().open_url("/work/thesis", "http://localhost:8091")
        u = urlparse(url)
        self.assertEqual((u.scheme, u.netloc, u.path), ("http", "localhost:8120", "/api/enter"))
        self.assertEqual(parse_qs(u.query), {"ticket": ["a b"], "next": ["/p/p-1"]})
        self.assertEqual(self.calls[0], ("/api/service/project",
                                         {"email": "a@example.com", "folder": "/work/thesis", "name": "thesis"}))
        self.assertEqual(self.calls[1], ("/api/service/ticket", {"email": "a@example.com"}))

    def test_browser_address_follows_the_origin_or_the_public_url(self):
        self.assertEqual(Sift().public_base("http://127.0.0.1:8091"), "http://127.0.0.1:8120")
        self.assertEqual(Sift().public_base("http://[::1]:8091"), "http://[::1]:8120")
        # A public origin cannot reach a loopback Sift: refused, no ticket minted.
        with self.assertRaises(PluginError) as e:
            Sift().open_url("/work", "https://harman.example.com")
        self.assertEqual(e.exception.status, 409)
        self.assertEqual(self.calls, [])
        with patch.dict("os.environ", {"SIFT_PUBLIC_URL": "https://sift.example.com/"}):
            self.assertEqual(Sift().public_base("https://harman.example.com"), "https://sift.example.com")


class TestSiftCall(unittest.TestCase):
    """The HTTP edge: the bearer rides a header, and a refusal or a dead server
    becomes a sentence for the owner."""

    def setUp(self):
        patch.dict("os.environ", {"SIFT_URL": "http://127.0.0.1:8120/", "SIFT_SERVICE_TOKEN": "t"}).start()
        self.addCleanup(patch.stopall)

    def test_sends_bearer_and_json(self):
        seen = {}

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def urlopen(req, timeout):
            seen.update(url=req.full_url, auth=req.get_header("Authorization"), body=json.loads(req.data))
            return Resp(b'{"ticket": "k"}')
        with patch("urllib.request.urlopen", urlopen):
            self.assertEqual(Sift()._call("/api/service/ticket", {"email": "e"}), {"ticket": "k"})
        self.assertEqual(seen, {"url": "http://127.0.0.1:8120/api/service/ticket", "auth": "Bearer t", "body": {"email": "e"}})

    def test_refusal_and_unreachable(self):
        refused = urllib.error.HTTPError("u", 401, "no", {}, io.BytesIO(b'{"error": "The service token is wrong."}'))
        with patch("urllib.request.urlopen", side_effect=refused), self.assertRaises(PluginError) as e:
            Sift()._call("/api/service/ticket", {})
        self.assertEqual(str(e.exception), "Sift refused: The service token is wrong.")
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")), self.assertRaises(PluginError) as e:
            Sift()._call("/api/service/ticket", {})
        self.assertIn("not running", str(e.exception))


if __name__ == "__main__":
    unittest.main()
