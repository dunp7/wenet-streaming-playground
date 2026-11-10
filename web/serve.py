#!/usr/bin/env python3
"""
Simple HTTP server to serve the WeNet Streaming Playground web interface.
Usage:
    python3 web/serve.py [port]
Default port is 3000.
"""

import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
WEB_DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
    }

    def end_headers(self):
        # Enable CORS for local development
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

def run():
    # Use ThreadingHTTPServer for fast, non-blocking concurrent request handling
    ServerClass = getattr(http.server, "ThreadingHTTPServer", socketserver.TCPServer)
    ServerClass.allow_reuse_address = True
    with ServerClass(("", PORT), Handler) as httpd:
        print(f"============================================================")
        print(f"  WeNet Streaming ASR Demo Web UI is running at:")
        print(f"  --> http://localhost:{PORT}")
        print(f"============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")

if __name__ == "__main__":
    run()

