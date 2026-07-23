"""Unit tests for viewer.copilot pure functions — the Copilot run-flag builder
(security: gates the --model string) and the /models picker filter."""
from viewer.copilot import copilot_run_flags, _pick_models


class TestRunFlags:
    def test_auto_autopilot(self):
        assert copilot_run_flags("auto", "autopilot") == ["--model", "auto", "--allow-all-tools"]

    def test_custom_model_passthrough(self):
        assert copilot_run_flags("claude-opus-4.8", "autopilot") == [
            "--model", "claude-opus-4.8", "--allow-all-tools"]

    def test_plan_mode(self):
        assert copilot_run_flags("gpt-5.4", "plan") == ["--model", "gpt-5.4", "--mode", "plan"]

    def test_default_model_omitted(self):
        assert copilot_run_flags("", "autopilot") == ["--allow-all-tools"]
        assert copilot_run_flags("default", "autopilot") == ["--allow-all-tools"]

    def test_claude_aliases_never_forwarded(self):
        # A leftover Claude dropdown value must not become a Copilot --model.
        for alias in ("opus", "sonnet", "haiku"):
            assert "--model" not in copilot_run_flags(alias, "autopilot")

    def test_shell_injection_rejected(self):
        # Anything outside the model-id charset is dropped, never shelled out.
        assert copilot_run_flags("bad; rm -rf /", "autopilot") == ["--allow-all-tools"]
        assert copilot_run_flags("a b", "autopilot") == ["--allow-all-tools"]
        assert copilot_run_flags("$(whoami)", "autopilot") == ["--allow-all-tools"]

    def test_unknown_mode_defaults_to_allow_all(self):
        assert copilot_run_flags("", "acceptEdits") == ["--allow-all-tools"]
        assert copilot_run_flags("", "") == ["--allow-all-tools"]


class TestPickModels:
    def test_keeps_only_picker_enabled(self):
        payload = {"data": [
            {"id": "gpt-4o", "model_picker_enabled": False},
            {"id": "claude-opus-4.8", "name": "Claude Opus 4.8", "model_picker_enabled": True},
        ]}
        assert _pick_models(payload) == [{"v": "claude-opus-4.8", "label": "Claude Opus 4.8"}]

    def test_drops_disabled_policy(self):
        payload = {"data": [
            {"id": "x", "model_picker_enabled": True, "policy": {"state": "disabled"}}]}
        assert _pick_models(payload) == []

    def test_dedup_and_label_falls_back_to_id(self):
        payload = {"data": [
            {"id": "m1", "model_picker_enabled": True},
            {"id": "m1", "model_picker_enabled": True},
        ]}
        assert _pick_models(payload) == [{"v": "m1", "label": "m1"}]

    def test_accepts_bare_list(self):
        assert _pick_models([{"id": "m", "model_picker_enabled": True}]) == [{"v": "m", "label": "m"}]

    def test_empty_and_malformed(self):
        assert _pick_models({}) == []
        assert _pick_models({"data": None}) == []
        assert _pick_models({"data": ["not-a-dict", {"model_picker_enabled": True}]}) == []
