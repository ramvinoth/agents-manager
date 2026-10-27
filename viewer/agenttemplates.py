"""viewer.agenttemplates — the rules for an agent template (Agents tab) a person
writes: which fields are valid, who sees an agent, who may change it.

Pure apart from the plugin catalog lookup, so the routes stay thin and the
rules are unit-tested without a server. Ownership: a personal agent belongs to
the account that made it (agent_templates.owner_user_id); NULL is shared — the
builtins, and agents made before agents had owners. Builtins are never edited
in place; Duplicate makes an editable personal copy.
"""
from viewer import ai, orglogic
from viewer.config import agent_plugin_dir
from viewer.db import LENSES, TEMPLATE_FIELDS
from viewer.loops import build_schedule

NAME_MAX = 80
# The Agents tab groups by these (mobile lib/templateCategories.ts mirrors the
# labels); an agent in any other category would never be shown.
CATEGORIES = ("personal", "engineering", "design", "business")


def visible(template, user_id):
    """True when `user_id` may see (and start a chat from) this agent."""
    owner = template.get("owner_user_id")
    return owner is None or owner == user_id


def editable(template, user):
    """True when `user` ({id, role}) may edit or delete this agent: its owner,
    or the install owner for a shared user agent. Never a builtin."""
    if template.get("is_builtin"):
        return False
    owner = template.get("owner_user_id")
    return owner == user["id"] if owner is not None else user.get("role") == "owner"


def jobs_from(raw):
    """Validate an agent's jobs → ([{prompt, cron|interval}], error).

    Same schedule rules as a chat's jobs (build_schedule), stored as the
    schedule only: the next run is computed when a chat is started from it.
    A one-shot `at` has no meaning on a template, so it is not accepted."""
    if not raw:
        return [], None
    if not isinstance(raw, list):
        return None, "jobs must be a list"
    jobs = []
    for i, j in enumerate(raw, 1):
        prompt = (j.get("prompt") or "").strip() if isinstance(j, dict) else ""
        if not prompt:
            return None, f"Job {i} has no prompt"
        sched, err = build_schedule(j.get("cron"), j.get("interval"))
        if err:
            return None, f"Job {i}: {err}"
        jobs.append({"prompt": prompt, "cron": sched["cron"]} if sched["cron"]
                    else {"prompt": prompt, "interval": sched["interval"]})
    return jobs, None


def fields_from(body):
    """A request body → (TEMPLATE_FIELDS dict, error). The one validator for
    create and edit, so the two can never disagree on what an agent is."""
    def text(key, default=""):
        v = body.get(key)
        return v.strip() if isinstance(v, str) else default

    name = text("name")
    if not name:
        return None, "Name the agent"
    if len(name) > NAME_MAX:
        return None, f"Keep the name under {NAME_MAX} characters"
    plugin, lens, level = text("plugin"), text("lens"), text("level") or "ic"
    if plugin and not agent_plugin_dir(plugin):
        return None, f"Unknown plugin: {plugin}"
    if lens and lens not in LENSES:
        return None, f"Unknown lens: {lens}"
    if level not in orglogic.LEVELS:
        return None, f"Unknown level: {level}"
    category = text("category") or "personal"
    if category not in CATEGORIES:
        return None, f"Unknown category: {category}"
    jobs, err = jobs_from(body.get("jobs"))
    if err:
        return None, err
    selection, err = ai_from(body.get("ai"))
    if err:
        return None, err
    fields = {"name": name, "description": text("description"), "category": category,
              "icon": text("icon") or "sparkle", "system_prompt": text("system_prompt"), "goal": text("goal"),
              "ai": selection, "jobs": jobs, "plugin": plugin, "lens": lens, "level": level}
    assert set(fields) == set(TEMPLATE_FIELDS)
    return fields, None


def ai_from(raw):
    """An agent's AI → (selection, error). None = the owner's AI defaults; else
    the same {provider, model, convMode, effort} a chat's AI is (ai.validate),
    checked for the local Claude harness — the one an agent's chats run on."""
    if raw is None:
        return None, None
    try:
        return ai.validate(raw, "local", "claude"), None
    except ValueError as exc:
        return None, str(exc)


def plugins_from(raw):
    """An agent's Manager plugin list → (names, error). None means the body did
    not send one (an older client): the agent keeps what it has."""
    if raw is None:
        return None, None
    if not isinstance(raw, list) or not all(isinstance(n, str) for n in raw):
        return None, "plugins must be a list of names"
    names = list(dict.fromkeys(n.strip() for n in raw if n.strip()))
    unknown = [n for n in names if not agent_plugin_dir(n)]
    if unknown:
        return None, f"Unknown plugin: {unknown[0]}"
    return names, None


def copy_fields(template):
    """The fields of a duplicate: the same agent, named as a copy."""
    fields = {c: template.get(c) for c in TEMPLATE_FIELDS}
    fields["name"] = f"{template['name']} copy"[:NAME_MAX]
    fields["jobs"] = template.get("jobs") or []
    return fields
