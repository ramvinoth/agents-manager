"""What the public surface is allowed to contain.

PUBLIC_API is the one place in the server where a request skips the logged-in
session check, so it is the one place where adding a line can create an
unauthenticated endpoint. It did once: /api/org/board and /api/org/cards sat in
this set while, unlike their siblings, never calling current_user() — so the
board and every card body answered 200 to anyone who asked. That whole surface is
gone now, and these tests are what stop an equivalent entry arriving quietly.

The rule being pinned is NOT "no new public routes" — it is that a public route
must carry its own proof of identity, because nothing else will check for it.
"""
import pytest

from viewer.server import SessionViewerHandler as Handler

# Every path allowed to bypass the session gate, and why it can be trusted to.
# A new entry here is a deliberate act: add it to this table with its reason, or
# the test below fails. Keeping the justification in the test rather than a
# comment means it cannot drift away from the thing it justifies.
JUSTIFIED_PUBLIC = {
    "/api/auth/me": "reports whether you are signed in; must answer when you are not",
    "/api/auth/state": "same, for the login screen's initial render",
    "/api/auth/signin": "is how a session is obtained",
    "/api/auth/signup": "same, on an open instance",
    "/api/chat/permission": "the permission MCP subprocess has no cookie; it "
                            "authenticates with a per-run token in the body",
    "/api/push/unregister": "a device dropping its own push token, keyed by the "
                            "token itself",
}


def test_every_public_path_is_justified():
    assert Handler.PUBLIC_API == set(JUSTIFIED_PUBLIC), (
        "PUBLIC_API changed. A path here skips the session check entirely, so it "
        "must authenticate itself (see /api/chat/permission's per-run token). Add "
        "it to JUSTIFIED_PUBLIC with that reason, or gate it instead."
    )


@pytest.mark.parametrize("table", ["GET_ROUTES", "POST_ROUTES"])
def test_no_org_or_orchestrator_routes_remain(table):
    """The autonomous org/Kanban API does not belong on this branch.

    Checked against the live route tables rather than by grepping the file: a
    route only exists if it is dispatchable, and that is what these are.
    """
    offenders = [p for p in getattr(Handler, table) if "/org" in p or "kanban" in p.lower()]
    assert offenders == [], f"{table} still serves {offenders}"


def test_no_orchestrator_mixin_in_the_handler():
    names = [b.__name__ for b in Handler.__mro__]
    assert not [n for n in names if "Orchestrator" in n], (
        f"handler MRO still carries an orchestrator mixin: {names}"
    )
