"""Push tokens and the per-session inbox."""
import time

from orchestrator.shared import postgres


def add_push_token(user_id, token, platform="ios", app_version=None, app_build=None):
    """Register a device push token for a user. Idempotent: re-registering the
    same token re-points it at this user (a device can only serve one account).
    app_version/app_build are what the client declares it runs. TestFlight
    builds share one version string (0.1.0) and differ only in the build
    number, so the build is the identity that matters."""
    if not token:
        return
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO push_tokens(token, user_id, platform, created_at, app_version, app_build) "
            "VALUES(%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, "
            "platform = excluded.platform, created_at = excluded.created_at, "
            # COALESCE: a pre-telemetry build re-registering must not erase a
            # newer declaration for the same token.
            "app_version = COALESCE(excluded.app_version, push_tokens.app_version), "
            "app_build = COALESCE(excluded.app_build, push_tokens.app_build)",
            (token, user_id, platform or "ios", time.time(),
             app_version or None, app_build or None),
        )


def remove_push_token(token):
    """Drop a device token (logout, or Expo reported it unregistered)."""
    if not token:
        return
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM push_tokens WHERE token = %s", (token,))


def all_push_tokens():
    """Every registered device token. The base is single-owner, so a run's
    completion pushes to all of them (there's effectively one account)."""
    with postgres.cursor() as cur:
        cur.execute("SELECT token FROM push_tokens")
        return [r["token"] for r in cur.fetchall()]


# Inbox messages (the owner's and the agents' message ledger) ----------------

# "red" is an org Red approval (the approvals table) — see inbox.REF_FIELD.
INBOX_KINDS = ("message", "question", "plan", "approval", "card", "red")

_DECISION_KINDS = ("question", "plan", "approval", "card", "red")


def inbox_create(sender_type, sender_id, recipient_type, recipient_id, body,
                 kind="message", ref_id="", in_reply_to=0,
                 session_id="", project_id=None):
    """One inbox row. Decision kinds with a ref_id upsert on (kind, ref_id):
    re-delivering an open item refreshes the existing message — and puts it
    back to 'sent' unless the owner snoozed it (a snoozed item stays out of
    sight until its grace period lapses, then resurfaces; see inbox_list)."""
    if kind not in INBOX_KINDS:
        kind = "message"
    now = postgres.now()
    if kind in _DECISION_KINDS and ref_id:
        sql = ("INSERT INTO inbox_messages(session_id, project_id, sender_type, "
               "sender_id, recipient_type, recipient_id, body, kind, ref_id, "
               "in_reply_to, status, archived, created_at, updated_at) "
               "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'sent',FALSE,%s,%s) "
               "ON CONFLICT (kind, ref_id) WHERE ref_id <> '' DO UPDATE SET "
               "body = EXCLUDED.body, "
               "status = CASE WHEN inbox_messages.status = 'snoozed' "
               "THEN 'snoozed' ELSE 'sent' END, "
               "updated_at = EXCLUDED.updated_at RETURNING *")
    else:
        sql = ("INSERT INTO inbox_messages(session_id, project_id, sender_type, "
               "sender_id, recipient_type, recipient_id, body, kind, ref_id, "
               "in_reply_to, status, archived, created_at, updated_at) "
               "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'sent',FALSE,%s,%s) RETURNING *")
    with postgres.cursor() as cur:
        cur.execute(sql, (session_id, project_id, sender_type, sender_id,
                          recipient_type, recipient_id, body, kind, ref_id,
                          int(in_reply_to or 0), now, now))
        return dict(cur.fetchone())


