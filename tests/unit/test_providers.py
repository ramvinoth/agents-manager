"""Unit tests for the custom-provider feature:
- viewer.providers: the preset store's keys-vs-reveal contract (list never leaks
  the apiKey; reveal returns it) + validation + edit-preserves-key.
- viewer.customrun: the OpenAI-response -> Claude-transcript line builders parse
  back as renderable user/assistant bubbles, and history replay skips tool noise.
"""
import json

import pytest

from viewer import providers, customrun


class _FakeProviderDB:
    """In-memory stand-in for the providers table: the three accessors
    viewer.providers calls, with the "at most one default" invariant provider_upsert
    enforces in one SQL transaction reproduced here."""

    def __init__(self):
        self.rows = {}   # pid -> full record (incl. apiKey), the reveal-path store

    def setting_get(self, key, default=None):
        return default

    def providers_load(self):
        return {pid: dict(rec) for pid, rec in self.rows.items()}

    def provider_limits_set(self, pid, limits):
        self.rows[pid]["modelLimits"] = limits

    def provider_upsert(self, pid, rec, default_change=None):
        if rec.get("isDefault"):
            for other, r in self.rows.items():
                if other != pid:
                    r["isDefault"] = False
        self.rows[pid] = dict(rec)

    def provider_delete(self, pid):
        return self.rows.pop(pid, None) is not None


@pytest.fixture()
def store(monkeypatch):
    """Back the preset store with an in-memory fake db (no Postgres)."""
    monkeypatch.setattr(providers, "db", _FakeProviderDB())
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


class TestAlternating:
    def test_merges_consecutive_same_role(self):
        # Two user turns in a row (e.g. after an error assistant line was dropped)
        # collapse into one so a strict template (Gemma) accepts the request.
        out = customrun._enforce_alternating([
            {"role": "user", "content": "a"},
            {"role": "user", "content": "b"},
            {"role": "assistant", "content": "c"},
        ])
        assert out == [
            {"role": "user", "content": "a\n\nb"},
            {"role": "assistant", "content": "c"},
        ]

    def test_drops_leading_assistant(self):
        out = customrun._enforce_alternating([
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "q"},
        ])
        assert out == [{"role": "user", "content": "q"}]

    def test_does_not_mutate_input(self):
        src = [{"role": "user", "content": "a"}, {"role": "user", "content": "b"}]
        customrun._enforce_alternating(src)
        assert src[0]["content"] == "a"  # original untouched


class TestPerModelLimits:
    def test_override_wins_and_discovery_fills_the_rest(self, store):
        p = store.upsert_preset("", "LiteLLM", "http://gw:4000", "a", model_overrides={"a": 100000})
        store.remember_discovered(p["id"], {"a": {"discovered": 200000, "maxOutput": 0},
                                            "b": {"discovered": 128000, "maxOutput": 64000}})
        rows = {r["id"]: r for r in store.list_presets()[0]["models"]}
        assert [r["id"] for r in store.list_presets()[0]["models"]] == ["a", "b"]  # default first
        assert rows["a"]["contextWindow"] == 100000 and rows["a"]["source"] == "override"
        assert rows["b"]["contextWindow"] == 128000 and rows["b"]["source"] == "discovered"
        assert rows["b"]["maxOutput"] == 64000

    def test_overrides_replace_but_keep_discovered(self, store):
        p = store.upsert_preset("", "n", "http://gw:4000", "a", model_overrides={"a": 1, "b": 2})
        store.remember_discovered(p["id"], {"b": {"discovered": 9, "maxOutput": 0}})
        saved = store.upsert_preset(p["id"], "n", "http://gw:4000", "a", model_overrides={"b": 0})
        rows = {r["id"]: r for r in saved["models"]}
        assert rows["a"]["contextWindow"] == 0
        assert rows["b"]["contextWindow"] == 9 and rows["b"]["source"] == "discovered"

    def test_endpoint_change_drops_discovered_keeps_overrides(self, store):
        p = store.upsert_preset("", "n", "http://gw:4000", "a", model_overrides={"a": 5})
        store.remember_discovered(p["id"], {"b": {"discovered": 9, "maxOutput": 0}})
        saved = store.upsert_preset(p["id"], "n", "http://other:4000", "a")
        assert [(r["id"], r["contextWindow"]) for r in saved["models"]] == [("a", 5)]

    def test_legacy_context_limit_sets_default_model_override(self, store):
        p = store.upsert_preset("", "n", "http://gw:4000", "a", context_limit=242000)
        assert p["contextLimit"] == 242000 and p["models"][0]["source"] == "override"

    def test_invalid_override_rejected(self, store):
        with pytest.raises(ValueError):
            store.upsert_preset("", "n", "http://gw:4000", "a", model_overrides={"a": -1})


def test_model_facts_reads_each_server_dialect():
    from viewer.routes.providers import _model_facts
    assert _model_facts({"id": "x", "max_input_tokens": 242000, "max_output_tokens": 64000}) == {"discovered": 242000, "maxOutput": 64000}
    assert _model_facts({"id": "x", "max_model_len": 131072}) == {"discovered": 131072, "maxOutput": 0}
    assert _model_facts({"id": "x", "meta": {"n_ctx": 242000, "n_ctx_train": 262144}}) == {"discovered": 242000, "maxOutput": 0}
    assert _model_facts({"id": "x", "max_input_tokens": None, "max_model_len": True}) == {"discovered": 0, "maxOutput": 0}
