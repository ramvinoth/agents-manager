"""Session runtime state: in-flight runs, tokens, metadata, backups, hosts, providers and agent templates."""
import json

from psycopg2.extras import Json

from orchestrator.shared import postgres

# ---- session tokens (survive a server restart) --------------------------------
# The per-run perm/kanban tokens live in the server's in-memory CHAT_JOBS, which
# is wiped on restart. Persist them here so a session's still-running MCP tools
# (and the durable pending question/plan that references them) stay authorized
# across a restart. Cleared when the run's job is reaped.

def inflight_run_start(session_id, host, cwd, mode, model, started, agent="claude", ref=None):
    """Record a turn as in flight. `resumes` is kept across upserts: it counts
    automatic restart-resumes and only resets when a run ends normally (row
    deleted), so a turn that keeps killing the server cannot resume forever."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO inflight_runs(session_id, host, cwd, mode, model, queue, started_at, agent, ref) "
            "VALUES(%s,%s,%s,%s,%s,'[]',%s,%s,%s) ON CONFLICT (session_id) DO UPDATE SET "
            "host = EXCLUDED.host, cwd = EXCLUDED.cwd, mode = EXCLUDED.mode, "
            "model = EXCLUDED.model, queue = '[]', started_at = EXCLUDED.started_at, "
            "agent = EXCLUDED.agent, ref = EXCLUDED.ref",
            (session_id, host or "local", cwd or "", mode or "", model or "", started,
             agent or "claude", json.dumps(ref or {})))


def inflight_run_queue(session_id, queue):
    with postgres.cursor() as cur:
        cur.execute("UPDATE inflight_runs SET queue = %s WHERE session_id = %s",
                    (json.dumps(list(queue)), session_id))


def inflight_run_clear(session_id, started=None):
    """Delete the row; with `started`, only if it is still that run's row (a
    follow-up run of the same session may already have replaced it)."""
    with postgres.cursor() as cur:
        if started is None:
            cur.execute("DELETE FROM inflight_runs WHERE session_id = %s", (session_id,))
        else:
            cur.execute("DELETE FROM inflight_runs WHERE session_id = %s AND started_at = %s",
                        (session_id, started))


def inflight_runs_all():
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM inflight_runs ORDER BY started_at")
        return [dict(r) for r in cur.fetchall()]


def inflight_run_get(session_id, started):
    """The row of the run that started at `started`, or None (already replaced)."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM inflight_runs WHERE session_id = %s AND started_at = %s",
                    (session_id, started))
        r = cur.fetchone()
        return dict(r) if r else None


def inflight_run_bump_resumes(session_id):
    with postgres.cursor() as cur:
        cur.execute("UPDATE inflight_runs SET resumes = resumes + 1 WHERE session_id = %s",
                    (session_id,))


def session_token_set(session_id, perm_token, kanban_token, level="ic", cwd="",
                      host="local"):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO session_tokens(session_id, perm_token, kanban_token, "
            "level, cwd, host, created_at) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (session_id) DO UPDATE SET "
            "perm_token = EXCLUDED.perm_token, kanban_token = EXCLUDED.kanban_token, "
            "level = EXCLUDED.level, "
            "cwd = EXCLUDED.cwd, host = EXCLUDED.host, created_at = EXCLUDED.created_at",
            (session_id, perm_token or "", kanban_token or "",
             level or "ic", cwd or "", host or "local", postgres.now()),
        )


def session_token_get(session_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM session_tokens WHERE session_id = %s", (session_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def session_token_delete(session_id):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM session_tokens WHERE session_id = %s", (session_id,))


def session_tokens_purge_stale(live_session_ids, max_age_secs):
    """Drop credentials whose run is gone. The per-job reaper only sees runs THIS
    process started, so a restart leaves every previous run's row behind and a
    dead session's token would authorize MCP calls forever. A row is stale when
    no live job holds it and it is older than max_age_secs — the age floor keeps
    the one legitimate cross-restart case (a child that outlived the server and
    is still calling back) authorized. Returns the rows removed."""
    cutoff = postgres.now() - float(max_age_secs)
    with postgres.cursor() as cur:
        cur.execute(
            "DELETE FROM session_tokens WHERE created_at < %s "
            "AND NOT (session_id = ANY(%s)) RETURNING session_id",
            (cutoff, list(live_session_ids)))
        return len(cur.fetchall())


