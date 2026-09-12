"""Unit tests for viewer.sessions and viewer.loops — the I/O-core functions
that previously had zero test coverage. Pure-function tests: no simulator,
no network, no database."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from viewer.sessions import (
    StatCache,
    auto_trim_session,
    compute_session_summary,
    create_backup,
    extract_cwd,
    extract_cwd_from_lines,
    list_backups,
    restore_session,
    session_digest_from_lines,
    _compress,
    _decompress,
    _session_id_from_path,
    _BACKUP_DIR,
)
from viewer.loops import parse_interval


class TestExtractCwdFromLines(unittest.TestCase):
    """extract_cwd_from_lines is a pure function: lines in, cwd out."""

    def test_returns_last_cwd(self):
        lines = [
            json.dumps({"type": "init", "cwd": "/first"}),
            json.dumps({"type": "user", "cwd": "/second"}),
            json.dumps({"type": "assistant"}),
            json.dumps({"type": "fork", "cwd": "/third"}),
        ]
        self.assertEqual(extract_cwd_from_lines(lines), "/third")

    def test_returns_none_when_no_cwd(self):
        lines = [json.dumps({"type": "user", "message": "hello"})]
        self.assertIsNone(extract_cwd_from_lines(lines))

    def test_skips_malformed_json(self):
        lines = [
            "not json",
            json.dumps({"cwd": "/good"}),
            "{broken",
        ]
        self.assertEqual(extract_cwd_from_lines(lines), "/good")

    def test_empty_input(self):
        self.assertIsNone(extract_cwd_from_lines([]))

    def test_ignores_empty_cwd_string(self):
        lines = [json.dumps({"cwd": ""}), json.dumps({"cwd": "/real"})]
        self.assertEqual(extract_cwd_from_lines(lines), "/real")

    def test_single_cwd(self):
        lines = [json.dumps({"type": "init", "cwd": "/only"})]
        self.assertEqual(extract_cwd_from_lines(lines), "/only")


class TestExtractCwd(unittest.TestCase):
    """extract_cwd reads from files and has fallbacks."""

    def test_reads_file_returns_last_cwd(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
            f.write(json.dumps({"cwd": "/a"}) + "\n")
            f.write(json.dumps({"cwd": "/b"}) + "\n")
            f.flush()
            try:
                self.assertEqual(extract_cwd(f.name), "/b")
            finally:
                os.unlink(f.name)

    def test_fallback_to_parent_dir_name(self):
        """When no cwd in file, derive from Claude's project dir name."""
        d = tempfile.mkdtemp(prefix="-Users-testuser-myproject")
        try:
            p = Path(d) / "session.jsonl"
            p.write_text(json.dumps({"type": "user"}) + "\n")
            result = extract_cwd(str(p))
            # Should derive a path from the dir name
            self.assertTrue(result.startswith("/"))
        finally:
            os.unlink(str(p))
            os.rmdir(d)

    def test_fallback_to_home_on_missing_file(self):
        result = extract_cwd("/nonexistent/path/session.jsonl")
        self.assertEqual(result, str(Path.home()))


