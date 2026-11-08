# CCFD1 Decision Intelligence Dashboard — Data Dictionary

Describes what [index.html](index.html) and the "Ask the data" assistant actually use today, and
how that relates to the planned SQLite store ([pipeline/schema.sql](pipeline/schema.sql)).

Every dashboard number carries a source and a **status**, and the assistant must cite them.

## 1. Data layers

| Layer | File | Role |
|---|---|---|
| Page data | `DATA` constant in [index.html](index.html) | Numbers the panels draw. Edit there to update the page. |
| Fact registry | `data/facts.json` | One record per sourced number, with source and status. Panels' "Sources" dialogs and the assistant read it. |
| Scenario engine | [shared/engine.js](shared/engine.js) | Constants and math for Scenario 1 and Scenario 3&4. Shared by the panels and the assistant so they cannot disagree. |
| Assistant tools | [assistant/tools.js](assistant/tools.js) | Pure functions over `facts.json` and the engine. Aggregates only. |
| Relational store (planned) | [pipeline/schema.sql](pipeline/schema.sql) | ERD-based SQLite DB loaded by the CAD ingest pipeline. Not read by the dashboard yet. |

On page load the dashboard compares each fact that has a `check` path with the page value and logs
mismatches to the console.

## 2. Fact record (`data/facts.json`)

| Field | Description |
|---|---|
| `id` | Dotted key, e.g. `fin.revenue.2024` |
| `label` | Human-readable name |
| `value` | The figure; `null` if not yet available |
| `unit` | `USD`, `USD per year`, `USD per $100 AV`, `rate`, `percent`, `count`, ... |
| `year_or_period` | Period covered |
| `panel` | Dashboard panel id the fact belongs to (see §3) |
| `source`, `source_detail` | Source document and section/page |
| `note` | Caveats |
| `status` | `verified`, `partner_stated`, `model_output` or `placeholder` |
| `check` | Optional path compared against the page: `DATA.…`, `ENG.…`, `S1.…`, `MODEL.…`, `KPI.n`, `DOM.id` |

A tool result's status is the weakest status of the facts it depends on.

## 3. Panels and their data

| Panel id | Title | Data | Source | Period |
|---|---|---|---|---|
| `overview` | Key figures | Structural gap $635,758 (2027 budget $1,795,950 − recurring revenue $1,160,192); fund balance end of 2025 $1,624,691 (partner-stated); CCFD1 incidents 604 | Gateway Form 1; partner-stated; CAD extract | 2027 budget; Sep 16 2025 – Sep 16 2026 |
| `financial` | Receipts and disbursements | `operatingRevenue`, `operatingSpending`, `endingBalance` by year (`fin.revenue.<yr>`, `fin.spending.<yr>`, `fin.balance.<yr>`) | Indiana Gateway AFR | 2011–2024 (2025 AFR pending, `gap.afr_2025`) |
| `revenue-sources` | Revenue by source | Property tax, local income tax, interest and other, vehicle excise tax, fire protection contracts (`fin.source2024.*`) | 2024 Gateway AFR | 2024 only |
| `gis` | Townships and service area | Township boundaries with `role` ("CCFD1 Core", "Directly Involved", "Other Cass County") | CCFD1 township financial join, simplified | Static |
| `staffing` | Personnel vs. contracted service cost | `personnel`, `contracted` by year (`staffcost.*.<yr>`). Personnel = salaries and wages + AFR "Employee Benefits". District moved from contracted service to its own staff in 2020. | Gateway AFR | 2011–2024 |
| `uncompensated` | Responses outside the District | Incidents by location: inside the District, Washington Township contract area, outside the District (Jefferson, Clinton, other), no location (`cad.location.<n>`, `cad.outside.*`). The CAD does not record automatic vs. mutual aid. | CCFD1 CAD extract, incident lat/long joined to township boundaries | Sep 16 2025 – Sep 16 2026 |
| `cad` | Incidents by hour of day | 24 counts (`cad.hourly.00`–`23`), `cad.daytime_share` (06:00–18:00) | CAD extract (Fire + EMS, de-duplicated, agency "DIST") | Sep 16 2025 – Sep 16 2026 |
| `scenario` | Scenario 3&4: staffing and compensation | Engine inputs and results (see §4) | Team cost engine v2 | Model |
| `funding-scenario` | Scenario 1: funding change | Engine inputs and results (see §4) | Same basis as the staffing engine | 2026–2030 projection |

Operating finance figures exclude loan proceeds, interfund transfers and payroll pass-throughs.
Only aggregated counts are held; there are no incident-level records, addresses, names, phone
numbers or individual pay.

## 4. Scenario engine constants (`shared/engine.js`)

**Scenario 3&4 (`ENG`)** — fact ids `eng.*`, `kpi.*`

| Constant | Value | Status note |
|---|---|---|
| `AVG_SALARY` | $56,204 | Aggregate |
| `LINE_FF` | 12 | Line firefighters |
| `POSTS_NOW` | 4 | Continuously staffed posts today |
| `PAYROLL_TAX` | 7.65% | |
| `OT_COST_CAP` | $61,569 | Overtime actually recorded; caps the overtime offset |
| `BASE_GAP` | $635,758 | = structural gap |
| `AV` | $307,471,175 | 2027 assessed value |
| `CURRENT_RATE` | $0.2907 per $100 AV | |
| `CEILING` | $0.40 | |
| `HOUSEHOLD_AV` | $150,000 | |
| `FUND_BALANCE` | $1,624,691 | Partner-stated |

