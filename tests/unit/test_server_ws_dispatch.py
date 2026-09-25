import socket

import pytest

from viewer.server import PooledHTTPServer, SessionViewerHandler


@pytest.mark.parametrize('target, expected', [
    ('/', False),
    ('/api/sessions', False),
    ('/api/terminal/ws?session=fixture', True),
    ('/api/browser/ws?host=local', True),
    ('/api/browser/ws-extra', False),
])
def test_request_peek_selects_only_registered_websockets(target, expected):
    server = object.__new__(PooledHTTPServer)
    client, connection = socket.socketpair()
    try:
        request = f'GET {target} HTTP/1.1\r\n\r\n'.encode()
        client.sendall(request)
        assert server._is_ws(connection) is expected
        assert connection.recv(len(request)) == request
    finally:
        client.close()
        connection.close()


def test_websocket_paths_derive_from_live_routes():
    assert PooledHTTPServer.WS_PATHS == {
        path.encode() for path in SessionViewerHandler.GET_ROUTES if path.endswith('/ws')
    }
