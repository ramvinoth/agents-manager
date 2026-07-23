"""viewer.routes.git — GitHub repo picker + clone + working-dir git status."""
from viewer import gitops


class GitMixin:
    def _g_git_repos(self, req):
        """The token owner's GitHub repos for the current host (or configured:
        False when no GH_TOKEN/GITHUB_TOKEN/GIT_TOKEN is set for it)."""
        try:
            self.send_json(gitops.list_repos(req.host))
        except Exception as e:
            self.send_json({"error": f"GitHub: {e}"}, status=502)

    def _g_git_status(self, req):
        cwd = (req.query.get("cwd") or [""])[0].strip()
        if not cwd:
            self.send_json({"error": "No cwd"}, status=400)
            return
        try:
            self.send_json(gitops.repo_status(req.host, cwd))
        except Exception as e:
            self.send_json({"error": f"git: {e}"}, status=502)

    def _p_git_clone(self, req):
        """Start a background clone; returns {"job": id} to poll on
        /api/git/clone/status (clones can take minutes on big repos)."""
        body = self.read_body() or {}
        repo = (body.get("repo") or "").strip()
        parent = (body.get("dir") or "~").strip()
        branch = (body.get("branch") or "").strip()
        try:
            self.send_host_result(gitops.start_clone(body.get("host", "local"), repo, parent, branch))
        except Exception as e:
            self.send_json({"error": f"Clone failed: {e}"}, status=502)

    def _g_git_clone_status(self, req):
        jid = (req.query.get("id") or [""])[0]
        self.send_host_result(gitops.clone_status(jid), not_found="No such clone job")
