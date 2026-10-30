"""Card 270: the last Unix-only paths that broke the server on Windows.

- db: with DATABASE_URL unset, Windows (no unix socket) reaches Postgres over
  TCP on localhost:5432; DATABASE_URL still wins.
- gitops: a local repo's status is read by running git directly (no bash),
  and must match what the remote shell script reports for the same repo.
- browser: on a Windows server the local live browser says why it cannot run
  instead of failing on bash/nohup/pkill.
The Windows branches are driven by setting os.name; no real Windows runs them.
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from viewer import browser, db, gitops


class DefaultDsnTest(unittest.TestCase):
    def test_posix_uses_the_unix_socket(self):
        with mock.patch.object(db.os, "name", "posix"):
            self.assertEqual(db.default_dsn(), "dbname=viewer")

    def test_windows_uses_tcp_localhost(self):
        with mock.patch.object(db.os, "name", "nt"):
            self.assertEqual(db.default_dsn(), "dbname=viewer host=localhost port=5432")

    def test_database_url_still_wins(self):
        # The module-level DSN is read once at import; the unit run sets one.
        env_url = os.environ.get("DATABASE_URL")
        if env_url:
            self.assertEqual(db.DATABASE_URL, env_url)
        else:
            self.assertEqual(db.DATABASE_URL, db.default_dsn())


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                   cwd=cwd, check=True, capture_output=True)


@unittest.skipUnless(shutil.which("git"), "needs git")
class LocalRepoStatusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # One repo for the class: each git call through the macOS xcrun shim
        # costs a few hundred ms. A test that changes it puts it back.
        cls.tmp = tempfile.mkdtemp()
        cls.origin = os.path.join(cls.tmp, "origin.git")
        _git(cls.tmp, "init", "-q", "--bare", cls.origin)
        cls.work = os.path.join(cls.tmp, "work")
        _git(cls.tmp, "clone", "-q", cls.origin, cls.work)
        with open(os.path.join(cls.work, "a.txt"), "w") as f:
            f.write("a\n")
        _git(cls.work, "add", "a.txt")
        _git(cls.work, "commit", "-q", "-m", "one")
        _git(cls.work, "push", "-q", "origin", "HEAD")
        cls.branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cls.work,
                                    capture_output=True, text=True).stdout.strip()
        cls._track()
        with open(os.path.join(cls.work, "b.txt"), "w") as f:
            f.write("b\n")
        _git(cls.work, "add", "b.txt")
        _git(cls.work, "commit", "-q", "-m", "two")       # one ahead
        with open(os.path.join(cls.work, "c.txt"), "w") as f:
            f.write("c\n")                                 # one dirty

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, True)

    @classmethod
    def _track(cls):
        _git(cls.work, "branch", "-q", "--set-upstream-to", "origin/" + cls.branch)

    def test_status_without_a_shell(self):
        with mock.patch.object(gitops.subprocess, "run", wraps=subprocess.run) as run:
            st = gitops.repo_status("local", self.work)
        self.assertTrue(all(c.args[0][0] == "git" for c in run.call_args_list))
        self.assertEqual(st["branch"], self.branch)
        self.assertEqual((st["dirty"], st["ahead"], st["behind"]), (1, 1, 0))
        self.assertEqual(st["remote"], self.origin)
        self.assertEqual(os.path.realpath(st["root"]), os.path.realpath(self.work))

    @unittest.skipUnless(shutil.which("bash"), "the remote script is bash")
    def test_matches_the_remote_shell_script(self):
        out = subprocess.run(["bash", "-c", gitops._STATUS_SH.format(cwd=gitops._q_path(self.work))],
                             capture_output=True, text=True).stdout
        line = next(ln for ln in out.splitlines() if ln.startswith("GIT|"))
        remote_fields = tuple(f.strip() for f in line.split("|")[1:7])
        self.assertEqual(gitops._local_status_fields(self.work), remote_fields)

    def test_no_upstream_reads_as_unknown(self):
        _git(self.work, "branch", "-q", "--unset-upstream")
        self.addCleanup(self._track)
        st = gitops.repo_status("local", self.work)
        self.assertEqual((st["ahead"], st["behind"]), (None, None))

    def test_not_a_repo_not_a_dir_or_empty(self):
        for cwd in (self.tmp, os.path.join(self.tmp, "missing"), ""):
            self.assertEqual(gitops.repo_status("local", cwd), {"repo": False}, cwd)

    def test_missing_git_is_not_a_repo(self):
        with mock.patch.object(gitops.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(gitops.repo_status("local", self.work), {"repo": False})


class BrowserOnWindowsTest(unittest.TestCase):
    def test_every_local_entry_point_says_why(self):
        with mock.patch.object(browser.os, "name", "nt"), \
                mock.patch.object(browser.subprocess, "run", side_effect=AssertionError("ran a shell")), \
                mock.patch.object(browser.subprocess, "Popen", side_effect=AssertionError("ran a shell")):
            st = browser.browser_status("local")
            self.assertEqual(st["reasons"], [browser.NO_LOCAL_SHELL])
            self.assertIsNone(st["action"])
            for fn in (browser.browser_start, browser.browser_stop,
                       browser.browser_install, browser.browser_install_xvfb):
                self.assertEqual(fn("local"), {"error": browser.NO_LOCAL_SHELL}, fn.__name__)

    def test_remote_hosts_are_not_affected(self):
        with mock.patch.object(browser.os, "name", "nt"):
            self.assertIsNone(browser._no_local_shell("some-host"))
        with mock.patch.object(browser.os, "name", "posix"):
            self.assertIsNone(browser._no_local_shell("local"))


if __name__ == "__main__":
    unittest.main()
