"""Unit tests for pure helpers in orchestrator.engine: loop-interval parsing (clamped)
and SKILL.md/command frontmatter description extraction."""
from orchestrator.engine import frontmatter_description
from orchestrator.loops import parse_interval


class TestParseInterval:
    def test_units(self):
        assert parse_interval("30s") == 30
        assert parse_interval("5m") == 300
        assert parse_interval("2h") == 7200
        assert parse_interval("90") == 90  # plain seconds

    def test_clamped_to_bounds(self):
        assert parse_interval("1s") == 30       # min 30
        assert parse_interval("10s") == 30
        assert parse_interval("100h") == 86400  # max 24h

    def test_invalid_returns_none(self):
        assert parse_interval("abc") is None
        assert parse_interval("5x") is None
        assert parse_interval("") is None


class TestFrontmatterDescription:
    def test_plain(self, tmp_path):
        p = tmp_path / "SKILL.md"
        p.write_text("---\nname: x\ndescription: Does a thing\n---\nbody")
        assert frontmatter_description(str(p)) == "Does a thing"

    def test_quoted(self, tmp_path):
        p = tmp_path / "s.md"
        p.write_text('---\ndescription: "Quoted desc"\n---\n')
        assert frontmatter_description(str(p)) == "Quoted desc"

    def test_folded_block_scalar(self, tmp_path):
        p = tmp_path / "s.md"
        p.write_text("---\ndescription: >-\n  Folded line here\n---\n")
        assert frontmatter_description(str(p)) == "Folded line here"

    def test_no_frontmatter(self, tmp_path):
        p = tmp_path / "x.md"
        p.write_text("no frontmatter here\n")
        assert frontmatter_description(str(p)) == ""

    def test_missing_description(self, tmp_path):
        p = tmp_path / "s.md"
        p.write_text("---\nname: only-name\n---\n")
        assert frontmatter_description(str(p)) == ""


class TestPermissionDeniedHint:
    """The local fs 403 text: names the macOS privacy switch for the three
    consent-gated home folders, stays the plain unix answer everywhere else."""

    def test_tcc_folder_names_the_switch(self, monkeypatch):
        from pathlib import Path
        from orchestrator import engine
        monkeypatch.setattr(engine.sys, "platform", "darwin")
        monkeypatch.setattr(engine.sys, "executable", "/opt/py/bin/python3")
        monkeypatch.setattr(engine, "_responsible_app", lambda: None)
        msg = engine._permission_denied_hint(Path.home() / "Downloads")
        assert "~/Downloads" in msg and "Privacy & Security" in msg
        # the actionable fact is WHICH binary needs the grant — it must name the
        # live interpreter path, not a hardcoded product name the list can't show.
        assert "/opt/py/bin/python3" in msg

    def test_tcc_folder_names_the_wrapping_app(self, monkeypatch):
        from pathlib import Path
        from orchestrator import engine
        monkeypatch.setattr(engine.sys, "platform", "darwin")
        monkeypatch.setattr(engine, "_responsible_app",
                            lambda: ("Harman", "/Applications/Harman.app"))
        msg = engine._permission_denied_hint(Path.home() / "Desktop")
        # under the launcher the grant is charged to the app, not the interpreter
        assert "“Harman”" in msg and "/Applications/Harman.app" in msg
        assert "Python" not in msg

    def test_responsible_app_reads_the_parent_bundle(self, monkeypatch):
        from orchestrator import engine
        class R: stdout = "/Users/x/Applications/Harman.app/Contents/MacOS/Harman\n"
        monkeypatch.setattr(engine.subprocess, "run", lambda *a, **k: R)
        assert engine._responsible_app() == ("Harman", "/Users/x/Applications/Harman.app")
        R.stdout = "/bin/zsh\n"
        assert engine._responsible_app() is None

    def test_other_paths_stay_plain(self, monkeypatch):
        from pathlib import Path
        from orchestrator import engine
        monkeypatch.setattr(engine.sys, "platform", "darwin")
        assert engine._permission_denied_hint(Path("/root")) == "Permission denied"
        assert engine._permission_denied_hint(Path.home() / "srv" / "Downloads") == "Permission denied"

    def test_not_a_mac_stays_plain(self, monkeypatch):
        from pathlib import Path
        from orchestrator import engine
        monkeypatch.setattr(engine.sys, "platform", "linux")
        assert engine._permission_denied_hint(Path.home() / "Downloads") == "Permission denied"


def test_idle_timeout_waits_while_owner_is_deciding():
    import os, threading, time
    import pytest
    from orchestrator.engine import iter_stdout_until

    r, w = os.pipe()

    class Proc:
        stdout = os.fdopen(r)

    waiting = {"on": True}
    threading.Timer(0.6, lambda: waiting.update(on=False)).start()
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        list(iter_stdout_until(Proc, 0.2, paused=lambda: waiting["on"], poll=0.05))
    assert time.monotonic() - t0 >= 0.75  # held past 0.2s while paused, then a full window
    os.close(w)
