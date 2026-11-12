"""Oracle: the REAL orchestrator.maintenance replayed against its TLA+ spec.

formal/Maintenance.tla models the hourly restart window. TLC enumerates every
reachable state of the model; this test takes random walks through that graph
and, for each edge, makes the real module take the same step (its threads are
parked at the call that starts each step), then checks the real state matches
the spec's. A mismatch means the spec no longer describes the code, so the
invariants TLC proved say nothing about it.

The variant is picked from the code: the module with start_boot_finish is
checked against Fixed=TRUE, older code against Fixed=FALSE (run this file in a
worktree of the old commit to see that). Needs java + tla2tools.jar
(TLA2TOOLS, default ~/.local/share/tla/tla2tools.jar); skipped without them.
ORACLE_WALKS sets the number of walks (default 200).
"""
import datetime
import json
import os
import pathlib
import random
import re
import shutil
import subprocess
import threading
import types

import pytest

from orchestrator import db, inbox, maintenance

ROOT = pathlib.Path(__file__).resolve().parents[2]
JAR = pathlib.Path(os.environ.get("TLA2TOOLS", "~/.local/share/tla/tla2tools.jar")).expanduser()
FIXED = hasattr(maintenance, "start_boot_finish")
N = 2


# ---- the TLC state graph ------------------------------------------------------
def _value(s, i=0):
    """Parse one TLC value at s[i:]: int, string, TRUE/FALSE, <<..>>, {..}, [k |-> v]."""
    def ws(i):
        while s[i] == " ":
            i += 1
        return i
    i = ws(i)
    if s.startswith("<<", i) or s[i] == "{":
        close, i = (">>", i + 2) if s[i] == "<" else ("}", i + 1)
        out = []
        while not s.startswith(close, ws(i)):
            v, i = _value(s, i)
            out.append(v)
            i = ws(i)
            if s[i] == ",":
                i += 1
        return (out if close == ">>" else frozenset(out)), ws(i) + len(close)
    if s[i] == "[":
        out, i = {}, i + 1
        while s[ws(i)] != "]":
            m = re.compile(r"\s*(\w+) \|-> ").match(s, i)
            v, i = _value(s, m.end())
            out[m.group(1)] = v
            i = ws(i)
            if s[i] == ",":
                i += 1
        return out, ws(i) + 1
    if s[i] == '"':
        j = s.index('"', i + 1)
        return s[i + 1:j], j + 1
    m = re.compile(r"TRUE|FALSE|-?\d+").match(s, i)
    t = m.group()
    return (t == "TRUE" if t in ("TRUE", "FALSE") else int(t)), m.end()


@pytest.fixture(scope="module")
def graph(tmp_path_factory):
    java = shutil.which("java")
    if not java or not JAR.exists():
        pytest.skip("TLC not installed (java + tla2tools.jar)")
    d = tmp_path_factory.mktemp("tlc")
    for f in ("Maintenance.tla",):
        shutil.copy(ROOT / "formal" / f, d / f)
    # TypeOK only: the full graph, even for the variant whose invariants fail.
    (d / "Oracle.cfg").write_text(
        f"CONSTANTS N = {N}  MaxEdits = 2  MaxHour = 1  MaxEpoch = 2  Fixed = {'TRUE' if FIXED else 'FALSE'}\n"
        "INIT Init\nNEXT Next\nINVARIANT TypeOK\nCHECK_DEADLOCK FALSE\n")
    r = subprocess.run([java, "-XX:+UseParallelGC", "-cp", str(JAR), "tlc2.TLC", "-workers", "1",
                        "-config", "Oracle.cfg", "-metadir", str(d / "meta"), "-dump", "dot,actionlabels",
                        str(d / "g.dot"), "Maintenance.tla"], cwd=d, capture_output=True, text=True, timeout=600)
    assert "No error has been found" in r.stdout, r.stdout[-2000:]
    nodes, edges, init = {}, {}, None
    for line in (d / "g.dot").read_text().splitlines():
        if m := re.match(r'(-?\d+) \[label="(.*)"(,style = filled)?\];?$', line):
            body = m.group(2).replace('\\"', '"').replace("\\\\", "\\")
            nodes[m.group(1)] = {k: _value(v)[0] for k, v in
                                 (c.split(" = ", 1) for c in body[3:].split("\\n/\\ "))}
            init = m.group(1) if m.group(3) else init
        elif m := re.match(r'(-?\d+) -> (-?\d+) \[label="(\w+)"', line):
            edges.setdefault(m.group(1), []).append((m.group(3), m.group(2)))
    return nodes, edges, init


# ---- the real module, steppable ------------------------------------------------
class Died(BaseException):
    """The process died (crash or exit): unwinds a parked thread without running more code."""


