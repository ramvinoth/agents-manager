"""Where a sandbox box lives: the drivers behind backends.sandbox.

The sandbox backend speaks to its box only through a driver: start a box, run
a command in it (to completion, or as a live process with pipes), list and
remove boxes, and route an address the box cannot reach as written. Two
drivers implement it:

  docker      a container on this machine's docker (the default);
  cloudflare  a Cloudflare Container behind the Worker in sandbox/cloudflare,
              driven by box_client.mjs over a WebSocket. The box reaches what
              only this machine can (its loopback, its private network) back
              through a tunnel the same client holds open, so nothing here is
              exposed to the internet.

The server setting `sandbox_provider` picks one. Both hand back real
subprocess objects, so the backend's pipes, signals and waits are the same
whichever runs the box.
"""
import ipaddress
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from orchestrator import db
from orchestrator.project_plugins import LOOPBACK

PROVIDERS = ("docker", "cloudflare")
LABEL = "harman.run"
# Shared address space (RFC 6598): carrier NAT and Tailscale's tailnet. Python
# counts it neither private nor global, so it is named here.
SHARED = ipaddress.ip_network("100.64.0.0/10")
PRIVATE_SUFFIXES = (".local", ".ts.net")


def private(host):
    """True for a host only this machine's networks can reach: loopback, a
    private or tailnet address, an mDNS or MagicDNS name."""
    host = host.lower().rstrip(".")
    if host in LOOPBACK or host.endswith(PRIVATE_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip in SHARED


def provider():
    """The configured provider; an unknown value reads as docker, the local one."""
    value = db.setting_get("sandbox_provider", "docker") or "docker"
    return value if value in PROVIDERS else "docker"


def open_driver():
    return CloudflareDriver() if provider() == "cloudflare" else DockerDriver()


class DockerDriver:
    """The docker CLI with a config of its own: the owner's may name a
    credential helper that hangs a headless call."""
    IMAGE = "harman-sandbox:dev"
    LIMITS = ["--cpus", "2", "--memory", "4g", "--pids-limit", "512"]
    REACH_HOST = "host.docker.internal"

    def __init__(self):
        self._config = None
        self.bin = shutil.which("docker") or "/usr/local/bin/docker"

    def route(self, scheme, host, port):
        """A container here reaches this machine's networks itself; only
        loopback means something else inside it."""
        if host not in LOOPBACK:
            return None
        return scheme, self.REACH_HOST + (f":{port}" if port else "")

    def _env(self, extra=None):
        if self._config is None:
            self._config = tempfile.mkdtemp(prefix="harman-docker-")
            with open(os.path.join(self._config, "config.json"), "w") as f:
                f.write("{}")
        env = {"DOCKER_CONFIG": self._config, "HOME": os.path.expanduser("~"),
               "PATH": os.path.dirname(self.bin) + ":/usr/bin:/bin"}
        env.update(extra or {})
        return env

    def _cli(self, *args, input=None, timeout=120, check=True):
        return subprocess.run([self.bin, *args], input=input, capture_output=True,
                              env=self._env(), timeout=timeout, check=check)

    def start(self, name, labels):
        image = db.setting_get("sandbox_image", self.IMAGE) or self.IMAGE
        flags = []
        for k, v in labels.items():
            flags += ["--label", f"{k}={v}"]
        try:
            self._cli("run", "-d", "--name", name, *self.LIMITS,
                      "--add-host", f"{self.REACH_HOST}:host-gateway", *flags, image, timeout=180)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Could not start a sandbox from {image}: "
                               f"{e.stderr.decode(errors='replace').strip()[:300]}") from e

    def _exec_args(self, name, argv, user, workdir, env_names, stdin):
        args = ["exec"] + (["-i"] if stdin else [])
        if user:
            args += ["-u", user]
        if workdir:
            args += ["-w", workdir]
        for k in env_names:
            args += ["-e", k]
        return args + [name, *argv]

    def run(self, name, argv, *, user=None, input=None, timeout=120, check=True):
        return self._cli(*self._exec_args(name, argv, user, None, (), input is not None),
                         input=input, timeout=timeout, check=check)

    def popen(self, name, argv, *, user=None, workdir=None, env=None, **kw):
        stdin = kw.get("stdin") not in (None, subprocess.DEVNULL)
        args = self._exec_args(name, argv, user, workdir, env or {}, stdin)
        return subprocess.Popen([self.bin, *args], env=self._env(env), **kw)

    def remove(self, name):
        self._cli("rm", "-f", name, check=False, timeout=60)

    def names(self, labels):
        args = ["ps", "-a"]
        for k, v in labels.items():
            args += ["--filter", f"label={k}={v}"]
        return self._cli(*args, "--format", "{{.Names}}", check=False).stdout.decode().split()

    def close(self):
        if self._config:
            shutil.rmtree(self._config, ignore_errors=True)


