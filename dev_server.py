"""Local static server for the dashboard, with a dev-mode override for the assistant URL.

    python3 dev_server.py                   # same as python -m http.server 8000
    python3 dev_server.py --dev --port 8001 # config.json's assistant_url -> http://localhost:8787
    python3 dev_server.py --dev --assistant-url ""   # hide the assistant entirely

The override is applied in the response only; config.json on disk is never changed. For the local
Worker, run from worker/:  npx wrangler dev --port 8787 --var ALLOWED_ORIGINS:http://localhost:8001
Standard library only.
"""
import argparse
import functools
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(SimpleHTTPRequestHandler):
    assistant_url = None  # set in dev mode

    def do_GET(self):
        if self.assistant_url is not None and self.path.split("?")[0] == "/config.json":
            cfg = json.loads((ROOT / "config.json").read_text())
            cfg["assistant_url"] = self.assistant_url
            body = json.dumps(cfg).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dev", action="store_true", help="override assistant_url in config.json")
    ap.add_argument("--assistant-url", default="http://localhost:8787",
                    help="with --dev: Worker URL to use (default: local `wrangler dev`; empty hides the assistant)")
    args = ap.parse_args()
    if args.dev:
        Handler.assistant_url = args.assistant_url
        print(f"dev mode: assistant_url -> {args.assistant_url or '(none)'}")
        print(f"local Worker must allow this page's origin, from worker/:\n"
              f"  npx wrangler dev --port 8787 --var ALLOWED_ORIGINS:http://localhost:{args.port}")
    handler = functools.partial(Handler, directory=str(ROOT))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as srv:
        print(f"serving {ROOT} at http://localhost:{args.port}/")
        srv.serve_forever()


if __name__ == "__main__":
    main()
