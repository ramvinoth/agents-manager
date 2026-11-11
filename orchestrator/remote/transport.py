"""SSH transport: the per-host connection pool, host config test, and the
exec helpers (python/shell over SSH) every other remote module builds on."""
import os
import shlex
import socket
import threading
import time
from contextlib import contextmanager
from orchestrator import db


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
        return db.hosts_load().get(hid)

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