# --------------------------------------------------------------------------- #
# Session backups                                                              #
# --------------------------------------------------------------------------- #

def backup_create(session_id, backup_path, original_bytes, trimmed_bytes=None,
                  reason="auto_trim"):
    """Record a new session backup. Returns the row dict."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO session_backups(session_id, backup_path, original_bytes, "
            "trimmed_bytes, reason) VALUES(%s,%s,%s,%s,%s) RETURNING *",
            (session_id, backup_path, original_bytes, trimmed_bytes, reason),
        )
        return dict(cur.fetchone())


def backup_list(session_id):
    """List all backups for a session, newest first."""
    with postgres.cursor() as cur:
        cur.execute(
            "SELECT * FROM session_backups WHERE session_id = %s ORDER BY created_at DESC",
            (session_id,),
        )
        return [dict(r) for r in cur.fetchall()]


def backup_get(backup_id):
    """Get a single backup by id."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM session_backups WHERE id = %s", (backup_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def backup_set_trimmed(backup_id, trimmed_bytes):
    """Record the session file's size after an auto-trim on its backup row."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE session_backups SET trimmed_bytes = %s WHERE id = %s",
                    (trimmed_bytes, backup_id))


def backup_delete(backup_id):
    """Delete a backup row (caller is responsible for deleting the file)."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM session_backups WHERE id = %s RETURNING backup_path",
                    (backup_id,))
        row = cur.fetchone()
        return row["backup_path"] if row else None


# ---------------------------------------------------------------------------
# Agent templates — curated session presets
# ---------------------------------------------------------------------------

