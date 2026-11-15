"""Call recording: the evidence behind the live-call engine.

One call is one CallRecorder. It keeps two raw audio files on disk — the caller's
16 kHz input and the reply's 24 kHz voice — and a timeline of events in Postgres
(orchestrator.call_events), aligned by byte offset: every event records how many
bytes of each stream had arrived when it fired. A later reader can line the audio
against what was heard and said and check, with certainty, whether the caller's
first words were actually captured before the engine answered — the one thing an
ASR transcript alone cannot show (a dropped opening word leaves text that starts
mid-sentence, with no way to know a gap was there).

Deliberately cheap on the call path. Audio goes straight to an open file (the OS
page cache, no fsync per chunk); events buffer in memory and flush to Postgres
once, in close(). Nothing here may raise into a live call: a dead disk or a down
database must never break a call, so every operation is guarded, and a recorder
that cannot open degrades to a silent no-op. The directory is 0700 — this is the
owner's own voice, kept private and bounded by retention (call_recordings_days,
purged by the scheduler, whose file sweep runs independently of the row purge).
"""
import json
import re
import struct
import time
import threading


def safe_call_id(raw):
    """A call's on-disk and DB id: the session id with any filename-unsafe
    character flattened and the length capped, so it never trips a path or a
    column. Blank input still yields a usable, unique-per-call id."""
    s = re.sub(r"[^0-9A-Za-z._-]", "_", str(raw or ""))[:64]
    return s or "call"


def wav_header(data_bytes, rate):
    """44-byte RIFF header for raw 16-bit mono PCM, so a recording plays in any
    audio element without a conversion pass."""
    return (b"RIFF" + struct.pack("<I", 36 + data_bytes) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", data_bytes))


class CallRecorder:
    def __init__(self, call_id, enabled=True):
        self.call_id = call_id
        self.enabled = enabled
        self.t0 = time.monotonic()
        self._lock = threading.Lock()
        self._caller_f = self._reply_f = None
        self._caller_bytes = 0
        self._reply_bytes = 0
        self._events = []
        self._closed = False
        if enabled:
            self._open_files()

    def _open_files(self):
        try:
            from orchestrator import config
            d = config.CALL_RECORDINGS_DIR
            d.mkdir(parents=True, exist_ok=True)
            try:
                d.chmod(0o700)          # the owner's voice is private
            except OSError:
                pass
            self._caller_f = (d / f"{self.call_id}.caller.pcm").open("wb")
            self._reply_f = (d / f"{self.call_id}.reply.pcm").open("wb")
        except Exception as e:
            print(f"[callrecord] open failed, recording disabled: {e}", flush=True)
            self.enabled = False

    # -- audio (hot path: one guarded write per chunk, no fsync)
    def _write(self, f, chunk):
        if not self.enabled or f is None:
            return
        with self._lock:
            try:
                f.write(chunk)
            except Exception:
                pass
            if f is self._caller_f:
                self._caller_bytes += len(chunk)
            elif f is self._reply_f:
                self._reply_bytes += len(chunk)

    def caller(self, chunk):
        self._write(self._caller_f, chunk)

    def reply(self, chunk):
        self._write(self._reply_f, chunk)

    # -- events (buffered here, flushed once in close)
    def event(self, kind, sub="", turn=-1, text="", **detail):
        if not self.enabled:
            return
        row = {"ts": time.monotonic() - self.t0, "abs_ts": time.time(),
               "call_id": self.call_id, "kind": kind, "sub": sub,
               "turn": turn, "text": text}
        if detail:
            row["detail"] = json.dumps(detail)
        with self._lock:
            row["caller_bytes"] = self._caller_bytes
            row["reply_bytes"] = self._reply_bytes
            self._events.append(row)

    def close(self, reason="closed"):
        if not self.enabled or self._closed:
            return
        self._closed = True
        self.event("stop", sub=reason)          # the timeline ends with the totals
        with self._lock:
            caller_f, reply_f, self._caller_f, self._reply_f = \
                self._caller_f, self._reply_f, None, None
            events, self._events = self._events, []
        for f in (caller_f, reply_f):
            try:
                if f is not None:
                    f.close()
            except Exception:
                pass
        try:
            from orchestrator import db
            db.call_events_insert(self.call_id, events)
        except Exception as e:
            print(f"[callrecord] flush failed ({len(events)} events lost): {e}", flush=True)


def purge_files(max_age_days):
    """Drop raw call audio older than the retention window, whatever happened to
    its rows. Independent of the row purge, so the disk stays bounded even if the
    database is down (which would leave files whose timelines were never flushed).
    Never raises."""
    if not max_age_days or max_age_days <= 0:
        return
    try:
        from orchestrator import config
        d = config.CALL_RECORDINGS_DIR
        if not d.is_dir():
            return
        cutoff = time.time() - float(max_age_days) * 86400
        for p in d.iterdir():
            try:
                if p.suffix == ".pcm" and p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass
    except Exception:
        pass
