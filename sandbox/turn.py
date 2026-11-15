"""One Harman turn in an ephemeral sandbox, end to end.

The shape the SaaS harness needs, in its smallest working form:

  object store  ->  lease a fresh Linux box  ->  restore workspace + transcript
                ->  run one unmodified `claude -p` turn under a time budget
                ->  save workspace + transcript back  ->  destroy the box

Nothing lives in the box between turns. The workspace (/work) and the Claude
project dir (~/.claude/projects/-work, the transcript plus its sidecars) are two
tar objects in the store, so any later lease, on any host, resumes the session.
The cwd is always /work, which pins the project dir name to "-work" and removes
the cwd mismatch that breaks `--resume` on a real machine.

The lease verbs (put, exec, get, close) are the ones every hosted sandbox SDK
offers (files write, commands run, files read, kill), so the Docker lease here is
the local stand in for a cloud one, not a second design.

A turn that runs out of budget is not lost: the transcript is written message by
message, so it is saved as the checkpoint and the next lease resumes it.
"""
import argparse
import io
import json
import os
import selectors
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from pathlib import Path

IMAGE = "harman-sandbox:dev"
HOME = "/home/node"
WORKDIR = "/work"
PROJECT_DIR = HOME + "/.claude/projects/-work"   # cwd /work, '/' -> '-'
# Credentials and endpoint the turn may see. Values travel as exec env, never on
# argv, never in the image, never in the store.
SECRET_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
              "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL")
CONTINUE_PROMPT = "Your previous turn hit its time budget. Continue where you left off."


class Store:
    """The object store, keyed per session. A local directory here; R2 or S3 in
    production keep the same two keys."""

    def __init__(self, root):
        self.root = Path(root)

    def _path(self, session_id, name):
        return self.root / session_id / name

    def get(self, session_id, name):
        p = self._path(session_id, name)
        return p.read_bytes() if p.exists() else None

    def put(self, session_id, name, data):
        p = self._path(session_id, name)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(p)   # a crash mid write never leaves a torn checkpoint


class DockerLease:
    """A fresh container with a CPU and memory cap, destroyed on close."""

    def __init__(self, image=IMAGE, cpus=2, memory_gb=4):
        self.name = "harman-turn-" + uuid.uuid4().hex[:12]
        _docker("run", "-d", "--name", self.name, "--cpus", str(cpus),
                "--memory", f"{memory_gb}g", "--pids-limit", "512", image)

    def put(self, tar_bytes, path):
        """Restore a tar made by get(path) back to the same path, owned by the turn's user."""
        parent = os.path.dirname(path)
        _docker("exec", self.name, "mkdir", "-p", parent)
        _docker("cp", "-", f"{self.name}:{parent}", stdin=tar_bytes)
        _docker("exec", "-u", "root", self.name, "chown", "-R", "node:node", path)

    def exec(self, argv, env_names, budget_s, on_line):
        """Run argv in the box, streaming stdout lines. Past budget_s the box is
        stopped (it stays readable for get). Returns (exit_code, timed_out)."""
        cmd = ["docker", "exec", "-w", WORKDIR]
        for n in env_names:
            cmd += ["-e", n]          # name only: docker reads the value from our env
        self.stderr = tempfile.TemporaryFile()
        proc = subprocess.Popen(cmd + [self.name] + argv, stdout=subprocess.PIPE,
                                stderr=self.stderr, text=True)
        deadline = time.monotonic() + budget_s
        timed_out = False
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ)
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                timed_out = True
                _docker("stop", "-t", "5", self.name)
                break
            if not sel.select(timeout=min(left, 1.0)):
                if proc.poll() is not None:
                    break
                continue
            line = proc.stdout.readline()
            if not line:
                break
            on_line(line)
        sel.close()
        return proc.wait(), timed_out

    def stderr_tail(self, limit=2000):
        self.stderr.seek(0)
        return self.stderr.read().decode(errors="replace")[-limit:]

    def get(self, path):
        """The path as a tar stream; None when it does not exist yet."""
        r = subprocess.run(["docker", "cp", f"{self.name}:{path}", "-"], capture_output=True)
        return r.stdout if r.returncode == 0 else None

    def close(self):
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)


