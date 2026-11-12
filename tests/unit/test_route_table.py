"""Every route in the server's dispatch tables names a handler that exists.

do_GET/do_POST look handlers up by name with getattr. A route whose handler was deleted
or moved out of every mixin still type-checks and imports, then crashes the request.
"""
from orchestrator.server import SessionViewerHandler as H


def test_every_route_resolves_to_a_handler():
    names = [*H.GET_ROUTES.values(), *H.POST_ROUTES.values(),
             *(n for _, n in H.GET_PREFIX), *(n for _, n in H.POST_PREFIX)]
    missing = sorted({n for n in names if not callable(getattr(H, n, None))})
    assert not missing, f"routes point at handlers no mixin defines: {missing}"
