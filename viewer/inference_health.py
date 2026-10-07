"""viewer.inference_health — is a custom model endpoint reachable, and is it
working on our request? Liveness instead of blind timeouts.

A driven claude talking to a custom Anthropic-compatible endpoint (our vLLM
behind llama-swap) used to be governed only by timeouts: the CLI's first-byte
window (300s), its 10 retries, and whatever proxy sits in front. A long-context
prefill legitimately takes minutes on a GPU, so a fixed window either cuts off
real work or waits ~17 minutes on a dead host (10 retries x a 75s TCP connect
timeout, seen 2026-10-07). The endpoint itself is the authority on whether it is
alive and busy, so we ask it:

- `probe(base_url, model)` — one cheap read: is the server reachable, and (when
  it exposes vLLM Prometheus metrics, directly or through llama-swap's
  /upstream/<model>/metrics) how many requests are running/waiting.
- `ModelWait` — from the CLI's stream events, whether it is waiting
  on the model right now (a running tool legitimately leaves the server idle).
- `Watch` — folds successive probes, taken while the CLI waits on the model,
  into a verdict: keep waiting while the server is reachable and has work in
  flight; give up only after several consecutive probes show it unreachable or
  idle (our request is no longer on it). No fixed ceiling on a progressing turn,
  and a dead host is called in ~a minute instead of after every CLI retry.
- `diagnose(text)` — turns a known deterministic failure the CLI prints into a
  self-contained sentence a human can act on, so the owner is not told "usually
  temporary — try again" about something retrying can never fix.

Pure except `probe` (network) — the classification is unit-tested."""
import re
import urllib.error
import urllib.request

PROBE_TIMEOUT = 5          # s — a health read, not an inference call
POLL_INTERVAL = 20         # s between probes while the CLI waits on the model
GRACE = 90                 # s of waiting before an idle server counts against us (the CLI
                           # may still be starting MCP servers / hooks before it sends)
STRIKES = 3                # consecutive bad probes before the turn is stopped

REACHABLE, UNREACHABLE, ORIGIN_DOWN = "reachable", "unreachable", "origin_down"
# Cloudflare's definitive "the origin behind me is gone" answers (web server
# down, connect timed out, unreachable, tunnel down). Plain 502/503/504 are left
# out: a server warming a model answers those and comes good a moment later.
_ORIGIN_DOWN = {521, 522, 523, 530}

# Retries the CLI may spend on one model call to a custom endpoint. Its default
# (10, with backoff) turned an unreachable host into ~17 minutes of silence; the
# Watch now judges liveness, so the CLI keeps only a couple for transient blips.
MAX_RETRIES = "2"

# Settings that hand the timeout decision to the Watch: the CLI's own ceilings at
# their maximum (CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS is clamped to 30 min by the
# CLI; API_TIMEOUT_MS caps that window). Only set where a Watch is armed.
WATCHED_ENV = {"CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS": "1800000", "API_TIMEOUT_MS": "1800000"}

_METRIC = re.compile(r'^vllm:num_requests_(running|waiting)\{([^}]*)\}\s+([0-9.eE+-]+)\s*$', re.M)


def parse_load(metrics_text, model=""):
    """(running, waiting) for `model` from vLLM Prometheus text, or None when
    the text carries no request gauges (not a vLLM endpoint)."""
    found, load = False, {"running": 0.0, "waiting": 0.0}
    for kind, labels, value in _METRIC.findall(metrics_text or ""):
        m = re.search(r'model_name="([^"]*)"', labels)
        if model and m and m.group(1) != model:
            continue
        found = True
        load[kind] += float(value)
    return (int(load["running"]), int(load["waiting"])) if found else None


def _get(url):
    """(status, body) for a GET; status 0 = no HTTP answer at all."""
    req = urllib.request.Request(url, headers={"user-agent": "harman-viewer/health"})
    try:
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as r:
            return r.status, r.read(1 << 20).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return 0, ""


def probe(base_url, model=""):
    """{"state": reachable|unreachable|origin_down, "load": (running, waiting)|None}."""
    base = (base_url or "").rstrip("/")
    status, _ = _get(base + "/health")
    if status == 0:
        return {"state": UNREACHABLE, "load": None}
    if status in _ORIGIN_DOWN:
        return {"state": ORIGIN_DOWN, "load": None}
    for path in ([f"/upstream/{model}/metrics"] if model else []) + ["/metrics"]:
        s, body = _get(base + path)
        load = parse_load(body, model) if s == 200 else None
        if load is not None:
            return {"state": REACHABLE, "load": load}
    return {"state": REACHABLE, "load": None}


