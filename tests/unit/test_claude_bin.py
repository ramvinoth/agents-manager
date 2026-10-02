"""Resolution stays dumb; reporting carries the nuance.

These tests pin the split that viewer.config.claude_bin documents: the function
that picks the binary must answer from CLAUDE_BIN/PATH/known-install order and
NOTHING else (no version ranking, no subprocess), while claude_bin_info is
allowed to shell out because it only reports. Pinning both halves is what stops
"spawn the newest one" from quietly growing back into claude_bin.
"""
from pathlib import Path

import pytest

from viewer import config


def _fake_install(root, rel, version="1.2.3"):
    """A claude that exists on disk and reports `version` when probed."""
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"#!/bin/sh\necho '{version} (Claude Code)'\n")
    p.chmod(0o755)
    return p


@pytest.fixture
def home(tmp_path, monkeypatch):
    """An isolated HOME, so the result never depends on this machine's installs."""
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("CLAUDE_BIN", raising=False)
    monkeypatch.setattr(config.shutil, "which", lambda _name: None)
    return tmp_path


# ----- claude_bin: precedence only -----

def test_env_override_wins_over_everything(home, monkeypatch):
    _fake_install(home, ".local/bin/claude")
    monkeypatch.setattr(config.shutil, "which", lambda _name: "/usr/bin/claude")
    monkeypatch.setenv("CLAUDE_BIN", "/custom/claude")
    assert config.claude_bin() == "/custom/claude"


def test_path_wins_over_local_installs(home, monkeypatch):
    _fake_install(home, ".local/bin/claude")
    monkeypatch.setattr(config.shutil, "which", lambda _name: "/usr/bin/claude")
    assert config.claude_bin() == "/usr/bin/claude"


def test_falls_back_to_known_install_spots(home):
    cand = _fake_install(home, ".claude/local/claude")
    assert config.claude_bin() == str(cand)


def test_unresolved_returns_bare_name(home):
    assert config.claude_bin() == "claude"


def test_resolution_never_probes_versions(home, monkeypatch):
    """The whole point of the PATH-first rule: finding the binary must not run it.

    An earlier revision spawned every candidate to compare versions. Failing here
    means that policy has crept back in, bringing N subprocesses — and then a
    cache, and then cache invalidation — into a lookup PATH answers for free.
    """
    _fake_install(home, ".local/bin/claude")
    monkeypatch.setattr(config, "_claude_version",
                        lambda _p: pytest.fail("claude_bin must not probe versions"))
    config.claude_bin()


# ----- claude_bin_info: reporting -----

def test_reports_winner_and_source(home, monkeypatch):
    cand = _fake_install(home, ".local/bin/claude", "9.9.9")
    monkeypatch.setattr(config, "_claude_version", lambda p: "9.9.9" if p == str(cand) else "")
    info = config.claude_bin_info()
    assert info["path"] == str(cand)
    assert info["source"] == "local install"
    assert info["version"] == "9.9.9"


@pytest.mark.parametrize("setup, expected", [
    (lambda h, mp: mp.setenv("CLAUDE_BIN", "/custom/claude"), "CLAUDE_BIN"),
    (lambda h, mp: mp.setattr(config.shutil, "which", lambda _n: "/usr/bin/claude"), "PATH"),
    (lambda h, mp: _fake_install(h, ".local/bin/claude"), "local install"),
    (lambda h, mp: None, "unresolved"),
])
def test_source_precedence(home, monkeypatch, setup, expected):
    monkeypatch.setattr(config, "_claude_version", lambda _p: "")
    setup(home, monkeypatch)
    assert config.claude_bin_info()["source"] == expected


def test_losing_installs_are_listed_and_the_winner_is_not(home, monkeypatch):
    """`other` is the whole reason this function exists — a stale install that
    lost must be visible, and the winner must not be double-reported."""
    winner = _fake_install(home, ".local/bin/claude", "9.9.9")
    loser = _fake_install(home, ".nvm/versions/node/v22.0.0/bin/claude", "1.0.0")
    monkeypatch.setattr(config, "_claude_version",
                        lambda p: {str(winner): "9.9.9", str(loser): "1.0.0"}.get(p, ""))
    info = config.claude_bin_info()
    assert info["path"] == str(winner)
    assert info["other"] == [{"path": str(loser), "version": "1.0.0"}]


def test_same_install_reached_by_two_paths_is_reported_once(home):
    """A symlinked install is one install. Listing it as a rival would invent a
    staleness problem that isn't there."""
    real = _fake_install(home, ".local/bin/claude")
    link = home / ".claude/local/claude"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(real)
    assert config.claude_bin_info()["other"] == []


def test_a_probe_that_cannot_run_reports_empty_not_an_error(home):
    """Reporting must never be able to break the page it is reported on."""
    broken = home / ".local/bin/claude"
    broken.parent.mkdir(parents=True, exist_ok=True)
    broken.write_text("not an executable")   # no +x: running it raises
    info = config.claude_bin_info()
    assert info["path"] == str(broken)
    assert info["version"] == ""