class Thread:
    """A real thread of the module, parked at the call that starts each step."""

    def __init__(self):
        self.at, self.go, self.value = None, threading.Event(), None
        self.parked, self.done, self.thread = threading.Event(), False, None

    def park(self, name):
        self.at, self.value = name, None
        self.go.clear()
        self.parked.set()
        self.go.wait()
        if self.value is Died:
            raise Died()
        return self.value

    def release(self, value=True):
        self.parked.clear()
        self.value = value
        self.go.set()
        self.settle()

    def start(self):
        self.thread.start()
        self.settle()

    def settle(self):
        """Wait until the thread parks again or ends."""
        while not self.parked.wait(0.01):
            if self.done:
                return
        assert self.parked.is_set() or self.done


class World:
    def __init__(self, monkeypatch):
        self.settings, self.rows, self.audit = {}, {}, []
        self.disk, self.hour, self.epoch, self.up = 0, 0, 0, True
        self.window = self.boot = None     # Thread
        self.ids = frozenset()
        mp = monkeypatch
        role = lambda: {"maintenance": "window", "maintenance-boot": "boot"}.get(threading.current_thread().name)
        self.role = role

        def setting_get(k, d=None):
            if k == maintenance._PENDING_KEY and role() == "boot":
                self.boot.park("fin_read")
            v = self.settings.get(k)
            return d if v is None else json.loads(v)

        def setting_set(k, v):
            if k == maintenance._PENDING_KEY and v is not None and role() == "window":
                self.window.park("pending")
            self.settings[k] = json.dumps(v)

        def by_status(s):
            if role() == "window":
                self.window.n_reads += 1
                if self.window.n_reads == 1:
                    self.window.park("snap")
            out = [dict(r) for r in self.rows.values() if r["status"] == s]
            if role() == "window" and self.window.n_reads == 2:
                self.ids = frozenset(r["id"] for r in out)
            return out

        def set_status(ids, s):
            if s == "restarting":
                self.window.park("mark")
            for i in ids:
                self.rows[i]["status"] = s

        def fingerprint():
            self.window.n_prints += 1
            self.window.park("check" if self.window.n_prints % 2 else "verify")
            return f"v{self.disk}"

        def check():
            return (self.window.park("check") if not FIXED else self.window.verdict), "x"

        def leave():
            self.window.park("exit")

        real_run = maintenance.run_window
        mp.setattr(db, "setting_get", setting_get)
        mp.setattr(db, "setting_set", setting_set)
        mp.setattr(db, "restart_requests_by_status", by_status)
        mp.setattr(db, "restart_requests_set_status", set_status)
        mp.setattr(db, "audit_append", lambda *a: self.audit.append(a))
        mp.setattr(inbox, "deliver_message", lambda *a, **k: None)
        mp.setattr(inbox, "_push_owner", lambda *a: None)
        mp.setattr(maintenance, "supervised", lambda: True)
        mp.setattr(maintenance, "busy", lambda: 0)
        mp.setattr(maintenance, "_git_head", lambda: "head")
        mp.setattr(maintenance, "_running", threading.Lock())
        mp.setattr(maintenance, "BOOT_TIME", 0)
        if FIXED:
            mp.setattr(maintenance, "code_fingerprint", fingerprint)
            mp.setattr(maintenance, "BOOT_CODE", "v0")
        mp.setattr(maintenance, "run_window",
                   lambda **kw: real_run(**kw, check=check, leave=leave))
        mp.setattr(maintenance, "threading", types.SimpleNamespace(Thread=self._thread, Lock=threading.Lock))
        self.mp = mp

    # Threads the module starts are wrapped so the oracle can park and kill them.
    def _thread(self, target, kwargs=None, daemon=None, name=None, args=()):
        t = Thread()
        t.n_reads = t.n_prints = 0
        t.verdict = True
        if name == "maintenance":
            self.window = t
        else:
            self.boot = t

        def run():
            try:
                target(*args, **(kwargs or {}))
            except Died:
                pass
            finally:
                t.done = True
        t.thread = threading.Thread(target=run, daemon=True, name=name)
        return t

    # ---- spec actions ---------------------------------------------------------
    def kill(self):
        for t in (self.window, self.boot):
            if t and not t.done:
                t.release(Died)
                t.thread.join(5)
        self.window = self.boot = None
        self.up = False

    def do(self, label, before, after):
        if label == "Edit":
            self.disk += 1
        elif label == "NewHour":
            self.hour += 1
        elif label == "File":
            r = next(i for i in range(1, N + 1) if before["status"][i - 1] != after["status"][i - 1])
            self.rows[r] = {"id": r, "status": "queued", "created_at": self.epoch * 10 + 5,
                            "requested_by": "a", "session_id": f"s{r}", "reason": "x", "commit_sha": ""}
        elif label == "Tick":
            ts = datetime.datetime(2026, 10, 6, 10 + self.hour, 50).timestamp()
            maintenance.tick(ts)
        elif label in ("Crash", "Exit"):
            if label == "Exit":
                self.window.release()
            self.kill()
        elif label == "Boot":
            self.epoch += 1
            self.up = True
            self.mp.setattr(maintenance, "_running", threading.Lock())
            self.mp.setattr(maintenance, "BOOT_TIME", self.epoch * 10)
            kw = {"sleep": lambda s: self.boot.park("fin_write"), "health": lambda: {"ok": True}}
            if FIXED:
                self.mp.setattr(maintenance, "BOOT_CODE", f"v{self.disk}")
                maintenance.start_boot_finish(**kw)
            else:
                maintenance.threading.Thread(target=maintenance.finish_after_boot, kwargs=kw,
                                             daemon=True, name="maintenance-boot").start()
        elif label in ("FinishRead", "FinishWrite"):
            self.boot.release()
        elif label == "CheckFail":
            self._check(False)
        elif label == "CheckPass":
            self._check(True)
        else:                                   # Snap, Verify, WritePending, Mark
            self.window.release()

    def _check(self, ok):
        self.window.verdict = ok
        self.window.release(ok)

    # ---- the real state, in the spec's terms -------------------------------------
    def state(self):
        pend = json.loads(self.settings.get(maintenance._PENDING_KEY) or "null")
        last = json.loads(self.settings.get(maintenance._LAST_KEY) or "null")
        w = self.window if self.window and not self.window.done else None
        b = self.boot if self.boot and not self.boot.done else None
        s = {"status": [self.rows.get(r, {}).get("status", "unfiled") for r in range(1, N + 1)],
             "up": self.up, "disk": self.disk, "hour": self.hour, "epoch": self.epoch,
             "pc": w.at if w else "idle", "booting": bool(b),
             "fin": b.at if b else None,
             "lastKey": -1 if last is None else int(last.split()[1]) - 10,
             "pending.on": bool(pend),
             "pending.ids": frozenset(r["id"] for r in pend["requests"]) if pend else frozenset()}
        if s["pc"] not in ("idle", "snap"):
            s["ids"] = self.ids
        ends = [a for a in self.audit if a[3] in ("restarted", "unhealthy", "unpreflighted")]
        if ends:
            rec, out = ends[-1][2], ends[-1][3]
            s["audit"] = "outside" if rec["trigger"] == "restart outside the window" else out
            if FIXED and s["audit"] != "outside":
                s["audit.loaded"] = int(rec["code_booted"][1:])
                s["audit.checked"] = int(rec["code_preflighted"][1:])
        else:
            s["audit"] = "none"
        if FIXED and pend:
            s["pending.checked"] = int(pend["code_preflighted"][1:])
        return s


