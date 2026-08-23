"""viewer.remote — SSH transport + all remote_* helpers (sessions, fs,
capabilities, edits) and the python-over-SSH script payloads."""
import json
import os
import posixpath
import re
import shlex
import shutil
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from viewer.config import (
    HOSTS, MAX_POLL_BYTES, read_back_f, split_lines,
)
from viewer.agents import ENABLED_AGENTS, agent_public, get_agent, install_command, is_installed_local
from viewer.adapters import normalize_lines


def _safe_seg(name) -> bool:
    """A single, safe path segment (no separators, NUL, or dot-only). Guards remote
    create/rename against a client filename escaping the browsed dir (e.g.
    '../.ssh/authorized_keys' or an absolute path)."""
    return isinstance(name, str) and bool(name) and "/" not in name and "\0" not in name and name not in (".", "..")


def _auth_kwargs(cfg):
    """paramiko connect() auth kwargs from a host config:
    - a password  → password auth (no key/agent);
    - a key file  → public-key / certificate auth (paramiko auto-loads an
      adjacent <key>-cert.pub), with an optional passphrase for an encrypted key;
    - neither     → fall back to the ssh-agent + default ~/.ssh keys."""
    if cfg.get("password"):
        return {"password": cfg["password"], "look_for_keys": False, "allow_agent": False}
    if cfg.get("keyFile"):
        kw = {"key_filename": os.path.expanduser(cfg["keyFile"]),
              "look_for_keys": False, "allow_agent": False}
        if cfg.get("keyPassphrase"):
            kw["passphrase"] = cfg["keyPassphrase"]
        return kw
    return {}  # agent + ~/.ssh defaults


class SSHManager:
    """Lazily-connected, reused paramiko SSH+SFTP connections keyed by host id."""

    # One SSH transport caps concurrent channels (sshd MaxSessions, default 10),
    # shared by SFTP + exec + streams. Bound the parallel short ops we issue per
    # host safely under that, leaving headroom for browser/terminal/chat streams.
    MAX_CHANNELS = 5

    def __init__(self):
        self.conns = {}   # hid -> {"client": SSHClient, "sftp": SFTP, "home": str, "at": ts}
        self.lock = threading.Lock()
        self.op_locks = {}   # hid -> Lock serializing exec-channel setup on a connection
        self.chan_gates = {}   # hid -> BoundedSemaphore(MAX_CHANNELS): concurrent short ops/host

    def config(self, hid):
        return HOSTS.get(hid)

    @contextmanager
    def lock_for(self, hid):
        """Per-host lock. A single paramiko client (and its one SFTPClient) is
        NOT thread-safe: concurrent requests interleave on the wire and desync
        the transport ('Garbage packet received' / hangs). Every short-lived
        remote op holds this so only one runs on a connection at a time. The
        long-lived streaming channel (RemoteProc) holds it only during setup,
        then streams on its own dedicated channel.

        Bounded acquire: a wedged op must not queue every later request forever.
        And if the op fails at the wire level, drop the pooled connection —
        transport.is_active() can stay True on a dead TCP path (e.g. a
        tailscale/NAT idle drop), so the next op would hang again on reuse."""
        with self.lock:
            lk = self.op_locks.get(hid)
            if lk is None:
                lk = threading.Lock()
                self.op_locks[hid] = lk
        if not lk.acquire(timeout=90):
            raise TimeoutError("host connection is busy (a previous operation is still running)")
        try:
            yield
        except (socket.timeout, TimeoutError, EOFError, OSError):
            self.close(hid)
            raise
        finally:
            lk.release()

    @contextmanager
    def channel(self, hid):
        """Reserve one of the host's bounded channel slots (MAX_CHANNELS), so N
        short ops (SFTP file ops + exec scripts) run in parallel on a host but
        never exceed the transport's channel limit. Bounded wait (90s) → a burst
        queues instead of failing with ChannelException('Connect failed')."""
        with self.lock:
            gate = self.chan_gates.get(hid)
            if gate is None:
                gate = threading.BoundedSemaphore(self.MAX_CHANNELS)
                self.chan_gates[hid] = gate
        if not gate.acquire(timeout=90):
            raise TimeoutError("host connection is busy (all channels in use)")
        try:
            yield
        finally:
            gate.release()

    def _open_channel(self, hid, opener, tries=6):
        """Open a channel (opener()) with a short retry: even under the gate, a
        just-closed channel can briefly linger server-side and the next open
        races MaxSessions — retry rather than surface a transient failure."""
        import paramiko
        last = None
        for i in range(tries):
            try:
                return opener(self.get(hid))
            except paramiko.ChannelException as e:
                last = e
                time.sleep(0.05 * (i + 1))
        raise last

    @contextmanager
    def sftp(self, hid):
        """A dedicated SFTPClient for ONE file op, on its own channel (fresh per
        op so channels never accumulate against MaxSessions), bounded by the
        per-host channel gate so a host's file ops run concurrently but safely.
        A single shared SFTPClient would desync under parallel use; separate
        clients each on their own channel are safe."""
        with self.channel(hid):
            s = self._open_channel(hid, lambda c: c["client"].open_sftp())
            try:
                s.get_channel().settimeout(60)
                yield s
            finally:
                try:
                    s.close()
                except Exception:
                    pass

    def _connect(self, cfg):
        import paramiko
        client = paramiko.SSHClient()
        # Verify keys already in ~/.ssh/known_hosts (a changed key → connection
        # fails = MITM detected); still auto-add first-seen hosts (TOFU).
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kw = {"hostname": cfg["host"], "port": int(cfg.get("port", 22)),
              "username": cfg["user"], "timeout": 12, "banner_timeout": 12, "auth_timeout": 12}
        kw.update(_auth_kwargs(cfg))
        client.connect(**kw)
        client.get_transport().set_keepalive(30)
        sftp = client.open_sftp()
        # A dead path must error a pending op, not hang it forever.
        sftp.get_channel().settimeout(60)
        home = sftp.normalize(".")
        return {"client": client, "sftp": sftp, "home": home, "at": time.time()}

    @staticmethod
    def _alive(c):
        try:
            t = c["client"].get_transport()
            return bool(t and t.is_active())
        except Exception:
            return False

    def get(self, hid):
        """Return a live connection dict, reconnecting if the channel died. The
        (slow, up to ~36s) paramiko handshake runs OUTSIDE self.lock so that
        reconnecting to one wedged host doesn't stall SSH ops to every other."""
        cfg = self.config(hid)
        if not cfg:
            raise KeyError(f"Unknown host {hid}")
        with self.lock:
            c = self.conns.get(hid)
            if c and self._alive(c):
                return c
            if c:  # stale — drop it, then connect below without the lock held
                self.conns.pop(hid, None)
                try:
                    c["client"].close()
                except Exception:
                    pass
        fresh = self._connect(cfg)
        with self.lock:
            existing = self.conns.get(hid)
            if existing and self._alive(existing):  # a concurrent get() won the race
                try:
                    fresh["client"].close()
                except Exception:
                    pass
                return existing
            self.conns[hid] = fresh
            return fresh

    def close(self, hid):
        with self.lock:
            c = self.conns.pop(hid, None)
        if c:
            try:
                c["client"].close()
            except Exception:
                pass

    def claude_home(self, hid):
        """Absolute ~/.claude on the remote."""
        cfg = self.config(hid)
        c = self.get(hid)
        cd = (cfg.get("claudeHome") or ".claude").lstrip("~/").lstrip("/")
        return c["home"].rstrip("/") + "/" + cd


