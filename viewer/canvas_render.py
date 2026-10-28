"""viewer.canvas_render — a PNG of part of a canvas, for an agent to look at.

Only on request (an ink group, a frame or a box from the summary), never per
stroke, and cached by the content it shows: the same strokes at the same
versions render once. Lines and outlines only — enough for a model to read
handwriting, a sketch or a diagram; it is not a faithful Excalidraw render.
Pillow is imported lazily (it ships with the launchd interpreter only).
"""
import collections
import io
import threading

from viewer.canvas_reconcile import fnv1a
from viewer.canvas_summary import bbox

MAX_PX = 1024
PAD = 16
_CACHE = collections.OrderedDict()
_CACHE_N = 32
_lock = threading.Lock()


def _key(els, box):
    return fnv1a("|".join(f"{e['id']}:{e.get('version')}" for e in sorted(els, key=lambda e: e["id"]))
                 + repr(box))


def render(elements, box):
    """PNG bytes of `elements` clipped to box (x0, y0, x1, y1)."""
    key = _key(elements, box)
    with _lock:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    from PIL import Image, ImageDraw
    x0, y0, x1, y1 = box
    w, h = max(1.0, x1 - x0), max(1.0, y1 - y0)
    scale = min(1.0, (MAX_PX - 2 * PAD) / max(w, h))
    img = Image.new("RGB", (int(w * scale) + 2 * PAD, int(h * scale) + 2 * PAD), "white")
    d = ImageDraw.Draw(img)

    def at(px, py):
        return ((px - x0) * scale + PAD, (py - y0) * scale + PAD)

    for e in elements:
        color = e.get("strokeColor") if str(e.get("strokeColor", "")).startswith("#") else "#1e1e1e"
        width = max(1, int(float(e.get("strokeWidth") or 1) * scale))
        t = e.get("type")
        if t in ("freedraw", "line", "arrow") and e.get("points"):
            pts = [at(e["x"] + p[0], e["y"] + p[1]) for p in e["points"]]
            if len(pts) == 1:
                pts = pts * 2
            d.line(pts, fill=color, width=width, joint="curve")
        elif t == "text":
            d.text(at(e["x"], e["y"]), e.get("text") or "", fill=color)
        elif t in ("rectangle", "diamond", "ellipse", "frame", "image", "embeddable"):
            bx = bbox(e)
            a, b = at(bx[0], bx[1]), at(bx[2], bx[3])
            if t == "ellipse":
                d.ellipse([a, b], outline=color, width=width)
            elif t == "diamond":
                cx, cy = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                d.polygon([(cx, a[1]), (b[0], cy), (cx, b[1]), (a[0], cy)], outline=color)
            else:
                d.rectangle([a, b], outline=color, width=width)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    png = buf.getvalue()
    with _lock:
        _CACHE[key] = png
        while len(_CACHE) > _CACHE_N:
            _CACHE.popitem(last=False)
    return png


def select(elements, summary_ink, group=None, frame=None, box=None):
    """(elements, box) for one snapshot target, or raise ValueError."""
    live = [e for e in elements if not e.get("isDeleted")]
    if group:
        g = next((g for g in summary_ink if g["group_id"] == group), None)
        if not g:
            raise ValueError("no ink group with that id (read the canvas again: ids change when strokes do)")
        ids = set(g["ids"])
        return [e for e in live if e["id"] in ids], tuple(g["bbox"])
    if frame:
        f = next((e for e in live if e["id"] == frame and e.get("type") == "frame"), None)
        if not f:
            raise ValueError("no frame with that id")
        box = bbox(f)
    if not box or len(box) != 4:
        raise ValueError("give group, frame, or bbox [x0, y0, x1, y1]")
    x0, y0, x1, y1 = (float(v) for v in box)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("bbox must have x1 > x0 and y1 > y0")
    inside = []
    for e in live:
        b = bbox(e)
        if b[2] >= x0 and b[0] <= x1 and b[3] >= y0 and b[1] <= y1:
            inside.append(e)
    return inside, (x0, y0, x1, y1)