class CloudflareDriver:
    """A box is a Cloudflare Container owned by one Durable Object of the
    Worker in sandbox/cloudflare. Every call goes through box_client.mjs, a
    small Node program that pipes a command's stdio over a WebSocket, so the
    backend still gets an ordinary Popen.

    A box on the internet cannot reach this machine's loopback or private
    network, so route() gives each such origin an alias and the box dials
    http://<alias>.harman.internal. The Worker hands that request to the reach
    tunnel this driver holds open, which fetches it from the origin the alias
    stands for. Only the origins this run was routed exist on the tunnel."""
    REACH_DOMAIN = "harman.internal"
    DEFAULT_PORTS = {"http": 80, "https": 443}
    USERS = {"root": "0:0", "node": "1000:1000", None: "1000:1000"}
    CLIENT = Path(__file__).with_name("box_client.mjs")

    def __init__(self):
        cfg = _cloudflare_config()
        self.url, self.secret = cfg["url"].rstrip("/"), cfg["secret"]
        self.node = cfg.get("node") or shutil.which("node") or "node"
        self.targets = {}            # alias -> origin it stands for
        self._reach = {}             # box name -> the tunnel's process

    def route(self, scheme, host, port):
        if not private(host):
            return None
        host = f"[{host}]" if ":" in host else host
        origin = f"{scheme}://{host}:{port or self.DEFAULT_PORTS[scheme]}"
        alias = next((a for a, o in self.targets.items() if o == origin), None)
        if alias is None:
            alias = f"t{len(self.targets)}"
            self.targets[alias] = origin
        return "http", f"{alias}.{self.REACH_DOMAIN}"

    def _client(self, mode, name, spec=None, **kw):
        env = {"PATH": os.path.dirname(self.node) + ":/usr/bin:/bin",
               "HARMAN_BOX_URL": self.url, "HARMAN_BOX_SECRET": self.secret,
               "HARMAN_BOX_SPEC": json.dumps(spec or {})}
        return subprocess.Popen([self.node, str(self.CLIENT), mode, name], env=env, **kw)

    def _call(self, mode, name, spec=None, input=None, timeout=120, check=True):
        p = self._client(mode, name, spec, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE)
        try:
            out, err = p.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.communicate()
            raise
        result = subprocess.CompletedProcess(p.args, p.returncode, out, err)
        if check:
            result.check_returncode()
        return result

    def _spec(self, argv, user, workdir=None, env=None):
        return {"argv": list(argv), "user": self.USERS[user], "cwd": workdir, "env": dict(env or {})}

    def start(self, name, labels):
        try:
            self._call("start", name, {"labels": labels}, timeout=180)
        except subprocess.CalledProcessError as e:
            raise RuntimeError("Could not start a Cloudflare sandbox: "
                               f"{e.stderr.decode(errors='replace').strip()[:300]}") from e
        self._reach[name] = self._client("reach", name, {"targets": self.targets}, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=None)

    def run(self, name, argv, *, user=None, input=None, timeout=120, check=True):
        return self._call("exec", name, self._spec(argv, user), input=input or b"", timeout=timeout,
                          check=check)

    def popen(self, name, argv, *, user=None, workdir=None, env=None, **kw):
        return self._client("exec", name, self._spec(argv, user, workdir, env), **kw)

    def remove(self, name):
        tunnel = self._reach.pop(name, None)
        if tunnel:
            tunnel.kill()
            tunnel.wait(timeout=10)
        self._call("destroy", name, check=False, timeout=60)

    def names(self, labels):
        r = self._call("list", "-", {"labels": labels}, check=False)
        return r.stdout.decode().split() if r.returncode == 0 else []

    def close(self):
        for name in list(self._reach):
            tunnel = self._reach.pop(name)
            tunnel.kill()


def _cloudflare_config():
    """The Worker's address and shared secret, from a file only this user
    reads. Written once by sandbox/cloudflare/README's deploy steps."""
    path = Path(os.environ.get("HARMAN_SANDBOX_CF_CONFIG",
                               "~/.config/harman/sandbox-cloudflare.json")).expanduser()
    try:
        cfg = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise RuntimeError(f"The Cloudflare sandbox is not set up here ({path} is missing or unreadable).") from e
    if not re.match(r"^https://", cfg.get("url", "")) or not cfg.get("secret"):
        raise RuntimeError(f"{path} needs an https url and a secret.")
    return cfg
