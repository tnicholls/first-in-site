"""Serve the site locally, account app included: http://127.0.0.1:8000/app/
and the app demo at /tools/demo.html.

    python3 tools/serve.py        (standard library only; PORT=8001 to change the port)

Like `python3 -m http.server` from the repo root, except it never serves the
backend's folders or dotfiles: supabase/ (its functions/.env holds the Stripe
test key while you test), tests/, .venv/, .git/ and anything starting with a
dot. Listens on 127.0.0.1 only.
"""
from __future__ import annotations

import functools
import http.server
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOT_SERVED = {"supabase", "tests", "node_modules"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        resolved = Path(super().translate_path(path)).resolve()
        try:
            rel = resolved.relative_to(ROOT)
        except ValueError:
            return str(ROOT / "__not_served__")
        if rel.parts and (rel.parts[0] in NOT_SERVED or any(part.startswith(".") for part in rel.parts)):
            return str(ROOT / "__not_served__")
        return str(resolved)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Serving http://127.0.0.1:{port}/ (the app: /app/, its demo: /tools/demo.html)", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