def spec_state(v, shape):
    """The spec state projected onto what the real module exposes (`shape` = World.state keys)."""
    s = {"status": v["status"], "up": v["up"], "disk": v["disk"], "hour": v["hour"], "epoch": v["epoch"],
         "pc": v["pc"], "booting": v["booting"],
         "fin": None if not v["booting"] else "fin_read" if v["finKind"] == "none" else "fin_write",
         "lastKey": v["lastKey"], "pending.on": v["pending"]["on"], "pending.ids": v["pending"]["ids"],
         "audit": v["audit"]["outcome"]}
    if "ids" in shape:
        s["ids"] = v["ids"]
    if "audit.loaded" in shape:
        s["audit.loaded"], s["audit.checked"] = v["audit"]["loaded"], v["audit"]["checked"]
    if "pending.checked" in shape:
        s["pending.checked"] = v["pending"]["checked"]
    return s


WEIGHT = {"Crash": 0.15, "Edit": 0.3, "NewHour": 0.3, "File": 0.5}


def test_real_code_takes_every_step_the_spec_takes(graph, monkeypatch):
    nodes, edges, init = graph
    rng = random.Random(int(os.environ.get("ORACLE_SEED", "1")))
    covered = set()
    for walk in range(int(os.environ.get("ORACLE_WALKS", "200"))):
        with monkeypatch.context() as mp:
            world, at, trace = World(mp), init, []
            try:
                for _ in range(40):
                    if not edges.get(at):
                        break
                    out = edges[at]   # world events rarer, so walks reach the restart itself
                    label, nxt = rng.choices(out, [WEIGHT.get(l, 1) for l, _ in out])[0]
                    trace.append(label)
                    world.do(label, nodes[at], nodes[nxt])
                    real = world.state()
                    want = spec_state(nodes[nxt], real)
                    assert real == want, (f"walk {walk}: after {' -> '.join(trace)}\n"
                                          f"code: {real}\nspec: {want}")
                    covered.add(label)
                    at = nxt
            finally:
                world.kill()
    assert covered >= {"Tick", "Snap", "CheckPass", "CheckFail", "Mark", "WritePending", "Exit",
                       "Crash", "Boot", "FinishRead", "FinishWrite", "File", "Edit"} | (
        {"Verify"} if FIXED else set())