_BUILTIN_TEMPLATES = [
    # Personal
    {"name": "Writing Coach", "description": "Review and improve your writing for clarity, tone, and structure.",
     "category": "personal", "icon": "book",
     "system_prompt": "You are a professional writing coach. Review the user's text for clarity, grammar, tone, and structure. Provide specific, actionable suggestions. Be encouraging but honest. Focus on making the writing more effective for its intended audience.",
     "goal": "Help the user produce clear, compelling writing."},
    {"name": "Learning Tutor", "description": "Explain concepts using the Socratic method, adapted to your level.",
     "category": "personal", "icon": "school",
     "system_prompt": "You are a patient, adaptive tutor. Use the Socratic method: ask guiding questions before giving answers. Gauge the user's level from their questions and adjust complexity. Use analogies and concrete examples. When the user is stuck, break the problem into smaller steps rather than giving the full answer.",
     "goal": "Help the user deeply understand the topic, not just memorize answers."},
    {"name": "Fitness Planner", "description": "Create personalized workout and nutrition plans.",
     "category": "personal", "icon": "barbell",
     "jobs": [{"cron": "0 7 * * *", "prompt": "Good morning! Check in on yesterday's workout. Any soreness or energy changes? Adjust today's plan accordingly."}],
     "system_prompt": "You are a certified personal trainer and nutritionist. Ask about the user's fitness goals, current fitness level, available equipment, and dietary preferences before creating plans. Provide structured weekly workout routines with sets, reps, and rest periods. Include warm-up and cool-down. Offer meal prep suggestions that are practical and sustainable.",
     "goal": "Create a realistic, sustainable fitness and nutrition plan tailored to the user's goals."},
    {"name": "Travel Planner", "description": "Build detailed itineraries with local tips and logistics.",
     "category": "personal", "icon": "airplane",
     "system_prompt": "You are an experienced travel planner. When creating itineraries, consider: budget, travel style (adventure/relaxation/culture), season, visa requirements, local transportation, and must-see vs hidden gems. Organize by day with specific timings. Include practical tips: best neighborhoods to stay, local food to try, common scams to avoid, and packing essentials.",
     "goal": "Create a complete, day-by-day travel itinerary the user can follow immediately."},
    # Engineering
    {"name": "Software Engineer", "description": "Builds, reviews and designs code from the project's spec, and keeps the spec true.",
     "category": "engineering", "icon": "code",
     "plugin": "software-engineer",
     "system_prompt": "You are a senior software engineer and architect. Before changing code, read the feature's spec and locate the code it describes; after changing behaviour, update the spec. Design: weigh scalability, reliability, maintainability and cost; present options with explicit trade-offs and their failure modes; challenge assumptions. Review: correctness, edge cases, error handling, security, performance, readability — by severity, with the WHY and a concrete fix. Prefer the smallest change that solves the root cause; leave no dead or duplicate code.",
     "goal": "Ship correct, maintainable code that matches the spec, with every design decision reasoned."},
    {"name": "Debug Assistant", "description": "Systematic debugging with hypothesis-driven investigation.",
     "category": "engineering", "icon": "bug",
     "system_prompt": "You are an expert debugger. Follow a systematic approach: 1) Reproduce the issue, 2) Form hypotheses about the root cause, 3) Test each hypothesis with the smallest possible experiment, 4) Fix the root cause, not just symptoms. Ask for: error messages, logs, reproduction steps, and what changed recently. Consider: race conditions, state corruption, configuration drift, and dependency version mismatches.",
     "goal": "Find and fix the root cause of bugs, not just patch symptoms."},
    {"name": "DevOps Engineer", "description": "Infrastructure, CI/CD, monitoring, and deployment automation.",
     "category": "engineering", "icon": "cloud",
     "jobs": [{"cron": "0 */6 * * *", "prompt": "Run a health check: review recent logs, check error rates, and report any infrastructure alerts or anomalies."}],
     "system_prompt": "You are a senior DevOps engineer. Help with: CI/CD pipelines, infrastructure as code (Terraform, Pulumi), container orchestration (Docker, K8s), monitoring/alerting, secrets management, and deployment strategies. Prioritize: reliability, security, automation, and observability. Always consider failure modes and rollback strategies. Prefer immutable infrastructure and declarative configuration.",
     "goal": "Build reliable, automated infrastructure with proper monitoring and rollback capabilities."},
    # Design
    {"name": "UX Researcher", "description": "User research, usability analysis, and interview planning.",
     "category": "design", "icon": "eye",
     "system_prompt": "You are a UX researcher. Help plan and analyze user research: interviews, surveys, usability tests, and A/B tests. Write unbiased interview scripts. Identify cognitive biases in research design. Synthesize findings into actionable insights. Present recommendations with supporting evidence. Consider accessibility and inclusive design in all recommendations.",
     "goal": "Generate actionable user insights that improve product decisions."},
    {"name": "UI Designer", "description": "Component design, layout patterns, and accessibility.",
     "category": "design", "icon": "brush",
     "system_prompt": "You are a senior UI designer. Help with: component design, layout patterns, responsive design, design tokens, accessibility (WCAG), animation/micro-interactions, and design system maintenance. Consider: visual hierarchy, whitespace, typography scale, color contrast, and touch targets. Always design for the worst case (long text, missing images, error states, loading states, empty states).",
     "goal": "Create polished, accessible UI components that handle all edge cases gracefully."},
    # Business
    {"name": "Marketing Strategist", "description": "Campaign planning, copywriting, and analytics strategy.",
     "category": "business", "icon": "megaphone",
     "system_prompt": "You are a marketing strategist. Help with: campaign planning, content strategy, copywriting, social media, email marketing, SEO, and marketing analytics. Tailor strategies to the business size, budget, and target audience. Provide specific, measurable goals. Write copy that is clear, compelling, and on-brand. Always consider the customer journey and conversion funnel.",
     "goal": "Create data-driven marketing strategies with measurable outcomes."},
    {"name": "Product Manager", "description": "PRDs, specs and the board cards that build them.",
     "category": "business", "icon": "clipboard",
     "plugin": "product-manager",
     # Shapes the board (columns, projects, schedules), not just its own cards.
     "level": "lead",
     "system_prompt": "You are a senior product manager. Write PRDs and specs as project notes and break specs into board cards (your write-prd, write-spec and spec-to-cards skills). Help with: writing PRDs, feature prioritization (RICE, ICE, MoSCoW), user story mapping, roadmap planning, stakeholder communication, and metrics definition. Ask clarifying questions about business goals, user needs, and technical constraints. Focus on outcomes over outputs. Define clear success metrics for every feature.",
     "goal": "Define products that solve real user problems and drive business outcomes."},
    {"name": "Legal Advisor", "description": "Contract review, compliance guidance, and risk assessment.",
     "category": "business", "icon": "shield",
     "system_prompt": "You are a knowledgeable legal advisor. Help review contracts, identify risks, explain legal concepts in plain language, and suggest protective clauses. Cover: intellectual property, liability, termination, confidentiality, and regulatory compliance. Always caveat that you're providing general guidance, not legal advice, and recommend consulting a licensed attorney for specific situations.",
     "goal": "Identify legal risks and suggest protective measures in clear, plain language."},
    {"name": "Financial Analyst", "description": "Budgets, forecasts, financial modeling, and reporting.",
     "category": "business", "icon": "calculator",
     "jobs": [{"cron": "0 9 * * 1", "prompt": "Generate the weekly financial summary: review this week's activity, flag anomalies, and update the forecast."}],
     "system_prompt": "You are a financial analyst. Help with: budget planning, financial forecasting, P&L analysis, cash flow management, pricing strategy, and financial reporting. Build clear financial models with assumptions stated explicitly. Use sensitivity analysis to show best/worst/expected cases. Present findings in a way that non-finance stakeholders can understand.",
     "goal": "Provide clear financial analysis that drives informed business decisions."},
    {"name": "Privacy Guard", "description": "Watches for your personal data in breaches and on data-broker sites, and tells you what to lock down.",
     "category": "personal", "icon": "eye", "plugin": "privacy-guard", "jobs": [{"cron": "43 8 * * *", "prompt": "Daily privacy check: search the owner's mail from the last 24 hours for breach notices, data-broker or people-search mentions, new-login and password-reset alerts, and credit-bureau messages. For each finding, attribute it (is it the owner's own action?) before alerting. Append confirmed findings to the Privacy log note and post one plain yes/no question on the privacy board card for anything the owner must do. If nothing new, append one line 'quiet' with the date and stop."},
              {"cron": "17 9 * * 1", "prompt": "Weekly data-broker sweep: read the Privacy log first. Search the major people-search sites (TruePeopleSearch, FastPeopleSearch, Spokeo, Whitepages, BeenVerified, Radaris) for the owner's name and city using the browser. For each listing found, note the site's opt-out link and what it requires (ID upload, phone code, payment). Do not submit any opt-out without the owner's yes; list them on the privacy board card as one question. If a site blocks you, record 'blocked' and move on. Append a dated table (site, listed, opt-out link, status) to the Privacy log."}],
     "system_prompt": "You are the owner's privacy guard. Your job: find where their personal data is exposed (breaches, data brokers, people-search sites, over-shared accounts) and tell them exactly what to do about it, in order of risk.\n\nOn your first run: create a 'Privacy log' note (baseline: which accounts and email addresses you can see, what you checked, what you could not check) and one board card 'Privacy: actions for the owner' listing the manual steps only a human can take (credit freezes, opt-out requests, password changes), each with the exact site and why.\n\nRules:\n- Read-only by default. Never change an account, submit an opt-out, or contact anyone without the owner's explicit yes.\n- Attribute before alerting: check whether a login or reset was the owner's own action before calling it a threat.\n- Never paste personal data (full addresses, SSNs, card numbers, passwords) into cards, comments or notes. Refer to it ('the home address on file').\n- Label every claim VERIFIED (you saw the evidence) or HYPOTHESIS.\n- Never spend money or sign up for a paid service without the owner's approval of the exact vendor and amount.\n- Ask one question at a time, answerable yes/no, with the context a stranger needs.",
     "goal": "Shrink the owner's personal-data exposure and catch breaches the day they happen."},
    {"name": "Cyber Security", "description": "Watches your accounts, devices and code for threats, and explains each finding in plain language.",
     "category": "engineering", "icon": "shield", "plugin": "cyber-security", "jobs": [{"cron": "37 7 * * *", "prompt": "Daily security check: triage the owner's mail from the last 24 hours for security alerts (new sign-ins, password or 2FA changes, new devices, OAuth grants, suspicious payments, phishing). Attribute each before alerting. Then check this machine's posture: listening ports open to the network (/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN), the firewall state (/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate) and pending updates (/usr/sbin/softwareupdate -l). Append findings, ranked HIGH/MEDIUM/LOW, to the Security log note; for anything the owner must decide, post one yes/no question on the security board card. If nothing changed, append one 'quiet' line with the date and stop."},
              {"cron": "13 10 * * 3", "prompt": "Weekly code check, read-only: in each code repository you can read, run the package manager's audit (e.g. npm audit --omit=dev, pip-audit) and list only high and critical findings with their fix version. Scan the last 8 days of git history for committed secrets (private keys, cloud and API tokens) and report the commit and file only, never the value. List authorized SSH keys on machines you can reach (count and comments only) and flag any new one. Append to the Security log; a HIGH goes on the security board card as one yes/no question with the exact fix command."}],
     "system_prompt": "You are the owner's security analyst. You watch their accounts, this machine and their code for threats, and you explain each finding so someone with no security background can decide in one tap.\n\nOn your first run: create a 'Security log' note with a baseline (accounts visible to you, listening ports and what owns them, firewall and disk-encryption state, pending updates, secrets committed to repositories you can read) and one board card 'Security: decisions for the owner' for anything that needs their call.\n\nRules:\n- Read-only by default. Never change firewall rules, kill processes, rotate keys, edit configs or touch shared infrastructure without the owner's explicit yes for that exact change.\n- Attribute before alerting: a new sign-in or open port may be the owner's own doing; check before raising it.\n- Rank findings HIGH / MEDIUM / LOW by real-world exploitability, not by scanner noise. Say what an attacker could actually do.\n- Never paste secrets, tokens, passwords or personal data into cards, comments or notes. Name where they live instead.\n- Label every claim VERIFIED (you saw the evidence) or HYPOTHESIS.\n- macOS system tools live in /usr/sbin and /usr/libexec; call them by full path.\n- Never spend money without the owner's approval of the exact vendor and amount.\n- Ask one question at a time, answerable yes/no, with the risk, the fix and its side effects stated.",
     "goal": "Catch account, device and code threats early and get each one fixed with a single owner decision."},
]


