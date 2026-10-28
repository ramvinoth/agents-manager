"""viewer.canvas_patch: agent ops -> valid Excalidraw elements, ownership, revert."""
import pytest

from viewer import canvas_patch as cp
from viewer import canvas_reconcile as rec

ME, OTHER = "session:me", "session:other"


def store(*els):
    return {e["id"]: e for e in els}


def add(**spec):
    return {"op": "add", "element": spec}


def test_add_labelled_shape_makes_a_bound_text_and_both_validate():
    out, res = cp.build({}, [add(type="rectangle", x=10, y=20, label="Build")], ME, True)
    assert res[0]["ok"] and len(out) == 2
    shape, text = out
    assert shape["boundElements"] == [{"id": text["id"], "type": "text"}]
    assert text["containerId"] == shape["id"] and text["text"] == "Build"
    assert all(e["version"] == 1 and e["customData"]["createdBy"] == ME for e in out)
    assert all(rec.validate(e)[0] for e in out)


def test_arrow_between_existing_shapes_binds_both_ends_once():
    a = cp._base("rectangle", 0, 0, 100, 50, OTHER)
    b = cp._base("rectangle", 300, 0, 100, 50, OTHER)
    out, res = cp.build(store(a, b), [add(type="arrow", **{"from": a["id"], "to": b["id"]})], ME, True)
    assert res[0]["ok"]
    by = {e["id"]: e for e in out}
    arrow = by[res[0]["ids"][0]]
    assert arrow["startBinding"]["elementId"] == a["id"] and arrow["endBinding"]["elementId"] == b["id"]
    # binding bookkeeping on someone else's shapes is allowed, and bumps their version
    assert by[a["id"]]["boundElements"] == [{"id": arrow["id"], "type": "arrow"}]
    assert by[a["id"]]["version"] == 2 and len(out) == 3


def test_shape_added_then_bound_in_one_patch_is_sent_once_at_version_1():
    out, res = cp.build({}, [add(type="rectangle", x=0, y=0)], ME, True)
    sid = res[0]["ids"][0]
    stored = {}
    ops = [add(type="rectangle", x=0, y=0), add(type="ellipse", x=300, y=0)]
    out, res = cp.build(stored, ops, ME, True)
    a, b = res[0]["ids"][0], res[1]["ids"][0]
    out, res = cp.build({}, ops + [add(type="arrow", **{"from": "x", "to": "y"})], ME, True)
    assert not res[2]["ok"]                     # unknown ids refuse only that op
    assert res[0]["ok"] and res[1]["ok"]
    ids = [e["id"] for e in out]
    assert len(ids) == len(set(ids))
    assert sid and a and b


def test_own_only_refuses_others_elements_but_a_lead_may():
    theirs = cp._base("rectangle", 0, 0, 10, 10, OTHER)
    ops = [{"op": "update", "id": theirs["id"], "set": {"x": 5}}]
    _, res = cp.build(store(theirs), ops, ME, True)
    assert not res[0]["ok"] and "not yours" in res[0]["error"]
    out, res = cp.build(store(theirs), ops, ME, False)
    assert res[0]["ok"] and out[0]["x"] == 5 and out[0]["version"] == 2


def test_update_rejects_structural_fields_and_keeps_creator():
    mine = cp._base("text", 0, 0, 10, 10, ME, {"text": "a", "originalText": "a"})
    _, res = cp.build(store(mine), [{"op": "update", "id": mine["id"], "set": {"type": "frame"}}], ME, True)
    assert "cannot set type" in res[0]["error"]
    out, res = cp.build(store(mine), [{"op": "update", "id": mine["id"],
                                       "set": {"text": "b", "customData": {"createdBy": OTHER, "k": 1}}}], ME, True)
    assert res[0]["ok"] and out[0]["originalText"] == "b"
    assert out[0]["customData"] == {"createdBy": ME, "k": 1}


def test_delete_takes_the_label_and_add_then_delete_sends_nothing():
    out, res = cp.build({}, [add(type="rectangle", label="x")], ME, True)
    stored = {e["id"]: e for e in out}
    sid = res[0]["ids"][0]
    out, res = cp.build(stored, [{"op": "delete", "id": sid}], ME, True)
    assert res[0]["ok"] and len(out) == 2 and all(e["isDeleted"] for e in out)
    out, res = cp.build({}, [add(type="ellipse"), {"op": "delete", "id": "zz"}], ME, True)
    assert res[1]["ok"] is False
    new = res[0]["ids"][0]
    out, _ = cp.build({}, [add(type="ellipse"), {"op": "delete", "id": new}], ME, True)
    assert len(out) == 1                       # the other id was never created here


def test_bad_input_is_per_op_and_limits_are_whole_patch():
    _, res = cp.build({}, ["x", {"op": "zap"}, add(type="star"), add(type="text")], ME, True)
    assert [r["ok"] for r in res] == [False] * 4
    with pytest.raises(ValueError):
        cp.build({}, [], ME, True)
    with pytest.raises(ValueError):
        cp.build({}, [add(type="ellipse")] * (cp.MAX_OPS + 1), ME, True)


def test_frame_membership_requires_a_live_frame():
    out, res = cp.build({}, [add(type="frame", name="Flow")], ME, True)
    f = out[0]
    out, res = cp.build(store(f), [add(type="rectangle", frame=f["id"], label="s")], ME, True)
    assert res[0]["ok"] and all(e["frameId"] == f["id"] for e in out)
    _, res = cp.build({}, [add(type="rectangle", frame="nope")], ME, True)
    assert not res[0]["ok"]


def test_revert_restores_prior_and_skips_a_later_edit():
    a = cp._base("rectangle", 0, 0, 10, 10, ME)
    a2 = {**a, "x": 50, "version": 2}
    stored = store(a2)
    out = cp.revert(stored, [(a["id"], a, 2)])
    assert out[0]["x"] == 0 and out[0]["version"] == 3
    stored[a["id"]] = {**a2, "version": 3}         # someone moved it after the patch
    assert cp.revert(stored, [(a["id"], a, 2)]) == []
    out = cp.revert(store(a), [(a["id"], None, 1)])  # created by the patch -> tombstone
    assert out[0]["isDeleted"] and out[0]["version"] == 2


# -- canonical elements: nothing left for a browser to fill in -----------------
def test_index_after_steps_the_integer_key():
    assert cp.index_after(None) == "a0"
    assert cp.index_after("a0") == "a1"
    assert cp.index_after("a9") == "aA"
    assert cp.index_after("az") == "b00"
    assert cp.index_after("b0z") == "b10"
    assert cp.index_after("a5V") == "a6"          # a fraction steps to the next integer


def test_new_elements_get_ordered_indices_above_the_canvas():
    stored = {"x": {"id": "x", "type": "rectangle", "index": "a7", "version": 3}}
    out, _ = cp.build(stored, [{"op": "add", "element": {"type": "rectangle", "x": 0, "y": 0,
                                                          "width": 10, "height": 10, "label": "hi"}}],
                      "session:t", False)
    idx = [e["index"] for e in out]
    assert idx == sorted(idx) and all(i > "a7" for i in idx)
    for e in out:
        assert e["boundElements"] is not None and e["updated"] > 0
