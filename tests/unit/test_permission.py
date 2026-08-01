"""Unit tests for the Ask-mode tool-approval flow in viewer.engine:
register_permission (blocks until decided / times out -> deny), decide_permission
(the UI's Allow/Deny), and pending_approvals_public (drops the internal Event).

The blocking wait is exercised by deciding from a background thread so the test
stays fast and hermetic — no subprocess, no real claude."""
import threading
import time

import viewer.engine as engine
from viewer.config import CHAT_JOBS
from viewer.engine import decide_permission, pending_approvals_public, register_permission


def _fresh_job(sid, token="tok"):
    CHAT_JOBS[sid] = {"running": True, "perm_token": token, "pending_approvals": []}


def _teardown(sid):
    CHAT_JOBS.pop(sid, None)


class TestRegisterPermission:
    def test_unknown_session_denies(self):
        res = register_permission("nope", "tok", "T", {}, "u1")
        assert res == {"behavior": "deny", "message": "Unknown or unauthorized session"}

    def test_bad_token_denies(self):
        _fresh_job("s1", token="right")
        try:
            res = register_permission("s1", "wrong", "T", {}, "u1")
            assert res["behavior"] == "deny"
        finally:
            _teardown("s1")

    def test_allow_decision_unblocks(self):
        _fresh_job("s2")
        try:
            def approve():
                # wait until the pending approval is registered, then allow it
                for _ in range(200):
                    pend = pending_approvals_public("s2")
                    if pend:
                        decide_permission("s2", pend[0]["id"], "allow")
                        return
                    time.sleep(0.005)

            threading.Thread(target=approve).start()
            res = register_permission("s2", "tok", "Bash", {"command": "ls"}, "u2")
            assert res == {"behavior": "allow"}
        finally:
            _teardown("s2")

    def test_deny_decision(self):
        _fresh_job("s3")
        try:
            def deny():
                for _ in range(200):
                    pend = pending_approvals_public("s3")
                    if pend:
                        decide_permission("s3", pend[0]["id"], "deny")
                        return
                    time.sleep(0.005)

            threading.Thread(target=deny).start()
            res = register_permission("s3", "tok", "Bash", {}, "u3")
            assert res["behavior"] == "deny"
            assert res["message"] == "Denied"
        finally:
            _teardown("s3")

    def test_timeout_denies(self, monkeypatch):
        _fresh_job("s4")
        monkeypatch.setattr(engine, "PERM_TIMEOUT", 0.05)
        try:
            res = register_permission("s4", "tok", "Bash", {}, "u4")
            assert res["behavior"] == "deny"
            assert "timed out" in res["message"].lower()
        finally:
            _teardown("s4")


class TestPendingApprovalsPublic:
    def test_drops_event_and_shapes_entry(self):
        _fresh_job("s5")
        CHAT_JOBS["s5"]["pending_approvals"].append(
            {"id": "p1", "tool_name": "Bash", "input": {"command": "ls"},
             "tool_use_id": "u5", "event": threading.Event(), "decision": None,
             "created": time.time()})
        try:
            pub = pending_approvals_public("s5")
            assert pub == [{"id": "p1", "tool_name": "Bash", "input": {"command": "ls"}}]
            assert "event" not in pub[0]
        finally:
            _teardown("s5")

    def test_unknown_session_returns_empty(self):
        assert pending_approvals_public("ghost") == []


class TestDecidePermission:
    def test_unknown_returns_false(self):
        _fresh_job("s6")
        try:
            assert decide_permission("s6", "missing", "allow") is False
        finally:
            _teardown("s6")