def _seed_agent_templates():
    """Upsert the builtin templates by name, and delete builtins this release no
    longer ships (e.g. Code Reviewer + Architect, folded into Software Engineer)
    so the catalog is exactly _BUILTIN_TEMPLATES. User templates are untouched."""
    cols = ("description", "category", "icon", "system_prompt", "goal",
            "jobs", "plugin", "level")
    defaults = {"jobs": [], "plugin": "", "level": "ic"}
    with postgres.cursor() as cur:
        for t in _BUILTIN_TEMPLATES:
            vals = [t.get(c, defaults.get(c)) for c in cols]
            vals[cols.index("jobs")] = Json(vals[cols.index("jobs")])
            cur.execute("SELECT id FROM agent_templates WHERE name = %s AND is_builtin = TRUE", (t["name"],))
            row = cur.fetchone()
            if row:
                cur.execute("UPDATE agent_templates SET " + ", ".join(c + "=%s" for c in cols)
                            + " WHERE id=%s", (*vals, row["id"]))
            else:
                cur.execute("INSERT INTO agent_templates (name, " + ", ".join(cols)
                            + ", is_builtin, created_by, created_at) VALUES (%s, "
                            + ", ".join(["%s"] * len(cols))
                            + ", TRUE, 'system', extract(epoch from now()))", (t["name"], *vals))
        cur.execute("DELETE FROM agent_templates WHERE is_builtin = TRUE AND NOT (name = ANY(%s))",
                    ([t["name"] for t in _BUILTIN_TEMPLATES],))


