#!/usr/bin/env python3
"""GitHub Actions entry point: assemble the pre-publish site/ folder from files already in the repo.

    python build_site.py

No database, keys or network are needed. The local data pipeline (run.py) ends by pushing; the workflow in
.github/workflows/pages.yml then runs the tests, this script, and publishes site/ (and deploys the Worker).
Only the paths listed in PUBLIC_PATHS are served. Standard library only.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site"
PUBLIC_PATHS = ["index.html", "config.json", "shared", "assistant", "datasets", "assets", "data/facts.json"]


def build_site() -> None:
    shutil.rmtree(SITE, ignore_errors=True)
    SITE.mkdir()
    for rel in PUBLIC_PATHS:
        src = ROOT / rel
        if not src.exists():
            continue
        dst = SITE / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("*.test.js", "__pycache__"))
        else:
            shutil.copyfile(src, dst)
    (SITE / ".nojekyll").write_text("")
    print(f"Site assembled in {SITE.relative_to(ROOT)}/")


if __name__ == "__main__":
    build_site()
    sys.exit(0)
