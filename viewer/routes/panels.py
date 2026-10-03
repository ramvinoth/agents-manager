"""viewer.routes.panels — PanelsMixin route + business methods."""
import sys
import threading
import traceback
from viewer import config, db
from viewer.browser import (
    browser_frame, browser_input, browser_install, browser_install_xvfb, browser_start, browser_status, browser_stop, browser_tab_action, browser_tabs, serve_browser_ws, serve_terminal_ws,
)


class PanelsMixin:
    def _p_browser(self, req):
        body = self.read_body() or {}
        hid = body.get("host", "local")
        op = req.path.rsplit("/", 1)[-1]
        try:
            if op == "start":
                self.send_json(browser_start(hid, headless=body.get("headless")))
            elif op == "stop":
                self.send_json(browser_stop(hid))
            elif op == "install":
                self.send_json(browser_install(hid))
            elif op == "install-xvfb":
                self.send_json(browser_install_xvfb(hid))
            elif op == "input":
                self.send_json(browser_input(hid, body.get("events") or []))
            elif op == "tab":
                self.send_json(browser_tab_action(hid, body.get("action"),
                                                  body.get("id"), body.get("url")))
            else:
                self.send_json({"error": "unknown browser op"}, status=404)
        except Exception as e:
            self.send_json({"error": str(e)}, status=502)

    def _g_browser_tabs(self, req):
        try:
            self.send_json(browser_tabs(req.host))
        except Exception as e:
            self.send_json({"error": f"tabs: {e}"}, status=502)

    def _g_browser_ws(self, req):
        serve_browser_ws(self, req.host)

    def _g_debug_stacks(self, req):
        # All thread stacks — for diagnosing wedged SSH ops without ptrace.
        frames = sys._current_frames()
        out = {}
        for t in threading.enumerate():
            f = frames.get(t.ident)
            out[t.name] = traceback.format_stack(f) if f else []
        self.send_json(out)

    def _g_healthz(self, req):
        """Public, unauthenticated liveness + version probe (gated-False by
        construction: not under /api/, see server._gated). The deploy CLI on the
        Mac polls this after an update to confirm the new release is actually
        serving, and to catch a HALF-APPLIED upgrade: `version` is read from the
        code/disk on this release (config.VERSION, which tracks the `current`
        symlink), while `db_version`/`db_schema` are what the DB was last stamped
        with by init_db(). They match on a clean boot; they diverge if the files
        were swapped but the server didn't restart, or a migration didn't run.

        Never 500s on a DB outage — a health probe must still answer. The disk
        version is always reportable; the DB fields degrade to null and `ok`
        stays True (the process IS up; `db_ok` tells the prober the DB is not)."""
        body = {
            "ok": True,
            "version": config.VERSION,
            "schema_version": db.SCHEMA_VERSION,
            "db_ok": True,
            "db_version": None,
            "db_schema": None,
        }
        try:
            meta = db.setting_get("app_meta", {}) or {}
            body["db_version"] = meta.get("version")
            body["db_schema"] = meta.get("schema_version")
        except Exception:
            body["db_ok"] = False
        self.send_json(body)

    def _g_browser_status(self, req):
        try:
            self.send_json(browser_status(req.host))
        except Exception as e:
            self.send_json({"running": False, "reasons": [f"Cannot reach host: {e}"]}, status=502)

    def _g_browser_frame(self, req):
        try:
            frame, page_url = browser_frame(req.host)
        except Exception as e:
            self.send_json({"error": f"frame: {e}"}, status=502)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(frame)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Page-Url", page_url[:2000])
        self.end_headers()
        try:
            self.wfile.write(frame)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _g_terminal_ws(self, req):
        try:
            cols = int((req.query.get("cols") or ["80"])[0])
            rows = int((req.query.get("rows") or ["24"])[0])
        except ValueError:
            cols, rows = 80, 24
        key = (req.query.get("key") or [""])[0]
        init = (req.query.get("init") or [""])[0]
        serve_terminal_ws(self, req.host, cols, rows, key, init)

