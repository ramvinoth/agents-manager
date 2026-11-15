"""A run in a throwaway container: the same claude, none of this machine's reach.

Each run leases one fresh box from the sandbox image (sandbox/Dockerfile), copies
in what the CLI needs to behave as it would here, drives `claude -p` inside it
through `docker exec`, and at the end brings the box's work home and removes it.

What goes in, at the paths the CLI expects:
  - the folder, at the same absolute path, so the transcript's project slug and
    every path the agent writes match this machine's;
  - the chat's transcript, its sidecar folder and the folder's memory;
  - the viewer's two MCP servers (permission and board tools), the chat's
    plugins and each project plugin's box build (Sift), the owner's skills and
    CLAUDE.md;
  - the run's --settings and --mcp-config.
The box reaches this machine's viewer, Sift and any loopback endpoint through
host.docker.internal; nothing else of this machine is mounted.

What comes back: the transcript (streamed live while the run goes, replaced
whole at the end), the sidecar folder, and a three way sync of the folder and
the memory (backends.sandbox_sync), so a file someone changed here meanwhile is
never overwritten. A box left by a stopped server is synced home and removed
the next time a sandbox run starts.
"""
import io
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from orchestrator import db, project_plugins
from orchestrator.config import CLAUDE_DIR, PORT, session_plugin_dirs, transcript_path
from orchestrator.runtime.backends import Backend, sandbox_sync
from orchestrator.runtime.run_config import perm_mcp_servers

IMAGE = "harman-sandbox:dev"
HOME = "/home/node"
OPT = "/opt/harman"
BOX_PY = "python3"
REACH_HOST = "host.docker.internal"
LIMITS = ["--cpus", "2", "--memory", "4g", "--pids-limit", "512"]
LABEL = "harman.run"
# Env the box gets: the run's own viewer and plugin wiring, the model provider
# and credentials, the keys the runner forwards on purpose. Never PATH, never
# the rest of this server's environment.
ENV_PREFIXES = ("VIEWER_", "ANTHROPIC_", "CLAUDE_CODE_")
ENV_NAMES = ("MCP_TIMEOUT", "HARMAN_SESSION_LABEL")
ORCH = Path(__file__).resolve().parents[2]      # orchestrator/
SHIPPED = (ORCH / "permission_mcp.py", ORCH / "viewer_mcp.py", Path(sandbox_sync.__file__))
# The claude this backend started, by an argv no other process in the box has.
CLAUDE_MATCH = "-p --input-format stream-json"

_LIVE = set()            # box names a run in this server owns
_LIVE_LOCK = threading.Lock()
_SWEEP_LOCK = threading.Lock()


