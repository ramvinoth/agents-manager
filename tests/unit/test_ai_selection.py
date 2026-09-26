"""Hermetic regression tests: no DB connections, processes or endpoint traffic."""
from types import SimpleNamespace
from unittest.mock import Mock

import ast
import inspect
from threading import RLock

import pytest

from viewer import providers
from viewer.routes.providers import ProvidersMixin


def test_override_model_does_not_reuse_preset_context(monkeypatch):
    monkeypatch.setattr(providers, "get_preset", lambda _: {
        "baseUrl": "https://example.invalid", "model": "preset-model", "contextLimit": 242000})
    env = providers.anthropic_env("p", model="other/full:model[1m]")
    assert env["ANTHROPIC_MODEL"] == "other/full:model[1m]"
    assert "CLAUDE_CODE_MAX_CONTEXT_TOKENS" not in env


def test_builtin_discovery_is_explicitly_unsupported():
    handler = ProvidersMixin()
    handler.send_json = Mock()
    handler._g_providers_models(SimpleNamespace(query={}, principal={"kind": "human", "user": {"id": 1}}))
    result = handler.send_json.call_args.args[0]
    assert result["status"] == "unsupported"
    assert result["manualModelId"] is True


def test_draft_endpoint_change_cannot_reuse_saved_secret(monkeypatch):
    monkeypatch.setattr(providers, "get_preset", lambda _: {
        "baseUrl": "https://old.invalid", "apiKey": "secret"})
    handler = ProvidersMixin()
    handler.read_body = lambda: {"id": "p", "baseUrl": "https://new.invalid", "apiKeyAction": "keep"}
    handler.send_json = Mock()
    handler._p_providers_models(SimpleNamespace(principal={"kind": "human", "user": {"id": 1}}))
    assert handler.send_json.call_args.kwargs["status"] == 400


def test_queue_closing_race_preserves_launch_provider_and_effort():
    # Execute the actual cleanup continuation branch in isolation, with no process
    # startup. This is the branch reached when queue arrives as stdin closes.
    from viewer import engine
    tree = ast.parse(inspect.getsource(engine.start_claude_run))
    branch = next(n for n in ast.walk(tree) if isinstance(n, ast.If)
                  and isinstance(n.test, ast.BoolOp)
                  and ast.unparse(n.test).startswith("leftovers and"))
    launch = Mock(return_value=True)
    env = {"ANTHROPIC_MODEL": "custom"}
    scope = {"leftovers": ["next"], "job": {"returncode": 0, "mode": "default", "cwd": "/tmp",
             "model": "", "host": "local", "provider_env": env, "effort": "high"},
             "session_id": "sid", "start_claude_run": launch, "CHAT_LOCK": RLock(),
             "CHAT_JOBS": {"sid": {"queue": []}}}
    exec(compile(ast.Module(body=[branch], type_ignores=[]), "queue-continuation", "exec"), scope)
    assert launch.call_args.kwargs.get("provider_env") == env
    assert launch.call_args.kwargs.get("effort") == "high"


def choice(provider="", model=None, effort=""):
    return {"provider": provider, "model": model, "convMode": "agent", "effort": effort}


@pytest.mark.parametrize("selected,expected", [(None, "legacy"), ({"kind": "default"}, ""),
    ({"kind": "id", "id": "full/model:v1[1m]"}, "full/model:v1[1m]")])
def test_builtin_model_semantics(selected, expected):
    from viewer import ai
    assert ai.resolve(ai.meta_fields(choice(model=selected)), "legacy")["model"] == expected


def test_provider_switch_loop_does_not_leak_session_model(monkeypatch):
    from viewer import ai
    monkeypatch.setattr(providers, "get_preset", lambda pid: {"baseUrl": "https://example.invalid", "model": pid+"-default"})
    meta = ai.meta_fields(choice("a", {"kind": "id", "id": "a-override"}))
    assert ai.resolve(meta)["model"] == "a-override"
    assert ai.resolve(meta, provider_override="b")["model"] == "b-default"
    assert ai.resolve(meta, provider_override="b", model_override="b-explicit")["model"] == "b-explicit"