SSH = SSHManager()


def test_host_config(cfg):
    """Try a connection; return (ok, message)."""
    import paramiko
    client = paramiko.SSHClient()
    client.load_system_host_keys()  # verify known hosts; auto-add first-seen
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        kw = {"hostname": cfg["host"], "port": int(cfg.get("port", 22)),
              "username": cfg["user"], "timeout": 12}
        kw.update(_auth_kwargs(cfg))
        client.connect(**kw)
        # Same filesystem probe used for real runs — `which` alone misses
        # nvm/npm installs (not on the non-interactive login PATH).
        stdin, out, _ = client.exec_command("python3 -", timeout=15)
        stdin.write(REMOTE_FIND_CLAUDE_SCRIPT)
        stdin.channel.shutdown_write()
        found = out.read().decode().strip()
        return True, (f"connected; claude at {found}" if found
                      else "claude not found on remote — chat will fail")
    except Exception as e:
        return False, str(e)
    finally:
        try:
            client.close()
        except Exception:
            pass


# Remote listing helper shipped over SSH stdin (mirrors serve_session_list).
REMOTE_LIST_SCRIPT = r"""
import json, os, glob, sys
base = os.path.expanduser('~/.claude/projects')
out = []
for f in glob.glob(base + '/*/*.jsonl'):
    if 'subagents' in f:
        continue
    try:
        st = os.stat(f)
    except OSError:
        continue
    title = ''
    try:
        size = st.st_size
        with open(f, 'r', errors='replace') as fh:
            if size > 50000:
                fh.seek(size - 50000); fh.readline()
            for line in fh:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get('type') == 'custom-title':
                    title = o.get('customTitle', '')
                elif o.get('type') == 'agent-name' and not title:
                    title = o.get('agentName', '')
    except Exception:
        pass
    rel = 'projects/' + os.path.relpath(f, base)
    proj = os.path.basename(os.path.dirname(f)).replace('-home-', '~/').replace('--', '/').replace('-', '/')
    out.append({'id': os.path.splitext(os.path.basename(f))[0], 'path': rel,
                'title': title or os.path.splitext(os.path.basename(f))[0][:8],
                'project': proj, 'size': st.st_size, 'modified': st.st_mtime})
out.sort(key=lambda s: s['modified'], reverse=True)
print(json.dumps(out))
"""


# Distinct working directories seen across the remote host's sessions — the
# new-session picker's suggestions. Mirrors serve_projects, but on the host so
# the cwds (and the isdir check) come from the remote filesystem.
REMOTE_PROJECTS_SCRIPT = r"""
import json, os, glob
base = os.path.expanduser('~/.claude/projects')
dirs = {}
for proj in glob.glob(base + '/*'):
    if not os.path.isdir(proj):
        continue
    files = glob.glob(proj + '/*.jsonl')
    if not files:
        continue
    newest = max(files, key=lambda f: os.stat(f).st_mtime)
    cwd = None
    try:
        with open(newest, 'r', errors='replace') as fh:
            for i, line in enumerate(fh):
                if i > 100:
                    break
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get('cwd'):
                    cwd = o['cwd']; break
    except Exception:
        pass
    if cwd and os.path.isdir(cwd):
        mtime = os.stat(newest).st_mtime
        if cwd not in dirs or mtime > dirs[cwd]:
            dirs[cwd] = mtime
data = [{'cwd': c, 'modified': m} for c, m in sorted(dirs.items(), key=lambda kv: kv[1], reverse=True)]
print(json.dumps(data))
"""


def remote_run_python(hid, script):
    # One bounded channel slot for the whole exec (open→run→read→close): the
    # exec runs on its own channel so concurrent scripts on a host go in
    # parallel, but the per-host gate keeps total channels under MaxSessions.
    with SSH.channel(hid):
        chan = SSH._open_channel(hid, lambda c: c["client"].get_transport().open_session())
        try:
            chan.settimeout(60)  # a dead peer must raise, not block forever
            chan.exec_command("python3 -")
            chan.sendall(script.encode())
            chan.shutdown_write()
            out = b""
            while True:
                chunk = chan.recv(65536)
                if not chunk:
                    break
                out += chunk
            chan.recv_exit_status()
            return out.decode("utf-8", "replace")
        finally:
            try:
                chan.close()
            except Exception:
                pass


def remote_agents_status(hid):
    """Which registered agents are installed AND signed in on a remote host.
    installed = runnable binary present; loggedIn = the agent's credentials file
    exists (claude ~/.claude/.credentials.json, codex ~/.codex/auth.json; pi
    authenticates via models.json so it reports True)."""
    probe = [{"id": a["id"], "bin": a["bin"]} for a in ENABLED_AGENTS]
    script = (
        "import os, json, shutil\n"
        "A = json.loads(" + repr(json.dumps(probe)) + ")\n"
        "home = os.path.expanduser('~')\n"
        "dirs = [home + '/.local/bin', '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']\n"
        "def sz(p):\n"
        "    try: return os.path.getsize(p)\n"
        "    except OSError: return 0\n"
        "def copilot_li():\n"
        "    try:\n"
        "        lines = open(home + '/.copilot/config.json').read().splitlines()\n"
        "        t = '\\n'.join(l for l in lines if not l.strip().startswith('//'))\n"
        "        d = json.loads(t) if t.strip() else {}\n"
        "        return bool(d.get('loggedInUsers') or d.get('copilotTokens'))\n"
        "    except Exception:\n"
        "        return False\n"
        "LOGIN = {'claude': sz(home + '/.claude/.credentials.json') > 2,\n"
        "         'codex': sz(home + '/.codex/auth.json') > 2, 'pi': True, 'copilot': copilot_li()}\n"
        "res = {}\n"
        "for a in A:\n"
        "    inst = bool(shutil.which(a['bin'])) or any(os.path.exists(d + '/' + a['bin']) for d in dirs)\n"
        "    res[a['id']] = {'installed': inst, 'loggedIn': LOGIN.get(a['id'])}\n"
        "print(json.dumps(res))\n"
    )
    txt = remote_run_python(hid, script)
    try:
        status = json.loads(txt.strip().splitlines()[-1])
    except Exception:
        status = {}
    out = []
    for a in ENABLED_AGENTS:
        st = status.get(a["id"]) or {}
        pub = agent_public(a, st.get("installed", False))
        pub["loggedIn"] = st.get("loggedIn")
        out.append(pub)
    return out