def _docker(*args, stdin=None):
    r = subprocess.run(["docker", *args], input=stdin, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"docker {args[0]} failed: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def claude_argv(prompt, session_id, resume):
    """The unmodified CLI, headless, the same flags Harman's engine runs."""
    argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--permission-mode", "bypassPermissions"]
    return argv + (["--resume", session_id] if resume else ["--session-id", session_id])


def transcript_lines(state_tar, session_id):
    """The session's jsonl rows out of the saved project dir tar."""
    if not state_tar:
        return []
    with tarfile.open(fileobj=io.BytesIO(state_tar)) as t:
        try:
            f = t.extractfile(f"-work/{session_id}.jsonl")
        except KeyError:
            return []
        return [json.loads(x) for x in f.read().decode().splitlines() if x.strip()]


def run_turn(store, session_id, prompt, budget_s=600, cpus=2, memory_gb=4, image=IMAGE, on_event=None):
    """Lease, restore, run, save, destroy. Returns the turn's outcome."""
    workspace, state = store.get(session_id, "workspace.tar"), store.get(session_id, "state.tar")
    resume = bool(transcript_lines(state, session_id))
    env_names = [n for n in SECRET_ENV if os.environ.get(n)]
    outcome = {"session_id": session_id, "resumed": resume, "status": "error", "result": None}
    started = time.monotonic()
    lease = DockerLease(image, cpus, memory_gb)
    try:
        outcome["lease_ready_s"] = round(time.monotonic() - started, 2)
        if workspace:
            lease.put(workspace, WORKDIR)
        if state:
            lease.put(state, PROJECT_DIR)

        def on_line(line):
            try:
                ev = json.loads(line)
            except ValueError:
                return
            if on_event:
                on_event(ev)
            if ev.get("type") == "result":
                outcome.update(result=ev.get("result"), cost_usd=ev.get("total_cost_usd"),
                               is_error=ev.get("is_error"), num_turns=ev.get("num_turns"))

        code, timed_out = lease.exec(claude_argv(prompt, session_id, resume), env_names, budget_s, on_line)
        outcome["exit_code"] = code
        outcome["status"] = "budget_exhausted" if timed_out else ("done" if code == 0 else "error")
        if outcome["status"] == "error":
            outcome["stderr"] = lease.stderr_tail()
        # Save even after a budget stop or an error: the transcript so far is the checkpoint.
        for name, path in (("workspace.tar", WORKDIR), ("state.tar", PROJECT_DIR)):
            data = lease.get(path)
            if data:
                store.put(session_id, name, data)
    finally:
        lease.close()
    outcome["wall_s"] = round(time.monotonic() - started, 2)
    return outcome


def run_task(store, session_id, prompt, max_leases=1, **kw):
    """A long task across leases: each budget stop resumes from the saved transcript."""
    outcomes = []
    for i in range(max_leases):
        o = run_turn(store, session_id, prompt if i == 0 else CONTINUE_PROMPT, **kw)
        outcomes.append(o)
        if o["status"] != "budget_exhausted":
            break
    return outcomes


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run one Harman turn in an ephemeral sandbox.")
    ap.add_argument("prompt")
    ap.add_argument("--store", required=True, help="object store directory")
    ap.add_argument("--session", default=None, help="session id to resume (new when omitted)")
    ap.add_argument("--budget", type=int, default=600, help="seconds per lease")
    ap.add_argument("--max-leases", type=int, default=1, help="leases a long task may use")
    ap.add_argument("--cpus", type=float, default=2)
    ap.add_argument("--memory-gb", type=int, default=4)
    ap.add_argument("--image", default=IMAGE)
    a = ap.parse_args(argv)
    sid = a.session or str(uuid.uuid4())
    outcomes = run_task(Store(a.store), sid, a.prompt, a.max_leases, budget_s=a.budget,
                        cpus=a.cpus, memory_gb=a.memory_gb, image=a.image)
    print(json.dumps(outcomes, indent=2))
    return 0 if outcomes[-1]["status"] == "done" else 1


if __name__ == "__main__":
    sys.exit(main())