def test_missing_provider_and_remote_rejected(monkeypatch):
    from viewer import ai
    monkeypatch.setattr(providers, "get_preset", lambda _: None)
    with pytest.raises(ValueError, match="unavailable"):
        ai.resolve({"provider": "missing"})
    with pytest.raises(ValueError, match="local"):
        ai.resolve({"provider": "p"}, host="remote")
    with pytest.raises(ValueError, match="harness"):
        ai.validate(choice(), agent="codex")


def test_custom_caps_and_validation(monkeypatch):
    from viewer import ai
    monkeypatch.setattr(providers, "get_preset", lambda _: {"baseUrl": "https://example.invalid"})
    assert ai.capabilities(provider="p")["efforts"] == [""]
    with pytest.raises(ValueError, match="Effort"):
        ai.validate(choice("p", effort="high"))


@pytest.mark.parametrize("method", ["_p_ai_defaults", "_p_session_ai", "_p_providers", "_p_providers_models", "_p_providers_delete"])
def test_agent_cannot_administer_ai_or_secrets(method):
    handler = ProvidersMixin()
    handler.send_json = Mock()
    handler.read_body = Mock(side_effect=AssertionError("Must reject before reading body"))
    getattr(handler, method)(SimpleNamespace(principal={"kind": "mcp", "user": None, "session": "s"}))
    assert handler.send_json.call_args.kwargs["status"] == 403


def test_draft_keep_remove_replace_and_edited_url(monkeypatch):
    from viewer.routes.providers import _draft_connection
    monkeypatch.setattr(providers, "get_preset", lambda _: {"baseUrl": "https://old.invalid", "apiKey": "saved"})
    assert _draft_connection({"id": "p", "baseUrl": "https://old.invalid/", "apiKey": ""})[1] == "saved"
    assert _draft_connection({"id": "p", "baseUrl": "https://new.invalid", "apiKeyAction": "remove"}) == ("https://new.invalid", "")
    assert _draft_connection({"id": "p", "baseUrl": "https://new.invalid", "apiKeyAction": "replace", "apiKey": "fresh"}) == ("https://new.invalid", "fresh")


def test_discovery_redirects_never_forward_secret():
    from viewer.routes.providers import _NoRedirect
    assert _NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://else.invalid") is None


def test_discovery_normalizes_deduplicates_and_legacy_get(monkeypatch):
    import io
    import urllib.request
    monkeypatch.setattr(providers, "get_preset", lambda _: {"baseUrl": "https://saved.invalid", "apiKey": "saved"})
    opener = Mock()
    opener.open.return_value = io.BytesIO(b'{"data":[{"id":"z"},{"id":"a"},{"id":"z"}]}')
    monkeypatch.setattr(urllib.request, "build_opener", lambda *args: opener)
    handler = ProvidersMixin(); handler.send_json = Mock()
    handler._g_providers_models(SimpleNamespace(query={"id": ["p"]}, principal={"user": {"id": 1}}))
    result = handler.send_json.call_args.args[0]
    assert result["models"] == ["a", "z"]
    assert result["status"] == "ok"
    assert opener.open.call_args.args[0].get_header("Authorization") == "Bearer saved"