def remote_run_shell(hid, cmd, timeout=300):
    """Run a shell command on a remote host via a login shell; returns combined output."""
    with SSH.lock_for(hid):
        c = SSH.get(hid)
        chan = c["client"].get_transport().open_session()
        try:
            chan.settimeout(timeout)
            chan.get_pty()  # some installers expect a tty
            chan.exec_command("bash -lc " + shlex.quote(cmd))
            out = b""
            while True:
                try:
                    chunk = chan.recv(65536)
                except Exception:
                    break
                if not chunk:
                    break
                out += chunk
            rc = chan.recv_exit_status()
        finally:
            chan.close()  # else the channel leaks against sshd MaxSessions
    return rc, out.decode("utf-8", "replace")


def save_browser_mcp_all(config, name="playwright"):
    """Write an MCP server into EVERY installed agent's config, in its native
    format (Claude/Pi JSON, Codex TOML). Local only. Backs each file up first."""
    from viewer.agents import AGENTS_BY_ID
    cfg = {k: v for k, v in config.items() if v not in (None, "", [], {})}
    results = {}

    def backup(p):
        if p.exists():
            try:
                shutil.copy2(p, str(p) + ".bak-viewer")
            except Exception:
                pass

    if is_installed_local(AGENTS_BY_ID["claude"]):
        try:
            p = Path.home() / ".claude.json"
            data = json.loads(p.read_text()) if p.exists() else {}
            backup(p)
            data.setdefault("mcpServers", {})[name] = cfg
            p.write_text(json.dumps(data, indent=2))
            results["claude"] = "ok"
        except Exception as e:
            results["claude"] = f"error: {e}"

    if is_installed_local(AGENTS_BY_ID["codex"]):
        try:
            import tomllib
            import tomli_w
            p = Path.home() / ".codex" / "config.toml"
            data = tomllib.loads(p.read_text()) if p.exists() else {}
            backup(p)
            data.setdefault("mcp_servers", {})[name] = cfg
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(tomli_w.dumps(data))
            results["codex"] = "ok"
        except Exception as e:
            results["codex"] = f"error: {e}"

    if is_installed_local(AGENTS_BY_ID["pi"]):
        try:
            p = Path.home() / ".pi" / "agent" / "mcp.json"
            data = json.loads(p.read_text()) if p.exists() else {}
            backup(p)
            data.setdefault("mcpServers", {})[name] = cfg
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(data, indent=2))
            results["pi"] = "ok"
        except Exception as e:
            results["pi"] = f"error: {e}"

    return {"saved": [a for a, r in results.items() if r == "ok"], "results": results}


def remote_install_agent(hid, agent):
    with SSH.lock_for(hid):
        home = SSH.get(hid)["home"]
    rc, out = remote_run_shell(hid, install_command(agent, home), timeout=400)
    installed = False
    try:
        installed = bool(json.loads(remote_run_python(
            hid, "import shutil, os, json; h=os.path.expanduser('~');"
                 " print(json.dumps(bool(shutil.which(%r)) or os.path.exists(h+'/.local/bin/'+%r)))"
                 % (agent["bin"], agent["bin"])).strip().splitlines()[-1]))
    except Exception:
        pass
    return {"ok": rc == 0, "returncode": rc, "output": out[-6000:], "installed": installed}


def remote_list_sessions(hid):
    txt = remote_run_python(hid, REMOTE_LIST_SCRIPT)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return []


def remote_projects(hid):
    txt = remote_run_python(hid, REMOTE_PROJECTS_SCRIPT)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return []


# Locate the claude binary on a remote host. `bash -lc` does NOT source
# .bashrc on most distros (non-interactive), so nvm/npm installs are invisible
# to `which claude` — probe the filesystem for the usual install locations.
REMOTE_FIND_CLAUDE_SCRIPT = r"""
import glob, os, re, shutil
cands = []
w = shutil.which('claude')
if w: cands.append(w)
for pat in ['~/.local/bin/claude', '~/.claude/local/claude', '~/bin/claude',
            '/usr/local/bin/claude', '/opt/homebrew/bin/claude']:
    p = os.path.expanduser(pat)
    if os.path.exists(p): cands.append(p)
def ver(p):
    m = re.search(r'/v(\d+)\.(\d+)\.(\d+)/', p)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
for root in ['~/.nvm/versions/node', '~/.local/share/nvm']:
    nvm = glob.glob(os.path.expanduser(root + '/*/bin/claude'))
    if nvm: cands.append(max(nvm, key=ver))
print(cands[0] if cands else '')
"""


def remote_claude_bin(hid):
    """Resolved claude path on the host, cached on the pooled connection
    (so it re-probes after a reconnect)."""
    c = SSH.get(hid)
    if "claude_bin" not in c:
        c["claude_bin"] = remote_run_python(hid, REMOTE_FIND_CLAUDE_SCRIPT).strip() or "claude"
    return c["claude_bin"]


REMOTE_FIND_CODEX_SCRIPT = r"""
import glob, os, re, shutil
cands = []
w = shutil.which('codex')
if w: cands.append(w)
for pat in ['~/.local/bin/codex', '~/bin/codex', '/usr/local/bin/codex',
            '/opt/homebrew/bin/codex', '/usr/bin/codex']:
    p = os.path.expanduser(pat)
    if os.path.exists(p): cands.append(p)
def ver(p):
    m = re.search(r'/v(\d+)\.(\d+)\.(\d+)/', p)
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
for root in ['~/.nvm/versions/node', '~/.local/share/nvm']:
    nvm = glob.glob(os.path.expanduser(root + '/*/bin/codex'))
    if nvm: cands.append(max(nvm, key=ver))
print(cands[0] if cands else '')
"""


