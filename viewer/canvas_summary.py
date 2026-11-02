"""viewer.canvas_summary — what an agent reads of a canvas (pure, no I/O).

An Excalidraw scene is thousands of fields an agent cannot reason over. The
summary keeps meaning and drops geometry noise: frames and what sits in them,
labelled shapes, free text, arrows as from → to edges, workflows (a frame
marked customData.kind = "workflow") as ordered steps, agents:// references
(card, note, inbox decision, Sift document, code file) resolved to what they
name, and freehand ink as spatial groups.

Ink is the one thing words cannot carry. Strokes are grouped by proximity
(bounding boxes within GROUP_GAP px merge, union-find) and each group gets a
stable id from its member ids — the agent asks /api/canvas/agent/snapshot for
that group and looks at the picture only when it needs to. Nothing renders per
stroke.
"""
import re

from viewer.canvas_reconcile import fnv1a

GROUP_GAP = 40.0
CAP = 500                          # per list; `truncated` says when one was cut
REF_RE = re.compile(r"^agents://(card|note|inbox|sift|code)/(.+)$")
INT_REFS = {"card", "note", "inbox"}   # numeric ids; sift and code ids are strings


def bbox(el):
    """(x0, y0, x1, y1) in scene coordinates. Points are relative to x, y and
    may be negative, so a line's box is not simply x, y, width, height."""
    x, y = float(el.get("x") or 0), float(el.get("y") or 0)
    pts = el.get("points")
    if isinstance(pts, list) and pts:
        xs = [p[0] for p in pts if isinstance(p, (list, tuple)) and len(p) >= 2]
        ys = [p[1] for p in pts if isinstance(p, (list, tuple)) and len(p) >= 2]
        if xs:
            return (x + min(xs), y + min(ys), x + max(xs), y + max(ys))
    return (x, y, x + float(el.get("width") or 0), y + float(el.get("height") or 0))


