"""Unit tests for backends.sandbox_sync: the three way folder sync a sandboxed
run's work comes home through, and the tar copy both directions use."""
import io
import json
import os
import subprocess
import sys
import tarfile

import pytest

from orchestrator.runtime.backends import sandbox_sync as s


def _write(root, name, data):
    path = os.path.join(root, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(data)


class TestPlanSync:
    def test_box_only_change_is_taken(self):
        assert s.plan_sync({"a": "1"}, {"a": "1"}, {"a": "2"}) == (["a"], [], [])

    def test_box_new_file_is_taken(self):
        assert s.plan_sync({}, {}, {"n": "1"}) == (["n"], [], [])

    def test_box_delete_is_applied(self):
        assert s.plan_sync({"a": "1"}, {"a": "1"}, {}) == ([], ["a"], [])

    def test_local_only_change_is_kept(self):
        assert s.plan_sync({"a": "1"}, {"a": "9"}, {"a": "1"}) == ([], [], [])

    def test_both_same_change_is_nothing(self):
        assert s.plan_sync({"a": "1"}, {"a": "2"}, {"a": "2"}) == ([], [], [])

    def test_both_changed_differently_is_conflict(self):
        assert s.plan_sync({"a": "1"}, {"a": "8"}, {"a": "9"}) == ([], [], ["a"])

    def test_box_deleted_but_local_edited_is_conflict(self):
        assert s.plan_sync({"a": "1"}, {"a": "8"}, {}) == ([], [], ["a"])


class TestListing:
    def test_walk_skips_rebuilt_folders(self, tmp_path):
        _write(tmp_path, "src/a.py", "x")
        _write(tmp_path, "node_modules/p/i.js", "x")
        _write(tmp_path, ".DS_Store", "x")
        assert s.list_files(str(tmp_path)) == ["src/a.py"]

    def test_git_folder_uses_ignore_rules_and_carries_git(self, tmp_path):
        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
        _write(tmp_path, ".gitignore", "build/\n")
        _write(tmp_path, "build/out.bin", "x")
        _write(tmp_path, "keep.txt", "x")
        names = s.list_files(str(tmp_path))
        assert "keep.txt" in names and ".gitignore" in names
        assert "build/out.bin" not in names
        assert any(n.startswith(".git/") for n in names)

    def test_too_big_raises(self, tmp_path):
        _write(tmp_path, "a", "x" * 100)
        with pytest.raises(s.TooBig):
            s.list_files(str(tmp_path), cap=10)

    def test_current_manifest_keeps_base_paths_a_listing_misses(self, tmp_path):
        # An ignore rule added during the run must not read as a delete.
        _write(tmp_path, "a.log", "x")
        assert "a.log" in s.current_manifest(str(tmp_path), ["a.log"])

    def test_manifest_leaves_out_symlinks(self, tmp_path):
        _write(tmp_path, "real", "x")
        os.symlink("real", tmp_path / "link")
        assert set(s.manifest(str(tmp_path), ["real", "link"])) == {"real"}


class TestTar:
    def _round_trip(self, src, paths, dest, allowed=None):
        buf = io.BytesIO()
        s.write_tar(buf, src, paths)
        buf.seek(0)
        return s.extract_tar(buf, dest, allowed=allowed)

    def test_round_trip_keeps_content_and_mode(self, tmp_path):
        src, dest = tmp_path / "src", tmp_path / "dest"
        _write(src, "d/run.sh", "echo hi")
        os.chmod(src / "d/run.sh", 0o755)
        dest.mkdir()
        assert self._round_trip(str(src), ["d/run.sh"], str(dest)) == ["d/run.sh"]
        assert (dest / "d/run.sh").read_text() == "echo hi"
        assert os.stat(dest / "d/run.sh").st_mode & 0o777 == 0o755

    def test_allowed_limits_what_is_written(self, tmp_path):
        src, dest = tmp_path / "src", tmp_path / "dest"
        _write(src, "a", "1")
        _write(src, "b", "2")
        dest.mkdir()
        assert self._round_trip(str(src), ["a", "b"], str(dest), allowed={"b"}) == ["b"]
        assert not (dest / "a").exists()

    def test_name_escaping_root_is_refused(self, tmp_path):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            info = tarfile.TarInfo("../evil")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        buf.seek(0)
        (tmp_path / "root").mkdir()
        assert s.extract_tar(buf, str(tmp_path / "root")) == []
        assert not (tmp_path / "evil").exists()


def test_manifest_command_matches_the_library(tmp_path):
    """The box runs this file as a script; its answer must equal this machine's."""
    _write(tmp_path, "a", "1")
    out = subprocess.run([sys.executable, s.__file__, "manifest", str(tmp_path)],
                         input=json.dumps(["a", "gone"]), capture_output=True, text=True, check=True)
    assert json.loads(out.stdout) == s.current_manifest(str(tmp_path), ["a", "gone"])