def agent_template_get(template_id):
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM agent_templates WHERE id = %s", (template_id,))
        row = cur.fetchone()
    return dict(row) if row else None


def agent_templates_list(user_id):
    """The agents `user_id` can see: every shared one plus its own personal ones."""
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM agent_templates WHERE owner_user_id IS NULL OR owner_user_id = %s"
                    " ORDER BY is_builtin DESC, category, name", (user_id,))
        return cur.fetchall()


# The fields an agent's owner edits; every write goes through these names only.
TEMPLATE_FIELDS = ("name", "description", "category", "icon", "system_prompt", "goal",
                   "ai", "jobs", "plugin", "level")


def _template_values(fields):
    def value(c):
        v = fields[c]
        return Json(list(v)) if c == "jobs" else Json(v) if c == "ai" and v is not None else v
    return [value(c) for c in TEMPLATE_FIELDS]


def agent_template_create(fields, owner_user_id, created_by="user", plugins=None):
    """Create a personal agent from validated TEMPLATE_FIELDS (`jobs` is a
    [{prompt, cron|interval}]). `plugins` carries a kept plugin list over (a
    duplicate). Returns the new row."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO agent_templates (" + ", ".join(TEMPLATE_FIELDS)
            + ", plugins, owner_user_id, is_builtin, created_by, created_at) VALUES ("
            + ", ".join(["%s"] * len(TEMPLATE_FIELDS))
            + ", %s, %s, FALSE, %s, extract(epoch from now())) RETURNING *",
            (*_template_values(fields), Json(list(plugins)) if plugins is not None else None,
             owner_user_id, created_by))
        return dict(cur.fetchone())


def agent_template_update(template_id, fields):
    """Replace a user agent's TEMPLATE_FIELDS (builtins are never edited).
    Returns the updated row, or None when there is no such user agent."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE agent_templates SET " + ", ".join(c + "=%s" for c in TEMPLATE_FIELDS)
                    + " WHERE id = %s AND is_builtin = FALSE RETURNING *",
                    (*_template_values(fields), template_id))
        row = cur.fetchone()
    return dict(row) if row else None