class TestAutoTrimSession(unittest.TestCase):
    """auto_trim_session: file size → trim or skip."""

    # Realistic Claude CLI session headers: mode, permission-mode, 2x system
    _HEADERS = [
        {"type": "mode", "mode": "plan", "cwd": "/test"},
        {"type": "permission-mode", "permissionMode": "acceptEdits"},
        {"type": "system", "system": [{"type": "text", "text": "You are an assistant."}]},
        {"type": "system", "system": [{"type": "text", "text": "Project rules here."}]},
    ]

    def _make_session(self, num_lines, line_size=1000):
        """Create a session JSONL with num_lines lines of approximately line_size bytes each."""
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
        for hdr in self._HEADERS:
            f.write(json.dumps(hdr) + "\n")
        for i in range(num_lines):
            data = {"type": "assistant", "message": {"content": "x" * line_size}, "idx": i}
            f.write(json.dumps(data) + "\n")
        f.flush()
        f.close()
        return f.name

    def test_no_trim_small_file(self):
        path = self._make_session(10)
        try:
            size_before = os.path.getsize(path)
            auto_trim_session(path)
            self.assertEqual(os.path.getsize(path), size_before)
        finally:
            os.unlink(path)

    def test_trims_large_file(self):
        # Create a file > 16 MB (will exceed default threshold)
        path = self._make_session(2000, line_size=10000)
        try:
            size_before = os.path.getsize(path)
            self.assertGreater(size_before, 16 * 1024 * 1024)
            with patch("viewer.sessions.create_backup"):
                auto_trim_session(path)
            size_after = os.path.getsize(path)
            self.assertLess(size_after, size_before)
            self.assertLess(size_after, 4 * 1024 * 1024)  # should be around _SESSION_TRIM_TARGET
            # Verify ALL header lines are preserved
            with open(path) as f:
                for i, expected in enumerate(self._HEADERS):
                    line = json.loads(f.readline())
                    self.assertEqual(line["type"], expected["type"],
                                     f"Header line {i} should be type={expected['type']}")
                # Verify next line is conversation, not another header
                next_line = json.loads(f.readline())
                self.assertEqual(next_line["type"], "assistant")
        finally:
            os.unlink(path)

    def test_truncates_giant_lines(self):
        """A single line > 512 KB should be truncated in the output when trim fires."""
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
        for hdr in self._HEADERS:
            f.write(json.dumps(hdr) + "\n")
        # Write enough to push past 17 MB threshold
        for i in range(2000):
            f.write(json.dumps({"type": "user", "msg": "x" * 10000}) + "\n")
        # One giant line at the end
        f.write(json.dumps({"type": "tool_result", "output": "G" * 800000}) + "\n")
        f.flush()
        f.close()
        try:
            self.assertGreater(os.path.getsize(f.name), 17 * 1024 * 1024)
            with patch("viewer.sessions.create_backup"):
                auto_trim_session(f.name)
            # Check that no line in the output exceeds 512 KB + some overhead
            with open(f.name, "rb") as fh:
                for line in fh:
                    self.assertLess(len(line), 600 * 1024, "Giant line was not truncated")
        finally:
            os.unlink(f.name)

    def test_nonexistent_file(self):
        # Should not raise
        auto_trim_session("/nonexistent/session.jsonl")