def remote_codex_bin(hid):
    """Resolved codex path on the host, cached on the pooled connection."""
    c = SSH.get(hid)
    if "codex_bin" not in c:
        c["codex_bin"] = remote_run_python(hid, REMOTE_FIND_CODEX_SCRIPT).strip() or "codex"
    return c["codex_bin"]


def remote_copilot_bin(hid):
    """Resolved copilot path on the host (the app installs to ~/.local/bin — which
    isn't always on the login-shell PATH, so we resolve an absolute path), cached."""
    c = SSH.get(hid)
    if "copilot_bin" not in c:
        out = remote_run_shell(hid, 'command -v copilot 2>/dev/null || echo "$HOME/.local/bin/copilot"')
        txt = (out[1] if isinstance(out, tuple) else out) or ""
        lines = [ln.strip() for ln in txt.strip().splitlines() if ln.strip()]
        c["copilot_bin"] = (lines[-1] if lines else "") or (c.get("home", "~") + "/.local/bin/copilot")
    return c["copilot_bin"]


def remote_copilot_logged_in(hid):
    """True if Copilot has a stored login on the remote (~/.copilot/config.json has
    loggedInUsers/copilotTokens). The file has // comments, so strip them first."""
    try:
        out = remote_run_shell(hid, "cat ~/.copilot/config.json 2>/dev/null")
        txt = (out[1] if isinstance(out, tuple) else out) or ""
        txt = re.sub(r"^\s*//.*$", "", txt, flags=re.M)
        d = json.loads(txt) if txt.strip() else {}
        return bool(d.get("loggedInUsers") or d.get("copilotTokens"))
    except Exception:
        return False


REMOTE_CODEX_META_SCRIPT = r"""
import json, os
sid = cwd = ""
try:
    with open(REL, errors="replace") as fh:
        for i, line in enumerate(fh):
            if i > 6: break
            try: d = json.loads(line)
            except: continue
            if d.get("type") == "session_meta":
                pl = d.get("payload") or {}
                sid = pl.get("id") or ""; cwd = pl.get("cwd") or ""
                break
except Exception: pass
# The session's recorded workdir may be gone on the host (e.g. a /tmp dir that
# was cleaned up) — fall back to home so `cd` doesn't fail, matching local.
if not cwd or not os.path.isdir(cwd):
    cwd = os.path.expanduser("~")
print(json.dumps({"id": sid, "cwd": cwd}))
"""


def remote_codex_meta(hid, rel):
    """(codex session id, cwd) from a remote rollout's session_meta line, over SSH."""
    full = remote_agent_full_path(hid, "codex", rel)
    if not full:
        return "", ""
    script = "REL = %r\n" % full + REMOTE_CODEX_META_SCRIPT
    try:
        d = json.loads(remote_run_python(hid, script) or "{}")
    except Exception:
        return "", ""
    cwd = d.get("cwd") or ""
    return d.get("id", ""), cwd


def remote_codex_logged_in(hid):
    """Is codex signed in on the remote host (~/.codex/auth.json exists & >2b)?"""
    try:
        out = remote_run_python(
            hid,
            "import os;p=os.path.expanduser('~/.codex/auth.json');"
            "print('1' if os.path.exists(p) and os.path.getsize(p)>2 else '0')",
        )
    except Exception:
        return False
    return out.strip().endswith("1")


# Skills + MCP servers configured ON the remote host (mirrors serve_capabilities
# so the RHS panel and MCP editor act on the host you're connected to, not local).
REMOTE_CAPS_SCRIPT = r"""
import json, os, glob
home = os.path.expanduser('~')
cwd = CWD
skills = []; seen = set()
def desc_of(md):
    try:
        with open(md, errors='replace') as f:
            txt = f.read(4000)
    except Exception:
        return ''
    if txt.startswith('---'):
        end = txt.find('\n---', 3)
        for line in (txt[3:end] if end > 0 else '').splitlines():
            if line.strip().lower().startswith('description:'):
                return line.split(':', 1)[1].strip().strip('"').strip("'")
    return ''
def add_skill(md, source, editable):
    name = os.path.basename(os.path.dirname(md))
    key = source + ':' + name
    if key in seen: return
    seen.add(key)
    skills.append({'name': name, 'description': desc_of(md), 'source': source,
                   'path': md, 'editable': editable})
if cwd:
    for f in sorted(glob.glob(os.path.join(cwd, '.claude', 'skills', '*', 'SKILL.md'))):
        add_skill(f, 'project', True)
for f in sorted(glob.glob(os.path.join(home, '.claude', 'skills', '*', 'SKILL.md'))):
    add_skill(f, 'user', True)
proot = os.path.join(home, '.claude', 'plugins', 'cache')
for f in sorted(glob.glob(os.path.join(proot, '*', '*', '*', 'skills', '*', 'SKILL.md'))):
    parts = f.split(os.sep)
    add_skill(f, 'plugin:' + parts[-5], False)
mcp = []
def add_mcp(name, cfg, scope, editable):
    if not isinstance(cfg, dict): return
    transport = cfg.get('type') or ('http' if cfg.get('url') else 'stdio')
    target = cfg.get('url') or ' '.join([cfg.get('command', '')] + list(cfg.get('args', [])))
    mcp.append({'name': name, 'scope': scope, 'transport': transport,
                'target': target.strip(), 'config': cfg, 'editable': editable})
try:
    cj = json.load(open(os.path.join(home, '.claude.json')))
except Exception:
    cj = {}
for name, cfg in (cj.get('mcpServers') or {}).items():
    add_mcp(name, cfg, 'global', True)
if cwd:
    proj = (cj.get('projects') or {}).get(cwd) or {}
    for name, cfg in (proj.get('mcpServers') or {}).items():
        add_mcp(name, cfg, 'project-global', False)
    try:
        pm = json.load(open(os.path.join(cwd, '.mcp.json')))
        for name, cfg in (pm.get('mcpServers') or {}).items():
            add_mcp(name, cfg, 'project', True)
    except Exception:
        pass
for pf in sorted(glob.glob(os.path.join(proot, '*', '*', '*', '.mcp.json'))):
    try:
        pd = json.load(open(pf))
    except Exception:
        continue
    for name, cfg in (pd.get('mcpServers') or {}).items():
        add_mcp(name, cfg, 'plugin:' + pf.split(os.sep)[-3], False)
print(json.dumps({'skills': skills, 'mcp': mcp}))
"""


