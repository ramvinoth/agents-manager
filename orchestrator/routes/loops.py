"""orchestrator.routes.loops — Scheduled loops: create, edit, list and delete."""
import time
import uuid as uuid_mod
from orchestrator import db
from orchestrator.loops import USER_ORIGIN, build_schedule


class LoopsMixin:
    def handle_create_loop(self):
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        rel = body.get("session", "")
        prompt = (body.get("prompt") or "").strip()
        full = self.resolve_session_quiet(rel)
        if not full:
            self.send_json({"error": "Session not found"}, status=404)
            return
        if not prompt:
            self.send_json({"error": "Empty prompt"}, status=400)
            return
        # cron > at (one-shot, kind='once') > interval — same vocabulary and
        # precedence as the agent-side loop_create action.
        sched, err = build_schedule(body.get("cron"), body.get("interval"), body.get("at"))
        if err:
            self.send_json({"error": err}, status=400)
            return
        lid = uuid_mod.uuid4().hex[:12]
        entry = {"session": full.stem, "path": rel, "prompt": prompt,
                 "runs": 0, "created": time.time(), "enabled": True,
                 "origin": USER_ORIGIN,
                 "model": (body.get("model") or "").strip(),
                 "provider": (body.get("provider") or "").strip(),
                 **sched}
        db.loop_upsert(lid, entry)
        self.send_json({"created": lid, "kind": sched["kind"], "interval": sched["interval"],
                        "cron": sched["cron"], "nextRun": sched["nextRun"]})

    def handle_edit_loop(self):
        """Update an existing loop/job in place, preserving its id, session and
        run history. Only the fields present in the body change. Any schedule
        input (`at`, `cron`, `interval`) rebuilds the whole schedule through
        build_schedule: `at` turns the job into a one-shot (kind='once') and
        clears a stale cron; cron/interval turn a one-shot back to recurring."""
        body = self.read_body()
        if body is None:
            self.send_json({"error": "Invalid JSON body"}, status=400)
            return
        lid = body.get("id", "")
        loop = db.loop_get(lid)
        if not loop:
            self.send_json({"error": "Job not found"}, status=404)
            return
        fields = {}
        if "prompt" in body:
            prompt = (body.get("prompt") or "").strip()
            if not prompt:
                self.send_json({"error": "Empty prompt"}, status=400)
                return
            fields["prompt"] = prompt
        if "at" in body:
            sched, err = build_schedule(None, None, body.get("at"))
        elif "cron" in body or "interval" in body:
            # Absent inputs keep their stored value, so cron still wins over an
            # interval-only edit until the caller clears it (cron: "").
            sched, err = build_schedule(body.get("cron", loop.get("cron")),
                                        body.get("interval", loop.get("interval")))
        else:
            sched, err = None, None
        if err:
            self.send_json({"error": err}, status=400)
            return
        if sched is not None:
            # An unchanged recurring schedule (editor re-sending the same interval
            # alongside a prompt tweak) must not push nextRun out again.
            same = all(sched[k] == loop.get(k) for k in ("cron", "interval", "kind"))
            if not (same and sched["kind"] == "recurring"):
                fields.update(sched)
        if "model" in body:
            fields["model"] = (body.get("model") or "").strip()
        if "provider" in body:
            fields["provider"] = (body.get("provider") or "").strip()
        if "enabled" in body:
            # Pause/resume. nextRun is deliberately left untouched: a resumed loop
            # that is already overdue fires at most ONCE (loop_scheduler's "paused
            # means paused, not queued" — runtime/scheduler.py), never a burst of the runs it
            # missed while off.
            fields["enabled"] = bool(body["enabled"])
        updated = db.loop_update(lid, fields)
        self.send_json({"updated": lid, "kind": updated.get("kind", "recurring"),
                        "interval": updated.get("interval"), "cron": updated.get("cron"),
                        "nextRun": updated.get("nextRun"), "enabled": updated.get("enabled")})

    def _g_loops(self, req):
        sid = (req.query.get("session") or [""])[0]
        loops = [dict(lp, id=lid) for lid, lp in db.loop_list(sid or None).items()]
        self.send_json(sorted(loops, key=lambda l: l.get("created", 0)))

    def _p_loops_delete(self, req):
        body = self.read_body()
        lid = (body or {}).get("id", "")
        existed = db.loop_delete(lid)
        self.send_json({"deleted": bool(existed)})

    def _p_loops(self, req):
        self.handle_create_loop()

    def _p_loops_edit(self, req):
        self.handle_edit_loop()
