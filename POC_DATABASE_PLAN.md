# CCFD1 Dashboard — Database PoC Plan

Goal: replace the hardcoded `SAMPLES` visuals and constants in [index.html](index.html) with real
figures, using the smallest system that can plausibly grow into a production feed. This is a proof
of concept, not the production architecture — scope is a single-analyst pipeline that pulls data by
hand or by script, lands it in a local database, and exports it for the dashboard to read.

## Guiding constraint

`index.html` is a static, dependency-free single file. The PoC should preserve that: no server
required to *view* the dashboard. Data is pulled and transformed offline, landed in a local
database, then exported to static JSON files the page fetches at load time — same pattern already
used for `EMBEDS` (paste a URL, or fall back to a sample). This keeps the PoC deployable as static
files (e.g., GitHub Pages) while still being backed by a real database during authoring.

```
Sources (Gateway, CAD export, annual report PDFs, payroll)
        │  manual download / scripted pull
        ▼
  raw/ (CSV, PDF, XLSX as received — untouched, dated)
        │  ingestion scripts (Python)
        ▼
  SQLite database (ccfd1.db)  ← the "like a db"
        │  export scripts
        ▼
  data/*.json  (one file per dashboard panel)
        │  fetch() at page load
        ▼
  index.html (charts render from JSON instead of SAMPLES)
```

## Why SQLite for the PoC

- Zero install, single file, trivial to hand off or commit-ignore.
- Real SQL: joins, constraints, and views — good enough to prove the schema before any migration.
- Python's `sqlite3` and `pandas.to_sql` make ingestion scripts short.
- Clean upgrade path: the same schema moves to Postgres later with minimal DDL changes if this
  becomes a live, multi-user system (e.g., needs concurrent writers, an API, or ArcGIS feature
  service sync).

Not proposing this as the long-term store — flag that decision explicitly for later (see
"Beyond the PoC" below).

## Schema (draft)

Tables map directly to the sections in [DATA_DICTIONARY.md](DATA_DICTIONARY.md).

```sql
-- Annual financial series (§2)
CREATE TABLE financial_annual (
  fiscal_year        INTEGER PRIMARY KEY,
  total_receipts      REAL,
  total_disbursements  REAL,
  source_citation_id  INTEGER REFERENCES citations(id)
);

-- Revenue breakdown by category, per year (§2a)
CREATE TABLE revenue_by_source (
  id                  INTEGER PRIMARY KEY,
  fiscal_year         INTEGER REFERENCES financial_annual(fiscal_year),
  category            TEXT CHECK(category IN ('property_tax','local_income_tax','ems_billing','other')),
  amount              REAL,
  source_citation_id  INTEGER REFERENCES citations(id)
);

-- KPI-level annual figures not already covered above (§1)
CREATE TABLE budget_summary (
  fiscal_year             INTEGER PRIMARY KEY,
  proposed_operating_budget REAL,
  recurring_revenue        REAL,
  fund_balance_end_of_year REAL,
  source_citation_id       INTEGER REFERENCES citations(id)
);

-- Staffing by shift, per pay period (§4)
CREATE TABLE staffing_period (
  id                    INTEGER PRIMARY KEY,
  period_start          DATE,
  period_end            DATE,
  shift_code            TEXT CHECK(shift_code IN ('A','B','C')),
  scheduled_hours       REAL,
  staffed_hours         REAL,
  overtime_hours        REAL,
  source_citation_id    INTEGER REFERENCES citations(id)
);

-- Aid/response category rollups (§5)
CREATE TABLE response_category_summary (
  id                    INTEGER PRIMARY KEY,
  period_start          DATE,
  period_end            DATE,
  category              TEXT CHECK(category IN ('primary','automatic_aid','mutual_aid','contract')),
  response_count        INTEGER,
  source_citation_id    INTEGER REFERENCES citations(id)
);

-- Raw CAD incidents (§6) — the fact table; hour-of-day chart aggregates from this
CREATE TABLE cad_incident (
  incident_id       TEXT PRIMARY KEY,
  incident_type     TEXT,
  dispatch_ts       DATETIME,
  enroute_ts        DATETIME,
  arrive_ts         DATETIME,
  clear_ts          DATETIME,
  unit_id           TEXT,
  response_category TEXT,           -- links conceptually to response_category_summary
  lat               REAL,
  lon               REAL,
  source_citation_id INTEGER REFERENCES citations(id)
);

-- Scenario model constants (§7) — versioned so old scenarios stay reproducible
CREATE TABLE scenario_assumptions (
  id                          INTEGER PRIMARY KEY,
  effective_date              DATE,
  fully_loaded_cost_per_hire  REAL,
  positions_per_shift_slot    INTEGER,
  income_tax_loss_annual      REAL,
  income_tax_loss_start_year  INTEGER,
  source_citation_id          INTEGER REFERENCES citations(id)
);

-- Provenance for every figure (§8) — what "Ask the data" cites
CREATE TABLE citations (
  id                  INTEGER PRIMARY KEY,
  document_name       TEXT,
  document_url_or_path TEXT,
  section_or_page      TEXT,
  retrieved_at         DATETIME
);

-- Static/rare-change reference data (§3, partial — full geometry stays in ArcGIS)
CREATE TABLE station (
  station_id   TEXT PRIMARY KEY,
  station_name TEXT,
  lat          REAL,
  lon          REAL
);

CREATE TABLE township (
  township_id           TEXT PRIMARY KEY,
  township_name         TEXT,
  is_taxing_district     BOOLEAN,
  effective_start_date   DATE,
  effective_end_date     DATE  -- nullable; supports historical annexation changes
);
```

