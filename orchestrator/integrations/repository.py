"""Cloud drives, drive OAuth clients, local-disk rules and intake channels."""
import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

from orchestrator.shared import postgres
from orchestrator.shared import settings


# Drives (cloud storage registry) --------------------------------------------
# A drive is a cloud account (Google Drive, Dropbox, OneDrive) that the file
# routes serve as just one more disk. The bytes live on the vendor; these
# columns hold only the OAuth tokens (`config`, JSONB) and the plugin
# lifecycle (status active|paused, hidden). The list route must strip `config`
# before returning to a client, exactly as the hosts list route strips
# password/key_file.
def _drive_row(r):
    return {
        "id": r["id"],
        "label": r["label"],
        "kind": r["kind"],
        "config": r["config"] or {},
        "status": r["status"],
        "hidden": bool(r["hidden"]),
        "created_at": r["created_at"],
    }


def drives_load():
    """{id: {label, kind, config, status, hidden, created_at}} for every drive."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM drives ORDER BY created_at")
        return {r["id"]: _drive_row(r) for r in cur.fetchall()}


def drive_get(did):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM drives WHERE id = %s", (did,))
        r = cur.fetchone()
        return None if r is None else _drive_row(r)


def drive_upsert(did, entry):
    """Create or update one drive row. `entry` uses the JSON keys the API
    uses: label, kind, config, status, hidden."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO drives (id, label, kind, config, status, hidden, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO UPDATE SET "
            "label = EXCLUDED.label, kind = EXCLUDED.kind, config = EXCLUDED.config, "
            "status = EXCLUDED.status, hidden = EXCLUDED.hidden",
            (
                did,
                entry.get("label") or did,
                entry.get("kind") or "",
                Json(entry.get("config") or {}),
                entry.get("status") or "active",
                bool(entry.get("hidden")),
                postgres.now(),
            ),
        )


def drive_delete(did):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM drives WHERE id = %s RETURNING id", (did,))
        return cur.fetchone() is not None


# Intake channels (orchestrator.intake) --------------------------------------------

def intake_create(cid, name, project_id, session_id, token_hash, app_feedback, created_by):
    with postgres.cursor() as cur:
        if app_feedback:
            cur.execute("UPDATE intake_channels SET app_feedback = FALSE WHERE app_feedback")
        cur.execute(
            "INSERT INTO intake_channels(id, name, project_id, session_id, token_hash, "
            "app_feedback, created_by, created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (cid, name, project_id, session_id or "", token_hash, bool(app_feedback),
             created_by, postgres.now()))
        return dict(cur.fetchone())


def intake_list():
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM intake_channels ORDER BY created_at")
        return [dict(r) for r in cur.fetchall()]


def intake_get(cid):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM intake_channels WHERE id = %s", (cid,))
        row = cur.fetchone()
    return dict(row) if row else None


def intake_feedback_channel():
    """The channel the owner's in-app feedback goes to, or None."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM intake_channels WHERE app_feedback LIMIT 1")
        row = cur.fetchone()
    return dict(row) if row else None


def intake_update(cid, **fields):
    """Change name / session_id / app_feedback. Turning app_feedback on clears it
    on every other channel in the same transaction (at most one receives it)."""
    allowed = {k: v for k, v in fields.items() if k in ("name", "session_id", "app_feedback")}
    if not allowed:
        return intake_get(cid)
    with postgres.cursor() as cur:
        if allowed.get("app_feedback"):
            cur.execute("UPDATE intake_channels SET app_feedback = FALSE "
                        "WHERE app_feedback AND id <> %s", (cid,))
        sets = ", ".join(f"{k} = %s" for k in allowed)
        cur.execute(f"UPDATE intake_channels SET {sets} WHERE id = %s RETURNING *",
                    (*allowed.values(), cid))
        row = cur.fetchone()
    return dict(row) if row else None


def intake_set_token(cid, token_hash):
    with postgres.cursor() as cur:
        cur.execute("UPDATE intake_channels SET token_hash = %s WHERE id = %s RETURNING *",
                    (token_hash, cid))
        row = cur.fetchone()
    return dict(row) if row else None


def intake_delete(cid):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM intake_channels WHERE id = %s RETURNING id", (cid,))
        return cur.fetchone() is not None


def intake_card(cid, key):
    """The card channel `cid` opened for the sender's `key`, or None."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM cards WHERE created_by = %s AND intake_key = %s",
                    (f"intake:{cid}", key))
        row = cur.fetchone()
    return dict(row) if row else None


def intake_card_key(card_id, key):
    """Tag a card with its sender's key. False when another card already holds
    it (the unique index is the backstop; intake.deliver serialises keyed posts)."""
    try:
        with postgres.cursor() as cur:
            cur.execute("UPDATE cards SET intake_key = %s WHERE id = %s", (key, card_id))
        return True
    except psycopg2.errors.UniqueViolation:
        return False


def intake_touch(cid):
    """Record one delivery: bump the counter, stamp last_used. Returns the count
    of cards and updates this channel posted in the last hour (the rate-limit input)."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE intake_channels SET received = received + 1, last_used = %s "
                    "WHERE id = %s", (postgres.now(), cid))
        cur.execute("SELECT (SELECT count(*) FROM cards WHERE created_by = %(a)s AND created_at > %(t)s)"
                    " + (SELECT count(*) FROM card_comments WHERE author = %(a)s AND created_at > %(t)s) AS n",
                    {"a": f"intake:{cid}", "t": postgres.now() - 3600})
        return cur.fetchone()["n"]


# The owner's local-disk rules (Integrations → Local disk): which folders and
# operations agents may use on this machine. One reader for the engine and the
# routes, so core code never imports a route module to learn them.
LOCAL_DISK_KEY = "local_disk"


def local_disk_rules():
    from orchestrator.integrations import catalog
    return catalog.local_rules(settings.setting_get(LOCAL_DISK_KEY))


def local_disk_set(rules):
    settings.setting_set(LOCAL_DISK_KEY, rules)


# Cloud-drive OAuth CLIENTS: the viewer's own identity to each vendor (a
# vendor's per-user tokens live in the drives table). settings['drive_clients']
# = {kind: {client_id, client_secret?}}. Edited from the app's Integrations
# dialog; the secret is read only by the token exchange/refresh, never listed.

def drive_clients_load():
    return settings.setting_get("drive_clients", {}) or {}


def drive_client_get(kind):
    return drive_clients_load().get(kind)


def drive_client_set(kind, client_id, client_secret=None):
    """Store one vendor client. `client_secret=None` keeps the secret already
    on record (the UI never has it to send back); '' clears it."""
    clients = drive_clients_load()
    prev = clients.get(kind) or {}
    entry = {"client_id": client_id}
    secret = prev.get("client_secret") if client_secret is None else client_secret
    if secret:
        entry["client_secret"] = secret
    clients[kind] = entry
    settings.setting_set("drive_clients", clients)
    return entry


def drive_client_delete(kind):
    clients = drive_clients_load()
    if kind not in clients:
        return False
    del clients[kind]
    settings.setting_set("drive_clients", clients)
    return True
