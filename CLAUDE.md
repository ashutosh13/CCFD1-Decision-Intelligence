# CCFD1 Decision Intelligence: runbook for agents

Read [README.md](README.md) for the layout and [DATA_DICTIONARY.md](DATA_DICTIONARY.md) for what each
panel uses. This file is the process for moving data from SQLite to the dashboard and assistant.

## Rules

- The assistant and dashboard only ever receive **aggregated** data, plus one **sanitized** incident table
  (`cad_incidents_clean`, see below) that stays behind the Worker. Never export incident numbers,
  addresses, names, phone numbers, lat/long of single incidents, or individual pay into `data/` or `datasets/`.
  True source records (`ccfd1.db`) are only read by pipeline scripts, which print counts and rule names only.
- Never print field values from `fact_incident`, `fact_unit_response` or `ocr-pipe` output. Report counts
  and rule names only (the pipeline already does this).
- `data/facts.json` is the registry the assistant cites. Every fact keeps `source`, `source_detail`,
  `status`. An export may not drop or upgrade a status (partner-stated stays partner-stated).
- `shared/engine.js` is the only place scenario math lives. Do not export scenario results as facts.
- `index.html` has no `DATA` literal any more: it is built from `datasets/` at load. Never type figures into the page.

## What SQLite can and cannot feed today

| Dashboard / assistant data | In SQLite? | Bridge status |
|---|---|---|
| Incidents by hour (`cad.hourly.*`) | `fact_incident.incident_datetime` | Exportable. Must match the dashboard's de-duplication rule (Fire + EMS combined, agency "DIST"). |
| Incident total (`cad.incidents`) | `fact_incident` | Exportable (distinct `incident_no`). |
| Incidents by township (`cad.location.*`, `cad.outside.*`) | **No.** The loader stamps one `--township` label on a whole folder, so `township_id` is not a geographic join. | Blocked until a lat/long to township-boundary join exists. |
| Finance by year, revenue by source, personnel vs contracted (`fin.*`, `staffcost.*`) | Table exists (`fact_financial_year`, `fact_compensation`), **no loader** | Blocked until a Gateway AFR loader is written. Today these live only in `DATA`. |
| Gap, fund balance, PERF rate, premium | No | Stay hand-maintained (partner-stated or placeholder). |

## Process

**Canonical path: `python run.py` (see README). It performs steps 1-6 below; the manual list is for debugging.**

Run from the repo root. Stop at the first failing step.

1. **Ingest.** Run `python pipeline/ingest_cad_export.py <structured_folder> --db ccfd1.db --dry-run`, then
   without `--dry-run`. Check `ingest_run` and `ingest_reject`; a high reject rate means stop and
   investigate, do not export.
2. **Aggregate.** An export script (to be written: `pipeline/export_facts.py`) reads `ccfd1.db` and
   emits aggregates only: 24 hourly counts, total distinct incidents, the period start and end. It must
   not write incident-level fields.
3. **Stage, don't overwrite.** Write to `data/facts.candidate.json` (same record shape as `facts.json`,
   only the fact ids it owns). Never write straight to `facts.json`.
4. **Diff.** Compare candidate values with `facts.json` for the same ids. Report each difference with old
   value, new value and size. Differences are expected when new data arrives; unexplained ones are not.
5. **Review.** A person approves the diff. Merge approved facts into `facts.json`, update the matching
   `DATA` values in `index.html`, and set `DATA.updated`.
6. **Verify.**
   - `node --test assistant/tools.test.js assistant/chart.test.js` (some expected values, such as 604 incidents, will need
     updating deliberately when data changes; update the test and say so).
   - Serve with `./start.sh --dev` and open the page. The console must say
     "all N mapped numbers match the page".
   - From `worker/`, `npm test`. If `TOOL_SCHEMAS` changed, `npm run sync-tools` first.
7. **Record.** Note what changed and why in the commit message. Do not commit `ccfd1.db`, the
   structured CSVs or `data/DailyBlotter/`.

## Datasets (series for charts and the assistant)

Series live in `datasets/*.json` (tidy rows, one file per dataset, manifest `datasets/index.json`), queried by
`shared/dataset.js` through the assistant's `list_datasets` / `query_dataset` tools. Same rules as facts: aggregates
only, `source`, `source_detail` and `status` stay on every dataset, never upgrade a status. Rows may hold only the
declared dimension and measure columns; `datasets_lib.py` and `dataset.js` both reject anything else.

- CAD hourly: `python pipeline/export_datasets.py --db ccfd1.db` writes to `datasets.candidate/`.
- Finance: download Gateway AFR figures to CSV, then `python pipeline/build_finance_dataset.py afr_by_year.csv
  --sources afr_sources.csv --source-year 2024`. Columns are in the script's docstring.
- Diff `datasets.candidate/` against `datasets/`, get a person to approve, copy approved files and rerun
  `node --test shared/dataset.test.js`. Its parity test fails if `DATA` in `index.html` and the datasets disagree;
  update both deliberately and say so.
- `facts.json` stays for one-off scalars (gap, fund balance, PERF rate, scenario constants). The older
  `finance_by_year`, `incidents_by_hour` and `incidents_by_location` tools still read `facts.json`; retire them once
  the datasets are the single source.

## Sanitized record-level table (`cad_incidents_clean`)

- Build: `python pipeline/clean_incidents.py --db ccfd1.db` (run.py does it during export). It drops every identifying
  column, keeps hour/weekday/month, Fire/EMS group, controlled call category, in_district, township and `duration_min`,
  refuses to write if `datasets_lib.scan_pii` finds PII columns or patterns, writes the private rows to `datasets.private/`
  (git-ignored, never published) and a row-free schema (`remote: true`) to `datasets.candidate/`.
- Publish: approve the schema diff as usual, then upload the rows with `cd worker && npm run upload-data` (run.py does this
  after deploying the Worker). Only the Worker reads them, as aggregates with groups under 3 incidents hidden.
- `in_district` must be computed from the TRUE coordinates (blocker 1) before they are dropped. Until then it is "unknown".
- Tests: `pytest pipeline/tests` (leak tests use synthetic data), `node --test assistant/chart.test.js`, `cd worker && npm test`.

## Known blockers to resolve first

1. Add a township assignment by spatial join (incident lat/long against the township boundaries in
   `DATA`) so location counts can come from SQLite.
2. Write the Gateway AFR / Form 1 loader for `fact_financial_year`.
3. Decide whether `facts.json` becomes generated or stays hand-maintained.

Until 1 and 2 are done, only the hourly and total incident facts can be bridged.
