"""A chat's project is the folder it ran in, not a decode of Claude's dir name.

Claude encodes '/', ' ' and '-' all as '-' in ~/.claude/projects/<dir>, so a
folder like "/work/Case A - Land 23" decoded to "/work/Case/A//Land/23": the
chat landed in a phantom project named "23" and never showed under its real
project in the rail. The list reads the cwd the transcript records instead.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from viewer import engine, remote

CWD = "/work/Case A - Land 23"


def _transcript(root, records):
    proj = os.path.join(root, "projects", "-work-Case-A---Land-23")
    os.makedirs(proj)
    with open(os.path.join(proj, "abc.jsonl"), "w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    return os.path.join(root, "projects")


class TestLocalSessionProject(unittest.TestCase):
    def _project(self, records):
        with tempfile.TemporaryDirectory() as tmp:
            root = _transcript(tmp, records)
            with patch.object(engine, "CLAUDE_DIR", pathlib.Path(root)):
                return engine.LocalHost().list_sessions()[0]["project"]

    def test_a_folder_with_spaces_and_dashes_keeps_its_name(self):
        self.assertEqual(self._project([{"type": "user", "cwd": CWD, "message": {"content": "hi"}}]), CWD)

    def test_the_last_recorded_cwd_wins(self):
        self.assertEqual(self._project([{"type": "user", "cwd": "/old"},
                                        {"type": "user", "cwd": CWD}]), CWD)

    def test_a_transcript_with_no_cwd_falls_back_to_the_dir_name(self):
        self.assertEqual(self._project([{"type": "custom-title", "customTitle": "Notes"}]),
                         "/work/Case/A//Land/23")


class TestRemoteSessionProject(unittest.TestCase):
    def test_the_shipped_script_reads_the_recorded_cwd(self):
        captured = {}

        def run(hid, script):
            captured["script"] = script
            return "[]"

        with patch.object(remote, "remote_run_python", run):
            remote.remote_list_sessions("h")
        with tempfile.TemporaryDirectory() as home:
            _transcript(os.path.join(home, ".claude"), [{"type": "user", "cwd": CWD}])
            out = subprocess.run([sys.executable, "-c", captured["script"]], capture_output=True,
                                 text=True, env={**os.environ, "HOME": home}, check=True).stdout
        self.assertEqual(json.loads(out.strip().splitlines()[-1])[0]["project"], CWD)


if __name__ == "__main__":
    unittest.main()
