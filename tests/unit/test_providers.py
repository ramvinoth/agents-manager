"""Unit tests for the custom-provider feature:
- viewer.providers: the preset store's keys-vs-reveal contract (list never leaks
  the apiKey; reveal returns it) + validation + edit-preserves-key.
- viewer.customrun: the OpenAI-response -> Claude-transcript line builders parse
  back as renderable user/assistant bubbles, and history replay skips tool noise.
"""
import json

import pytest

from viewer import providers, customrun


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """Point the preset store at a throwaway file."""
    monkeypatch.setattr(providers, "PROVIDERS_FILE", tmp_path / "providers.json")
    return providers


class TestProviderStore:
    def test_upsert_mints_id_and_list_hides_key(self, store):
        saved = store.upsert_preset("", "BrainTwin", "https://inference.braintwin.ai/", "gemma-2b", "sk-secret")
        assert saved["id"] and saved["name"] == "BrainTwin"
        # Base URL is normalised (trailing slash trimmed).
        assert saved["baseUrl"] == "https://inference.braintwin.ai"
        # The public views (save return + list) NEVER contain the key.
        assert "apiKey" not in saved
        listed = store.list_presets()
        assert len(listed) == 1 and "apiKey" not in listed[0]

    def test_reveal_returns_key(self, store):
        pid = store.upsert_preset("", "P", "https://x.ai", "m", "sk-abc")["id"]
        assert store.get_api_key(pid) == "sk-abc"
        assert store.get_preset(pid)["apiKey"] == "sk-abc"

    def test_edit_without_key_preserves_it(self, store):
        pid = store.upsert_preset("", "P", "https://x.ai", "m", "sk-keep")["id"]
        # api_key=None => keep the existing secret while changing the model.
        store.upsert_preset(pid, "P", "https://x.ai", "m2", None)
        assert store.get_api_key(pid) == "sk-keep"
        assert store.get_preset(pid)["model"] == "m2"

    def test_rejects_bad_base_url(self, store):
        with pytest.raises(ValueError):
            store.upsert_preset("", "P", "ftp://nope", "m", "k")

    def test_delete(self, store):
        pid = store.upsert_preset("", "P", "https://x.ai", "m", "k")["id"]
        assert store.delete_preset(pid) is True
        assert store.list_presets() == []
        assert store.delete_preset(pid) is False


class TestTranscriptBuilders:
    def _parse(self, rec):
        # Every renderable line needs a unique uuid + a timestamp.
        assert rec["uuid"] and rec["timestamp"]
        return rec

    def test_user_record_renders(self):
        r = self._parse(customrun._user_record("sid", "/home/x", "hello"))
        assert r["type"] == "user"
        assert r["message"] == {"role": "user", "content": "hello"}
        assert r["cwd"] == "/home/x"

    def test_assistant_record_renders(self):
        r = self._parse(customrun._assistant_record("sid", "/home/x", "hi there", "gemma-2b"))
        assert r["type"] == "assistant"
        blocks = r["message"]["content"]
        assert blocks == [{"type": "text", "text": "hi there"}]
        assert r["message"]["model"] == "gemma-2b"

    def test_project_dir_encoding(self):
        assert customrun._project_dir_for("/home/tim/proj") == "-home-tim-proj"

    def test_history_skips_tool_noise_and_meta(self, tmp_path):
        path = tmp_path / "t.jsonl"
        lines = [
            {"type": "mode", "mode": "normal"},                                   # meta -> skip
            {"type": "user", "message": {"role": "user", "content": "q1"}},
            {"type": "assistant", "message": {"role": "assistant",
             "content": [{"type": "text", "text": "a1"}]}},
            {"type": "user", "message": {"role": "user",
             "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]}},  # tool-only -> skip
            {"type": "assistant", "message": {"role": "assistant",
             "content": [{"type": "tool_use", "id": "t", "name": "bash", "input": {}}]}},  # tool-only -> skip
            {"type": "user", "message": {"role": "user", "content": "q2"}},
        ]
        path.write_text("".join(json.dumps(x) + "\n" for x in lines))
        msgs = customrun._history_messages(path)
        assert msgs == [
            {"role": "user", "content": "q1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "q2"},
        ]