class TestParseInterval(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(parse_interval("60"), 60)
        self.assertEqual(parse_interval("60s"), 60)

    def test_minutes(self):
        self.assertEqual(parse_interval("5m"), 300)

    def test_hours(self):
        self.assertEqual(parse_interval("2h"), 7200)

    def test_minimum_30(self):
        self.assertEqual(parse_interval("1"), 30)
        self.assertEqual(parse_interval("10s"), 30)

    def test_maximum_24h(self):
        self.assertEqual(parse_interval("100h"), 86400)

    def test_invalid(self):
        self.assertIsNone(parse_interval("abc"))
        self.assertIsNone(parse_interval(""))

    def test_decimal(self):
        self.assertEqual(parse_interval("1.5h"), 5400)


class TestStatCache(unittest.TestCase):
    def test_hit_and_miss(self):
        c = StatCache(cap=5)
        c.put("k1", 100.0, 500, {"data": True})
        self.assertEqual(c.get("k1", 100.0, 500), {"data": True})
        # Different mtime invalidates
        self.assertIsNone(c.get("k1", 101.0, 500))
        # Different size invalidates
        self.assertIsNone(c.get("k1", 100.0, 501))

    def test_cap(self):
        c = StatCache(cap=2)
        c.put("a", 1.0, 1, "A")
        c.put("b", 2.0, 2, "B")
        c.put("c", 3.0, 3, "C")  # should evict "a"
        self.assertIsNone(c.get("a", 1.0, 1))
        self.assertEqual(c.get("b", 2.0, 2), "B")
        self.assertEqual(c.get("c", 3.0, 3), "C")


class TestComputeSessionSummary(unittest.TestCase):
    def test_basic(self):
        lines = [
            json.dumps({"type": "user", "message": {"content": "hello"}, "timestamp": "2024-01-01T00:00:00Z"}),
            json.dumps({"type": "assistant", "message": {"role": "assistant", "model": "claude-sonnet-4-20250514",
                         "content": [{"type": "text", "text": "hi"}],
                         "usage": {"input_tokens": 100, "output_tokens": 50}},
                         "timestamp": "2024-01-01T00:00:01Z"}),
        ]
        data = compute_session_summary(lines, "/test")
        self.assertEqual(data["userMessages"], 1)
        self.assertEqual(data["assistantMessages"], 1)
        self.assertEqual(data["totalInput"], 100)
        self.assertEqual(data["totalOutput"], 50)
        self.assertEqual(data["cwd"], "/test")
        self.assertIn("claude-sonnet-4-20250514", data["models"])

    def test_empty(self):
        data = compute_session_summary([], "/test")
        self.assertEqual(data["lines"], 0)
        self.assertEqual(data["userMessages"], 0)


class TestSessionDigest(unittest.TestCase):
    def test_extracts_user_and_assistant(self):
        lines = [
            json.dumps({"type": "user", "message": {"content": "do the thing"}}),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}]}}),
        ]
        digest = session_digest_from_lines(lines)
        self.assertIn("USER: do the thing", digest)
        self.assertIn("CLAUDE: done", digest)

    def test_skips_tool_results(self):
        lines = [
            json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x"}]}}),
        ]
        digest = session_digest_from_lines(lines)
        self.assertEqual(digest, "")

    def test_truncation(self):
        lines = [
            json.dumps({"type": "user", "message": {"content": "word " * 10000}})
            for _ in range(20)
        ]
        digest = session_digest_from_lines(lines, max_chars=1000)
        self.assertLessEqual(len(digest), 1100)  # some slack for prefix


class TestCompressDecompress(unittest.TestCase):
    """Round-trip compression: compress → decompress → identical content."""

    def test_round_trip(self):
        """Compress and decompress a file, verify content matches."""
        content = b"hello world\n" * 1000
        with tempfile.NamedTemporaryFile(delete=False, suffix=".jsonl") as f:
            f.write(content)
            src = Path(f.name)
        dst = src.with_suffix(".jsonl.zst")
        restored = src.with_suffix(".restored.jsonl")
        try:
            _compress(src, dst)
            self.assertTrue(dst.exists())
            self.assertFalse(src.exists())  # _compress removes src
            self.assertLess(dst.stat().st_size, len(content))  # compressed
            _decompress(dst, restored)
            self.assertEqual(restored.read_bytes(), content)
        finally:
            for p in (src, dst, restored):
                if p.exists():
                    p.unlink()


class TestSessionIdFromPath(unittest.TestCase):
    def test_extracts_uuid(self):
        self.assertEqual(
            _session_id_from_path("/foo/bar/abc-123-def.jsonl"),
            "abc-123-def",
        )


