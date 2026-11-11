"""Sessions on a remote host: listing, reading, resolving, cwd discovery and
fork/restore/rename/delete, run as python payloads over SSH."""
import json
import posixpath
import shlex
from orchestrator.config import (
    MAX_POLL_BYTES, read_back_f, split_lines,
)
from orchestrator.agents import get_agent
from orchestrator.adapters import normalize_lines
from orchestrator.remote.transport import SSH, remote_run_python


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
    try:
        with open(f, 'rb') as fh:
            proj = last_cwd_in_file(fh)
    except OSError:
        proj = None
    # The dir name is a lossy fallback: '/', ' ' and '-' all encode as '-'.
    proj = proj or os.path.basename(os.path.dirname(f)).replace('-home-', '~/').replace('--', '/').replace('-', '/')
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


def remote_list_sessions(hid):
    import inspect
    from orchestrator.sessions import last_cwd_in_file
    txt = remote_run_python(hid, inspect.getsource(last_cwd_in_file) + REMOTE_LIST_SCRIPT)
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
    """Extract the cwd from a remote session using the unified last-cwd strategy.
    Ships last_cwd_in_file to the host via remote_run_python so the
    algorithm is identical to local — the LAST cwd wins (correct for forks)."""
    full = remote_full_path(hid, rel)
    if not full:
        return None
    import inspect
    from orchestrator.sessions import last_cwd_in_file
    script = ("import json, sys\n"
              + inspect.getsource(last_cwd_in_file)
              + "P = json.loads(%r)\n" % json.dumps({"path": full})
              + "try:\n"
                "    with open(P['path'], 'rb') as fh:\n"
                "        cwd = last_cwd_in_file(fh)\n"
                "except OSError:\n"
                "    cwd = None\n"
                "print(json.dumps(cwd))\n")
    txt = remote_run_python(hid, script)
    try:
        cwd = json.loads(txt.strip().splitlines()[-1])
    except Exception:
        cwd = None
    if cwd:
        return cwd
    with SSH.lock_for(hid):
        return SSH.get(hid)["home"]


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
