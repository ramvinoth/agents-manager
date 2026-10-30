"""viewer.agents — where a local agent CLI is looked for, on every platform
(card 270). One PATH (agent_path) feeds both the spawn env and the installed
check, so "installed" and "runs" can never disagree. The Windows branches are
driven by setting os.name and os.pathsep; no real Windows runs them.
"""
import os
import shlex
import unittest
from unittest import mock

from viewer import agents


class AgentPathTest(unittest.TestCase):
    def test_posix_user_dir_first_then_server_path_then_missing_system_dirs(self):
        with mock.patch.object(agents.os, "name", "posix"):
            got = agents.agent_path("/srv/node/bin:/usr/bin").split(":")
        self.assertEqual(got[0], os.path.join(agents.USER_PREFIX, "bin"))
        self.assertEqual(got[1:3], ["/srv/node/bin", "/usr/bin"])
        # /usr/bin is already on the server PATH, so it is not repeated, and the
        # system dirs never shadow the server's chosen (version-managed) node.
        self.assertEqual(got[3:], ["/usr/local/bin", "/opt/homebrew/bin"])

    def test_windows_dirs_joined_with_semicolons(self):
        env = {"APPDATA": "C:\\Users\\u\\AppData\\Roaming",
               "LOCALAPPDATA": "C:\\Users\\u\\AppData\\Local"}
        with mock.patch.object(agents.os, "name", "nt"), \
                mock.patch.object(agents.os, "pathsep", ";"), \
                mock.patch.dict(agents.os.environ, env):
            got = agents.agent_path("C:\\Windows\\system32").split(";")
        self.assertEqual(got, [
            os.path.join(agents.USER_PREFIX, "bin"),         # native claude.exe
            agents.USER_PREFIX,                              # npm --prefix bins on Windows
            os.path.join(env["APPDATA"], "npm"),             # npm's default global prefix
            os.path.join(env["LOCALAPPDATA"], "Microsoft", "WinGet", "Links"),
            "C:\\Windows\\system32",                         # no Unix system dirs appended
        ])

    def test_windows_skips_dirs_whose_variable_is_unset(self):
        with mock.patch.object(agents.os, "name", "nt"), \
                mock.patch.dict(agents.os.environ, clear=True):
            self.assertEqual(agents._user_bin_dirs(),
                             [os.path.join(agents.USER_PREFIX, "bin"), agents.USER_PREFIX])

    def test_agent_env_copies_the_environment_with_the_agent_path(self):
        env = agents.agent_env()
        self.assertEqual(env["PATH"], agents.agent_path(os.environ.get("PATH", "")))
        self.assertIsNot(env, os.environ)


class FindBinTest(unittest.TestCase):
    def test_finds_an_install_in_the_user_dir_and_reports_it_installed(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            bin_dir = os.path.join(d, "bin")
            os.mkdir(bin_dir)
            exe = os.path.join(bin_dir, "codex")
            with open(exe, "w") as f:
                f.write("#!/bin/sh\n")
            os.chmod(exe, 0o755)
            with mock.patch.object(agents, "USER_PREFIX", d), \
                    mock.patch.object(agents.os, "name", "posix"):
                self.assertEqual(agents.find_agent_bin("codex"), exe)
                self.assertTrue(agents.is_installed_local({"bin": "codex"}))
                self.assertFalse(agents.is_installed_local({"bin": "no-such-agent-cli"}))


class InstallTest(unittest.TestCase):
    a = {"pkg": "@openai/codex"}

    def test_remote_install_is_a_quoted_posix_line(self):
        line = agents.install_command(self.a, "/home/some one")
        self.assertEqual(shlex.split(line),
                         ["npm", "install", "-g", "--prefix", "/home/some one/.local", "@openai/codex"])

    def test_local_install_is_an_argv_with_npm_resolved(self):
        with mock.patch.object(agents, "find_agent_bin", lambda n: "/x/npm.cmd" if n == "npm" else None):
            argv = agents.local_install_argv(self.a)
        self.assertEqual(argv, ["/x/npm.cmd", "install", "-g", "--prefix", agents.USER_PREFIX, "@openai/codex"])

    def test_local_install_falls_back_to_bare_npm(self):
        with mock.patch.object(agents, "find_agent_bin", lambda n: None):
            self.assertEqual(agents.local_install_argv(self.a)[0], "npm")


if __name__ == "__main__":
    unittest.main()
