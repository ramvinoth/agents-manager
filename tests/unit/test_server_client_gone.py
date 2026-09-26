"""A client that hangs up mid-response is not a server error. The stdlib
handle_error prints a full traceback for every exception a handler raises;
25 of the 33 tracebacks in the launchd log were BrokenPipeError from send_json
(the app cancelling a transcript poll), burying the eight real ones. Only the
client-gone family is condensed — every other exception keeps its traceback.
"""
import sys

import pytest

from viewer import server


@pytest.fixture
def srv():
    # No socket, no pool: only handle_error is exercised.
    return server.PooledHTTPServer.__new__(server.PooledHTTPServer)


def _handle(srv, exc, capsys):
    try:
        raise exc
    except Exception:
        srv.handle_error(None, ("10.0.0.7", 51234))
    return capsys.readouterr().err


@pytest.mark.parametrize("exc", [BrokenPipeError(32, "Broken pipe"),
                                 ConnectionResetError(54, "reset"),
                                 ConnectionAbortedError(53, "aborted")])
def test_client_hangup_is_one_line_without_a_traceback(srv, exc, capsys):
    err = _handle(srv, exc, capsys)
    assert err.count("\n") == 1
    assert "10.0.0.7" in err and type(exc).__name__ in err
    assert "Traceback" not in err


def test_real_errors_keep_the_full_traceback(srv, capsys):
    err = _handle(srv, ModuleNotFoundError("No module named 'tomllib'"), capsys)
    assert "Traceback (most recent call last)" in err
    assert "No module named 'tomllib'" in err
    assert "('10.0.0.7', 51234)" in err


def test_no_active_exception_falls_through_to_stdlib(srv, capsys):
    assert sys.exc_info()[1] is None
    srv.handle_error(None, ("10.0.0.7", 1))
    assert "Exception occurred during processing" in capsys.readouterr().err
