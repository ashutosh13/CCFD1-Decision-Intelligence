# CCFD1 Decision Intelligence

A static dashboard (GitHub Pages) with an optional "Ask the data" assistant (a small Cloudflare Worker that
calls the Claude API so the key never reaches the browser).

## Two ways to run it

Both use the same Docker image (the built site plus the assistant Worker in one container).

| Method | Command | What it does |
|---|---|---|
| Local | `./start.sh` (peers) or `./start.sh --dev` (you) | `start.sh` pulls the pre-built multi-architecture image `ghcr.io/ashutosh13/ccfd1` and runs it at http://localhost:8000; it only needs Docker and asks for the API key the first time (saved in `.env`). `--dev` builds the image from your working copy first. `./stop.sh` stops it. If `datasets.private/` exists it is mounted read-only into the container (the sanitized rows are never in the image). Only `http://localhost:<port>` is allowed to call the assistant. |
| CI | push to `main` | `.github/workflows/pages.yml` runs the tests, publishes Pages, deploys the Cloudflare Worker, and builds and pushes the Intel/AMD + ARM image that `start.sh` pulls. |

For a machine with no registry access, `docker save ghcr.io/ashutosh13/ccfd1:latest -o ccfd1-image.tar` and put the file next to `start.sh`; it loads it instead of pulling.
`python3 run.py` is the data-refresh pipeline that feeds both: it ends at the push, which starts the CI run.

`run.py` (1) checks setup, (2) extracts new PDFs from `inbox/`, (3) validates and loads them into `ccfd1.db`,
(4) exports datasets and builds the dataset schemas and the sanitized incident table (with the PII scan), (5) runs
every test (pytest, Node, Worker), (6) syncs the assistant's tool schemas and uploads the sanitized rows, (7) assembles
`site/` as a preview, (8) asks to commit and push. It stops at the first failure. After the push, the workflow in
`.github/workflows/pages.yml` runs the tests again, runs `build_site.py`, publishes Pages and deploys the Worker.

## Hand-off runbook (no coding needed)

One-time setup:
1. Install [Python 3.10+](https://python.org), [Node.js 20+](https://nodejs.org) and [git](https://git-scm.com).
2. Clone this repository and sign in to GitHub (so `git push` works).
3. In the GitHub repo: **Settings > Pages > Source = GitHub Actions**.
4. Run `python3 run.py --setup` (Mac: double-click `run.command` after running it once from a terminal with `--setup`;
   Windows: `run.bat --setup`). It asks for your Anthropic API key, Cloudflare API token (permissions: Workers
   Scripts Edit, Workers KV Storage Edit) and Cloudflare account ID, and saves them in `.env` (never committed).

Every update:
1. Put the new Daily Blotter PDFs in `inbox/`. File names must contain **FIRE** or **EMS**.
   (Already-extracted folders containing `incidents.csv` and `unit_responses.csv` also work.)
2. Run `python3 run.py` (or double-click `run.command` / `run.bat`). It extracts, validates, loads, exports,
   tests, builds the site and pushes to GitHub, whose workflow publishes it and deploys the assistant.

Running again with the same files does nothing new. `python3 run.py --dry-run` only validates.

| Message | Meaning |
|---|---|
| `too many rows failed validation` | A file has more than 5% bad rows. See `reports/`; nothing was loaded. |
| `cannot tell FIRE or EMS` | Rename the PDF so its name contains FIRE or EMS. |
| `A check failed` | A test failed; nothing was pushed. Run `git checkout datasets` to undo local data changes. |
| `Cloudflare rejected` | Re-check the token and account ID in `.env`. |
| `git push failed` | Sign in to GitHub / check write access. |
| `WARNING: incidents by location ...` | The by-township split is still hand-maintained; update `datasets/cad_incidents_by_location.json`. |

## Where things live

- `datasets/` is the only copy of the numbers the page and assistant use (tidy JSON, aggregates only, plus `index.json`
  with the last-updated date). The page builds its figures from these files when it loads. `assets/` holds the map shapes.
- `config.json` is the only place for the Pages address and the assistant's Worker URL (fixed; the Worker deploys to it).
- `data/facts.json` is the assistant's registry of sourced scalars (see Known gaps).
- `run.py` is the pipeline; `pipeline/` (validation, SQLite ingest, dataset export), `ocr-pipe/` (PDF extraction),
  `worker/` (assistant proxy), `shared/` and `assistant/` (scenario math and assistant tools).
- `.github/workflows/pages.yml` publishes the site on every push to `main`.
- More detail: `DATA_DICTIONARY.md`, `POC_DATABASE_PLAN.md`, `CLAUDE.md`.

## Known gaps

- `data/facts.json` still repeats some figures that also live in `datasets/` (it is protected by this repo's Claude
  settings, so it was not migrated). Retiring it means moving its sourced scalars into a dataset and pointing the
  assistant's older tools at `query_dataset`.
- The by-township split and the map's incident points are not derived from SQLite (no township join yet).
- Extraction uses pdfplumber (MIT). PyMuPDF (AGPL) was removed because of public-use restrictions.

- `gis-map/`: CAD & GIS Incident Analysis page (opened from "Open Full Map" on the Overview map); uses `shared/cad-gis.js` (township boundaries and de-identified incident layer) and `shared/cad-metrics.js` (pure metric functions, tests in `shared/cad-metrics.test.js`). `pipeline/build_gis_detail.py` builds the git-ignored `data/cad-gis-detail.json` for local use only.