def test_first_launch_snapshots_ai_and_ignores_stale_client_model(monkeypatch, tmp_path):
    import io, json
    from viewer import db
    from viewer.routes import sessions
    saved = {}
    monkeypatch.setattr(db, "session_meta_set", lambda sid, data: saved.update({sid: data}))
    launch = Mock(side_effect=lambda sid, *a, **kw: bool(saved[sid]))
    monkeypatch.setattr(sessions, "start_claude_run", launch)
    payload = {"message": "hello", "cwd": str(tmp_path), "model": "stale", "ai": choice(model={"kind": "id", "id": "exact/full:v1"})}
    raw = json.dumps(payload).encode()
    handler = sessions.SessionsMixin(); handler.headers = {"Content-Length": str(len(raw))}
    handler.rfile = io.BytesIO(raw); handler.send_json = Mock()
    handler.handle_new_session()
    assert launch.call_args.args[5] == "exact/full:v1"
    assert next(iter(saved.values()))["modelSelection"] == payload["ai"]["model"]


def test_canonical_defaults_override_legacy_default_flag(monkeypatch):
    from viewer import db
    monkeypatch.setattr(db, "setting_get", lambda *a: {"revision": 2, "selection": choice("b")})
    monkeypatch.setattr(db, "providers_load", lambda: {"a": {"isDefault": True}, "b": {}})
    assert providers.get_default_id() == "b"
    assert [p["id"] for p in providers.list_presets() if p["isDefault"]] == ["b"]


def test_session_write_is_ai_only_and_conflict_is_409(monkeypatch):
    from viewer import db
    monkeypatch.setattr(db, "session_meta_get", lambda _: {"goal": "keep"})
    write = Mock(return_value=None); monkeypatch.setattr(db, "session_ai_cas", write)
    handler = ProvidersMixin(); handler.send_json = Mock()
    handler.read_body = lambda: {"id": "sid", "revision": 3, "selection": choice(), "goal": "must not overwrite"}
    handler._p_session_ai(SimpleNamespace(principal={"user": {"id": 1}}))
    assert set(write.call_args.args[2]) == {"provider", "modelSelection", "convMode", "effort"}
    assert handler.send_json.call_args.kwargs["status"] == 409


@pytest.mark.parametrize("defaults", [True, False])
def test_cas_locks_before_compare_and_merge(monkeypatch, defaults):
    from contextlib import contextmanager
    from viewer import db
    cur = Mock()
    cur.fetchone.side_effect = ([{"value": {"revision": 4}}] if defaults else
                              [{"data": {"aiRevision": 4, "goal": "keep"}}, {"data": {"aiRevision": 5, "goal": "keep"}}])
    @contextmanager
    def fake_db():
        yield cur
    monkeypatch.setattr(db, "_db", fake_db)
    result = db.ai_defaults_cas(4, choice()) if defaults else db.session_ai_cas("s", 4, {"provider": ""})
    sql = [c.args[0] for c in cur.execute.call_args_list]
    assert "FOR UPDATE" in sql[1]
    assert sql[2].startswith("UPDATE")
    assert result["revision" if defaults else "aiRevision"] == 5
    if not defaults:
        assert "data = data ||" in sql[2]
        assert result["goal"] == "keep"


@pytest.mark.parametrize("defaults", [True, False])
def test_stale_cas_does_not_update(monkeypatch, defaults):
    from contextlib import contextmanager
    from viewer import db
    cur = Mock()
    cur.fetchone.return_value = {"value": {"revision": 5}, "data": {"aiRevision": 5}}
    @contextmanager
    def fake_db():
        yield cur
    monkeypatch.setattr(db, "_db", fake_db)
    result = db.ai_defaults_cas(4, choice()) if defaults else db.session_ai_cas("s", 4, {})
    assert result is None
    assert not any(c.args[0].startswith("UPDATE") for c in cur.execute.call_args_list)


def test_defaults_write_never_touches_sessions(monkeypatch):
    from viewer import db
    monkeypatch.setattr(db, "ai_defaults_cas", lambda rev, sel: {"revision": rev + 1, "selection": sel})
    monkeypatch.setattr(db, "session_meta_patch", Mock(side_effect=AssertionError("Session mutation forbidden")))
    monkeypatch.setattr(db, "session_ai_cas", Mock(side_effect=AssertionError("Session mutation forbidden")))
    handler = ProvidersMixin(); handler.send_json = Mock()
    handler.read_body = lambda: {"revision": 0, "selection": choice(model={"kind": "default"})}
    handler._p_ai_defaults(SimpleNamespace(principal={"user": {"id": 1}}))
    doc = handler.send_json.call_args.args[0]
    assert doc["configured"] is True and doc["revision"] == 1


