"""viewer.discussion — the message board under every note.

A note is a post; its comments are a Reddit-style thread (replies nest under
replies, votes rank them). Agents and the owner use it to talk ABOUT a piece
of knowledge: one session writes up research, another challenges it in the
thread, the owner settles it with a reply. The board is for work and its
decisions; this is for discussion that is not (yet) a task.

Who finds out about a new comment (Reddit's rule: the post's author and the
author of the comment you answered):
  - the note's own session, and the session that wrote the parent comment, are
    woken through boardwatch.schedule_once — the one wake mechanism, coalesced
    per (note, session), never a self-wake, origin = the cause (a human's
    comment wakes as 'user', an agent's as 'harman' and so obeys the loop mode
    and the automation switch);
  - the owner's phone is pushed only when an agent answers the OWNER (a reply
    to their comment, or a comment on a note they wrote). Agent-to-agent
    chatter never pages a person.

Runaway guard: agents waking agents can talk forever and burn the owner's
money. Once the thread's last RUNAWAY_LIMIT comments are all by agents, an
agent's comment wakes nobody until a human speaks in that thread.
"""
import sys

from viewer import db

RUNAWAY_LIMIT = 8
SORTS = ("best", "new", "old")


def is_human(author):
    return (author or "").startswith("user:")


def thread(comments, sort="best"):
    """Shape a note's flat comments (db.note_comment_list) into the nested
    thread: each comment gains `replies` (its children, same sort). `best`
    ranks by score then age (oldest first among equals, so the first good
    answer stays on top), `new` newest first, `old` posting order. A comment
    whose parent is missing is promoted to the top level, never lost."""
    by_id = {c["id"]: {**c, "replies": []} for c in comments}
    roots = []
    for c in by_id.values():
        parent = by_id.get(c.get("parent_id"))
        (parent["replies"] if parent else roots).append(c)
    key = {
        "best": lambda c: (-c.get("score", 0), c["created_at"], c["id"]),
        "new": lambda c: (-c["created_at"], -c["id"]),
        "old": lambda c: (c["created_at"], c["id"]),
    }.get(sort if sort in SORTS else "best")

    def order(nodes):
        nodes.sort(key=key)
        for n in nodes:
            order(n["replies"])
        return nodes
    return order(roots)


def runaway(comments, limit=RUNAWAY_LIMIT):
    """True when the thread's last `limit` comments are all by agents — the
    point at which agent comments stop waking agents."""
    tail = comments[-limit:]
    return len(tail) >= limit and not any(is_human(c.get("author")) for c in tail)


def recipients(note, parent, author_session):
    """The sessions a new comment wakes: the note's session and the parent
    comment's session, minus the commenter's own, de-duplicated."""
    out = []
    for sid in ((note or {}).get("session_id"), (parent or {}).get("session_id")):
        if sid and sid != author_session and sid not in out:
            out.append(sid)
    return out


def wake_id(note_id, session_id):
    """One pending wake per (note, session): a burst of replies coalesces."""
    return f"nd{note_id}:{session_id}"


def cancel_wakes(note_id):
    """Drop every pending discussion wake for a note (one per recipient session,
    nd<note>:<sid>) — called when the note is deleted, so no orphaned one-shot
    fires later against a note that is gone. Returns how many were removed. The
    `:` terminator keeps nd12: from also matching nd123:."""
    return db.loop_delete_prefix(f"nd{note_id}:")


def purge_session_notes(session_id):
    """Delete a chat's notes AND clear each one's discussion wakes — the member
    of the session-delete cleanup bundle that loop_delete_for_session cannot
    cover. A note's wakes are addressed to the RECIPIENT sessions (the repliers),
    not the note's owner, so dropping the owner's loops leaves nd<note>:<other>
    rows behind to fire against a note that is gone. Returns how many notes went."""
    ids = db.notes_delete_for_session(session_id)
    for nid in ids:
        cancel_wakes(nid)
    return len(ids)


def followup(comment, actor, by_agent):
    """After a comment commits: wake the sessions it concerns and, when an
    agent answers the owner, push the owner. Never raises — the comment is
    already stored; a failed wake leaves it in the thread for the next read."""
    try:
        from viewer import boardwatch
        from viewer.loops import AGENT_ORIGIN, USER_ORIGIN
        note = db.note_get(comment["note_id"])
        if not note:
            return
        parent = db.note_comment_get(comment["parent_id"]) if comment.get("parent_id") else None
        body = " ".join((comment.get("body") or "").split())
        excerpt = body[:200] + ("…" if len(body) > 200 else "")
        title = note.get("title") or "Untitled"
        if by_agent and (is_human((parent or {}).get("author")) or
                         (not parent and is_human(note.get("created_by")))):
            from viewer import push
            push.notify_all(f"Note {note['id']} · {title}"[:120],
                            f"{actor}: {excerpt}"[:300], data={"note": note["id"]})
        if by_agent and runaway(db.note_comment_list(note["id"])):
            return
        what = f"replied to a comment by {parent['author']}" if parent else "commented"
        prompt = (
            f"[note-discussion] Note {note['id']} \"{title}\" — {actor} {what}: "
            f"\"{excerpt}\" (comment {comment['id']}). Read the thread "
            f"(note_comments note_id={note['id']}). Reply with note_comment "
            f"(parent_id={comment['id']}) only if you add something new — an "
            "answer, a correction, evidence, a decision. Do not reply just to "
            "acknowledge; upvote with note_vote instead."
        )
        origin = AGENT_ORIGIN if by_agent else USER_ORIGIN
        for sid in recipients(note, parent, comment.get("session_id") or ""):
            boardwatch.schedule_once(wake_id(note["id"], sid), sid, prompt, origin)
    except Exception as e:
        print(f"[discussion] follow-up for comment {comment.get('id')} failed: {e}",
              file=sys.stderr)
