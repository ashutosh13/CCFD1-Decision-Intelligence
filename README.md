# CCFD1-Decision-Intelligence

- `index.html`: static dashboard (data in the `DATA` constant and `data/facts.json`)
- `DATA_DICTIONARY.md`: what the dashboard, facts and assistant use
- `POC_DATABASE_PLAN.md`: plan and status of the SQLite store
- `gis-map/`: CAD & GIS Incident Analysis page (opened from "Open Full Map" on the Overview map)
  - `shared/cad-gis.js`: township boundaries + published (de-identified) CCFD1 incident layer
  - `shared/cad-metrics.js`: every metric on the page, as pure functions (`run(ds, "byHour", filters)`); tests in `shared/cad-metrics.test.js`
  - `pipeline/build_gis_detail.py`: builds `data/cad-gis-detail.json` from the combined CAD CSVs.
    That file holds incident-level records and is git-ignored, so the published site shows the
    de-identified layer only. Local test: `python pipeline/build_gis_detail.py`, then
    `python -m http.server 8000` and open http://127.0.0.1:8000/gis-map/
- `township_fire_ems_full_erd.html`: entity-relationship diagram
- `shared/engine.js`: scenario math shared by the panels and the assistant
- `assistant/`: "Ask the data" tools; `worker/`: Cloudflare Worker proxy to the Claude API
- `pipeline/`: CAD validation and SQLite ingest (`schema.sql`)
- `ocr-pipe/`: Daily Blotter extraction pipeline (see its README)
