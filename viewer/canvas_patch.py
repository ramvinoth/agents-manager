"""viewer.canvas_patch — turn an agent's canvas ops into Excalidraw elements (pure).

An agent writes intent, not Excalidraw internals: "a rectangle labelled Build at
(0,0)", "an arrow from a to b", "set this text". `build` expands each op into
complete elements (every field the Excalidraw renderer reads), assigns the
conflict clock (version = stored + 1, a fresh random nonce) and returns them for
Room.patch to merge — so an agent's edit flows through exactly the path a
human's does and every open browser sees it live.

Ownership: at Own work level an agent may change or delete only elements it
created (customData.createdBy). Binding bookkeeping — adding an arrow or label
id to a shape's boundElements so they move together — is allowed on any shape:
it changes no content anyone drew.
"""
import random
import secrets
import time

MAX_OPS = 2000
KINDS = ("rectangle", "diamond", "ellipse", "text", "arrow", "line", "frame", "embeddable")
# A doc tile (embeddable) needs room to read; a shape's 160x80 would show a line.
DEFAULT_SIZE = {"embeddable": (480.0, 320.0)}
# Fields an update may set. Anything structural (id, type, version, bindings)
# stays the server's business.
SETTABLE = frozenset({"x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
                      "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity",
                      "text", "name", "link", "locked", "points", "fontSize", "customData"})
FONT_SIZE = 20
LINE_HEIGHT = 1.25
CHAR_W = 0.6                 # average glyph width / font size — the client re-measures
DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _id():
    return secrets.token_urlsafe(15)[:20].replace("-", "a").replace("_", "b")


def _nonce():
    return random.randint(1, 2**31 - 1)


def _text_size(text, size):
    lines = (text or "").split("\n")
    return (max(len(l) for l in lines) * size * CHAR_W, len(lines) * size * LINE_HEIGHT)


def _int_len(head):
    if "a" <= head <= "z":
        return ord(head) - ord("a") + 2
    if "A" <= head <= "Z":
        return ord("Z") - ord(head) + 2
    raise ValueError(f"bad index head {head!r}")


def index_after(key):
    """A fractional index (Excalidraw's z-order key, rocicorp/fractional-indexing
    format) above `key`: the next integer key. Every new element gets one, so a
    browser has nothing to fill in — a filled-in index is a new version, and that
    would look like a person editing what the agent just drew."""
    if not key:
        return "a0"
    n = _int_len(key[0])
    head, digs = key[0], list(key[1:n])
    for i in range(len(digs) - 1, -1, -1):
        d = DIGITS.index(digs[i])
        if d < len(DIGITS) - 1:
            digs[i] = DIGITS[d + 1]
            return head + "".join(digs)
        digs[i] = "0"
    if head == "z":                    # the integer space ran out: extend the fraction
        return key + "V"
    head = chr(ord(head) + 1)
    if head > "a":
        digs.append("0")
    else:
        digs.pop()
    return head + "".join(digs)


def _top_index(stored):
    """The highest index on the canvas (None when nothing has one)."""
    keys = [e.get("index") for e in stored.values() if isinstance(e.get("index"), str) and e.get("index")]
    return max(keys) if keys else None


def _base(kind, x, y, w, h, actor, extra=None):
    el = {
        "id": _id(), "type": kind, "x": float(x), "y": float(y),
        "width": float(w), "height": float(h), "angle": 0,
        "strokeColor": "#1e1e1e", "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 1, "opacity": 100,
        "groupIds": [], "frameId": None, "index": None,
        "roundness": {"type": 3} if kind in ("rectangle", "diamond") else None,
        "seed": _nonce(), "version": 1, "versionNonce": _nonce(), "isDeleted": False,
        "boundElements": [], "updated": int(time.time() * 1000), "link": None, "locked": False,
        "customData": {"createdBy": actor},
    }
    el.update(extra or {})
    return el


