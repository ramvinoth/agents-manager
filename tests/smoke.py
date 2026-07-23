#!/usr/bin/env python3
"""Characterization smoke net for Agents.

Locks the observable behaviour of every host-branching endpoint on BOTH a local
and a remote host, so the Host-abstraction refactor can be proven behaviour-
preserving. Run before and after each change; the set of PASS/FAIL must not
regress. Exit code 0 = all green.

Usage:  python3 tests/smoke.py [BASE_URL] [REMOTE_HID]
"""
import json
import os
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8091"
# Remote host id to exercise the SSH path: CLI arg, else $VIEWER_TEST_REMOTE.
# Empty = skip the remote half (so `make check` passes with no host configured).
REMOTE = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("VIEWER_TEST_REMOTE", "")

# The API requires a logged-in session — mint one for a dedicated `_ci` account
# (see tests/ci_auth.py: random, gitignored per-machine secret) and send it as
# the session cookie, like any authenticated client.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # repo root -> `viewer`
sys.path.insert(0, _HERE)                   # tests/    -> `ci_auth`
try:
    import viewer.db as db
    from ci_auth import mint
    _TOK = mint()
    _AUTH = {"Cookie": f"{db.SESSION_COOKIE}={_TOK}"} if _TOK else {}
except Exception as _e:
    print(f"  (auth: could not mint a CI session — {_e}; requests may 401)")
    _AUTH = {}

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))
    return ok


def get(path, timeout=60):
    req = urllib.request.Request(BASE + path, headers=_AUTH)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode())


def post(path, body, timeout=90):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **_AUTH}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode())


def hq(hid, sep="&"):
    return "" if hid == "local" else f"{sep}host={hid}"


def run_for_host(hid, label):
    print(f"\n----- {label} ({hid}) -----")
    # sessions list
    try:
        _, sessions = get(f"/api/sessions{hq(hid,'?')}")
        ok = isinstance(sessions, list) and len(sessions) > 0
        check(f"[{label}] sessions list", ok, f"{len(sessions) if ok else sessions} sessions")
    except Exception as e:
        check(f"[{label}] sessions list", False, str(e)[:80]); return
    sample = sessions[0]["path"]

    # session read (tail)
    try:
        _, d = get(f"/api/session/{sample}?tail=5{hq(hid)}")
        check(f"[{label}] session read (tail)", "lines" in d and isinstance(d["lines"], list))
    except Exception as e:
        check(f"[{label}] session read (tail)", False, str(e)[:80])

    # session-meta
    try:
        _, d = get(f"/api/session-meta?session={sample}{hq(hid)}")
        check(f"[{label}] session-meta", "cwd" in d)
    except Exception as e:
        check(f"[{label}] session-meta", False, str(e)[:80])

    # resolve
    try:
        sid = sample.rsplit("/", 1)[-1].replace(".jsonl", "")
        _, d = get(f"/api/resolve?id={sid}{hq(hid)}")
        check(f"[{label}] resolve", d.get("found") is True, d.get("path", ""))
    except Exception as e:
        check(f"[{label}] resolve", False, str(e)[:80])

    # fs (home)
    try:
        _, d = get(f"/api/fs?path=~{hq(hid)}")
        check(f"[{label}] fs (home)", "entries" in d and "home" in d, f"{len(d.get('entries', []))} entries")
    except Exception as e:
        check(f"[{label}] fs (home)", False, str(e)[:80])

    # projects (new-session dir picker)
    try:
        _, d = get(f"/api/projects{hq(hid,'?')}")
        check(f"[{label}] projects", isinstance(d, list), f"{len(d) if isinstance(d,list) else d} dirs")
    except Exception as e:
        check(f"[{label}] projects", False, str(e)[:80])

    # capabilities (skills + mcp)
    try:
        _, d = get(f"/api/capabilities?session={sample}{hq(hid)}")
        check(f"[{label}] capabilities", "skills" in d and "mcp" in d,
              f"{len(d.get('skills',[]))} skills / {len(d.get('mcp',[]))} mcp")
    except Exception as e:
        check(f"[{label}] capabilities", False, str(e)[:80])

    # session-summary (server-computed, host-aware)
    try:
        _, d = get(f"/api/session-summary?session={sample}{hq(hid)}", timeout=120)
        check(f"[{label}] session-summary", "lines" in d and "userMessages" in d,
              f"{d.get('lines')} lines, {d.get('userMessages')} user msgs")
    except Exception as e:
        check(f"[{label}] session-summary", False, str(e)[:100])

    # browser status (host-aware probe)
    try:
        _, d = get(f"/api/browser/status{hq(hid,'?')}", timeout=60)
        check(f"[{label}] browser status", "running" in d, f"running={d.get('running')}")
    except Exception as e:
        check(f"[{label}] browser status", False, str(e)[:80])


def main():
    # basic liveness
    try:
        _, d = get("/api/default")
        check("server default", "default" in d)
        _, hosts = get("/api/hosts")
        check("hosts list", isinstance(hosts, list) and len(hosts) >= 1, f"{len(hosts)} hosts")
    except Exception as e:
        check("server liveness", False, str(e)[:80]); print("SERVER DOWN"); sys.exit(1)

    run_for_host("local", "LOCAL")
    if REMOTE and REMOTE != "local":
        run_for_host(REMOTE, "REMOTE")
    else:
        print("\n----- REMOTE: skipped (pass a host id or set VIEWER_TEST_REMOTE to exercise the SSH path) -----")

    passed = sum(results)
    total = len(results)
    print(f"\n==== {passed}/{total} checks passed ====")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