def slug(path):
    """The CLI's project folder name for a cwd: every non alphanumeric becomes '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def reach(value):
    """A loopback URL rewritten to the host the box reaches this machine on."""
    if not isinstance(value, str) or not value.startswith(("http://", "https://")):
        return value
    u = urlparse(value)
    if (u.hostname or "") not in project_plugins.LOOPBACK:
        return value
    netloc = REACH_HOST + (f":{u.port}" if u.port else "")
    return urlunparse(u._replace(netloc=netloc))


def _docker_bin():
    return shutil.which("docker") or "/usr/local/bin/docker"


class _Docker:
    """The docker CLI with a config of its own: the owner's may name a
    credential helper that hangs a headless call."""

    def __init__(self):
        self.config = tempfile.mkdtemp(prefix="harman-docker-")
        with open(os.path.join(self.config, "config.json"), "w") as f:
            f.write("{}")
        self.bin = _docker_bin()

    def env(self, extra=None):
        env = {"DOCKER_CONFIG": self.config, "HOME": os.path.expanduser("~"),
               "PATH": os.path.dirname(self.bin) + ":/usr/bin:/bin"}
        env.update(extra or {})
        return env

    def run(self, *args, input=None, timeout=120, check=True):
        return subprocess.run([self.bin, *args], input=input, capture_output=True,
                              env=self.env(), timeout=timeout, check=check)

    def popen(self, args, env=None, **kw):
        return subprocess.Popen([self.bin, *args], env=self.env(env), **kw)

    def close(self):
        shutil.rmtree(self.config, ignore_errors=True)


# For each path: find the highest folder that does not exist yet, make the
# path, then hand that whole new chain to the box user. Folders that already
# existed keep their owner; the path itself is always the box user's.
MKDIRS_SH = (
    'for p; do top="$p"; '
    'while [ ! -e "$(dirname "$top")" ]; do top="$(dirname "$top")"; done; '
    'mkdir -p "$p" && chown node:node "$p" || exit 1; '
    '[ "$top" = "$p" ] || chown -R node:node "$top" || exit 1; '
    'done'
)


class _Box:
    """One leased container and the plan that brings its work home. The plan
    is also written into the box, so a box this server lost track of (a
    restart mid run) can still be synced by the next one."""

    def __init__(self, docker, name, plan):
        self.docker, self.name, self.plan = docker, name, plan

    # -- putting files in --------------------------------------------------
    def mkdirs(self, *paths):
        """Make each path, and every parent it needs, owned by the box user."""
        self.docker.run("exec", "-u", "root", self.name, "sh", "-c", MKDIRS_SH, "sh", *paths)

    def put_stream(self, dest, write):
        """Unpack into dest, as the box user, the tar that `write(pipe)` streams."""
        p = self.docker.popen(["exec", "-i", "-u", "node", self.name, "tar", "-xf", "-", "-C", dest],
                              stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            write(p.stdin)
        finally:
            p.stdin.close()
            err = p.stderr.read()
            if p.wait(timeout=300) != 0:
                raise RuntimeError(f"copy into the sandbox failed: {err.decode(errors='replace')[:300]}")

    def put_files(self, dest, files):
        """{name: bytes} into dest."""
        def write(pipe):
            with tarfile.open(fileobj=pipe, mode="w|") as tar:
                for name, data in files.items():
                    info = tarfile.TarInfo(name)
                    info.size, info.mode = len(data), 0o600
                    tar.addfile(info, io.BytesIO(data))
        self.put_stream(dest, write)

    def put_tree(self, src, dest):
        """A folder's contents into dest, following symlinks (skills and
        plugins are often linked in from elsewhere)."""
        def write(pipe):
            with tarfile.open(fileobj=pipe, mode="w|", dereference=True) as tar:
                for entry in sorted(os.listdir(src)):
                    tar.add(os.path.join(src, entry), arcname=entry)
        self.put_stream(dest, write)

    def put_paths(self, dest, root, paths):
        """The listed files of root (sandbox_sync's listing) into dest."""
        self.put_stream(dest, lambda pipe: sandbox_sync.write_tar(pipe, root, paths))

    # -- bringing work home ------------------------------------------------
    def read(self, path):
        r = self.docker.run("exec", self.name, "cat", path, check=False, timeout=300)
        return r.stdout if r.returncode == 0 else None

    def manifest(self, root, base_paths):
        r = self.docker.run("exec", "-i", self.name, BOX_PY, f"{OPT}/sandbox_sync.py", "manifest", root,
                            input=json.dumps(sorted(base_paths)).encode(), timeout=600)
        return json.loads(r.stdout)

    def fetch(self, root, paths, local_root):
        """Copy `paths` (relative to root in the box) under local_root."""
        if not paths:
            return []
        p = self.docker.popen(["exec", "-i", self.name, "tar", "-C", root, "-cf", "-", "--null", "-T", "-"],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        feeder = threading.Thread(target=self._feed, args=(p.stdin, paths), daemon=True)
        feeder.start()
        try:
            return sandbox_sync.extract_tar(p.stdout, local_root, allowed=set(paths))
        finally:
            feeder.join(timeout=60)
            p.wait(timeout=300)

    @staticmethod
    def _feed(pipe, paths):
        try:
            pipe.write(b"\0".join(p.encode("utf-8", "surrogateescape") for p in paths) + b"\0")
        finally:
            pipe.close()

    def sync_folder(self, key):
        """Three way sync of one copied folder (the workspace or the memory)."""
        part = self.plan[key]
        if part is None:
            return
        local, box, base = part["local"], part["box"], part["base"]
        writes, deletes, conflicts = sandbox_sync.plan_sync(
            base, sandbox_sync.current_manifest(local, base), self.manifest(box, base))
        os.makedirs(local, exist_ok=True)
        self.fetch(box, writes, local)
        sandbox_sync.delete_files(local, deletes)
        for path in conflicts:
            print(f"  ⚠ sandbox {self.name}: {key} {path} changed here and in the box, kept this machine's copy",
                  flush=True)

    def bring_home(self):
        """Transcript, sidecar, folder, memory. Each step on its own: one
        failing must not lose the others."""
        t = self.plan["transcript"]
        steps = (("transcript", lambda: self._transcript_home(t)),
                 ("sidecar", lambda: self._sidecar_home(t)),
                 ("folder", lambda: self.sync_folder("workspace")),
                 ("memory", lambda: self.sync_folder("memory")))
        for what, step in steps:
            try:
                step()
            except Exception as e:
                print(f"  ⚠ sandbox {self.name}: bringing the {what} home failed: {type(e).__name__}: {e}", flush=True)

    def _transcript_home(self, t):
        data = self.read(t["box"])
        if data is None:
            return
        os.makedirs(os.path.dirname(t["local"]), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(t["local"]), prefix=".harman-sync.")
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, t["local"])

    def _sidecar_home(self, t):
        box_dir = t["box"][:-len(".jsonl")]
        if self.docker.run("exec", self.name, "test", "-d", box_dir, check=False).returncode != 0:
            return
        p = self.docker.popen(["exec", self.name, "tar", "-C", box_dir, "-cf", "-", "."],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            sandbox_sync.extract_tar(p.stdout, t["local"][:-len(".jsonl")])
        finally:
            p.stdout.close()
            p.wait(timeout=300)

    def remove(self):
        try:
            self.docker.run("rm", "-f", self.name, check=False, timeout=60)
        except Exception as e:
            print(f"  ⚠ sandbox {self.name}: remove failed: {e}", flush=True)
        with _LIVE_LOCK:
            _LIVE.discard(self.name)


def sweep_orphans(docker):
    """Boxes this server's port started that no live run owns (a restart cut
    their run off): bring their work home, then remove them. A preflight
    server on another port never touches this one's boxes."""
    with _SWEEP_LOCK:
        r = docker.run("ps", "-a", "--filter", f"label={LABEL}", "--filter", f"label=harman.port={PORT}",
                       "--format", "{{.Names}}", check=False)
        for name in r.stdout.decode().split():
            with _LIVE_LOCK:
                if name in _LIVE:
                    continue
                _LIVE.add(name)
            box = _Box(docker, name, None)
            try:
                raw = box.read(f"{OPT}/plan.json")
                box.plan = json.loads(raw) if raw else None
                if box.plan:
                    box.bring_home()
                    print(f"  ↺ sandbox {name}: synced an orphaned box home", flush=True)
            except Exception as e:
                print(f"  ⚠ sandbox {name}: orphan sync failed: {type(e).__name__}: {e}", flush=True)
            box.remove()


class SandboxProc:
    """Popen-like handle on the `docker exec` that runs claude in the box.
    Signals to the docker client never reach the box, so they are sent inside."""

    def __init__(self, box, popen):
        self.box, self.popen = box, popen
        self.stdin, self.stdout, self.stderr = popen.stdin, popen.stdout, popen.stderr

    @property
    def returncode(self):
        return self.popen.returncode

    @property
    def pid(self):
        return self.popen.pid

    def poll(self):
        return self.popen.poll()

    def wait(self, timeout=None):
        return self.popen.wait(timeout=timeout)

    def send_signal(self, sig):
        name = signal.Signals(sig).name.removeprefix("SIG")
        try:
            self.box.docker.run("exec", self.box.name, "pkill", f"-{name}", "-f", CLAUDE_MATCH,
                                check=False, timeout=30)
        except Exception as e:
            raise OSError(f"signal into the sandbox failed: {e}") from e

    def terminate(self):
        self.send_signal(signal.SIGTERM)

    def kill(self):
        try:
            self.send_signal(signal.SIGKILL)
        finally:
            self.popen.kill()


class SandboxBackend(Backend):
    name = "sandbox"

    def __init__(self):
        self.docker = None
        self.box = None
        self.run_settings = {}
        self.plugins = []            # local plugin folders, staged as OPT/plugins/<i>
        self._tail = None

    def binary(self):
        return "claude"

    def mcp_config(self):
        return f"{OPT}/mcp.json"

    def settings_arg(self, run_settings):
        self.run_settings = run_settings
        return ["--settings", f"{OPT}/settings.json"]

    def plugin_args(self, session_id, meta):
        # The chat's own plugins travel as they are; a project plugin ships a
        # box build of itself (its local one runs from this machine's source).
        self.plugins = [Path(p) for p in session_plugin_dirs(session_id, meta)] + project_plugins.box_plugin_dirs()
        args = []
        for i in range(len(self.plugins)):
            args += ["--plugin-dir", f"{OPT}/plugins/{i}"]
        return args

    def system_note(self):
        return ("This run is in a cloud sandbox: a fresh Linux box with this folder copied in. "
                "The browser and this machine's own MCP servers are not here, and rebuilt folders "
                "such as node_modules were not copied, so reinstall what you need. "
                "Your changes to the folder sync back when the turn ends.")

    # -- spawn -------------------------------------------------------------
    def _box_env(self, env, forward):
        keep = {k: v for k, v in env.items()
                if k.startswith(ENV_PREFIXES) or k in ENV_NAMES or k in forward}
        for plugin in project_plugins.available():
            keep.update({k: env[k] for k in plugin.mcp_env if env.get(k)})
        keep = {k: reach(str(v)) for k, v in keep.items()}
        keep["HOME"] = HOME
        base = f"http://{REACH_HOST}:{PORT}"
        if keep.get("VIEWER_PERM_TOKEN"):
            keep["VIEWER_PERM_BASE"] = base
        if keep.get("VIEWER_KANBAN_TOKEN"):
            keep["VIEWER_KANBAN_BASE"] = base
        for var, key in (("NAME", "user.name"), ("EMAIL", "user.email")):
            value = _git_config(key)
            if value:
                keep[f"GIT_AUTHOR_{var}"] = keep[f"GIT_COMMITTER_{var}"] = value
        if not any(keep.get(k) for k in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")) \
                and not (self.run_settings.get("env") or {}).get("ANTHROPIC_AUTH_TOKEN"):
            raise RuntimeError("A sandbox run needs a Claude token or a provider key, and this server has neither. "
                               "Sign in with a setup token or pick a provider.")
        return keep

    def _plan(self, session_id, cwd):
        live = transcript_path(session_id)
        local_dir = live.parent if live else CLAUDE_DIR / slug(cwd)
        box_dir = f"{HOME}/.claude/projects/{slug(cwd)}"
        paths = sandbox_sync.list_files(cwd)
        memory = local_dir / "memory"
        mem_paths = sandbox_sync.list_files(str(memory)) if memory.is_dir() else []
        return {
            "session": session_id,
            "transcript": {"local": str(live or local_dir / f"{session_id}.jsonl"),
                           "box": f"{box_dir}/{session_id}.jsonl"},
            "workspace": {"local": cwd, "box": cwd, "paths": paths,
                          "base": sandbox_sync.manifest(cwd, paths)},
            "memory": {"local": str(memory), "box": f"{box_dir}/memory", "paths": mem_paths,
                       "base": sandbox_sync.manifest(str(memory), mem_paths)},
        }

    def _stage(self, box, plan):
        t, ws, mem = plan["transcript"], plan["workspace"], plan["memory"]
        box_dir = os.path.dirname(t["box"])
        plugin_dests = [f"{OPT}/plugins/{i}" for i in range(len(self.plugins))]
        box.mkdirs(ws["box"], OPT, box_dir, mem["box"], f"{HOME}/.claude/skills", *plugin_dests)

        settings = dict(self.run_settings)
        if settings.get("env"):
            settings["env"] = {k: reach(v) for k, v in settings["env"].items()}
        mcp = {"mcpServers": perm_mcp_servers(BOX_PY, OPT)}
        files = {p.name: p.read_bytes() for p in SHIPPED}
        files.update({"settings.json": json.dumps(settings).encode(),
                      "mcp.json": json.dumps(mcp).encode(),
                      "plan.json": json.dumps(plan).encode()})
        box.put_files(OPT, files)
        for src, dest in zip(self.plugins, plugin_dests):
            box.put_tree(str(src), dest)

        claude_home = Path.home() / ".claude"
        if (claude_home / "skills").is_dir():
            box.put_tree(str(claude_home / "skills"), f"{HOME}/.claude/skills")
        if (claude_home / "CLAUDE.md").is_file():
            box.put_files(f"{HOME}/.claude", {"CLAUDE.md": (claude_home / "CLAUDE.md").read_bytes()})

        local_t = Path(t["local"])
        if local_t.is_file():
            box.put_files(box_dir, {local_t.name: local_t.read_bytes()})
        sidecar = local_t.with_suffix("")
        if sidecar.is_dir():
            box.mkdirs(f"{box_dir}/{sidecar.name}")
            box.put_tree(str(sidecar), f"{box_dir}/{sidecar.name}")
        box.put_paths(mem["box"], mem["local"], mem["paths"])
        box.put_paths(ws["box"], ws["local"], ws["paths"])

    def spawn(self, cmd, cwd, env, session_id, forward=()):
        cwd = os.path.expanduser(cwd or "~")
        self.docker = _Docker()
        sweep_orphans(self.docker)
        plan = self._plan(session_id, cwd)
        box_env = self._box_env(env, set(forward))
        name = f"harman-run-{session_id[:8]}-{secrets.token_hex(3)}"
        with _LIVE_LOCK:
            _LIVE.add(name)
        self.box = _Box(self.docker, name, plan)
        image = db.setting_get("sandbox_image", IMAGE) or IMAGE
        try:
            self.docker.run("run", "-d", "--name", name, *LIMITS,
                            "--add-host", f"{REACH_HOST}:host-gateway",
                            "--label", f"{LABEL}=1", "--label", f"harman.port={PORT}",
                            "--label", f"harman.session={session_id}",
                            image, timeout=180)
        except subprocess.CalledProcessError as e:
            self.box.remove()
            raise RuntimeError(f"Could not start a sandbox from {image}: "
                               f"{e.stderr.decode(errors='replace').strip()[:300]}") from e
        self._stage(self.box, plan)
        self._tail = _TranscriptTail(self.box, plan["transcript"])
        self._tail.start()
        args = ["exec", "-i", "-u", "node", "-w", cwd]
        for k in box_env:
            args += ["-e", k]
        popen = self.docker.popen(args + [name] + cmd, env=box_env, text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return SandboxProc(self.box, popen)

    def finish(self, session_id):
        try:
            if self._tail:
                self._tail.stop()
            if self.box:
                self.box.bring_home()
                self.box.remove()
        except Exception as e:
            print(f"  ⚠ sandbox finish {session_id[:8]} failed: {type(e).__name__}: {e}", flush=True)
        finally:
            if self.docker:
                self.docker.close()


def _git_config(key):
    try:
        r = subprocess.run(["git", "config", "--global", key], capture_output=True, text=True, timeout=10)
        return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


class _TranscriptTail:
    """Streams what the box appends to the transcript into this machine's copy
    while the run goes, so the app shows the turn live. The whole file replaces
    it at the end, which is what makes this safe to lose."""

    def __init__(self, box, t):
        self.box, self.local = box, t["local"]
        os.makedirs(os.path.dirname(self.local), exist_ok=True)
        start = os.path.getsize(self.local) + 1 if os.path.exists(self.local) else 1
        self.proc = box.docker.popen(["exec", box.name, "tail", "-c", f"+{start}", "-F", t["box"]],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.thread = threading.Thread(target=self._copy, daemon=True, name="sandbox-tail")

    def start(self):
        self.thread.start()

    def _copy(self):
        with open(self.local, "ab") as out:
            for chunk in iter(lambda: self.proc.stdout.read1(1 << 16), b""):
                out.write(chunk)
                out.flush()

    def stop(self):
        try:
            self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:
            pass
        self.thread.join(timeout=10)