# Add / edit / delete an MCP server in the remote host's config (global
# ~/.claude.json or project <cwd>/.mcp.json). Mirrors handle_mcp_save.
REMOTE_MCP_SAVE_SCRIPT = r"""
import json, os, shutil, sys
name = P['name']; scope = P['scope']; cfg = P.get('config')
cwd = P.get('cwd'); delete = P.get('delete')
home = os.path.expanduser('~')
if scope == 'global':
    path = os.path.join(home, '.claude.json')
    try:
        data = json.load(open(path))
    except Exception as e:
        print(json.dumps({'error': 'Cannot read ~/.claude.json: ' + str(e)})); sys.exit()
    shutil.copy2(path, path + '.bak-viewer')
elif scope == 'project':
    if not cwd:
        print(json.dumps({'error': 'Session not found for project scope'})); sys.exit()
    path = os.path.join(cwd, '.mcp.json')
    try:
        data = json.load(open(path)) if os.path.exists(path) else {}
    except Exception:
        data = {}
    if os.path.exists(path):
        shutil.copy2(path, path + '.bak-viewer')
else:
    print(json.dumps({'error': 'Scope must be global or project'})); sys.exit()
servers = data.setdefault('mcpServers', {})
if delete:
    if servers.pop(name, None) is None:
        print(json.dumps({'error': 'Server not found in that scope'})); sys.exit()
else:
    servers[name] = cfg
try:
    open(path, 'w').write(json.dumps(data, indent=2))
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit()
print(json.dumps({'saved': True, 'file': path}))
"""


def remote_capabilities(hid, cwd):
    hdr = "CWD=" + json.dumps(cwd or "") + "\n"
    txt = remote_run_python(hid, hdr + REMOTE_CAPS_SCRIPT)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"skills": [], "mcp": []}


def remote_mcp_save(hid, name, scope, cfg, cwd, delete=False):
    # Reconstruct params via json.loads of a Python string literal: JSON
    # booleans/null (false/true/null) are NOT valid Python literals, so a raw
    # json.dumps embedded as `P={...}` would raise NameError on the host.
    params = {"name": name, "scope": scope, "config": cfg,
              "cwd": cwd or "", "delete": bool(delete)}
    hdr = "import json\nP = json.loads(%r)\n" % json.dumps(params)
    txt = remote_run_python(hid, hdr + REMOTE_MCP_SAVE_SCRIPT)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "remote MCP op failed: " + txt.strip()[-300:]}


def remote_full_path(hid, rel):
    """Map a 'projects/...' rel path to an absolute remote path; guard traversal."""
    c = SSH.get(hid)
    root = c["home"].rstrip("/") + "/.claude"
    p = posixpath.normpath(root + "/" + rel)
    if p != root and not p.startswith(root + "/"):  # trailing sep: block ~/.claude-evil
        return None
    return p


def remote_agent_root(hid, agent_id):
    """Absolute sessions root for an agent on a remote host (e.g. ~/.codex/sessions)."""
    c = SSH.get(hid)
    sub = get_agent(agent_id)["sessions"].replace("~/", "").replace("~", "").lstrip("/")
    return c["home"].rstrip("/") + "/" + sub


def remote_agent_full_path(hid, agent_id, rel):
    root = remote_agent_root(hid, agent_id)
    p = posixpath.normpath(root + "/" + rel)
    if p != root and not p.startswith(root + "/"):  # trailing sep: block sibling-dir escape
        return None
    return p


def remote_read_agent_session(hid, agent_id, rel, q):
    """tail/before/from over SFTP for a Codex/Pi session, normalised to Claude schema."""
    with SSH.sftp(hid) as sftp:
        full = remote_agent_full_path(hid, agent_id, rel)
        if not full:
            return None
        try:
            size = sftp.stat(full).st_size
        except IOError:
            return None
        f = sftp.open(full, "rb")
        f.prefetch = getattr(f, "prefetch", lambda *a, **k: None)
        try:
            if "from" in q:
                start = max(0, min(int(q["from"][0]), size))
                length = min(size - start, MAX_POLL_BYTES)
                f.seek(start)
                data = f.read(length)
                if start + length < size:
                    nl = data.rfind(b"\n")
                    data = data[:nl + 1] if nl >= 0 else b""
                lines, end = split_lines(data, start)
                res = {"start": start, "end": end, "size": size, "lines": lines}
            elif "tail" in q:
                n = max(1, min(int(q["tail"][0]), 5000))
                start, data = read_back_f(f, size, n)
                lines, end = split_lines(data, start)
                res = {"start": start, "end": end, "size": size, "lines": lines}
            else:  # before
                end_off = max(0, min(int(q["before"][0]), size))
                n = max(1, min(int((q.get("lines") or ["300"])[0]), 5000))
                start, data = read_back_f(f, end_off, n)
                lines, _ = split_lines(data, start)
                res = {"start": start, "end": end_off, "size": size, "lines": lines}
        finally:
            f.close()
    res["lines"] = normalize_lines(agent_id, res["lines"])
    return res


# Self-contained remote discovery for Codex/Pi (runs on the host via python3).
_REMOTE_AGENT_LIST_BODY = '''
import os, glob, json
root = P["root"]; agent = P["agent"]
META = ("<environment_context>", "<user_instructions>", "<permissions")
def btext(content, types):
    if isinstance(content, str): return content
    if isinstance(content, list):
        return " ".join(b.get("text","") for b in content if isinstance(b, dict) and b.get("type") in types and b.get("text"))
    return ""
def peek(f):
    cwd = title = ""
    try:
        with open(f, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 80 or (cwd and title): break
                try: d = json.loads(line)
                except Exception: continue
                if agent == "codex":
                    if d.get("type") == "session_meta": cwd = (d.get("payload") or {}).get("cwd") or cwd
                    p = d.get("payload") or {}
                    if not title and p.get("type") == "user_message" and p.get("message"): title = str(p["message"])
                    if not title and p.get("type") == "message" and p.get("role") == "user":
                        t = btext(p.get("content"), ("input_text","text"))
                        if t and not t.lstrip().startswith(META): title = t
                elif agent == "pi":
                    if d.get("type") == "session": cwd = d.get("cwd") or cwd
                    if not title and d.get("type") == "message":
                        m = d.get("message") or {}
                        if m.get("role") == "user": title = btext(m.get("content"), ("text",))
                elif agent == "copilot":
                    if d.get("type") == "session.start": cwd = ((d.get("data") or {}).get("context") or {}).get("cwd") or cwd
                    if not title and d.get("type") == "user.message": title = (d.get("data") or {}).get("content") or ""
    except Exception: pass
    return cwd, " ".join(title.split())[:80]
out = []
for f in glob.glob(root + "/**/*.jsonl", recursive=True):
    # Copilot: one session per <id>/ dir, transcript = events.jsonl, id = DIR name.
    if agent == "copilot" and os.path.basename(f) != "events.jsonl": continue
    try: st = os.stat(f)
    except OSError: continue
    cwd, title = peek(f)
    sid = os.path.basename(os.path.dirname(f)) if agent == "copilot" else os.path.splitext(os.path.basename(f))[0]
    out.append({"id": sid, "path": os.path.relpath(f, root), "title": title or sid[:8],
                "project": cwd or os.path.basename(os.path.dirname(f)), "size": st.st_size, "modified": st.st_mtime})
out.sort(key=lambda s: s["modified"], reverse=True)
print(json.dumps(out))
'''


