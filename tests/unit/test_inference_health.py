"""viewer.inference_health: liveness verdicts for a custom model endpoint,
instead of blind timeouts (the 2026-10-07 Cloudflare 524 / dead-host incident)."""
import json

from viewer import inference_health as h

UP_BUSY = {"state": h.REACHABLE, "load": (1, 0)}
UP_IDLE = {"state": h.REACHABLE, "load": (0, 0)}
UP_BLIND = {"state": h.REACHABLE, "load": None}
DOWN = {"state": h.UNREACHABLE, "load": None}

METRICS = """# HELP vllm:num_requests_running ...
vllm:num_requests_running{engine="0",model_name="qwen3.8-27b"} 1.0
vllm:num_requests_waiting{engine="0",model_name="qwen3.8-27b"} 2.0
vllm:num_requests_waiting_by_reason{engine="0",model_name="qwen3.8-27b",reason="capacity"} 2.0
vllm:num_requests_running{engine="0",model_name="other"} 5.0
"""


def test_parse_load_reads_this_models_gauges_only():
    assert h.parse_load(METRICS, "qwen3.8-27b") == (1, 2)
    assert h.parse_load(METRICS, "") == (6, 2)  # no model: the whole server


def test_parse_load_none_when_not_vllm():
    assert h.parse_load("<html>llama-swap</html>", "x") is None
    assert h.parse_load("", "x") is None


def test_a_progressing_prefill_is_never_cut_off():
    w = h.Watch("https://inference.example")
    for waited in range(0, 3600, h.POLL_INTERVAL):  # an hour of prefill
        assert w.observe(UP_BUSY, waited) is None


def test_no_metrics_means_reachability_is_enough():
    w = h.Watch("https://inference.example")
    assert all(w.observe(UP_BLIND, t) is None for t in range(0, 3600, 20))


def test_unreachable_is_called_after_strikes_not_one_blip():
    w = h.Watch("https://inference.example/v1")
    for _ in range(h.STRIKES - 1):
        assert w.observe(DOWN, 10) is None
    assert w.observe(UP_BUSY, 10) is None  # came back: strikes reset
    for _ in range(h.STRIKES - 1):
        assert w.observe(DOWN, 10) is None
    verdict = w.observe(DOWN, 10)
    assert verdict and "inference.example" in verdict and "can't be reached" in verdict


def test_idle_counts_only_after_grace():
    w = h.Watch("http://x")
    for _ in range(h.STRIKES * 2):
        assert w.observe(UP_IDLE, h.GRACE - 1) is None  # request may not be sent yet
    for _ in range(h.STRIKES - 1):
        assert w.observe(UP_IDLE, h.GRACE) is None
    assert "stopped working" in w.observe(UP_IDLE, h.GRACE)


def test_origin_down_counts_as_a_strike():
    w = h.Watch("http://x")
    out = [w.observe({"state": h.ORIGIN_DOWN, "load": None}, 0) for _ in range(h.STRIKES)]
    assert out[-1] and not any(out[:-1])


def _asst(*blocks, parent=None):
    return {"type": "assistant", "parent_tool_use_id": parent, "message": {"content": list(blocks)}}


def _results(*ids, parent=None):
    return {"type": "user", "parent_tool_use_id": parent,
            "message": {"content": [{"type": "tool_result", "tool_use_id": i} for i in ids]}}


def test_model_wait_tracks_who_holds_the_turn():
    m = h.ModelWait()
    m.update({"type": "system", "subtype": "init"}, 1)
    assert m.since == 1                                   # first request goes out
    m.update(_asst({"type": "text", "text": "hi"}), 2)
    assert m.since == 2                                   # model replying: grace restarts
    m.update(_asst({"type": "tool_use", "id": "a"}), 3)
    m.update(_asst({"type": "tool_use", "id": "b"}), 3)
    assert m.since is None                                # tools run: server may idle
    m.update(_results("a"), 4)
    assert m.since is None                                # b still running (parallel calls)
    m.update({"type": "stream_event"}, 5)
    assert m.since is None                                # unrelated events change nothing
    m.update(_results("b"), 6)
    assert m.since == 6                                   # all results in: next request
    m.update({"type": "result"}, 7)
    assert m.since is None and not m.open
    m.turn_sent(8)
    assert m.since == 8                                   # a queued message is the next turn


def test_a_subagents_model_calls_are_watched():
    m = h.ModelWait()
    m.update(_asst({"type": "tool_use", "id": "task"}), 1)
    assert m.since is None
    m.update(_asst({"type": "tool_use", "id": "s1"}, parent="task"), 2)
    assert m.since is None                                # the subagent's tool runs
    m.update(_results("s1", parent="task"), 3)
    assert m.since == 3                                   # subagent waits on the model
    m.update(_results("task"), 4)
    assert m.since == 4


def test_anthropic_env_caps_cli_retries():
    from viewer import providers
    env = providers.anthropic_env(None, preset={"baseUrl": "https://x", "model": "m"})
    assert env["CLAUDE_CODE_MAX_RETRIES"] == h.MAX_RETRIES


def test_diagnose_names_the_524_and_the_zone():
    # The shape the CLI prints (verified 2026-10-07): the Cloudflare JSON escaped
    # inside the stream-json line.
    err = {"title": "Error 524: A timeout occurred", "status": 524,
           "error_name": "origin_response_timeout", "zone": "inference.braintwin.ai"}
    line = json.dumps({"type": "result", "is_error": True,
                       "result": "API Error: 524 " + json.dumps(err)})
    msg = h.diagnose(line)
    assert "inference.braintwin.ai" in msg and "Cloudflare" in msg and "Retrying" in msg
    assert h.diagnose('{"type":"result","result":"done"}') is None
    assert h.diagnose("") is None


def test_probe_classifies_by_http_answer(monkeypatch):
    answers = {"/upstream/m/metrics": (200, METRICS.replace("qwen3.8-27b", "m"))}
    asked = []

    def get(url):
        path = url.split("example")[1]
        asked.append(path)
        return answers.get(path, (404, ""))
    monkeypatch.setattr(h, "_get", get)
    # Any HTTP answer at the root is alive, even a 404 (vLLM has no root page).
    assert h.probe("https://example/", "m") == {"state": h.REACHABLE, "load": (1, 2)}
    # Never /health: a deep check there (LiteLLM, 8-30s) is not a dead host.
    assert "/health" not in asked
    answers["/"] = (0, "")
    assert h.probe("https://example", "m")["state"] == h.UNREACHABLE
    answers["/"] = (530, "")
    assert h.probe("https://example", "m")["state"] == h.ORIGIN_DOWN
    answers["/"] = (503, "")  # warming up, not gone
    assert h.probe("https://example", "m")["state"] == h.REACHABLE