def inbox_list(session_id=None, project_id=None, kind=None,
               unread_only=False, archived=False, limit=200, to_session=None):
    """The owner's inbox as a filtered VIEW. `session_id` narrows to one chat
    (its messages in both directions), `project_id` to a project, `kind` to one
    of INBOX_KINDS, `unread_only` to messages that need the owner's eye
    (status 'sent' and any snooze lapsed). Newest first."""
    clauses, params = ["archived = %s"], [bool(archived)]
    if session_id is not None:
        clauses.append("session_id = %s"); params.append(session_id)
    if project_id is not None:
        clauses.append("project_id = %s"); params.append(project_id)
    if kind is not None and kind in INBOX_KINDS:
        clauses.append("kind = %s"); params.append(kind)
    if to_session is not None:
        # An agent's unread mail is what was sent TO it; its own asks to the
        # owner are the owner's to read, not news to the agent.
        clauses.append("recipient_type = 'session' AND recipient_id = %s")
        params.append(str(to_session))
    if unread_only:
        clauses.append("(status = 'read' OR (status = 'snoozed' AND snoozed_until > %s)) = FALSE")
        params.append(postgres.now())
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM inbox_messages WHERE " + " AND ".join(clauses) +
                    " ORDER BY created_at DESC, id DESC LIMIT %s",
                    (*params, int(limit)))
        return [dict(r) for r in cur.fetchall()]


def inbox_get(message_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM inbox_messages WHERE id = %s", (message_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def inbox_mark_read(message_id):
    with postgres.cursor() as cur:
        cur.execute("UPDATE inbox_messages SET status = 'read', updated_at = %s "
                    "WHERE id = %s AND status = 'snoozed' RETURNING *",
                    (postgres.now(), message_id))
        row = cur.fetchone()
    if row:
        return dict(row)
    with postgres.cursor() as cur:
        cur.execute("UPDATE inbox_messages SET status = 'read', updated_at = %s "
                    "WHERE id = %s AND status = 'sent' RETURNING *",
                    (postgres.now(), message_id))
        row = cur.fetchone()
    return dict(row) if row else None


def inbox_mark_read_many(ids):
    """Mark these 'sent' rows read in one statement (an agent's listing)."""
    if not ids:
        return
    with postgres.cursor() as cur:
        cur.execute("UPDATE inbox_messages SET status = 'read', updated_at = %s "
                    "WHERE id = ANY(%s) AND status = 'sent'",
                    (postgres.now(), [int(i) for i in ids]))


def inbox_snooze(message_id, until):
    """Snooze a message out of the owner's sight until `until` (epoch). It
    resurfaces automatically when the clock passes `until` (inbox_list's
    unread filter treats a lapsed snooze as unread again) — a skipped
    question is never silently dropped, it waits and comes back."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE inbox_messages SET status = 'snoozed', "
                    "snoozed_until = %s, updated_at = %s WHERE id = %s "
                    "RETURNING *", (float(until or 0), postgres.now(), message_id))
        row = cur.fetchone()
    return dict(row) if row else None


def inbox_decision_refs():
    """Every live decision row's (kind, ref_id) → its inbox id and snooze
    deadline. The decision queue joins this onto its items so a snooze taken
    anywhere (Inbox or board cockpit) hides the item everywhere until it
    lapses, and so a client can snooze an item by its inbox id."""
    with postgres.cursor() as cur:
        cur.execute("SELECT kind, ref_id, id, status, snoozed_until FROM inbox_messages "
                    "WHERE kind IN %s AND ref_id <> '' AND archived = FALSE",
                    (_DECISION_KINDS,))
        return [dict(r) for r in cur.fetchall()]


def inbox_archive_for_session(session_id, archived):
    """Archiving a chat shelves its inbox messages; unarchiving brings them
    back (the notes rule, applied to messages). Returns how many changed."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE inbox_messages SET archived = %s, updated_at = %s "
                    "WHERE session_id = %s AND archived <> %s",
                    (bool(archived), postgres.now(), session_id, bool(archived)))
        return cur.rowcount


def inbox_delete_for_session(session_id):
    """A deleted chat takes its inbox messages with it (same lifecycle as its
    notes, loops and meta). Returns how many were removed."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM inbox_messages WHERE session_id = %s", (session_id,))
        return cur.rowcount