def _union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def ink_groups(elements):
    """Freehand strokes clustered by proximity: [{group_id, bbox, stroke_count, ids}].
    A sweep over strokes sorted by left edge keeps it near O(n log n)."""
    strokes = [(e["id"], bbox(e)) for e in elements
               if e.get("type") == "freedraw" and not e.get("isDeleted")]
    strokes.sort(key=lambda s: s[1][0])
    parent = list(range(len(strokes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    active = []                                     # indices whose right edge may still touch
    for i, (_, b) in enumerate(strokes):
        active = [j for j in active if strokes[j][1][2] + GROUP_GAP >= b[0]]
        for j in active:
            o = strokes[j][1]
            if o[1] - GROUP_GAP <= b[3] and b[1] - GROUP_GAP <= o[3]:
                parent[find(i)] = find(j)
        active.append(i)
    groups = {}
    for i, (eid, b) in enumerate(strokes):
        groups.setdefault(find(i), []).append((eid, b))
    out = []
    for members in groups.values():
        ids = sorted(m[0] for m in members)
        box = _union([m[1] for m in members])
        out.append({"group_id": f"g-{fnv1a(','.join(ids)):08x}", "bbox": [round(v) for v in box],
                    "stroke_count": len(ids), "ids": ids})
    out.sort(key=lambda g: (g["bbox"][1], g["bbox"][0]))
    return out


def _inside(inner, outer):
    cx, cy = (inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2
    return outer[0] <= cx <= outer[2] and outer[1] <= cy <= outer[3]


def _order(steps, edges):
    """Kahn's topological order; ties and cycles fall back to reading order."""
    pos = {s["id"]: (s["bbox"][1], s["bbox"][0]) for s in steps}
    indeg = {sid: 0 for sid in pos}
    nxt = {sid: [] for sid in pos}
    for a, b in edges:
        if a in pos and b in pos and a != b:
            nxt[a].append(b)
            indeg[b] += 1
    ready = sorted((sid for sid, d in indeg.items() if d == 0), key=pos.get)
    order = []
    while len(order) < len(pos):
        if not ready:                                  # a cycle: take the top-left remaining
            ready = [min((sid for sid in pos if sid not in order), key=pos.get)]
        sid = ready.pop(0)
        if sid in order:
            continue
        order.append(sid)
        for b in nxt[sid]:
            indeg[b] -= 1
            if indeg[b] == 0 and b not in order:
                ready.append(b)
        ready.sort(key=pos.get)
    return order


def summarize(elements, resolve=None):
    """The agent's view of a scene. `resolve(kind, id)` returns a short title
    for a agents:// reference, or None when it no longer exists."""
    live = [e for e in elements if isinstance(e, dict) and not e.get("isDeleted")]
    by_id = {e["id"]: e for e in live}
    labels = {}
    for e in live:
        if e.get("type") == "text" and e.get("containerId") in by_id:
            labels[e["containerId"]] = e.get("text") or ""
    counts = {}
    for e in live:
        counts[e.get("type")] = counts.get(e.get("type"), 0) + 1
    frames = [e for e in live if e.get("type") == "frame"]
    truncated = False

    def cap(xs):
        nonlocal truncated
        if len(xs) > CAP:
            truncated = True
        return xs[:CAP]

    def who(e):
        return (e.get("customData") or {}).get("createdBy") or None

    refs = []

    def ref_of(e):
        m = REF_RE.match((e.get("link") or "").strip())
        if not m:
            return None
        kind, rid = m.group(1), m.group(2)
        if kind in INT_REFS:
            if not rid.isdigit():
                return None
            rid = int(rid)
        title = resolve(kind, rid) if resolve else None
        refs.append({"kind": kind, "id": rid, "element": e["id"], "title": title,
                     "missing": resolve is not None and title is None})
        return f"{kind}/{rid}"

    shapes, texts, arrows = [], [], []
    for e in live:
        t = e.get("type")
        if t in ("rectangle", "diamond", "ellipse", "image", "embeddable"):
            shapes.append({"id": e["id"], "type": t, "label": labels.get(e["id"]),
                           "bbox": [round(v) for v in bbox(e)], "frame": e.get("frameId"),
                           "link": e.get("link") or None, "ref": ref_of(e), "createdBy": who(e)})
        elif t == "text" and e.get("containerId") not in by_id:
            texts.append({"id": e["id"], "text": e.get("text") or "",
                          "bbox": [round(v) for v in bbox(e)], "frame": e.get("frameId"),
                          "ref": ref_of(e), "createdBy": who(e)})
        elif t in ("arrow", "line"):
            s, d = e.get("startBinding") or {}, e.get("endBinding") or {}
            if s.get("elementId") in by_id or d.get("elementId") in by_id:
                arrows.append({"id": e["id"], "from": s.get("elementId"), "to": d.get("elementId"),
                               "label": labels.get(e["id"]), "createdBy": who(e)})

    frame_out, workflows = [], []
    for f in frames:
        fb = bbox(f)
        members = [e["id"] for e in live if e["id"] != f["id"]
                   and (e.get("frameId") == f["id"] or (e.get("frameId") is None
                        and e.get("type") != "frame" and _inside(bbox(e), fb)))]
        frame_out.append({"id": f["id"], "name": f.get("name"), "bbox": [round(v) for v in fb],
                          "members": len(members)})
        if (f.get("customData") or {}).get("kind") == "workflow":
            mset = set(members)
            steps = [s for s in shapes if s["id"] in mset]
            edges = [(a["from"], a["to"]) for a in arrows if a["from"] in mset and a["to"] in mset]
            order = _order(steps, edges)
            named = {s["id"]: s for s in steps}
            workflows.append({"frame": f["id"], "name": f.get("name"),
                              "steps": [{"id": sid, "label": named[sid]["label"], "ref": named[sid]["ref"]}
                                        for sid in order]})

    return {
        "counts": counts,
        "frames": cap(frame_out),
        "workflows": cap(workflows),
        "shapes": cap(shapes),
        "texts": cap(texts),
        "arrows": cap(arrows),
        "refs": cap(refs),
        "ink": cap([{k: g[k] for k in ("group_id", "bbox", "stroke_count")} for g in ink_groups(live)]),
        "truncated": truncated,
    }
