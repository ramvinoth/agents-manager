"""Server-owned AI selection: validation and launch resolution, not a model catalog."""
import re

from viewer import db, providers

DEFAULTS_KEY = "ai_defaults"
EFFORTS = ["", "low", "medium", "high", "xhigh", "max"]


def capabilities(host="local", agent="claude", provider=""):
    return {"editable": agent == "claude", "customProviders": agent == "claude" and host == "local",
            "conversationModes": ["agent", "chat"] if provider else ["agent"],
            "efforts": [""] if provider else EFFORTS, "manualModelId": True}


def selection_from_meta(meta):
    pid = meta.get("provider", "")
    return {"provider": pid, "model": meta.get("modelSelection"),
            "convMode": meta.get("convMode", "chat") if pid else "agent",
            "effort": meta.get("effort", "")}


def validate(selection, host="local", agent="claude"):
    if not isinstance(selection, dict) or set(selection) != {"provider", "model", "convMode", "effort"}:
        raise ValueError("selection must contain only provider, model, convMode and effort")
    pid = selection["provider"]
    if not isinstance(pid, str) or (pid and not providers.valid_id(pid)):
        raise ValueError("Invalid provider id")
    caps = capabilities(host, agent, pid)
    if not caps["editable"]:
        raise ValueError("AI selection is not supported by this harness")
    if pid and not caps["customProviders"]:
        raise ValueError("Custom providers are supported only on the local Claude harness")
    if pid and not (providers.get_preset(pid) or {}).get("baseUrl"):
        raise ValueError("Provider unavailable; choose an existing connection")
    model = selection["model"]
    if model is not None:
        if not isinstance(model, dict):
            raise ValueError("Invalid model selection")
        if model == {"kind": "default"}:
            pass
        elif set(model) == {"kind", "id"} and model.get("kind") == "id":
            mid = model.get("id")
            if not isinstance(mid, str) or not mid or len(mid) > 256 or re.search(r"[\s\x00-\x1f\x7f]", mid):
                raise ValueError("Model ID must be a nonempty identifier without whitespace")
        else:
            raise ValueError("Model must be null, default, or an explicit id")
    if selection["convMode"] not in ("chat", "agent"):
        raise ValueError("Invalid conversation mode")
    if selection["effort"] not in caps["efforts"]:
        raise ValueError("Effort is not supported for this provider")
    return {**selection, "convMode": selection["convMode"] if pid else "agent"}


def meta_fields(selection):
    return {"provider": selection["provider"], "modelSelection": selection["model"],
            "convMode": selection["convMode"], "effort": selection["effort"]}


def document(meta=None, defaults=False, host="local", agent="claude"):
    record = (db.setting_get(DEFAULTS_KEY) or {}) if defaults else (meta or {})
    if defaults:
        selection = record.get("selection") or {
            "provider": providers.get_default_id(), "model": None, "convMode": "chat", "effort": ""}
        if not selection["provider"]:
            selection = {**selection, "convMode": "agent"}
    else:
        selection = selection_from_meta(record)
    result = {"revision": record.get("revision" if defaults else "aiRevision", 0),
              "selection": selection, "capabilities": capabilities(host, agent, selection["provider"])}
    if defaults:
        result["configured"] = bool(record)
    try:
        validate(selection, host, agent)
    except ValueError as exc:
        result["issue"] = str(exc)
    return result


def resolve(meta, request_model="", host="local", provider_override="", model_override=""):
    """Resolve a provider and its model together. Explicit loop choices win.

    Legacy custom sessions use preset.model, not a stale composer model. A loop
    changing provider cannot inherit a model associated with the session provider.
    """
    pid = provider_override or meta.get("provider", "")
    if pid and host != "local":
        raise ValueError("Custom providers are supported only on the local host")
    preset = providers.get_preset(pid) if pid else None
    if pid and not (preset or {}).get("baseUrl"):
        raise ValueError("Provider unavailable; choose an existing connection")
    selected = meta.get("modelSelection") if pid == meta.get("provider", "") else None
    if model_override:
        model = model_override
    elif selected is not None:
        model = selected["id"] if selected["kind"] == "id" else ((preset or {}).get("model", ""))
    else:
        model = preset.get("model", "") if preset else request_model
    return {"provider": pid, "model": model, "preset": preset,
            "convMode": meta.get("convMode", "chat") if pid else "agent",
            "effort": "" if pid else meta.get("effort", "")}
