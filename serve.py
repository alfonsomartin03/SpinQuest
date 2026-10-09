#!/usr/bin/env python3
"""Serve SpinQuest on http://localhost:8000 (localhost counts as a secure context, which Web Bluetooth requires).

Usage: python3 serve.py [port] [--no-open]
"""
import functools
import http.server
import pathlib
import sys
import webbrowser

args = [a for a in sys.argv[1:] if not a.startswith("--")]
port = int(args[0]) if args else 8000
root = pathlib.Path(__file__).parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def end_headers(self):
        # always serve the latest files, so an update is never hidden by a cached script
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = functools.partial(Handler, directory=str(root))

with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
    url = f"http://localhost:{port}/"
    print(f"SpinQuest running at {url} (Ctrl+C to stop). Use Chrome or Edge for Bluetooth.")
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