GIS polygons (township boundaries, service area) are **not** proposed for SQLite in the PoC — keep
those in ArcGIS Online and use the dashboard's existing `EMBEDS.map` mechanism. Forcing polygon
geometry into a relational PoC adds complexity the dashboard doesn't need yet, since it already has
a working embed pattern for that panel.

## Ingestion scripts (one per source, Python + pandas)

| Script | Source | Output tables |
|---|---|---|
| `ingest_gateway_budget.py` | Manually downloaded Gateway Form 1 / AFR CSV or PDF | `budget_summary`, `financial_annual`, `revenue_by_source` |
| `ingest_annual_report.py` | CCFD1 annual report PDF (table extraction, e.g. `pdfplumber`) | `financial_annual`, `budget_summary` |
| `ingest_cad_export.py` | Cass County E911 CAD CSV export | `cad_incident`, rolled up into `response_category_summary` |
| `ingest_payroll.py` | Internal scheduling/payroll export | `staffing_period` |
| `seed_reference.py` | Hand-maintained CSV (stations, townships, scenario assumptions) | `station`, `township`, `scenario_assumptions` |

Each script:
1. Reads a raw file from `raw/<source>/<pulled_date>/...` (raw files kept as-received, never edited).
2. Normalizes into the schema above.
3. Writes/derives a `citations` row for the batch (document name, path, retrieved_at).
4. Upserts into `ccfd1.db` — re-running a script for the same period should update, not duplicate.

## Export layer

`export_dashboard_json.py` runs SQL views against `ccfd1.db` and writes one JSON file per panel
into `data/`:

```
data/kpis.json
data/financial_series.json
data/revenue_by_source.json
data/staffing.json
data/uncompensated.json
data/cad_hourly.json
data/scenario_assumptions.json
```

Shapes should mirror what each chart function in `index.html` already expects internally (e.g.
`cad_hourly.json` = 24 counts indexed by hour, matching what `hourly()` currently hardcodes) so the
dashboard-side change is "fetch then render" instead of a rewrite of the chart code.

## Dashboard-side change (small, deferred until data exists)

Replace the `SAMPLES` fallback logic with an async fetch-then-render step:

```js
async function loadPanel(key, renderFn) {
  try {
    const res = await fetch(`data/${key}.json`);
    if (!res.ok) throw new Error();
    return renderFn(await res.json());
  } catch { return SAMPLES[key]?.(); }  // keep sample as graceful fallback
}
```

This keeps the existing "Sample data" tag/fallback behavior intact for any panel whose JSON isn't
present yet — useful while sources are onboarded one at a time.

## Phased rollout

1. **Schema + empty DB.** Create `ccfd1.db` from the DDL above. No data yet.
2. **Seed static reference data.** Stations, townships, scenario assumptions — hand-entered from
   known values (the numbers already in `index.html` are a reasonable seed).
3. **One real source end-to-end.** Pick the easiest win — likely CAD hourly incidents or the annual
   budget figures — and get raw pull → ingest → export → dashboard fetch working for that one panel.
   Proves the pipeline before investing in the harder sources (PDF parsing, records requests).
4. **Add remaining sources** one script at a time, per the table above.
5. **Citations pass.** Confirm every exported JSON value carries a resolvable `citations` row, since
   the "Ask the data" panel's value proposition depends on this.
6. **Refresh cadence.** Wrap ingestion + export in a single `refresh_all.py`; run manually for the
   PoC. Log each run (source, row counts, timestamp) to catch silent failures early.

## Beyond the PoC (explicitly out of scope now, flagged for later)

- **Swap SQLite → Postgres** if this needs concurrent writers, a hosted API, or scheduled automated
  pulls rather than manual/analyst-driven refresh.
- **Real API layer** (FastAPI/Flask) if the dashboard needs to be dynamic rather than static-JSON,
  or if "Ask the data" becomes a real LLM-backed assistant needing live query access.
- **Automated CAD/Gateway pulls** once it's confirmed whether those sources expose anything
  better than manual export (see open questions in the data dictionary).
- **GIS sync** — if ArcGIS layers need to reflect data-dictionary state (e.g., taxing township flips),
  decide whether ArcGIS or the SQL store is authoritative to avoid two sources of truth.
