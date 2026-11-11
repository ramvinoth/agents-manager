"""orchestrator.canvas_render: snapshot target selection and a cached PNG."""
import pytest

from orchestrator import canvas_render as cr
from orchestrator import canvas_summary as cs

pytest.importorskip("PIL")


def stroke(i, x, y):
    return {"id": i, "type": "freedraw", "x": x, "y": y, "points": [[0, 0], [20, 10]], "version": 1}


def test_select_by_group_frame_and_box():
    els = [stroke("a", 0, 0), stroke("b", 500, 500),
           {"id": "f", "type": "frame", "x": 400, "y": 400, "width": 300, "height": 300}]
    ink = cs.ink_groups(els)
    sel, box = cr.select(els, ink, group=ink[0]["group_id"])
    assert [e["id"] for e in sel] == ["a"]
    sel, box = cr.select(els, ink, frame="f")
    assert {e["id"] for e in sel} == {"b", "f"}
    sel, _ = cr.select(els, ink, box=[-5, -5, 30, 30])
    assert [e["id"] for e in sel] == ["a"]
    for kw in ({"group": "g-0"}, {"frame": "nope"}, {}, {"box": [10, 10, 0, 0]}):
        with pytest.raises(ValueError):
            cr.select(els, ink, **kw)


def test_render_is_a_bounded_png_and_cached():
    els = [stroke("a", 0, 0), {"id": "r", "type": "rectangle", "x": 0, "y": 0, "width": 5000,
                               "height": 100, "version": 3, "strokeColor": "transparent"}]
    png = cr.render(els, (0, 0, 5000, 100))
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    from PIL import Image
    import io
    w, h = Image.open(io.BytesIO(png)).size
    assert w <= cr.MAX_PX and h >= 1
    assert cr.render(els, (0, 0, 5000, 100)) is png