User inputs: posts (4–8), fund PERF 77 pension, PERF rate (20–30%, default 26.5% **partner-stated, not
verified with INPRS**), health premium per employee ($0–30,000, default $0 is a **placeholder**, no quote
exists), salary adjustment (0–10%), overtime displacement.

**Scenario 1 (`S1`)** — fact ids `s1.*`

`BUDGET_2027` $1,795,950; `RECURRING_REVENUE` $1,160,192; projection years 2026–2030 starting from the
end-2025 balance; revenue sources use 2024 AFR amounts: property tax $882,965, local income tax $212,041,
vehicle excise tax $64,785, fire protection contracts $21,042. Inputs: funding change (−$500k to $1M),
recurring or one-time, one source changed by ±50%, optionally starting from the Scenario 3&4 gap.

Both are planning comparisons, not forecasts. Rates are gross, before circuit-breaker caps.

## 5. Known gaps (facts `gap.*`)

| Id | Missing | Needed |
|---|---|---|
| `gap.afr_2025` | 2025 AFR | Filing from Indiana Gateway |
| `gap.response_time` | Response-time metrics | Validated dispatch-to-on-scene times, station/apparatus locations with a travel-time model, agreed reporting method |
| `gap.scenario2` | Scenario 2 (township contributions, service agreements) | Agreements, township populations and levies, township incident demand and costs |
| `gap.scenario5` | Scenario 5 (levy controls, circuit-breaker caps) | Maximum levy and growth limits, caps and credits by property class, net assessed value |

## 6. "Ask the data" assistant

Cloudflare Worker ([worker/](worker/)) holds the model (`claude-haiku-5-5`), system prompt and tool
list; the browser runs the tools. Tools: `get_fact`, `search_facts`, `finance_by_year`,
`incidents_by_location`, `incidents_by_hour`, `run_scenario_1`, `run_scenario_34`,
`compare_to_baseline`, `unsupported`. Each returns `{result, sources, status}`, where `sources` are
fact ids. Citations are the fact's `source` and `source_detail`; there is no separate citations table.
`unsupported` returns a standard refusal for response times, Scenario 2 and 5, and record-level or
personal data.

## 7. Relational schema (`pipeline/schema.sql`)

SQLite, translated from [township_fire_ems_full_erd.html](township_fire_ems_full_erd.html). Loaded by
`pipeline/ingest_cad_export.py` from CAD extractor CSVs after row-wise validation (`validate_cad.py`).

| Group | Tables |
|---|---|
| Scenario | `scenario`, `scenario_assumptions`, `scenario_township` |
| Dimensions | `dim_township`, `dim_department`, `dim_apparatus`, `dim_staff` |
| Facts | `fact_financial_year`, `fact_staffing_year`, `fact_compensation`, `fact_incident`, `fact_unit_response` |
| Service links | `township_service` (township ↔ department) |
| Pipeline provenance | `ingest_run`, `ingest_reject` (counts and rule names only, no field values) |

Key relations: `dim_township` → `fact_financial_year`, `fact_incident`, `township_service`,
`scenario_township`; `dim_department` → `township_service`, `dim_apparatus`, `dim_staff`,
`fact_staffing_year`, `fact_compensation`, `fact_unit_response`; `fact_incident` →
`fact_unit_response` ← `dim_apparatus`; `scenario` → `scenario_assumptions`, `scenario_township`;
`ingest_run` → `ingest_reject`. `fact_incident.incident_no` is the upsert key.

`fact_incident` and `fact_unit_response` hold record-level data and must stay out of the dashboard and
assistant. Nothing exports from this database to `facts.json` yet; today `facts.json` and `DATA` are
maintained by hand.

## 8. Daily Blotter extraction output (`ocr-pipe/`)

`data/DailyBlotter/structured/<pdf stem>.csv` (git-ignored; contains PII), one row per incident, header
fields only. Columns are defined in `ocr-pipe/structure_blotter.py`: `source_file`, `page`, `event`,
`create_datetime`, `incident_no`, `disposition`, `case_nos`, `phone`, `caller_name`, `created_by`,
`caller_location`, `station`, `event_location`, `lat_long`. Unit-response tables and narratives are not
yet mapped.

## Source systems

| Source | Feeds | Access |
|---|---|---|
| Indiana Gateway (DLGF) | Form 1 budget, AFR, revenue by source | Public portal; manual PDF/CSV pull, no confirmed API |
| Cass County E911 CAD | Incident counts, hour of day, location; `fact_incident` / `fact_unit_response` | Export or records request, not a public API |
| CCFD1 payroll | Aggregate salary and overtime constants | Internal export |
| Partner-stated figures | End-2025 fund balance, PERF rate | Not yet verified against documents |
| ArcGIS / Cass County GIS | Township boundaries, service area | Embedded layers; geometry stays out of SQLite |

## Open questions

1. Does Cass County E911 provide CAD exports on a schedule, or does each pull need a request?
2. Is there bulk or API access to Gateway filings?
3. Who owns the ArcGIS Online account CCFD1's layers would live in?
4. What are the authoritative taxing vs. non-taxing township lists, with effective dates?
5. Can the CAD distinguish automatic aid from mutual aid (it does not today)?
6. Will `facts.json` be generated from the SQLite store, or stay hand-maintained?
