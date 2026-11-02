"""viewer.canvas_summary: what an agent reads — ink groups, workflows, refs, caps."""
from viewer import canvas_summary as cs


def stroke(i, x, y, pts=((0, 0), (10, 10))):
    return {"id": i, "type": "freedraw", "x": x, "y": y, "points": [list(p) for p in pts]}


def shape(i, x, y, **kw):
    return dict({"id": i, "type": "rectangle", "x": x, "y": y, "width": 100, "height": 50}, **kw)


def label(i, cid, text):
    return {"id": i, "type": "text", "x": 0, "y": 0, "containerId": cid, "text": text}


def arrow(i, a, b):
    return {"id": i, "type": "arrow", "x": 0, "y": 0, "points": [[0, 0], [1, 1]],
            "startBinding": {"elementId": a}, "endBinding": {"elementId": b}}


def test_bbox_handles_negative_points():
    assert cs.bbox(stroke("s", 100, 100, ((0, 0), (-30, 20)))) == (70, 100, 100, 120)


def test_ink_groups_by_proximity_with_stable_ids():
    els = [stroke("a", 0, 0), stroke("b", 30, 0), stroke("c", 1000, 1000),
           stroke("d", 2000, 0, ((0, 0), (5, 5))), {**stroke("e", 5, 5), "isDeleted": True}]
    gs = cs.ink_groups(els)
    assert sorted(g["stroke_count"] for g in gs) == [1, 1, 2]
    pair = next(g for g in gs if g["stroke_count"] == 2)
    assert pair["ids"] == ["a", "b"]
    assert cs.ink_groups(list(reversed(els)))[0]["group_id"] in {g["group_id"] for g in gs}
    assert {g["group_id"] for g in cs.ink_groups(list(reversed(els)))} == {g["group_id"] for g in gs}


def test_ink_chain_merges_transitively_even_when_sorted_far_apart():
    # a tall stroke links two strokes that are far from each other
    els = [stroke("top", 0, 0), stroke("bottom", 0, 500), stroke("pole", 15, 0, ((0, 0), (0, 510)))]
    assert len(cs.ink_groups(els)) == 1


def test_workflow_steps_follow_arrows_not_position_and_survive_a_cycle():
    f = {"id": "f", "type": "frame", "x": 0, "y": 0, "width": 1000, "height": 1000,
         "name": "Ship", "customData": {"kind": "workflow"}}
    els = [f, shape("c", 0, 0), shape("a", 0, 300), shape("b", 0, 600),
           label("lc", "c", "Third"), label("la", "a", "First"), label("lb", "b", "Second"),
           arrow("x1", "a", "b"), arrow("x2", "b", "c")]
    wf = cs.summarize(els)["workflows"][0]
    assert [s["label"] for s in wf["steps"]] == ["First", "Second", "Third"]
    els.append(arrow("x3", "c", "a"))             # now a cycle: fall back, never hang or drop
    wf = cs.summarize(els)["workflows"][0]
    assert sorted(s["id"] for s in wf["steps"]) == ["a", "b", "c"]


def test_refs_resolve_and_flag_missing():
    els = [shape("s1", 0, 0, link="agents://card/5"), shape("s2", 0, 100, link="agents://note/9"),
           shape("s3", 0, 200, link="https://x.test")]
    out = cs.summarize(els, resolve=lambda k, i: "Five" if (k, i) == ("card", 5) else None)
    refs = {(r["kind"], r["id"]): r for r in out["refs"]}
    assert refs[("card", 5)]["title"] == "Five" and not refs[("card", 5)]["missing"]
    assert refs[("note", 9)]["missing"]
    assert len(out["refs"]) == 2
    assert next(s for s in out["shapes"] if s["id"] == "s1")["ref"] == "card/5"


def test_refs_of_every_kind_keep_their_id_type():
    els = [shape("i", 0, 0, link="agents://inbox/41"), shape("f", 0, 100, link="agents://sift/doc-7"),
           shape("c", 0, 200, link="agents://code/viewer/db.py"), shape("bad", 0, 300, link="agents://card/x1")]
    out = cs.summarize(els, resolve=lambda k, i: None if k == "code" else str(i))
    refs = {r["kind"]: r for r in out["refs"]}
    assert refs["inbox"]["id"] == 41 and refs["sift"]["id"] == "doc-7"
    assert refs["code"]["id"] == "viewer/db.py" and refs["code"]["missing"]
    assert "card" not in refs                     # a non-numeric card id is not a ref


def test_code_refs_resolve_inside_the_project_only(tmp_path):
    from viewer.routes import canvas_board as cb
    (tmp_path / "a.py").write_text("x")
    r = cb.resolver({"host": None, "cwd": str(tmp_path)})
    assert r("code", "a.py") == "a.py"
    assert r("code", "missing.py") is None
    assert r("code", "../../etc/passwd") is None
    assert cb.resolver({"host": "box", "cwd": "/srv/x"})("code", "a.py") == "a.py"   # elsewhere: not judged
    assert cb.resolver(None)("sift", "d1") == "d1"


def test_labels_texts_arrows_and_truncation(monkeypatch):
    els = [shape("a", 0, 0), label("la", "a", "Box"), {"id": "t", "type": "text", "x": 0, "y": 0,
           "text": "free"}, shape("b", 300, 0), arrow("ar", "a", "b"), arrow("loose", "zz", "yy")]
    out = cs.summarize(els)
    assert next(s for s in out["shapes"] if s["id"] == "a")["label"] == "Box"
    assert [t["text"] for t in out["texts"]] == ["free"]
    assert [a["id"] for a in out["arrows"]] == ["ar"]
    monkeypatch.setattr(cs, "CAP", 1)
    out = cs.summarize(els)
    assert out["truncated"] and len(out["shapes"]) == 1
