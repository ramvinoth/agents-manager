"""viewer.canvas_reconcile: the conflict rule, validation, checksum."""
from viewer import canvas_reconcile as cr


def el(i="a", v=1, n=5, **kw):
    return dict({"id": i, "type": "rectangle", "version": v, "versionNonce": n}, **kw)


def test_higher_version_wins_and_tie_goes_to_lower_nonce():
    assert cr.wins(el(v=2), el(v=1))
    assert not cr.wins(el(v=1), el(v=2))
    assert cr.wins(el(v=3, n=1), el(v=3, n=9))
    assert not cr.wins(el(v=3, n=9), el(v=3, n=1))
    assert not cr.wins(el(v=3, n=4), el(v=3, n=4))  # identical: no-op, not a change
    assert cr.wins(el(), None)


def test_merge_is_order_independent():
    a, b, c = el(v=2, n=7), el(v=2, n=3), el(v=1, n=0)
    for order in ([a, b, c], [c, b, a], [b, a, c]):
        m = {}
        for e in order:
            cr.merge(m, [e])
        assert m["a"] is b


def test_merge_reports_stale_with_winner():
    m = {"a": el(v=5)}
    acc, rej = cr.merge(m, [el(v=4)])
    assert acc == [] and rej == [("a", "stale", m["a"])]


def test_validate_rejects_bad_input():
    bad = [None, [], el(i="x y"), el(i="z" * 65), el(type="iframe"), el(type="script"),
           dict(el(), version="1"), dict(el(), version=True),
           el(link="javascript:alert(1)"), el(link=" data:text/html,x"),
           el(type="freedraw", points=[[0, 0]] * (cr.MAX_POINTS + 1)),
           el(type="text", text="x" * (cr.MAX_TEXT + 1)),
           el(customData={"blob": "x" * cr.MAX_ELEMENT_BYTES})]
    for b in bad:
        assert not cr.validate(b)[0], b
    for good in (el(), el(link="https://x.io"), el(type="embeddable", link="agents://card/7"),
                 el(link=None), el(link="")):
        assert cr.validate(good)[0], good


def test_merge_survives_garbage_in_batch():
    m = {}
    acc, rej = cr.merge(m, [None, "x", el()])
    assert [e["id"] for e in acc] == ["a"] and len(rej) == 2


def test_checksum_ignores_tombstones_and_order():
    s1 = [el("a", 1), el("b", 2)]
    s2 = [el("b", 2), el("a", 1), el("c", 9, isDeleted=True)]
    assert cr.checksum(s1) == cr.checksum(s2)
    assert cr.checksum(s1) != cr.checksum([el("a", 2), el("b", 2)])


def test_fnv1a_known_vectors():
    # Published FNV-1a 32-bit test vectors; the web client must match these.
    assert cr.fnv1a("") == 0x811C9DC5
    assert cr.fnv1a("a") == 0xE40C292C
    assert cr.fnv1a("foobar") == 0xBF9CF968