def remote_list_sessions_agent(hid, agent_id):
    with SSH.lock_for(hid):
        root = remote_agent_root(hid, agent_id)
    script = "import json\nP = json.loads(" + repr(json.dumps({"root": root, "agent": agent_id})) + ")\n" + _REMOTE_AGENT_LIST_BODY
    txt = remote_run_python(hid, script)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return []


def remote_read_session(hid, rel, q):
    """Serve tail/before/from over SFTP (byte-offset identical to local)."""
    with SSH.sftp(hid) as sftp:
        full = remote_full_path(hid, rel)
        if not full:
            return None
        try:
            size = sftp.stat(full).st_size
        except IOError:
            return None
        f = sftp.open(full, "rb")
        f.prefetch = getattr(f, "prefetch", lambda *a, **k: None)
        try:
            if "from" in q:
                start = max(0, min(int(q["from"][0]), size))
                length = min(size - start, MAX_POLL_BYTES)
                f.seek(start)
                data = f.read(length)
                if start + length < size:
                    nl = data.rfind(b"\n")
                    data = data[:nl + 1] if nl >= 0 else b""
                lines, end = split_lines(data, start)
                return {"start": start, "end": end, "size": size, "lines": lines}
            elif "tail" in q:
                n = max(1, min(int(q["tail"][0]), 5000))
                start, data = read_back_f(f, size, n)
                lines, end = split_lines(data, start)
                return {"start": start, "end": end, "size": size, "lines": lines}
            else:  # before
                end_off = max(0, min(int(q["before"][0]), size))
                n = max(1, min(int((q.get("lines") or ["300"])[0]), 5000))
                start, data = read_back_f(f, end_off, n)
                lines, _ = split_lines(data, start)
                return {"start": start, "end": end_off, "size": size, "lines": lines}
        finally:
            f.close()


def remote_extract_cwd(hid, rel):
    with SSH.sftp(hid) as sftp:
        full = remote_full_path(hid, rel)
        if not full:
            return None
        try:
            f = sftp.open(full, "r")
            try:
                for _ in range(100):
                    line = f.readline()
                    if not line:
                        break
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    if o.get("cwd"):
                        return o["cwd"]
            finally:
                f.close()
        except IOError:
            pass
        return SSH.get(hid)["home"]


def _remote_expand(home, raw):
    """SFTP has no ~ expansion; map ~, ~/x, and '' to absolute remote paths."""
    raw = (raw or "~").strip()
    if raw in ("~", ""):
        return home
    if raw.startswith("~/"):
        return home.rstrip("/") + "/" + raw[2:]
    return raw


def remote_fs(hid, raw, show_hidden=False):
    import stat as statmod
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        try:
            p = sftp.normalize(_remote_expand(c["home"], raw))
        except IOError:
            return {"error": "Not a directory"}
        entries = []
        truncated = False
        try:
            for attr in sftp.listdir_attr(p):
                name = attr.filename
                if not show_hidden and name.startswith("."):
                    continue
                is_dir = statmod.S_ISDIR(attr.st_mode)
                entries.append({"name": name, "dir": is_dir,
                                "size": 0 if is_dir else attr.st_size, "mtime": attr.st_mtime})
                if len(entries) >= 800:
                    truncated = True
                    break
        except IOError as e:
            return {"error": str(e)}
        parent = posixpath.dirname(p) if p != "/" else None
        return {"path": p, "parent": parent, "entries": entries, "home": c["home"], "truncated": truncated}


def remote_mkdir(hid, path, name):
    if not _safe_seg(name):
        return {"error": "invalid folder name"}
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        base = sftp.normalize(_remote_expand(c["home"], path))
        target = posixpath.join(base, name)
        try:
            sftp.mkdir(target)
        except IOError as e:
            return {"error": "Folder already exists or cannot be created: " + str(e)}
        return {"created": target}


def remote_delete(hid, fpath):
    """Move a remote file/dir into ~/.viewer-trash (reversible), not rm -rf."""
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        target = sftp.normalize(_remote_expand(c["home"], fpath))
        if target in ("/", c["home"]):
            return {"error": "Refusing to delete this path"}
        trash = posixpath.join(c["home"], ".viewer-trash")
        try:
            sftp.mkdir(trash)
        except IOError:
            pass
        dest = posixpath.join(trash, posixpath.basename(target))
        try:
            sftp.stat(dest)
            dest = dest + "." + str(int(time.time()))
        except IOError:
            pass
        try:
            sftp.rename(target, dest)
        except IOError as e:
            return {"error": f"Cannot delete: {e}"}
        return {"deleted": target, "trash": dest}


def remote_read_bytes(hid, fpath):
    """Read a remote file into memory (≤200MB) → {"bytes","name"} or {"error"}."""
    import stat as statmod
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        target = sftp.normalize(_remote_expand(c["home"], fpath))
        try:
            st = sftp.stat(target)
            if statmod.S_ISDIR(st.st_mode):
                return {"error": "Is a directory"}
            if st.st_size > 200 * 1024 * 1024:  # 200 MB limit
                return {"error": "File too large (> 200 MB)"}
            with sftp.open(target, "rb") as f:
                f.prefetch(st.st_size)
                content = f.read()
            return {"bytes": content, "name": posixpath.basename(target)}
        except IOError as e:
            return {"error": f"Cannot download: {e}"}


