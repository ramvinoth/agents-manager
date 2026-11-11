"""Key/value settings rows."""
from psycopg2.extras import Json

from orchestrator.shared import postgres


# Settings (singleton key/value) ----------------------------------------------

def setting_get(key, default=None):
    with postgres.cursor() as cur:
        cur.execute("SELECT value FROM settings WHERE key = %s", (key,))
        row = cur.fetchone()
    return row["value"] if row else default


def setting_set(key, value):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (key, Json(value)),
        )


# Retention policy. Reads from settings so a SaaS-admin portal can tune the caps
# per plan/license without a deploy; falls back to the seeded defaults when the
# row is missing or a value is malformed (never returns junk the purge can't use).
_RETENTION_DEFAULTS = {"job_runs_days": 90, "job_runs_per_loop": 500, "ui_events_days": 180}


def retention_config():
    cfg = setting_get("retention", {}) or {}
    out = {}
    for k, dflt in _RETENTION_DEFAULTS.items():
        try:
            out[k] = int(cfg.get(k, dflt))
        except (TypeError, ValueError):
            out[k] = dflt
    return out
