"""HTTP route mixins for SessionViewerHandler."""


def require_human(handler, req):
    """Gate a write to a HUMAN account: an agent's MCP principal (user None)
    may read most things but never edits credentials. Answers the 403 itself;
    the caller just returns when this is False."""
    if not (getattr(req, "principal", None) or {}).get("user"):
        handler.send_json({"error": "Human authentication required"}, status=403)
        return False
    return True