class TestCreateBackup(unittest.TestCase):
    """create_backup: compress + DB record + prune."""

    _HEADERS = TestAutoTrimSession._HEADERS

    def _make_session(self, num_lines=10, line_size=100):
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
        for hdr in self._HEADERS:
            f.write(json.dumps(hdr) + "\n")
        for i in range(num_lines):
            f.write(json.dumps({"type": "assistant", "msg": "x" * line_size}) + "\n")
        f.flush()
        f.close()
        return f.name

    @patch("viewer.sessions._prune_backups")
    @patch("viewer.db.backup_create")
    def test_creates_compressed_backup(self, mock_bc, mock_prune):
        """create_backup produces a compressed file and calls db.backup_create."""
        mock_bc.return_value = {"id": 1}
        path = self._make_session()
        original_size = os.path.getsize(path)
        try:
            result = create_backup(path, reason="test")
            self.assertIsNotNone(result)
            self.assertTrue(Path(result).exists())
            self.assertLess(Path(result).stat().st_size, original_size)
            mock_bc.assert_called_once()
            # Original file should still exist (create_backup copies, doesn't move)
            self.assertTrue(Path(path).exists())
        finally:
            os.unlink(path)
            if result and Path(result).exists():
                Path(result).unlink()
            # Clean up backup dir
            session_id = _session_id_from_path(path)
            bdir = _BACKUP_DIR / session_id
            if bdir.exists():
                import shutil
                shutil.rmtree(bdir)

    @patch("viewer.db.backup_delete")
    @patch("viewer.db.backup_list")
    def test_prune_keeps_only_3(self, mock_list, mock_delete):
        """_prune_backups deletes rows + files beyond BACKUP_KEEP."""
        from viewer.sessions import _prune_backups
        # Simulate 5 backup rows, newest first
        fake_rows = []
        tmpfiles = []
        for i in range(5):
            tf = tempfile.NamedTemporaryFile(delete=False, suffix=".zst")
            tf.write(b"fake")
            tf.close()
            tmpfiles.append(tf.name)
            fake_rows.append({"id": i + 1, "backup_path": tf.name})
        mock_list.return_value = fake_rows
        mock_delete.return_value = None
        try:
            _prune_backups("test-session")
            # Should delete rows 4 and 5 (index 3 and 4 — beyond keep=3)
            self.assertEqual(mock_delete.call_count, 2)
            # Files for pruned backups should be gone
            self.assertFalse(Path(tmpfiles[3]).exists())
            self.assertFalse(Path(tmpfiles[4]).exists())
            # First 3 should still exist
            for i in range(3):
                self.assertTrue(Path(tmpfiles[i]).exists())
        finally:
            for tf in tmpfiles:
                if Path(tf).exists():
                    Path(tf).unlink()


class TestRestoreSession(unittest.TestCase):
    """restore_session: decompress backup → session path."""

    def test_restore_round_trip(self):
        """Backup then restore produces identical content."""
        import shutil
        content_lines = [
            json.dumps({"type": "mode", "mode": "plan", "cwd": "/test"}),
            json.dumps({"type": "permission-mode", "permissionMode": "acceptEdits"}),
            json.dumps({"type": "user", "message": {"content": "hello"}}),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}),
        ]
        original_content = "\n".join(content_lines) + "\n"

        # Create proper directory structure: claude_dir/project_dir/session.jsonl
        tmpdir = Path(tempfile.mkdtemp())
        claude_dir = tmpdir / "projects"
        proj_dir = claude_dir / "test-project"
        proj_dir.mkdir(parents=True)

        session_id = "test-restore-session"
        session_file = proj_dir / f"{session_id}.jsonl"
        session_file.write_text(original_content)

        # Compress to simulate a backup
        backup_dir = _BACKUP_DIR / session_id
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_file = backup_dir / f"{session_id}_test.jsonl.zst"
        tmp_copy = backup_dir / ".tmp_copy"
        shutil.copy2(str(session_file), str(tmp_copy))
        _compress(tmp_copy, backup_file)

        # Delete session file to simulate it being trimmed/lost
        # But keep a dummy so the project dir is discoverable
        session_file.unlink()
        dummy = proj_dir / "dummy.jsonl"
        dummy.write_text("{}\n")

        mock_row = {"id": 42, "session_id": session_id, "backup_path": str(backup_file)}

        try:
            with patch("viewer.db.backup_get", return_value=mock_row):
                with patch("viewer.config.CLAUDE_DIR", claude_dir):
                    restored = restore_session(session_id, 42)
                    self.assertTrue(Path(restored).exists())
                    self.assertEqual(Path(restored).read_text(), original_content)
        finally:
            shutil.rmtree(tmpdir)
            if backup_dir.exists():
                shutil.rmtree(backup_dir)


if __name__ == "__main__":
    unittest.main()
