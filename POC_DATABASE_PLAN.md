# CCFD1 Dashboard — Database PoC Plan

Goal: back the dashboard's figures with a real database, using the smallest system that can grow into
a production feed. This is a proof of concept for a single-analyst pipeline, not the production
architecture. See [DATA_DICTIONARY.md](DATA_DICTIONARY.md) for what the dashboard uses today.

## Current state

| Piece | Status |
|---|---|
| Dashboard figures | In `DATA` in [index.html](index.html) and `data/facts.json`, maintained by hand. Gateway AFR 2011–2024 and a CAD extract are in. |
| Scenario math | [shared/engine.js](shared/engine.js), shared by the panels and the assistant. |
| Assistant | Tools in [assistant/tools.js](assistant/tools.js) read `facts.json` and the engine; Worker in [worker/](worker/). |
| SQLite schema | [pipeline/schema.sql](pipeline/schema.sql), ERD-based. Created and loaded by the CAD ingest pipeline. |
| CAD ingest | `pipeline/ingest_cad_export.py` (validate, then load), `validate_cad.py`, `stage_deltas.py`, `summarize_reports.py`. Output is counts and rule names only, because the data contains PII. |
| Blotter OCR | [ocr-pipe/](ocr-pipe/) extracts Daily Blotter PDFs to CSV. |
| Database to dashboard | **Not built.** Nothing exports from SQLite to `facts.json` or `DATA`. |

## Guiding constraint

`index.html` stays static: no server is needed to view it. Data is prepared offline and published as
static JSON the page fetches at load time (`data/facts.json` is the existing example), so it can be
hosted on GitHub Pages.

```
Sources (Gateway AFR/Form 1, CAD export, Blotter PDFs, payroll)
        │  manual download / scripted pull
        ▼
  raw files (as received, untouched)
        │  pipeline/ + ocr-pipe/ (Python; validate first)
        ▼
  SQLite (ccfd1.db, schema.sql)           ← built, CAD tables only
        │  export script                   ← NOT BUILT
        ▼
  data/facts.json (+ DATA values)         ← today edited by hand
        │  fetch() at page load
        ▼
  index.html + assistant/tools.js
```

## Why SQLite

Zero install, single file, real SQL with constraints, and the same schema moves to Postgres if it ever
needs concurrent writers or a hosted API.

## Schema

The schema follows the ERD ([township_fire_ems_full_erd.html](township_fire_ems_full_erd.html)) and
lives in [pipeline/schema.sql](pipeline/schema.sql). It is the source of truth; do not copy DDL here.

| Group | Tables |
|---|---|
| Scenario | `scenario`, `scenario_assumptions`, `scenario_township` |
| Dimensions | `dim_township`, `dim_department`, `dim_apparatus`, `dim_staff` |
| Facts | `fact_financial_year`, `fact_staffing_year`, `fact_compensation`, `fact_incident`, `fact_unit_response` |
| Links | `township_service` |
| Provenance | `ingest_run`, `ingest_reject` |

Additions beyond the ERD (marked `-- ADDED` in the SQL): unique keys used for upserts
(`dim_township.township_name`, `dim_department.department_name`, `fact_incident.incident_no`, apparatus
and unit-response uniques) and the two ingest tables.

Citations are carried on each `facts.json` record (`source`, `source_detail`, `status`), not in a
database table. If the export step is built, it should write those fields, not drop them.

GIS polygons stay in ArcGIS and are not stored in SQLite.

## Ingestion

| Script | Source | Output |
|---|---|---|
| `ingest_cad_export.py` | CAD extractor CSVs (`incidents.csv`, `unit_responses.csv`) | `fact_incident`, `fact_unit_response`, `ingest_run`, `ingest_reject` |
| `validate_cad.py` | Same | Row-wise findings (rule, severity), no field values |
| `stage_deltas.py` | `unit_responses.csv` | Aggregate stage-to-stage time deltas (JSON) |
| `summarize_reports.py` | `ingest_*.json` reports | Per-file and per-rule tables |
| `ocr-pipe/` | Daily Blotter PDFs | Structured CSVs (git-ignored, PII) |

Not yet written: loaders for Gateway AFR/Form 1 (`fact_financial_year`), payroll
(`fact_staffing_year`, `fact_compensation`), and reference data (townships, departments, apparatus,
agreements).

## Privacy

`fact_incident`, `fact_unit_response` and the blotter CSVs are record-level and contain PII. They stay
out of the dashboard and assistant, which only receive aggregated counts. Pipeline logs and rejects
record counts and rule names only.

## Next steps

1. Write the Gateway AFR/Form 1 loader so `fact_financial_year` reproduces the figures in `DATA.finance`.
2. Seed reference tables (townships, department, apparatus).
3. Write an export script that produces aggregated facts (hourly counts, incidents by township,
   finance by year) from SQLite into `facts.json`, keeping source and status. Reconcile with the
   existing `check` paths so the page and file still agree.
4. Decide whether `facts.json` becomes generated or stays hand-maintained (the source of truth must be
   one or the other).
5. Fill the documented gaps (`gap.*`): the 2025 AFR, response-time data, Scenario 2 and Scenario 5
   inputs.
6. Wrap ingest and export in one refresh command and log each run.

## Beyond the PoC

- Postgres if concurrent writers, a hosted API or scheduled pulls are needed.
- A live query API only if the assistant needs more than pre-aggregated facts; this would need a
  privacy review first.
- Automated CAD and Gateway pulls, once access options are confirmed.
- GIS sync: decide whether ArcGIS or SQL is authoritative for taxing-township status.