def remote_upload(hid, path, files):
    """Write uploaded (name, bytes) pairs into a remote directory via SFTP."""
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        base = sftp.normalize(_remote_expand(c["home"], path))
        uploaded = []
        for fn, content in files:
            if not _safe_seg(fn):
                uploaded.append({"name": fn, "error": "invalid filename"})
                continue
            target = posixpath.join(base, fn)
            try:
                with sftp.open(target, "wb") as f:
                    f.write(content)
                uploaded.append({"name": fn, "size": len(content), "path": target})
            except Exception as e:
                uploaded.append({"name": fn, "error": str(e)})
        return {"uploaded": uploaded}


def remote_rename(hid, fpath, name):
    """Rename a remote file/dir within its parent directory."""
    if not _safe_seg(name):
        return {"error": "invalid name"}
    with SSH.sftp(hid) as sftp:
        c = SSH.get(hid)
        target = sftp.normalize(_remote_expand(c["home"], fpath))
        dest = posixpath.join(posixpath.dirname(target), name)
        try:
            try:
                sftp.stat(dest)
                return {"error": "A file with that name already exists"}
            except IOError:
                pass
            sftp.rename(target, dest)
        except IOError as e:
            return {"error": f"Cannot rename: {e}"}
        return {"renamed": dest}


def remote_compress(hid, path, names, archive):
    """Zip named items inside a remote directory (via python3 on the host)."""
    params_lit = repr(json.dumps({"base": path, "names": names, "archive": archive or ""}))
    script = (
        "import os, json, zipfile, posixpath\n"
        "P = json.loads(" + params_lit + ")\n"
        "base = os.path.expanduser(P['base']); names = P['names']; arc = P['archive']\n"
        "if not arc: arc = (names[0] + '.zip') if len(names) == 1 else 'Archive.zip'\n"
        "if not arc.endswith('.zip'): arc += '.zip'\n"
        "stem = arc[:-4]; dest = posixpath.join(base, arc); i = 2\n"
        "while os.path.exists(dest):\n"
        "    dest = posixpath.join(base, stem + ' ' + str(i) + '.zip'); i += 1\n"
        "try:\n"
        "    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:\n"
        "        for n in names:\n"
        "            src = posixpath.join(base, n)\n"
        "            if os.path.isdir(src):\n"
        "                for root, dirs, files in os.walk(src):\n"
        "                    for f in files:\n"
        "                        full = os.path.join(root, f)\n"
        "                        z.write(full, os.path.relpath(full, base))\n"
        "            elif os.path.isfile(src):\n"
        "                z.write(src, os.path.relpath(src, base))\n"
        "    print(json.dumps({'created': dest}))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'error': str(e)}))\n"
    )
    txt = remote_run_python(hid, script)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "Compress failed: " + txt[-200:]}


def remote_build_zip(hid, path, names):
    """Zip named items into a TEMP file on the host → {"tmp"} or {"error"}.

    Used for download-as-zip: the archive never lands in the browsed dir; the
    caller streams it back and deletes it via remote_unlink.
    """
    params_lit = repr(json.dumps({"base": path, "names": names}))
    script = (
        "import os, json, zipfile, posixpath, tempfile\n"
        "P = json.loads(" + params_lit + ")\n"
        "base = os.path.expanduser(P['base']); names = P['names']\n"
        "fd, tmp = tempfile.mkstemp(suffix='.zip'); os.close(fd)\n"
        "try:\n"
        "    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:\n"
        "        for n in names:\n"
        "            src = posixpath.join(base, n)\n"
        "            if os.path.isdir(src):\n"
        "                for root, dirs, files in os.walk(src):\n"
        "                    for f in files:\n"
        "                        full = os.path.join(root, f)\n"
        "                        z.write(full, os.path.relpath(full, base))\n"
        "            elif os.path.isfile(src):\n"
        "                z.write(src, os.path.relpath(src, base))\n"
        "    print(json.dumps({'tmp': tmp}))\n"
        "except Exception as e:\n"
        "    os.path.exists(tmp) and os.unlink(tmp)\n"
        "    print(json.dumps({'error': str(e)}))\n"
    )
    txt = remote_run_python(hid, script)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "Zip failed: " + txt[-200:]}


def remote_unlink(hid, path):
    with SSH.sftp(hid) as sftp:
        try:
            sftp.remove(path)
        except IOError:
            pass


def content_disposition(name):
    """RFC 5987 attachment header that survives non-ASCII filenames.

    Python's http.server latin-1-encodes header values, so a raw Unicode
    filename (e.g. the U+202F narrow no-break space macOS uses in screenshot
    names) raises UnicodeEncodeError mid-response and the browser reports a
    failed download. Emit an ASCII fallback plus a percent-encoded UTF-8
    filename* that modern browsers prefer.
    """
    from urllib.parse import quote
    fallback = name.encode("ascii", "ignore").decode("ascii").replace('"', "").replace("\\", "").strip() or "download"
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (fallback, quote(name))


def remote_resolve(hid, sid):
    with SSH.lock_for(hid):
        c = SSH.get(hid)
        _, out, _ = c["client"].exec_command(
            f"ls ~/.claude/projects/*/{shlex.quote(sid)}.jsonl 2>/dev/null | head -1", timeout=10)
        try:
            line = out.read().decode().strip()
        finally:
            out.channel.close()  # close the exec channel so it doesn't leak
    if not line:
        return {"found": False}
    root = c["home"].rstrip("/") + "/.claude/"
    rel = line[len(root):] if line.startswith(root) else None
    return {"found": bool(rel), "path": rel}


# Fork / restore / rename / delete on a remote host, run as a python helper over
# SSH so the exact local logic is reused. Params are embedded via json.dumps
# (JSON string literals are valid python literals, so this is injection-safe).
def remote_session_edit(hid, op, sid, **params):
    hdr = "import json,os,uuid,glob,sys,time\n" + \
          "P=" + json.dumps({"sid": sid, **params}) + "\n"
    body = REMOTE_EDIT_SCRIPTS[op]
    txt = remote_run_python(hid, hdr + body)
    try:
        return json.loads(txt.strip().splitlines()[-1])
    except Exception:
        return {"error": "remote op failed: " + txt.strip()[-300:]}


