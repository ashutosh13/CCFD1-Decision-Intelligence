# CCFD1-Decision-Intelligence

- `index.html`: static dashboard (data in the `DATA` constant and `data/facts.json`)
- `DATA_DICTIONARY.md`: what the dashboard, facts and assistant use
- `POC_DATABASE_PLAN.md`: plan and status of the SQLite store
- `township_fire_ems_full_erd.html`: entity-relationship diagram
- `shared/engine.js`: scenario math shared by the panels and the assistant
- `datasets/`: static, aggregate-only tidy JSON datasets plus `index.json` (hostable on GitHub Pages);
  `shared/dataset.js` validates and queries them (browser and Node); `datasets.candidate/` is the staging folder
- `assistant/`: "Ask the data" tools; `worker/`: Cloudflare Worker proxy to the Claude API
- `pipeline/`: CAD validation and SQLite ingest (`schema.sql`); `export_datasets.py` (CAD hourly from SQLite) and
  `build_finance_dataset.py` (Gateway AFR CSV) write datasets via `datasets_lib.py`
- `ocr-pipe/`: Daily Blotter extraction pipeline (see its README)
