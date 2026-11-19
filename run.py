#!/usr/bin/env python3
"""One command from new CAD data to a live site.

    python run.py --setup        first time only: asks for your keys, writes .env
    python run.py                extract -> ingest -> export -> test -> deploy assistant -> build -> push

Put new blotter PDFs (file name must contain FIRE or EMS) or already-extracted folders
(incidents.csv + unit_responses.csv) in inbox/. Re-running with the same files does nothing new.

Flags: --dry-run (extract + validate only, no database or site changes), --skip-worker, --no-push,
--yes (no confirmation prompts), --build-only (just assemble site/, used by the GitHub workflow).
Uses only the Python standard library; it creates .venv for the extractor's dependencies.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INBOX = ROOT / "inbox"
STRUCTURED = ROOT / "data" / "DailyBlotter" / "structured"
DB = ROOT / "ccfd1.db"
DATASETS = ROOT / "datasets"
CANDIDATE = ROOT / "datasets.candidate"
SITE = ROOT / "site"
WORKER = ROOT / "worker"
CONFIG = ROOT / "config.json"
VENV = ROOT / ".venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
LEDGER = STRUCTURED / ".ingested.json"
PUBLIC_PATHS = ["index.html", "config.json", "shared", "assistant", "datasets", "assets", "data/facts.json"]


class Stop(Exception):
    """A problem the user can act on; printed without a traceback."""


def say(msg=""):
    print(msg, flush=True)


def step(n, title):
    say(f"\n[{n}] {title}")


def run(cmd, cwd=ROOT, input=None, env=None, capture=False):
    r = subprocess.run([str(c) for c in cmd], cwd=cwd, input=input, text=True, env=env,
                       capture_output=capture)
    return r


def need(cmd, hint):
    if not shutil.which(cmd):
        raise Stop(f"{cmd} is not installed. {hint}")


# ---------- config ----------
def load_env():
    f = ROOT / ".env"
    if not f.exists():
        return
    for line in f.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def config() -> dict:
    return json.loads(CONFIG.read_text())


def save_config(cfg: dict):
    CONFIG.write_text(json.dumps(cfg, indent=2) + "\n")


def setup():
    say("First-time setup. Press Enter to keep an existing value. Keys are saved only in .env (never committed).")
    env_file = ROOT / ".env"
    cur = {}
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                cur[k.strip()] = v.strip()
    out = {}
    for key, label in (("ANTHROPIC_API_KEY", "Anthropic API key (starts with sk-ant-)"),
                       ("CLOUDFLARE_API_TOKEN", "Cloudflare API token (Workers Scripts:Edit, KV:Edit)"),
                       ("CLOUDFLARE_ACCOUNT_ID", "Cloudflare account ID")):
        have = " [already set]" if cur.get(key) else ""
        val = input(f"{label}{have}: ").strip()
        out[key] = val or cur.get(key, "")
    env_file.write_text("".join(f"{k}={v}\n" for k, v in out.items()))
    try:
        env_file.chmod(0o600)
    except OSError:
        pass
    cfg = config()
    org = input(f"GitHub Pages address [{cfg['pages_origin']}]: ").strip()
    if org:
        cfg["pages_origin"] = org.rstrip("/")
        save_config(cfg)
    say("Saved. Add files to inbox/ and run: python run.py")


# ---------- steps ----------
def ensure_venv():
    if not VENV_PY.exists():
        say("Creating .venv and installing dependencies (first run only)...")
        if run([sys.executable, "-m", "venv", VENV]).returncode:
            raise Stop("Could not create the Python environment (.venv).")
    marker = VENV / ".deps-installed"
    req = ROOT / "requirements.txt"
    digest = hashlib.sha256(req.read_bytes()).hexdigest()
    if not marker.exists() or marker.read_text() != digest:
        if run([VENV_PY, "-m", "pip", "install", "-q", "-r", req]).returncode:
            raise Stop("Installing Python dependencies failed. Check your internet connection and retry.")
        marker.write_text(digest)


def file_hash(*paths: Path) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(p.read_bytes())
    return h.hexdigest()


def extract():
    """PDFs in inbox/ -> structured folders; ready-made folders in inbox/ are copied across."""
    INBOX.mkdir(exist_ok=True)
    STRUCTURED.mkdir(parents=True, exist_ok=True)
    pdfs = list(INBOX.glob("*.pdf"))
    if pdfs:
        r = run([VENV_PY, ROOT / "ocr-pipe" / "blotter_extract.py", "--input-dir", INBOX, "--out-dir", STRUCTURED],
                cwd=ROOT / "ocr-pipe")
        if r.returncode:
            raise Stop("Extraction failed for at least one PDF (see messages above). Nothing was published.")
    for d in INBOX.iterdir():
        if d.is_dir() and (d / "incidents.csv").exists() and (d / "unit_responses.csv").exists():
            shutil.copytree(d, STRUCTURED / d.name, dirs_exist_ok=True)
    if not pdfs and not any(INBOX.iterdir()) and not DB.exists():
        raise Stop("inbox/ is empty and there is no database yet. Put blotter PDFs in inbox/ and run again.")


def pending_folders() -> list[tuple[Path, str]]:
    done = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    out = []
    for d in sorted(p for p in STRUCTURED.iterdir() if p.is_dir()):
        inc, resp = d / "incidents.csv", d / "unit_responses.csv"
        if inc.exists() and resp.exists():
            h = file_hash(inc, resp)
            if h not in done:
                out.append((d, h))
    return out


def ingest(dry: bool, township: str) -> list[Path]:
    todo = pending_folders()
    if not todo:
        say("No new data to ingest.")
        return []
    py = [VENV_PY, ROOT / "pipeline" / "ingest_cad_export.py"]
    for d, _ in todo:  # validate everything first; any failure stops before the database is touched
        r = run(py + [d, "--db", DB, "--township", township, "--report-dir", ROOT / "reports", "--dry-run"])
        if r.returncode:
            raise Stop(f"{d.name}: too many rows failed validation (over 5%). See the report in reports/. "
                       "Nothing was loaded or published.")
    if dry:
        return []
    done = json.loads(LEDGER.read_text()) if LEDGER.exists() else {}
    for d, h in todo:
        r = run(py + [d, "--db", DB, "--township", township, "--report-dir", ROOT / "reports"])
        if r.returncode:
            raise Stop(f"{d.name}: loading into the database failed.")
        done[h] = d.name
        LEDGER.write_text(json.dumps(done, indent=2))
    return [d for d, _ in todo]


def export_and_promote(assume_yes: bool) -> bool:
    if not DB.exists():
        raise Stop("No database (ccfd1.db) to export from.")
    shutil.rmtree(CANDIDATE, ignore_errors=True)
    if run([VENV_PY, ROOT / "pipeline" / "export_datasets.py", "--db", DB, "--out", CANDIDATE]).returncode:
        raise Stop("Exporting datasets failed.")
    sys.path.insert(0, str(ROOT / "pipeline"))
    import datasets_lib as dl  # noqa: E402

    changed = []
    for f in sorted(CANDIDATE.glob("*.json")):
        if f.name == "index.json":
            continue
        ds = json.loads(f.read_text())
        errs = dl.validate(ds)
        if errs:
            raise Stop(f"{f.name} failed validation: {'; '.join(errs)}")
        old = DATASETS / f.name
        if old.exists() and json.loads(old.read_text()).get("rows") == ds.get("rows"):
            continue
        before = len(json.loads(old.read_text()).get("rows", [])) if old.exists() else 0
        changed.append((f, before, len(ds["rows"])))
    if not changed:
        say("Datasets are unchanged.")
        return False
    say("Datasets that will change:")
    for f, b, a in changed:
        say(f"  {f.name}: {b} rows -> {a} rows ({ds_total(f)})")
    if not assume_yes and input("Publish these? [y/N] ").strip().lower() != "y":
        raise Stop("Stopped at your request. Nothing was published.")
    for f, _, _ in changed:
        shutil.copyfile(f, DATASETS / f.name)
    dl.write_manifest(DATASETS, updated=datetime.now().date().isoformat())
    warn_stale_location()
    return True


def warn_stale_location():
    """The by-location split is still maintained by hand (no township join in SQLite yet)."""
    def total(name):
        return sum(r["incidents"] for r in json.loads((DATASETS / name).read_text())["rows"])
    hour, loc = total("cad_incidents_by_hour.json"), total("cad_incidents_by_location.json")
    if hour != loc:
        say(f"\nWARNING: incidents by location adds up to {loc} but the new incident total is {hour}. "
            "datasets/cad_incidents_by_location.json is still maintained by hand; update it before relying on the "
            'page\'s "Responses outside the District" panel.')


def ds_total(f: Path) -> str:
    rows = json.loads(f.read_text()).get("rows", [])
    for k in ("incidents", "amount", "revenue"):
        if rows and k in rows[0]:
            return f"total {k} {sum(r[k] for r in rows):,}"
    return "no total"


def test_all():
    cmds = [([VENV_PY, "-m", "pytest", "-q", "pipeline/tests"], ROOT),
            (["node", "--test", "shared/dataset.test.js", "assistant/tools.test.js"], ROOT)]
    if (WORKER / "node_modules").exists():
        cmds.append((["npm", "test", "--silent"], WORKER))
    for cmd, cwd in cmds:
        if run(cmd, cwd=cwd).returncode:
            raise Stop(f"A check failed: {' '.join(str(c) for c in cmd)}. Nothing was pushed or deployed; "
                       "datasets/ may already hold the new data locally (undo with `git checkout datasets`).")


def deploy_worker(cfg: dict):
    key, tok = os.environ.get("ANTHROPIC_API_KEY"), os.environ.get("CLOUDFLARE_API_TOKEN")
    if not (key and tok):
        say("No ANTHROPIC_API_KEY / CLOUDFLARE_API_TOKEN in .env: leaving the assistant as it is.")
        return
    need("npm", "Install Node.js from https://nodejs.org")
    if not (WORKER / "node_modules").exists():
        if run(["npm", "ci", "--silent"], cwd=WORKER).returncode:
            raise Stop("npm install failed in worker/.")
    origins = ",".join([cfg["pages_origin"], "http://localhost:8000"])
    toml = WORKER / "wrangler.toml"
    text = toml.read_text()
    block = f'# BEGIN run.py\n[vars]\nALLOWED_ORIGINS = "{origins}"\n# END run.py'
    if "# BEGIN run.py" in text:
        text = re.sub(r"# BEGIN run\.py.*?# END run\.py", block, text, flags=re.S)
    else:
        text = text.rstrip("\n") + "\n\n" + block + "\n"
    text = re.sub(r'^name = ".*"$', f'name = "{cfg["worker_name"]}"', text, count=1, flags=re.M)
    toml.write_text(text)
    if run(["npm", "run", "sync-tools", "--silent"], cwd=WORKER).returncode:
        raise Stop("Could not sync the assistant tool definitions.")
    r = run(["npx", "wrangler", "secret", "put", "ANTHROPIC_API_KEY"], cwd=WORKER, input=key, capture=True)
    if r.returncode:
        raise Stop("Cloudflare rejected the API key upload. Check CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env.")
    r = run(["npx", "wrangler", "deploy"], cwd=WORKER, capture=True)
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode:
        raise Stop("Deploying the assistant failed. Last lines:\n" + "\n".join(out.strip().splitlines()[-6:]))
    m = re.search(r"https://[\w.-]+\.workers\.dev", out)
    if m and m.group(0) != cfg.get("assistant_url"):
        cfg["assistant_url"] = m.group(0)
        save_config(cfg)
    say(f"Assistant deployed: {cfg.get('assistant_url')}")


def build_site():
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
    say(f"Site assembled in {SITE.relative_to(ROOT)}/")


def push(assume_yes: bool):
    need("git", "Install git from https://git-scm.com")
    paths = [p for p in ("datasets", "config.json", "index.html", "data/facts.json", "worker/wrangler.toml",
                         "worker/src/tool-schemas.js") if (ROOT / p).exists()]
    run(["git", "add", "--"] + paths)
    if run(["git", "diff", "--cached", "--quiet"]).returncode == 0:
        say("Nothing new to publish.")
        return
    if not assume_yes and input("Commit and push to GitHub now? [y/N] ").strip().lower() != "y":
        say("Not pushed. Changes are staged; run again with --yes or push yourself.")
        return
    if run(["git", "commit", "-q", "-m", f"Data refresh {datetime.now():%Y-%m-%d}"]).returncode:
        raise Stop("git commit failed. Check that git knows your name and email.")
    if run(["git", "push", "origin", "HEAD:main"]).returncode:
        raise Stop("git push failed. Check you are signed in to GitHub and have write access.")
    say("Pushed. GitHub will publish the site in a minute or two (see the Actions tab).")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for f in ("--setup", "--dry-run", "--skip-worker", "--no-push", "--yes", "--build-only"):
        ap.add_argument(f, action="store_true")
    a = ap.parse_args()
    os.chdir(ROOT)
    try:
        if a.setup:
            setup()
            return 0
        load_env()
        cfg = config()
        if a.build_only:
            build_site()
            return 0
        need("python3" if os.name != "nt" else "python", "Install Python 3.10+ from https://python.org")
        need("node", "Install Node.js from https://nodejs.org")
        step(1, "Checking setup")
        ensure_venv()
        step(2, "Extracting new PDFs")
        extract()
        step(3, "Validating and loading into the database")
        loaded = ingest(a.dry_run, cfg["township"])
        if a.dry_run:
            say("\nDry run finished: nothing was loaded or published.")
            return 0
        step(4, "Exporting datasets")
        export_and_promote(a.yes)
        step(5, "Running checks")
        test_all()
        if not a.skip_worker:
            step(6, "Deploying the assistant")
            deploy_worker(cfg)
        step(7, "Building the site")
        build_site()
        if not a.no_push:
            step(8, "Publishing to GitHub")
            push(a.yes)
        say("\nDone.")
        return 0
    except Stop as e:
        say(f"\nSTOPPED: {e}")
        return 1
    except KeyboardInterrupt:
        say("\nCancelled.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