@pytest.mark.parametrize("configured", [False, True])
def test_legacy_create_snapshots_only_configured_defaults(monkeypatch, tmp_path, configured):
    import io, json
    from viewer import db
    from viewer.routes import sessions
    selection = choice(model={"kind": "id", "id": "server/model"})
    monkeypatch.setattr(db, "setting_get", lambda *a: {"revision": 1, "selection": selection} if configured else None)
    saved = Mock(); monkeypatch.setattr(db, "session_meta_set", saved)
    launch = Mock(return_value=True); monkeypatch.setattr(sessions, "start_claude_run", launch)
    raw = json.dumps({"message": "hello", "cwd": str(tmp_path), "model": "legacy"}).encode()
    handler = sessions.SessionsMixin(); handler.headers = {"Content-Length": str(len(raw))}
    handler.rfile = io.BytesIO(raw); handler.send_json = Mock()
    handler.handle_new_session()
    assert launch.call_args.args[5] == ("server/model" if configured else "legacy")
    assert ("modelSelection" in saved.call_args.args[1]) == configured


def test_custom_first_launch_receives_exact_model_and_saved_config(monkeypatch, tmp_path):
    import io, json
    from viewer import db, customrun
    from viewer.routes import sessions
    preset = {"baseUrl": "https://example.invalid", "model": "preset-model"}
    monkeypatch.setattr(providers, "get_preset", lambda _: preset)
    saved = {}
    monkeypatch.setattr(db, "session_meta_set", lambda sid, meta: saved.update({sid: meta}))
    launch = Mock(side_effect=lambda sid, *a, **kw: bool(saved[sid]))
    monkeypatch.setattr(customrun, "start_custom_run", launch)
    selection = {**choice("p", {"kind": "id", "id": "other-model"}), "convMode": "chat"}
    raw = json.dumps({"message": "hello", "cwd": str(tmp_path), "ai": selection}).encode()
    handler = sessions.SessionsMixin(); handler.headers = {"Content-Length": str(len(raw))}
    handler.rfile = io.BytesIO(raw); handler.send_json = Mock()
    handler.handle_new_session()
    assert launch.call_args.kwargs["model"] == "other-model"
    assert preset["model"] == "preset-model"


def test_legacy_get_draft_discovery_shape(monkeypatch):
    handler = ProvidersMixin(); handler.send_json = Mock(); handler._discover_models = Mock()
    handler._g_providers_models(SimpleNamespace(query={"baseUrl": ["https://draft.invalid"], "key": ["draft-key"]}, principal={"user": {"id": 1}}))
    handler._discover_models.assert_called_once_with("https://draft.invalid", "draft-key")


def test_legacy_web_provider_save_preserves_key_and_context(monkeypatch):
    monkeypatch.setattr(providers, "get_preset", lambda _: {"baseUrl": "https://old.invalid", "apiKey": "keep"})
    save = Mock(return_value={"id": "p"}); monkeypatch.setattr(providers, "upsert_preset", save)
    handler = ProvidersMixin(); handler.send_json = Mock()
    handler.read_body = lambda: {"id": "p", "name": "old", "baseUrl": "https://old.invalid", "model": "m"}
    handler._p_providers(SimpleNamespace(principal={"user": {"id": 1}}))
    assert save.call_args.args[4:] == ("keep", None, None)