REMOTE_EDIT_SCRIPTS = {
    "fork": r"""
base=os.path.expanduser('~/.claude/projects')
m=glob.glob(base+'/*/'+P['sid']+'.jsonl')
if not m: print(json.dumps({"error":"Session not found on host"})); sys.exit()
src=m[0]; new_sid=str(uuid.uuid4()); dst=os.path.join(os.path.dirname(src),new_sid+'.jsonl')
before=[]; cut=None
for line in open(src, errors='replace'):
    try: o=json.loads(line)
    except: before.append(line); continue
    if o.get('uuid')==P['uuid']: cut=o; break
    before.append(line)
if cut is None: print(json.dumps({"error":"Message not found in session"})); sys.exit()
with open(dst,'w') as fo:
    for line in before:
        try:
            o=json.loads(line)
            if o.get('sessionId'): o['sessionId']=new_sid
            fo.write(json.dumps(o)+'\n')
        except: fo.write(line if line.endswith('\n') else line+'\n')
    if P.get('title'):
        fo.write(json.dumps({"type":"custom-title","customTitle":P['title'],"sessionId":new_sid,"timestamp":time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime())})+'\n')
c=(cut.get('message') or {}).get('content')
msg=c if isinstance(c,str) else (''.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text') if isinstance(c,list) else '')
print(json.dumps({"forked":True,"path":'projects/'+os.path.relpath(dst,base),"session":new_sid,"message":msg}))
""",
    "restore": r"""
base=os.path.expanduser('~/.claude/projects')
m=glob.glob(base+'/*/'+P['sid']+'.jsonl')
if not m: print(json.dumps({"error":"Session not found on host"})); sys.exit()
src=m[0]; before=[]; cut=None
for line in open(src, errors='replace'):
    try: o=json.loads(line)
    except: before.append(line); continue
    if o.get('uuid')==P['uuid']: cut=o; break
    before.append(line)
if cut is None: print(json.dumps({"error":"Message not found in session"})); sys.exit()
bak=src+'.bak-'+str(int(time.time()))
os.rename(src,bak)
with open(src,'w') as fo:
    for line in before: fo.write(line if line.endswith('\n') else line+'\n')
c=(cut.get('message') or {}).get('content')
msg=c if isinstance(c,str) else (''.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text') if isinstance(c,list) else '')
print(json.dumps({"restored":True,"message":msg,"backup":os.path.basename(bak)}))
""",
    "rename": r"""
base=os.path.expanduser('~/.claude/projects')
m=glob.glob(base+'/*/'+P['sid']+'.jsonl')
if not m: print(json.dumps({"error":"Session not found on host"})); sys.exit()
with open(m[0],'a') as f:
    f.write(json.dumps({"type":"custom-title","customTitle":P['title'],"sessionId":P['sid'],"timestamp":time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime())})+'\n')
print(json.dumps({"renamed":True,"title":P['title']}))
""",
    "delete": r"""
base=os.path.expanduser('~/.claude/projects')
m=glob.glob(base+'/*/'+P['sid']+'.jsonl')
if not m: print(json.dumps({"error":"Session not found on host"})); sys.exit()
src=m[0]; trash=os.path.expanduser('~/.claude/.viewer-trash/'+os.path.basename(os.path.dirname(src)))
os.makedirs(trash,exist_ok=True)
dst=os.path.join(trash,os.path.basename(src))
os.rename(src,dst)
print(json.dumps({"deleted":True,"trash":dst}))
""",
}


# ---- remote permission MCP (for AskUserQuestion on SSH hosts) -------------------
# A driven `claude` on a remote host must reach the viewer's /api/chat/permission to
# ask the user a question. Rather than an SSH reverse tunnel (many sshd configs deny
# remote port-forwarding), the remote MCP dials the viewer DIRECTLY at its
# tailnet IP:PORT (the viewer binds 0.0.0.0, reachable across the tailnet). We SFTP
# the tiny stdio permission_mcp.py + its --mcp-config onto the host and pass
# VIEWER_PERM_BASE=<tailnet base> in the remote env.

_REMOTE_PERM_DIR = ".claude/.viewer-perm"
_viewer_tailnet_ip = None


def viewer_tailnet_base(port):
    """The viewer's own tailnet URL a remote host can call back to
    (http://<tailscale-ip>:<port>), or None if tailscale isn't available."""
    global _viewer_tailnet_ip
    if _viewer_tailnet_ip is None:
        import subprocess
        try:
            r = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
            _viewer_tailnet_ip = (r.stdout or "").strip().splitlines()[0].strip() if r.stdout else ""
        except Exception:
            _viewer_tailnet_ip = ""
    return f"http://{_viewer_tailnet_ip}:{port}" if _viewer_tailnet_ip else None


def remote_setup_perm_mcp(hid, port):
    """Ship permission_mcp.py + an --mcp-config onto the host so a remote claude can
    drive the viewer permission tool (reaching the viewer at its tailnet IP).
    Returns the REMOTE --mcp-config path, or raises if the viewer isn't reachable."""
    if not viewer_tailnet_base(port):
        raise RuntimeError("no tailnet address for the viewer (remote AUQ needs it)")
    helper_src = (Path(__file__).parent / "permission_mcp.py").read_text()
    kanban_src = (Path(__file__).parent / "kanban_mcp.py").read_text()
    with SSH.sftp(hid) as sftp:
        home = SSH.get(hid)["home"].rstrip("/")
        d = f"{home}/{_REMOTE_PERM_DIR}"
        # mkdir -p the perm dir, segment by segment (SFTP has no recursive mkdir)
        cur = home
        for seg in _REMOTE_PERM_DIR.split("/"):
            cur = f"{cur}/{seg}"
            try:
                sftp.mkdir(cur)
            except IOError:
                pass
        helper_path = f"{d}/permission_mcp.py"
        kanban_path = f"{d}/kanban_mcp.py"
        cfg_path = f"{d}/mcp.json"
        with sftp.open(helper_path, "w") as f:
            f.write(helper_src)
        with sftp.open(kanban_path, "w") as f:
            f.write(kanban_src)
        cfg = {"mcpServers": {
            "viewerperm": {"command": "python3", "args": [helper_path]},
            "viewerkanban": {"command": "python3", "args": [kanban_path]},
        }}
        # Merge user MCP servers from ~/.claude/mcp.json on the remote host
        try:
            user_mcp_path = f"{home}/.claude/mcp.json"
            with sftp.open(user_mcp_path, "r") as uf:
                user_cfg = json.loads(uf.read())
            for name, srv in (user_cfg.get("mcpServers") or {}).items():
                if name not in cfg["mcpServers"]:
                    cfg["mcpServers"][name] = srv
        except Exception:
            pass
        with sftp.open(cfg_path, "w") as f:
            f.write(json.dumps(cfg))
    return cfg_path
