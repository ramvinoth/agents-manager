"""feed_next_queued: a message queued behind a turn is never lost — not when
stdin is already closed (the CLI can still start another turn after that, on a
background-task notification), and not when the write itself fails."""
import io

from viewer import engine, resume
from viewer.engine import feed_next_queued


class _Proc:
    def __init__(self, closed=False):
        self.stdin = io.StringIO()
        if closed:
            self.stdin.close()


def _job(queue, stdin_open=True):
    return {"queue": list(queue), "stdin_open": stdin_open, "turn_open": False}


def setup_function(_):
    engine._persist_queue = lambda *a: None  # no DB in unit tests


def test_feeds_next_message_in_order():
    job, proc = _job(["a", "b"]), _Proc()
    assert feed_next_queued("s", job, proc) is True
    assert '"a"' in proc.stdin.getvalue()
    assert job["queue"] == ["b"] and job["turn_open"] is True


def test_empty_queue_closes_out():
    job = _job([])
    assert feed_next_queued("s", job, _Proc()) is False
    assert job["stdin_open"] is False


def test_closed_stdin_keeps_queue_for_follow_up_run():
    # The 2026-10-10 loss: stdin closed after an empty-queue turn, the owner
    # queued two messages, the CLI ended one more turn → pop + write raised.
    job = _job(["mine", "also mine"], stdin_open=False)
    assert feed_next_queued("s", job, _Proc(closed=True)) is False
    assert job["queue"] == ["mine", "also mine"]


def test_failed_write_puts_message_back_and_routes_to_resume():
    # A write fails only because the pipe broke (the child is dying → this run
    # ends rc!=0). The finalizer's rc==0 leftovers follow-up would skip it, so
    # the message must ride the cut-off resume path instead: it goes back to the
    # front AND turn_open stays True so resume.was_cut_off fires on it.
    job = _job(["mine", "next"])
    assert feed_next_queued("s", job, _Proc(closed=True)) is False
    assert job["queue"] == ["mine", "next"]
    assert job["stdin_open"] is False
    assert job["turn_open"] is True
    # The state feed_next_queued leaves behind must make the finalizer treat
    # this as a cut-off turn (not interrupted, not explained), so the restored
    # message is resumed rather than dropped.
    assert resume.was_cut_off(job["turn_open"], interrupted=False, explained=False) is True
