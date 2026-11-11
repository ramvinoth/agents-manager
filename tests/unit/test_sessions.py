"""Unit tests for viewer.sessions and viewer.loops — the I/O-core functions
that previously had zero test coverage. Pure-function tests: no simulator,
no network, no database."""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from viewer.sessions import (
    StatCache,
    compute_session_summary,
    extract_cwd,
    last_cwd_in_file,
)
from viewer.loops import parse_interval


class TestLastCwdInFile(unittest.TestCase):
    """last_cwd_in_file reads backwards and returns the LAST cwd."""

    def cwd(self, lines, chunk=1 << 20):
        return last_cwd_in_file(io.BytesIO("\n".join(lines).encode()), chunk)

    def test_returns_last_cwd(self):
        lines = [
            json.dumps({"type": "init", "cwd": "/first"}),
            json.dumps({"type": "user", "cwd": "/second"}),
            json.dumps({"type": "assistant"}),
            json.dumps({"type": "fork", "cwd": "/third"}),
        ]
        self.assertEqual(self.cwd(lines), "/third")

    def test_returns_none_when_no_cwd(self):
        self.assertIsNone(self.cwd([json.dumps({"type": "user", "message": "hello"})]))

    def test_skips_malformed_json(self):
        self.assertEqual(self.cwd(["not json", json.dumps({"cwd": "/good"}), '{broken "cwd"']), "/good")

    def test_empty_input(self):
        self.assertIsNone(self.cwd([]))

    def test_ignores_empty_cwd_string(self):
        self.assertEqual(self.cwd([json.dumps({"cwd": "/real"}), json.dumps({"cwd": ""})]), "/real")

    def test_ignores_cwd_mentioned_inside_message_text(self):
        lines = [json.dumps({"cwd": "/real"}),
                 json.dumps({"message": 'the "cwd" key', "x": {"cwd": "/nested"}})]
        self.assertEqual(self.cwd(lines), "/real")

    def test_trailing_newline_and_unicode(self):
        lines = [json.dumps({"cwd": "/é/proj"}, ensure_ascii=False), ""]
        self.assertEqual(self.cwd(lines), "/é/proj")

    def test_lines_split_across_chunks_match_forward_scan(self):
        # Tiny chunks force every line to straddle chunk boundaries; the
        # answer must equal a plain forward scan for the last cwd.
        lines = [json.dumps({"cwd": f"/d{i}", "pad": "x" * (i * 7 % 50)}) if i % 3 else
                 json.dumps({"type": "noise", "pad": "y" * i}) for i in range(60)]
        expected = [json.loads(l)["cwd"] for l in lines if "cwd" in json.loads(l)][-1]
        for chunk in (1, 2, 7, 64, 4096):
            self.assertEqual(self.cwd(lines, chunk), expected, chunk)

    def test_only_line_is_the_first(self):
        self.assertEqual(self.cwd([json.dumps({"cwd": "/only"})], chunk=3), "/only")


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
