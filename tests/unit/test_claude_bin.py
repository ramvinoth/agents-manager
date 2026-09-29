"""config.claude_bin — the viewer spawns the NEWEST claude among the known
install locations (the CLAUDE_BIN env var wins outright, unchecked), so a
stale first-on-PATH install can no longer keep winning. That is the 2.1.84
Cask incident (card 18): the viewer pinned a 15-month-old Homebrew build
whose stdio-MCP hang was fixed upstream, while a current nvm install sat
unused. The probe and candidate discovery are injected, so no real binary
is needed.
"""
import pytest
from pathlib import Path


def _cm(f):
    return classmethod(lambda cls: f())

from viewer import config


class _Probe:
    """Stands in for _claude_version: returns canned versions per path and
    counts how many times it was asked."""

    def __init__(self, versions):
        self.versions = versions
        self.calls = []

    def __call__(self, path):
        self.calls.append(path)
        return self.versions.get(path, ())


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    monkeypatch.setattr(config, "_CLAUDE_BIN_CACHE", {"at": 0.0, "bin": ""})


def _mk(tmp_path, *rel):
    p = tmp_path.joinpath(*rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()
    return str(p)


def _home(monkeypatch, tmp_path, which_target=None, installs=()):
    """Point config.Path.home at tmp_path, `which` at which_target (or None),
    and create the given install paths under tmp_path. Returns (probe, home)."""
    monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
    monkeypatch.setattr(config.shutil, "which",
                        lambda name: which_target if name == "claude" else None)
    paths = [_mk(tmp_path, *p.split("/")) for p in installs]
    return paths


class TestResolution:
    def test_env_override_wins_unchecked(self, monkeypatch, tmp_path):
        monkeypatch.setenv("CLAUDE_BIN", "/opt/pinned/claude")
        probe = _Probe({})
        monkeypatch.setattr(config, "_claude_version", probe)
        _home(monkeypatch, tmp_path, which_target="/usr/local/bin/claude",
              installs=["nvm/claude"])
        assert config.claude_bin() == "/opt/pinned/claude"
        assert probe.calls == []  # the operator's call is never version-checked

    def test_newest_install_wins_regardless_of_path_order(
            self, monkeypatch, tmp_path):
        which_path = _mk(tmp_path, "usr/claude")
        nvm_path = _mk(tmp_path, ".nvm/versions/node/v24.19.0/bin/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which",
                            lambda name: which_path if name == "claude" else None)
        probe = _Probe({which_path: (2, 1, 84), nvm_path: (2, 1, 278)})
        monkeypatch.setattr(config, "_claude_version", probe)
        # The STALE one is first on the server PATH (the incident).
        assert config.claude_bin() == nvm_path

    def test_which_wins_when_it_is_the_newer_one(self, monkeypatch, tmp_path):
        which_path = _mk(tmp_path, "usr/claude")
        nvm_path = _mk(tmp_path, ".nvm/versions/node/v24.19.0/bin/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which",
                            lambda name: which_path if name == "claude" else None)
        probe = _Probe({which_path: (2, 1, 278), nvm_path: (2, 1, 84)})
        monkeypatch.setattr(config, "_claude_version", probe)
        assert config.claude_bin() == which_path

    def test_newer_claude_wins_across_node_versions(self, monkeypatch, tmp_path):
        old_node = _mk(tmp_path, ".nvm/versions/node/v18.17.0/bin/claude")
        new_node = _mk(tmp_path, ".nvm/versions/node/v24.19.0/bin/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which", lambda name: None)
        probe = _Probe({old_node: (2, 1, 270), new_node: (2, 1, 278)})
        monkeypatch.setattr(config, "_claude_version", probe)
        assert config.claude_bin() == new_node

    def test_no_installs_falls_back_to_bare_name(self, monkeypatch, tmp_path):
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which", lambda name: None)
        probe = _Probe({})
        monkeypatch.setattr(config, "_claude_version", probe)
        assert config.claude_bin() == "claude"
        assert probe.calls == []

    def test_probe_failure_keeps_prior_behaviour(self, monkeypatch, tmp_path):
        """If no version can be parsed, the first-on-PATH candidate is used —
        exactly what the code did before this fix, never a failure."""
        which_path = _mk(tmp_path, "usr/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which",
                            lambda name: which_path if name == "claude" else None)
        monkeypatch.setattr(config, "_claude_version", _Probe({}))
        assert config.claude_bin() == which_path

    def test_symlinked_installs_are_probed_once(self, monkeypatch, tmp_path):
        real = _mk(tmp_path, ".nvm/versions/node/v24.19.0/bin/claude")
        link = tmp_path / ".local/bin/claude"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(real)
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which", lambda name: None)
        probe = _Probe({str(link): (2, 1, 278)})
        monkeypatch.setattr(config, "_claude_version", probe)
        out = config.claude_bin()
        assert Path(out).resolve() == Path(real).resolve()
        assert len(probe.calls) == 1  # deduped by resolved path


class TestCache:
    def test_resolves_at_most_once_per_hour(self, monkeypatch, tmp_path):
        which_path = _mk(tmp_path, "usr/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which",
                            lambda name: which_path if name == "claude" else None)
        probe = _Probe({which_path: (2, 1, 84)})
        monkeypatch.setattr(config, "_claude_version", probe)
        first = config.claude_bin()
        again = config.claude_bin()
        assert first == again == which_path
        assert len(probe.calls) == 1  # second call served from the cache

    def test_stale_cache_re_resolves(self, monkeypatch, tmp_path):
        which_path = _mk(tmp_path, "usr/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which",
                            lambda name: which_path if name == "claude" else None)
        probe = _Probe({which_path: (2, 1, 84)})
        monkeypatch.setattr(config, "_claude_version", probe)
        import time as _t
        config.claude_bin()
        config._CLAUDE_BIN_CACHE["at"] = _t.time() - 3601
        config.claude_bin()
        assert len(probe.calls) == 2  # the hour passed: probed again

    def test_invalidate_forces_immediate_re_resolve(self, monkeypatch, tmp_path):
        """A too-old-CLI rejection self-heals: invalidate_claude_bin_cache()
        makes the very NEXT claude_bin() re-probe from disk, so a user who ran
        `claude update` is picked up at once — not after the hour, not after a
        restart (the stale half of the 2.1.84 incident)."""
        which_path = _mk(tmp_path, "usr/claude")
        monkeypatch.setattr(config.Path, "home", _cm(lambda: tmp_path))
        monkeypatch.setattr(config.shutil, "which",
                            lambda name: which_path if name == "claude" else None)
        probe = _Probe({which_path: (2, 1, 84)})
        monkeypatch.setattr(config, "_claude_version", probe)
        config.claude_bin()
        config.claude_bin()
        assert len(probe.calls) == 1  # cached
        config.invalidate_claude_bin_cache()
        config.claude_bin()
        assert len(probe.calls) == 2  # invalidation forced a fresh probe


# The exact raw stream line captured from the Ngram session's 400 (a real
# Copilot/LiteLLM rejection). Ground truth for the detector: it must survive
# the double JSON-escaping the CLI writes into the transcript/stream.
_REAL_GATE_LINE = (
    r'{"type":"assistant","message":{"content":[{"type":"text","text":'
    r'"API Error: 400 {\"error\":{\"message\":\"litellm.BadRequestError: '
    r'Github_copilotException - {\\\"type\\\":\\\"error\\\",\\\"error\\\":'
    r'{\\\"type\\\":\\\"invalid_request_error\\\",\\\"message\\\":\\\"Claude '
    r"Code 2.1.84 does not support this model; version 2.1.280 or newer is "
    r"required. Run 'claude update', or update the Claude desktop app, then "
    r'try again.\\\",\\\"details\\\":{\\\"error_code\\\":\\\"'
    r'claude_code_version_too_old\\\"}}}. Received Model Group=claude-opus-5.5'
    r'"}]}}'
)


class TestVersionGate:
    def test_none_on_ordinary_output(self):
        assert config.claude_version_gate("") is None
        assert config.claude_version_gate(None) is None
        assert config.claude_version_gate('{"type":"result","result":"ok"}') is None
        # A generic 400 that is NOT the version gate must not trip it.
        assert config.claude_version_gate(
            'API Error: 400 rate_limit_exceeded') is None

    def test_detects_real_transcript_line(self):
        msg = config.claude_version_gate(_REAL_GATE_LINE)
        assert msg is not None
        # Actionable + self-contained for a human with no context.
        assert "claude-opus-5.5" in msg
        assert "2.1.84" in msg
        assert "2.1.280" in msg
        assert "claude update" in msg

    def test_detects_by_error_code_alone(self):
        """Provider keeps the machine-readable code but reworded the sentence."""
        assert config.claude_version_gate(
            '{"details":{"error_code":"claude_code_version_too_old"}}') is not None

    def test_detects_by_human_sentence_alone(self):
        """Raw Anthropic gate (no LiteLLM error_code wrapper)."""
        msg = config.claude_version_gate(
            "Claude Code 2.1.84 does not support this model; "
            "version 2.1.280 or newer is required. Run 'claude update'.")
        assert msg is not None
        assert "2.1.280" in msg

    def test_message_degrades_without_extractable_numbers(self):
        """Code present, but no parseable versions/model: still actionable."""
        msg = config.claude_version_gate(
            'error_code":"claude_code_version_too_old')
        assert msg is not None
        assert "claude update" in msg
