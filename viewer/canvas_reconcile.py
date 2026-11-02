"""viewer.canvas_reconcile — the pure rules of the shared canvas (no I/O).

Excalidraw elements carry their own conflict clock: `version` bumps on every
edit and `versionNonce` is a random tie-breaker. The server applies the same
rule the Excalidraw client does (reconcileElements / shouldDiscardRemote), so
every replica converges on the same winner without a central lock:

    incoming beats stored  ⇔  version is higher,
                              or versions tie and its nonce is LOWER.

Validation is the only trust boundary between a browser and the room: an
allow-list of element types, size caps, and links limited to http(s) and the
agents:// reference scheme (never javascript: or data:)."""
import json
import re

PROTOCOL = 1

TYPES = frozenset({"rectangle", "diamond", "ellipse", "arrow", "line", "freedraw",
                   "text", "image", "frame", "embeddable"})
MAX_ELEMENT_BYTES = 256 * 1024
MAX_POINTS = 20000
MAX_TEXT = 100000
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
LINK_RE = re.compile(r"^(https?://|agents://)", re.I)


def wins(incoming, stored):
    """True when `incoming` should replace `stored` (None = nothing stored)."""
    if stored is None:
        return True
    iv, sv = int(incoming.get("version") or 0), int(stored.get("version") or 0)
    if iv != sv:
        return iv > sv
    return int(incoming.get("versionNonce") or 0) < int(stored.get("versionNonce") or 0)


def validate(el):
    """(ok, reason). A rejected element is dropped and reported to its sender."""
    if not isinstance(el, dict):
        return False, "not an object"
    eid = el.get("id")
    if not isinstance(eid, str) or not ID_RE.match(eid):
        return False, "bad id"
    if el.get("type") not in TYPES:
        return False, "type not allowed"
    for k in ("version", "versionNonce"):
        if not isinstance(el.get(k), int) or isinstance(el.get(k), bool):
            return False, f"bad {k}"
    link = el.get("link")
    if link not in (None, "") and not (isinstance(link, str) and LINK_RE.match(link.strip())):
        return False, "link scheme not allowed"
    pts = el.get("points")
    if pts is not None and (not isinstance(pts, list) or len(pts) > MAX_POINTS):
        return False, "too many points"
    txt = el.get("text")
    if txt is not None and (not isinstance(txt, str) or len(txt) > MAX_TEXT):
        return False, "text too long"
    if len(json.dumps(el, separators=(",", ":"))) > MAX_ELEMENT_BYTES:
        return False, "element too large"
    return True, ""


def merge(stored, incoming):
    """Apply a batch to a {id: element} map in place.
    Returns (accepted, rejected): accepted elements changed the map; rejected
    is [(id, reason, winner_or_None)] — the sender adopts the winner."""
    accepted, rejected = [], []
    for el in incoming or ():
        ok, why = validate(el)
        if not ok:
            rejected.append(((el or {}).get("id") if isinstance(el, dict) else None, why, None))
            continue
        cur = stored.get(el["id"])
        if wins(el, cur):
            stored[el["id"]] = el
            accepted.append(el)
        else:
            rejected.append((el["id"], "stale", cur))
    return accepted, rejected


def fnv1a(text):
    """32-bit FNV-1a — the web client computes the identical number, without
    needing crypto.subtle (unavailable on a plain-http origin)."""
    h = 0x811C9DC5
    for b in text.encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def checksum(elements):
    """Scene fingerprint over the LIVE elements: sorted `id:version` pairs.
    Tombstones are left out so the nightly GC never forces a refetch."""
    pairs = sorted(f"{e['id']}:{int(e.get('version') or 0)}"
                   for e in elements if not e.get("isDeleted"))
    return fnv1a(",".join(pairs))
