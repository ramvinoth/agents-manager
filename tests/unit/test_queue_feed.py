"""feed_next_queued: a message queued behind a turn is never lost — not when
stdin is already closed (the CLI can still start another turn after that, on a
background-task notification), and not when the write itself fails."""
import io

from viewer.engine import feed_next_queued


class _Proc:
    def __init__(self, closed=False):
        self.stdin = io.StringIO()
        if closed:
            self.stdin.close()


def _job(queue, stdin_open=True):
    return {"queue": list(queue), "stdin_open": stdin_open}


def test_feeds_next_message_in_order():
    job, proc = _job(["a", "b"]), _Proc()
    assert feed_next_queued(job, proc) is True
    assert '"a"' in proc.stdin.getvalue()
    assert job["queue"] == ["b"]


def test_empty_queue_closes_out():
    job = _job([])
    assert feed_next_queued(job, _Proc()) is False
    assert job["stdin_open"] is False


def test_closed_stdin_keeps_queue_for_follow_up_run():
    # stdin closed after an empty-queue turn, the owner queued two messages,
    # the CLI ended one more turn: nothing may be popped into a dead pipe.
    job = _job(["mine", "also mine"], stdin_open=False)
    assert feed_next_queued(job, _Proc(closed=True)) is False
    assert job["queue"] == ["mine", "also mine"]
    assert "requeued" not in job


def test_failed_write_puts_message_back_first_and_flags_follow_up():
    job = _job(["mine", "next"])
    assert feed_next_queued(job, _Proc(closed=True)) is False
    assert job["queue"] == ["mine", "next"]
    assert job["stdin_open"] is False
    # The finalizer gives requeued leftovers a follow-up run even when the
    # dying run's exit code is nonzero.
    assert job["requeued"] is True