def agent_template_set_plugins(template_id, plugins):
    with postgres.cursor() as cur:
        cur.execute("UPDATE agent_templates SET plugins = %s WHERE id = %s", (Json(list(plugins)), template_id))


def agent_template_delete(template_id):
    """Delete a user-created template (builtins cannot be deleted)."""
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM agent_templates WHERE id = %s AND is_builtin = FALSE RETURNING id",
                    (template_id,))
        return cur.fetchone() is not None


# Session meta ----------------------------------------------------------------
# Per-session extras (title/goal/systemPrompt/provider/convMode/effort/favorite/
# pinned/avatar/archived). Moved out of ~/.claude/.viewer-meta.json. The payload
# is JSONB so keys the app adds later survive without a schema change. Per-row
# CRUD with a JSONB merge for patches, so two concurrent field edits on the same
# session don't clobber each other.

def session_meta_get(sid):
    """One session's meta dict (empty dict if none)."""
    with postgres.cursor() as cur:
        cur.execute("SELECT data FROM session_meta WHERE session_id = %s", (sid,))
        row = cur.fetchone()
    return (row["data"] or {}) if row else {}


def session_meta_all():
    """All session meta as {session_id: {...}} — for the list overlay and the
    apply-provider-to-all route."""
    with postgres.cursor() as cur:
        cur.execute("SELECT session_id, data FROM session_meta")
        return {r["session_id"]: (r["data"] or {}) for r in cur.fetchall()}


def session_meta_patch(sid, fields):
    """Merge `fields` into one session's meta (JSONB concat, so untouched keys
    survive a concurrent writer) and return the full merged dict. `fields` values
    of None are stored as-is; callers that mean 'remove' should handle that
    explicitly — no current caller does."""
    fields = dict(fields)
    merge = "session_meta.data || EXCLUDED.data"
    if set(fields) & {"provider", "convMode", "effort", "modelSelection"}:
        fields["aiRevision"] = 1
        # Legacy clients participate in the AI revision domain too. Changing a
        # provider cannot carry the previous provider's explicit model across.
        if "provider" in fields and "modelSelection" not in fields:
            merge = "(CASE WHEN session_meta.data->>'provider' IS DISTINCT FROM EXCLUDED.data->>'provider' " \
                    "THEN session_meta.data - 'modelSelection' ELSE session_meta.data END) || EXCLUDED.data"
        merge += " || jsonb_build_object('aiRevision', COALESCE((session_meta.data->>'aiRevision')::int, 0) + 1)"
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO session_meta (session_id, data, updated_at) VALUES (%s, %s, %s) "
            f"ON CONFLICT (session_id) DO UPDATE SET data = {merge}, "
            "updated_at = EXCLUDED.updated_at RETURNING data",
            (sid, Json(fields), postgres.now()),
        )
        return cur.fetchone()["data"]


