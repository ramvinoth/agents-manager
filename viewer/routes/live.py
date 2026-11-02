"""viewer.routes.live — LiveMixin: the one realtime socket every surface shares.

GET /api/live/ws upgrades, sends {"t":"hello"}, then relays the hub's
invalidation events (viewer/live.py) until either side closes. The socket is
read-only: the client never sends anything but pings and the close frame —
writes still go through the ordinary routes and their gates."""
import json

from viewer import live


class LiveMixin:
    def _g_live_ws(self, req):
        if req.principal["kind"] != "app":  # agents read through MCP, not a socket
            self.send_json({"error": "not allowed"}, status=403)
            return
        from viewer.browser import WSServer
        ws = WSServer.upgrade(self)
        if not ws:
            return
        sub = None
        try:
            ws.send_text(json.dumps({"t": "hello"}))
            # A writer that stops (client fell behind, send failed) closes the
            # socket, which unblocks recv() below.
            sub = live.HUB.subscribe(ws.send_text, on_close=ws.close)
            while sub.alive:
                op, _ = ws.recv()
                if op == 0x8:
                    break
        except OSError:
            pass
        finally:
            if sub:
                live.HUB.unsubscribe(sub)
            ws.close()
