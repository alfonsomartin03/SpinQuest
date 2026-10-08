#!/usr/bin/env python3
"""Serve SpinQuest on http://localhost:8000 (localhost counts as a secure context, which Web Bluetooth requires)."""
import functools
import http.server
import pathlib
import sys
import webbrowser

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
root = pathlib.Path(__file__).parent
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
handler.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
    url = f"http://localhost:{port}/"
    print(f"SpinQuest running at {url} (Ctrl+C to stop). Use Chrome or Edge for Bluetooth.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