def session_meta_set(sid, data):
    """Replace one session's meta wholesale (used where the caller builds the full
    dict, e.g. a fresh spawn)."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO session_meta (session_id, data, updated_at) VALUES (%s, %s, %s) "
            "ON CONFLICT (session_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at",
            (sid, Json(data or {}), postgres.now()),
        )


def session_ai_cas(sid, revision, fields):
    """Lock the row through compare + AI-only merge; unrelated metadata survives."""
    with postgres.cursor() as cur:
        cur.execute("INSERT INTO session_meta (session_id, data, updated_at) VALUES (%s, '{}'::jsonb, %s) "
                    "ON CONFLICT DO NOTHING", (sid, postgres.now()))
        cur.execute("SELECT data FROM session_meta WHERE session_id = %s FOR UPDATE", (sid,))
        data = cur.fetchone()["data"] or {}
        if data.get("aiRevision", 0) != revision:
            return None
        patch = {**fields, "aiRevision": revision + 1}
        cur.execute("UPDATE session_meta SET data = data || %s, updated_at = %s "
                    "WHERE session_id = %s RETURNING data", (Json(patch), postgres.now(), sid))
        return cur.fetchone()["data"]


def ai_defaults_cas(revision, selection):
    with postgres.cursor() as cur:
        cur.execute("INSERT INTO settings (key, value) VALUES ('ai_defaults', '{}'::jsonb) ON CONFLICT DO NOTHING")
        cur.execute("SELECT value FROM settings WHERE key = 'ai_defaults' FOR UPDATE")
        record = cur.fetchone()["value"] or {}
        if record.get("revision", 0) != revision:
            return None
        record = {"revision": revision + 1, "selection": selection}
        cur.execute("UPDATE settings SET value = %s WHERE key = 'ai_defaults'", (Json(record),))
        return record


def session_meta_delete(sid):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM session_meta WHERE session_id = %s RETURNING session_id", (sid,))
        return cur.fetchone() is not None


# Per-reader unread cursors ---------------------------------------------------
# One row per (reader, session): when that reader last OPENED the session. Unread
# is derived, never stored: a session is unread for a reader when its transcript
# changed after the reader's cursor. Kept server-side so web, mobile and an agent
# over MCP all agree, unlike the old per-device seen-map this replaced.

def session_seen_get(reader):
    """{session_id: last_seen_epoch} for one reader — empty when they've opened
    nothing. The list handler joins this against each session's mtime to flag
    unread, so it's a single fetch per list request, not one query per session."""
    with postgres.cursor() as cur:
        cur.execute("SELECT session, last_seen FROM session_seen WHERE reader = %s", (reader,))
        return {r["session"]: r["last_seen"] for r in cur.fetchall()}


def session_seen_set(reader, session, ts=None):
    """Advance a reader's cursor on one session to `ts` (default now). Idempotent
    upsert; a later open always moves the cursor forward, never back."""
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO session_seen (reader, session, last_seen) VALUES (%s, %s, %s) "
            "ON CONFLICT (reader, session) DO UPDATE SET last_seen = EXCLUDED.last_seen",
            (reader, session, ts if ts is not None else postgres.now()),
        )


# Hosts (SSH registry) --------------------------------------------------------
# The hosts store keeps the same {id: {label, host, user, port, claudeHome,
# password, keyFile, keyPassphrase}} shape the config file had, so remote.py /
# routes/auth.py read it unchanged. Secrets live in these columns; the list
# route already strips them before returning to a client. `user` is a reserved
# word in Postgres, so it's double-quoted wherever it's named in DDL/DML.
_HOST_COLS = (
    ("label", "label", ""), ("host", "host", ""), ("user", '"user"', ""),
    ("port", "port", 22), ("claudeHome", "claude_home", ".claude"),
    ("password", "password", ""), ("keyFile", "key_file", ""),
    ("keyPassphrase", "key_passphrase", ""),
)


def hosts_load():
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM hosts")
        # The `user` column comes back under its plain name in the row dict.
        cols_by_json = {jk: (col.strip('"')) for jk, col, _ in _HOST_COLS}
        out = {}
        for r in cur.fetchall():
            out[r["id"]] = {jk: r[col] for jk, col in cols_by_json.items()}
    return out