class ModelWait:
    """From the CLI's stream events, since when it has been waiting on the model
    (`since`; None = not waiting). The server is legitimately idle while a tool
    runs, so the Watch judges only these stretches.

    The CLI sends the next request once every tool call it made has a result, so
    we track open tool_use ids. A tool that later events name as their
    parent_tool_use_id is a subagent (Task): its own model calls are what we
    wait on, so it does not count as a running tool."""

    def __init__(self):
        self.since = None
        self.open = set()
        self.containers = set()

    def update(self, ev, now):
        kind = ev.get("type")
        if ev.get("parent_tool_use_id"):
            self.containers.add(ev["parent_tool_use_id"])
        blocks = (ev.get("message") or {}).get("content")
        blocks = [b for b in blocks if isinstance(b, dict)] if isinstance(blocks, list) else []
        if kind == "result":
            self.since, self.open, self.containers = None, set(), set()
            return
        if kind == "system" and ev.get("subtype") == "init":
            pass  # the CLI is up and about to send the turn's first request
        elif kind == "assistant":
            self.open |= {b.get("id") for b in blocks if b.get("type") == "tool_use"}
        elif kind == "user":
            self.open -= {b.get("tool_use_id") for b in blocks if b.get("type") == "tool_result"}
        else:
            return
        # Any event from the model (or a finished tool) restarts the grace window.
        self.since = None if self.open - self.containers else now

    def turn_sent(self, now):
        """A queued message went to the CLI as the next turn."""
        self.since = now


def host_of(base_url):
    m = re.match(r"https?://([^/:]+)", base_url or "")
    return m.group(1) if m else (base_url or "the endpoint")


class Watch:
    """Liveness verdict for one waiting-on-the-model stretch of a turn.

    Feed it `observe(snapshot, waited)` each poll (`waited` = seconds since the
    CLI dispatched the request). It returns None to keep waiting, or a
    self-contained reason to stop the turn. A probe that is reachable and shows
    work in flight (ours or another client's, i.e. busy/queued) resets the
    strikes; so does one that can't see load (no metrics), since reachability is
    then all we know. Strikes come only from definite evidence: the server is
    gone, or it reports nothing running or waiting after the grace period —
    our request is no longer on it."""

    def __init__(self, base_url):
        self.host = host_of(base_url)
        self.strikes = 0
        self.last_bad = None

    def reset(self):
        self.strikes, self.last_bad = 0, None

    def observe(self, snapshot, waited):
        bad = None
        if snapshot["state"] in (UNREACHABLE, ORIGIN_DOWN):
            bad = snapshot["state"]
        elif snapshot["load"] == (0, 0) and waited >= GRACE:
            bad = "idle"
        if bad is None:
            self.reset()
            return None
        self.strikes += 1
        self.last_bad = bad
        if self.strikes < STRIKES:
            return None
        if bad == "idle":
            return (f"The model server {self.host} stopped working on this turn: it is up but "
                    f"has had no request running for about {STRIKES * POLL_INTERVAL}s while the "
                    "agent was waiting for its reply, so the turn was stopped instead of waiting "
                    "blindly. Send the message again; if it repeats, the server is dropping requests.")
        return (f"The model server {self.host} can't be reached from this machine (checked "
                f"{STRIKES} times over about {STRIKES * POLL_INTERVAL}s), so the turn was stopped "
                "instead of retrying blindly. Check that the server is on and that this machine's "
                "network (VPN/Tailscale) reaches it, then send the message again.")


def diagnose(text):
    """A self-contained explanation for a deterministic endpoint failure in a
    line of CLI output, or None. Today: a proxy cut the request off before the
    model's first byte (Cloudflare 524 origin_response_timeout) — the model was
    still reading the context; the same request will be cut off again."""
    if not text or "origin_response_timeout" not in text:
        return None
    m = re.search(r'\\?"zone\\?"\s*:\s*\\?"([^"\\]+)', text)
    host = m.group(1) if m else "the model server"
    return (f"The model was still reading this chat's context when the proxy in front of {host} "
            "(Cloudflare) cut the request off at its ~2-minute limit. Retrying sends the same "
            "long context and is cut off the same way. Fix: use a provider for this chat that "
            "doesn't go through Cloudflare, or continue in a new chat with a shorter context.")