def test_full_model_id_reaches_cli_command():
    from viewer import engine
    tree = ast.parse(inspect.getsource(engine.start_claude_run))
    branch = next(n for n in ast.walk(tree) if isinstance(n, ast.If) and any(
        isinstance(c, ast.Constant) and c.value == "--model" for c in ast.walk(n))
        and "model !=" in ast.unparse(n.test))
    import re
    scope = {"model": "full/model:v1[1m]", "cmd": [], "re": re}
    exec(compile(ast.Module(body=[branch], type_ignores=[]), "model-command", "exec"), scope)
    assert scope["cmd"] == ["--model", "full/model:v1[1m]"]


@pytest.mark.parametrize("override,expected", [("", "session-model"), ("other", "other-default")])
def test_real_loop_launch_uses_provider_associated_model(monkeypatch, tmp_path, override, expected):
    from viewer import ai, db, engine
    root = tmp_path / "projects"; root.mkdir()
    transcript = root / "s.jsonl"; transcript.write_text('{}\n')
    monkeypatch.setattr(engine, "CLAUDE_DIR", root)
    monkeypatch.setattr(engine, "extract_cwd", lambda _: str(tmp_path))
    monkeypatch.setattr(db, "session_meta_get", lambda _: ai.meta_fields(choice("p", {"kind": "id", "id": "session-model"})))
    monkeypatch.setattr(providers, "get_preset", lambda pid: {"baseUrl": "https://example.invalid", "model": pid + "-default", "contextLimit": 242000})
    launch = Mock(return_value=True); monkeypatch.setattr(engine, "start_claude_run", launch)
    assert engine.run_loop_iteration("s", "projects/s.jsonl", "hello", provider=override)
    env = launch.call_args.kwargs["provider_env"]
    assert env["ANTHROPIC_MODEL"] == expected
    assert ("CLAUDE_CODE_MAX_CONTEXT_TOKENS" in env) == bool(override)


def test_legacy_default_write_updates_locked_canonical_record(monkeypatch):
    from contextlib import contextmanager
    from viewer import db
    cur = Mock(); cur.fetchone.return_value = {"value": {"revision": 7, "selection": choice("old")}}
    @contextmanager
    def fake_db():
        yield cur
    monkeypatch.setattr(db, "_db", fake_db)
    db.provider_upsert("new", {"model": "m", "isDefault": True}, default_change=True)
    calls = cur.execute.call_args_list
    assert "FOR UPDATE" in calls[1].args[0]
    updated = calls[2].args[1][0].adapted
    assert updated["revision"] == 8
    assert updated["selection"]["provider"] == "new"
    assert updated["selection"]["model"] == {"kind": "default"}


def test_connection_save_without_default_flag_never_changes_defaults(monkeypatch):
    from contextlib import contextmanager
    from viewer import db
    cur = Mock()
    @contextmanager
    def fake_db():
        yield cur
    monkeypatch.setattr(db, "_db", fake_db)
    db.provider_upsert("p", {"model": "m"})
    assert not any("settings" in c.args[0] for c in cur.execute.call_args_list)


def test_discovery_error_never_echoes_credentials(monkeypatch):
    import urllib.request
    opener = Mock(); opener.open.side_effect = ValueError("SECRET http://user:password@bad")
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: opener)
    handler = ProvidersMixin(); handler.send_json = Mock()
    handler._discover_models("https://example.invalid", "SECRET")
    result = handler.send_json.call_args.args[0]
    assert result["status"] == "error"
    assert "SECRET" not in str(result) and "password" not in str(result)


def test_capability_read_uses_draft_provider_and_preserves_saved_selection(monkeypatch):
    from viewer import db
    monkeypatch.setattr(db, "session_meta_get", lambda _: {})
    handler = ProvidersMixin(); handler.send_json = Mock()
    handler._g_session_ai(SimpleNamespace(query={"id": ["sid"], "provider": ["draft-provider"]}))
    result = handler.send_json.call_args.args[0]
    assert result["selection"]["provider"] == ""
    assert result["capabilities"]["efforts"] == [""]