def host_upsert(hid, entry):
    cols = [col for _, col, _ in _HOST_COLS]  # already quoted where needed
    vals = [entry.get(jk, dflt) for jk, _, dflt in _HOST_COLS]
    setclause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    with postgres.cursor() as cur:
        cur.execute(
            f"INSERT INTO hosts (id, {', '.join(cols)}, created_at) "
            f"VALUES (%s, {', '.join(['%s'] * len(cols))}, %s) "
            f"ON CONFLICT (id) DO UPDATE SET {setclause}",
            (hid, *vals, postgres.now()),
        )


def host_delete(hid):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM hosts WHERE id = %s RETURNING id", (hid,))
        return cur.fetchone() is not None


# Per-host env vars -----------------------------------------------------------

def host_env_load(hid):
    """The {KEY: VALUE} map for a host id."""
    with postgres.cursor() as cur:
        cur.execute("SELECT key, value FROM host_env WHERE host = %s", (hid,))
        return {r["key"]: r["value"] for r in cur.fetchall()}


def host_env_set(hid, key, value):
    with postgres.cursor() as cur:
        cur.execute(
            "INSERT INTO host_env (host, key, value) VALUES (%s, %s, %s) "
            "ON CONFLICT (host, key) DO UPDATE SET value = EXCLUDED.value",
            (hid, key, str(value)),
        )


def host_env_unset(hid, key):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM host_env WHERE host = %s AND key = %s", (hid, key))


def host_env_unset_all(hid):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM host_env WHERE host = %s", (hid,))


# Provider presets ------------------------------------------------------------
# {id: {name, baseUrl, model, apiKey, isDefault, modelLimits}};
# modelLimits is JSONB, wrapped on write.
_PROVIDER_COLS = (
    ("name", "name", ""), ("baseUrl", "base_url", ""), ("model", "model", ""),
    ("apiKey", "api_key", ""), ("isDefault", "is_default", False),
    ("modelLimits", "model_limits", {}),
)


def providers_load():
    with postgres.cursor() as cur:
        cur.execute("SELECT * FROM providers")
        out = {}
        for r in cur.fetchall():
            out[r["id"]] = {jk: r[col] for jk, col, _ in _PROVIDER_COLS}
    return out


def provider_upsert(pid, rec, default_change=None):
    cols = [col for _, col, _ in _PROVIDER_COLS]
    vals = [Json(rec.get(jk) or {}) if jk == "modelLimits" else rec.get(jk, dflt)
            for jk, _, dflt in _PROVIDER_COLS]
    setclause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    with postgres.cursor() as cur:
        # The old-client default flag is an adapter once canonical defaults exist.
        # Lock the same settings row as the new CAS endpoint before changing it.
        if default_change is not None:
            cur.execute("INSERT INTO settings (key, value) VALUES ('ai_defaults', '{}'::jsonb) ON CONFLICT DO NOTHING")
            cur.execute("SELECT value FROM settings WHERE key = 'ai_defaults' FOR UPDATE")
            defaults = cur.fetchone()["value"] or {}
            if defaults and (default_change or defaults["selection"]["provider"] == pid):
                selection = {"provider": pid if default_change else "", "model": {"kind": "default"},
                             "convMode": "chat" if default_change else "agent", "effort": ""}
                cur.execute("UPDATE settings SET value = %s WHERE key = 'ai_defaults'",
                            (Json({"revision": defaults["revision"] + 1, "selection": selection}),))
        # Preserve the legacy default only until canonical defaults are configured.
        if rec.get("isDefault"):
            cur.execute("UPDATE providers SET is_default = FALSE WHERE id <> %s", (pid,))
        cur.execute(
            f"INSERT INTO providers (id, {', '.join(cols)}, created_at) "
            f"VALUES (%s, {', '.join(['%s'] * len(cols))}, %s) "
            f"ON CONFLICT (id) DO UPDATE SET {setclause}, context_limit = 0",
            (pid, *vals, postgres.now()),
        )


def provider_limits_set(pid, limits):
    """Replace only a connection's per-model facts (discovery cache), so a
    concurrent edit of its name/key/default is never clobbered."""
    with postgres.cursor() as cur:
        cur.execute("UPDATE providers SET model_limits = %s, context_limit = 0 WHERE id = %s", (Json(limits), pid))


def provider_delete(pid):
    with postgres.cursor() as cur:
        cur.execute("DELETE FROM providers WHERE id = %s RETURNING id", (pid,))
        return cur.fetchone() is not None