def _text(text, x, y, actor, size=FONT_SIZE, container=None):
    w, h = _text_size(text, size)
    if container:                                        # centred inside its shape
        x = container["x"] + (container["width"] - w) / 2
        y = container["y"] + (container["height"] - h) / 2
    return _base("text", x, y, w, h, actor, {
        "text": text, "originalText": text, "fontSize": size, "fontFamily": 5,
        "textAlign": "center" if container else "left",
        "verticalAlign": "middle" if container else "top",
        "containerId": container["id"] if container else None,
        "autoResize": True, "lineHeight": LINE_HEIGHT,
    })


def _center(el):
    return el["x"] + el.get("width", 0) / 2, el["y"] + el.get("height", 0) / 2


def _bind(shape, child_id, kind, changes):
    """Add a bound child to a shape's boundElements (a new version of it)."""
    cur = changes.get(shape["id"], shape)
    bound = list(cur.get("boundElements") or [])
    if any(b.get("id") == child_id for b in bound):
        return
    changes[shape["id"]] = {**cur, "boundElements": bound + [{"id": child_id, "type": kind}]}


def _num(v, default=0.0):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _add(spec, view, actor, changes):
    """New elements for one add op. Every check runs before the first binding is
    written into `changes`, so a refused op leaves no trace."""
    kind = spec.get("type")
    if kind not in KINDS:
        raise ValueError(f"type must be one of {', '.join(KINDS)}")
    frame = view(spec.get("frame"))
    if spec.get("frame") and (not frame or frame.get("type") != "frame"):
        raise ValueError("frame must name a live frame")
    x, y = _num(spec.get("x")), _num(spec.get("y"))
    out = []
    if kind == "text":
        text = spec.get("text")
        if not isinstance(text, str) or not text:
            raise ValueError("a text element needs text")
        out.append(_text(text, x, y, actor, int(_num(spec.get("fontSize"), FONT_SIZE))))
    elif kind in ("arrow", "line"):
        src, dst = view(spec.get("from")), view(spec.get("to"))
        if spec.get("from") and not src or spec.get("to") and not dst:
            raise ValueError("from/to must name live elements")
        if src and dst:
            (x, y), (x2, y2) = _center(src), _center(dst)
            pts = [[0, 0], [x2 - x, y2 - y]]
        else:
            pts = spec.get("points") or [[0, 0], [_num(spec.get("width"), 100), _num(spec.get("height"))]]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        el = _base(kind, x, y, max(xs) - min(xs), max(ys) - min(ys), actor, {
            "points": pts, "lastCommittedPoint": None,
            "startBinding": {"elementId": src["id"], "focus": 0, "gap": 8} if src else None,
            "endBinding": {"elementId": dst["id"], "focus": 0, "gap": 8} if dst else None,
            "startArrowhead": None, "endArrowhead": "arrow" if kind == "arrow" else None,
            "elbowed": False,
        })
        out.append(el)
        for shape in (src, dst):
            if shape:
                _bind(shape, el["id"], "arrow", changes)
        if spec.get("label"):
            t = _text(spec["label"], x + (pts[-1][0]) / 2, y + (pts[-1][1]) / 2, actor, container=None)
            t["containerId"], t["textAlign"], t["verticalAlign"] = el["id"], "center", "middle"
            el["boundElements"] = [{"id": t["id"], "type": "text"}]
            out.append(t)
    else:
        dw, dh = DEFAULT_SIZE.get(kind, (160.0, 80.0))
        w, h = _num(spec.get("width"), dw), _num(spec.get("height"), dh)
        el = _base(kind, x, y, w, h, actor)
        if kind == "frame":
            el["name"] = spec.get("name") or spec.get("label") or None
            el["roundness"] = None
        elif kind == "embeddable":
            if not isinstance(spec.get("link"), str):
                raise ValueError("an embeddable needs a link")
            el["roundness"] = None
        for k in ("strokeColor", "backgroundColor", "fillStyle"):
            if isinstance(spec.get(k), str):
                el[k] = spec[k]
        out.append(el)
        if spec.get("label") and kind not in ("frame", "embeddable"):
            t = _text(str(spec["label"]), 0, 0, actor, container=el)
            el["boundElements"] = [{"id": t["id"], "type": "text"}]
            out.append(t)
    head = out[0]
    if isinstance(spec.get("link"), str):
        head["link"] = spec["link"]
    if isinstance(spec.get("customData"), dict):
        head["customData"] = {**spec["customData"], "createdBy": actor}
    for el in out:
        el["frameId"] = frame["id"] if frame else None
    return out


