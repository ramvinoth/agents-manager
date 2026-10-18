"""viewer.routes.project_plugins — ProjectPluginsMixin: the project plugins
this machine has on, and the signed-in URL that opens one for a project
folder. See viewer/project_plugins.py."""
from viewer import project_plugins
from viewer.routes import require_human


class ProjectPluginsMixin:
    def _g_project_plugins(self, req):
        self.send_json({"plugins": [p.row() for p in project_plugins.available()]})

    def _p_project_plugin_open(self, req):
        """Sign the owner into the app and land on this folder's project. Human
        only: the URL carries a one-time sign-in, never an agent's to hold.
        Local folders only — the app shares the folder on this machine."""
        if not require_human(self, req):
            return
        body = self.read_body() or {}
        plugin = project_plugins.get(body.get("id") or "")
        cwd = project_plugins.local_folder(body.get("cwd"))
        if not plugin:
            self.send_json({"error": "That app is not set up on this computer."}, status=404); return
        if (body.get("host") or "local") != "local":
            self.send_json({"error": f"{plugin.label} opens only for projects on this computer."}, status=400); return
        if not cwd:
            self.send_json({"error": "cwd must be a folder on this computer"}, status=400); return
        try:
            self.send_json({"url": plugin.open_url(cwd, self.request_origin())})
        except project_plugins.PluginError as e:
            self.send_json({"error": str(e)}, status=e.status)