def _owned(el, actor, own_only):
    return not own_only or (el.get("customData") or {}).get("createdBy") == actor


def build(stored, ops, actor, own_only):
    """(elements, results). `stored` is the room's {id: element}; nothing is
    mutated. results[i] is {"ok": True, "ids": [...]} or {"ok": False, "error": ...}
    for ops[i] — one bad op never sinks the rest."""
    if not isinstance(ops, list) or not ops:
        raise ValueError("ops must be a non-empty list")
    if len(ops) > MAX_OPS:
        raise ValueError(f"at most {MAX_OPS} ops per patch")
    changes = {}                      # id -> element as it will be sent
    new = set()                       # ids this patch created: sent at version 1

    def view(eid):
        if not isinstance(eid, str):
            return None
        el = changes.get(eid) or stored.get(eid)
        return el if el and not el.get("isDeleted") else None

    results = []
    for op in ops:
        try:
            if not isinstance(op, dict):
                raise ValueError("op must be an object")
            kind = op.get("op")
            if kind == "add":
                els = _add(op.get("element") or {}, view, actor, changes)
                for el in els:
                    changes[el["id"]] = el
                    new.add(el["id"])
                results.append({"ok": True, "ids": [e["id"] for e in els]})
                continue
            cur = view(op.get("id"))
            if not cur:
                raise ValueError("no live element with that id")
            if not _owned(cur, actor, own_only):
                raise ValueError("not yours: at Own work level an agent changes only what it drew")
            if kind == "update":
                patch = op.get("set")
                if not isinstance(patch, dict) or not patch:
                    raise ValueError("update needs a non-empty set")
                bad = sorted(set(patch) - SETTABLE)
                if bad:
                    raise ValueError(f"cannot set {', '.join(bad)}")
                nxt = {**cur, **patch}
                if "text" in patch:
                    if cur.get("type") != "text" or not isinstance(patch["text"], str):
                        raise ValueError("text is set only on a text element, as a string")
                    nxt["originalText"] = patch["text"]
                if "customData" in patch:
                    nxt["customData"] = {**(patch["customData"] or {}),
                                         "createdBy": (cur.get("customData") or {}).get("createdBy")}
                changes[cur["id"]] = nxt
                results.append({"ok": True, "ids": [cur["id"]]})
            elif kind == "delete":
                gone = [cur["id"]] + [b["id"] for b in (cur.get("boundElements") or [])
                                      if b.get("type") == "text"]
                for gid in gone:
                    if gid in new:                # never left this patch: just drop it
                        changes.pop(gid, None)
                        new.discard(gid)
                    elif view(gid):
                        changes[gid] = {**view(gid), "isDeleted": True}
                results.append({"ok": True, "ids": gone})
            else:
                raise ValueError("op must be add, update or delete")
        except (ValueError, TypeError, KeyError) as e:
            results.append({"ok": False, "error": str(e)})
    out, top = [], _top_index(stored)
    for eid, el in changes.items():
        if eid in new:
            top = index_after(top)
            out.append({**el, "index": top})
        else:
            out.append({**el, "version": int(stored[eid].get("version") or 0) + 1,
                        "versionNonce": _nonce(), "updated": int(time.time() * 1000)})
    return out, results


def revert(stored, prior):
    """Elements that undo one patch: each touched id goes back to its prior
    state (None = it did not exist, so it becomes a tombstone), on a version
    above whatever is stored now so every replica takes it. An element someone
    changed after the patch is left alone — undo never eats a later edit."""
    out = []
    for eid, before, written in prior:
        cur = stored.get(eid)
        if cur is None or int(cur.get("version") or 0) != written:
            continue
        target = before if before is not None else {**cur, "isDeleted": True}
        out.append({**target, "version": int(cur.get("version") or 0) + 1,
                    "versionNonce": _nonce()})
    return out
