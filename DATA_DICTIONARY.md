# CCFD1 Decision Intelligence Dashboard — Data Dictionary

Maps every value currently hardcoded or sample-generated in [index.html](index.html) to the real
field(s) needed to drive it. Use this to identify what to pull from each source system and how to
shape it before injection.

Every dashboard number is displayed with a source tag and the "Ask the data" panel promises a
citation for every figure — so each field below carries a **Citation** requirement, not just a value.

---

## 1. Overview KPIs (`#overview`)

| Field | Type | Unit | Description | Current sample value | Source system | Cadence |
|---|---|---|---|---|---|---|
| `operating_gap_amount` | decimal | USD | Proposed budget minus recurring revenue for the budget year | $635,758 (2027) | Derived: `proposed_operating_budget - recurring_revenue` | Annual |
| `proposed_operating_budget` | decimal | USD | Total proposed operating budget for the budget year | $1,795,950 (2027) | Indiana Gateway, Form 1 (Budget Form) | Annual |
| `recurring_revenue` | decimal | USD | Recurring annual revenue, current year | $1,160,192 | Indiana Gateway budget/revenue filings | Annual |
| `fund_balance_end_of_year` | decimal | USD | Ending fund balance for a given fiscal year | $1,624,691 (2025) | CCFD1 annual financial report / Gateway Annual Financial Report (AFR) | Annual |
| `fund_balance_peak_year` / `fund_balance_peak_amount` | int / decimal | year / USD | Year and amount of the historical fund balance peak, for the "down $X from Y peak" delta | 2023, $1,932,643 (implied) | Same AFR series, computed as max over series | Annual |
| `dispatched_incidents_count` | int | count | Total dispatched incidents in the trailing 12-month window, Fire + EMS | 8,936 (Sep 2025–Sep 2026) | Cass County E911 CAD export | Monthly or on dashboard refresh |
| `dispatched_incidents_window_start` / `_end` | date | — | Rolling window bounds for the incident count | 2025-09 / 2026-09 | Derived (today − 12mo) | Same as above |

**Citation fields needed per KPI:** `source_document_name`, `source_section_or_form`, `source_url_or_filepath`, `as_of_date`.

---

## 2. Financial — Receipts & Disbursements, 2011–2025 (`#financial`)

Panel: paired bar chart, one pair per year.

| Field | Type | Unit | Description | Source system | Cadence |
|---|---|---|---|---|---|
| `fiscal_year` | int | year | Year label (2011–2025, currently every other year plotted) | — | — |
| `total_receipts` | decimal | USD | Total revenue received that fiscal year | Indiana Gateway AFR, or CCFD1 annual report | Annual |
| `total_disbursements` | decimal | USD | Total expenditures that fiscal year | Indiana Gateway AFR, or CCFD1 annual report | Annual |

Needs one row per fiscal year, 2011–2025 (15 rows minimum; chart currently samples odd years but
should be fed the full series and let the chart decide bucketing).

## 2a. Revenue by Source (donut, same row)

| Field | Type | Unit | Description | Sample % | Source system | Cadence |
|---|---|---|---|---|---|---|
| `revenue_source_category` | string (enum) | — | One of: Property tax, Local income tax, EMS billing, Other | — | Indiana Gateway budget/revenue detail | Annual |
| `revenue_source_amount` | decimal | USD | Dollar amount for that category, current year | Property tax 58%, Local income tax 22%, EMS billing 13%, Other 7% | Same | Annual |
| `revenue_source_pct` | decimal | % | Share of total revenue (derivable from amount ÷ total) | — | Derived | — |
| `revenue_source_fiscal_year` | int | year | Year the breakdown applies to | — | — | — |

---

## 3. GIS / Townships and Service Area (`#gis`)

Currently a static SVG grid + a live Leaflet/Esri basemap fallback. Real version needs GIS layers,
most naturally served from ArcGIS Online rather than the relational store (see PoC plan).

| Field | Type | Unit | Description | Source system | Cadence |
|---|---|---|---|---|---|
| `township_id` | string | — | Unique township identifier | Cass County GIS / ArcGIS | Static (rare change) |
| `township_name` | string | — | Township name | Cass County GIS | Static |
| `township_geometry` | polygon (GeoJSON/Shapefile) | — | Township boundary | Cass County GIS parcel/township layer | Static |
| `township_is_taxing_district` | boolean | — | Whether township is inside CCFD1's taxing area | CCFD1 governance record / Gateway district boundary | Rare (only on annexation/withdrawal) |
| `station_id` | string | — | Fire station identifier | CCFD1 asset record | Static |
| `station_name` | string | — | Station name/number | CCFD1 | Static |
| `station_lat` / `station_lon` | decimal | degrees | Station coordinates | CCFD1 / ArcGIS | Static |
| `service_area_boundary` | line/polygon (GeoJSON) | — | Primary response/service area outline shown as the curved band on the map | ArcGIS web map (CCFD1's own or Cass County E911's) | Rare |
| `county_boundary` | polygon (GeoJSON) | — | Cass County, Indiana outline for the basemap context | Public GIS (Esri/Census TIGER) | Static |

**Note:** the live map in `index.html` already uses Esri basemap tiles via Leaflet. The intended
integration path (per the in-file comment) is pasting an ArcGIS web map / Experience Builder embed
URL into `EMBEDS.map` — so township/station/service-area layers may not need to live in the PoC
database at all; they can be authored and maintained directly in ArcGIS Online and embedded.

---

## 4. Staffing — Staffed Hours by Shift (`#staffing`)

| Field | Type | Unit | Description | Sample value | Source system | Cadence |
|---|---|---|---|---|---|---|
| `shift_code` | string (enum) | — | A, B, or C shift | A/B/C | CCFD1 scheduling/roster system | Per pay period |
| `staffed_hours_pct` | decimal | % (0–1) | Share of scheduled hours actually staffed (vs. vacant/unfilled) | A 92%, B 88%, C 95% | Scheduling system, or timekeeping export | Per pay period |
| `staffed_hours_actual` | decimal | hours | Actual staffed hours for the shift in the period | — | Same | Per pay period |
| `staffed_hours_scheduled` | decimal | hours | Scheduled/required hours for the shift in the period | — | Same | Per pay period |
| `overtime_share_pct` | decimal | % (0–1) | Overtime hours as a share of total hours worked | 18% | Timekeeping/payroll export | Per pay period |
| `overtime_hours` | decimal | hours | Raw overtime hours | — | Payroll export | Per pay period |
| `staffing_period_start` / `_end` | date | — | Pay period or reporting window bounds | — | — | — |

---

## 5. Uncompensated Service — Responses Outside the District (`#uncompensated`)

| Field | Type | Unit | Description | Sample value | Source system | Cadence |
|---|---|---|---|---|---|---|
| `response_category` | string (enum) | — | Primary (in-District), Automatic aid, Mutual aid, Contract | — | Cass County E911 CAD, tagged by agreement type | Monthly |
| `response_count` | int | count | Number of responses in that category for the period | Primary 64%, Automatic aid 14%, Mutual aid 17%, Contract 5% | CAD export, joined to mutual/auto-aid agreement table | Monthly |
| `response_pct_of_total` | decimal | % | Share of total responses (derived) | — | Derived | — |
| `aid_agreement_id` | string | — | Which mutual/automatic aid or contract agreement applies | — | CCFD1 agreement records | Static/rare |
| `uncompensated_cost_estimate` | decimal | USD | Estimated unreimbursed cost of out-of-district responses (implied by panel name, not yet shown numerically) | — | Derived: unit-hour cost × response count, or explicit billing/reimbursement data | Monthly/Annual |
| `reporting_period_start` / `_end` | date | — | Window the percentages cover | — | — | — |

---

## 6. Incidents by Hour of Day — CAD (`#cad`)

Built from raw dispatch records, aggregated to hour-of-day.

| Field | Type | Unit | Description | Source system | Cadence |
|---|---|---|---|---|---|
| `incident_id` | string | — | Unique CAD incident/call number | Cass County E911 CAD | Real-time/daily export |
| `incident_type` | string (enum) | — | Fire, EMS, other | CAD | Same |
| `dispatch_timestamp` | datetime | — | Time the incident was dispatched (drives `hour_of_day`) | CAD | Same |
| `enroute_timestamp` | datetime | — | Unit enroute time (for future response-time metrics) | CAD | Same |
| `arrive_timestamp` | datetime | — | Unit on-scene time | CAD | Same |
| `clear_timestamp` | datetime | — | Unit clear/available time | CAD | Same |
| `unit_id` | string | — | Responding apparatus/unit | CAD | Same |
| `incident_lat` / `incident_lon` | decimal | degrees | Incident location, for future map overlay | CAD (geocoded) | Same |
| `hour_of_day` | int | 0–23 | Derived from `dispatch_timestamp` | Derived | — |
| `is_daytime` | boolean | — | Whether hour falls in the shaded "Daytime" band (~7:00–18:00) shown on the chart | Derived | — |

Aggregate needed for the chart itself: `incident_count` grouped by `hour_of_day`, over a defined
rolling window (matches the KPI window, Sep 2025–Sep 2026, or should be independently configurable).

---

## 7. Scenario Analysis (`#scenario`)

These are model **assumptions/constants**, not observed data, but they still need sourcing and
should live in the same store so the model stays reconcilable with the KPIs above.

| Field | Type | Unit | Description | Current hardcoded value | Source |
|---|---|---|---|---|---|
| `baseline_operating_gap` | decimal | USD | Starting gap before scenario adjustments | $635,758 | = `operating_gap_amount` (§1) |
| `baseline_fund_balance` | decimal | USD | Starting fund balance for "years of runway" math | $1,624,691 | = `fund_balance_end_of_year` (§1) |
| `fully_loaded_cost_per_hire` | decimal | USD/position | Fully loaded annual cost of one added position | $100,000 | CCFD1 compensation/benefits schedule |
| `positions_per_added_shift_slot` | int | count | Hires needed per "position added per shift" (3 shifts × 1) | 3 | Staffing model assumption |
| `income_tax_loss_2028` | decimal | USD | Projected annual local income tax revenue loss starting 2028 | $240,000 | Indiana DLGF / county income tax projection |
| `levy_increase_min` / `_max` / `_step` | decimal | USD | Slider bounds for levy increase input | $0 / $1,200,000 / $50,000 | Policy/planning assumption (levy cap rules) |
| `positions_min` / `_max` / `_step` | int | count | Slider bounds for positions-added input | 0 / 3 / 1 | Planning assumption |

---

## 8. "Ask the Data" Assistant (`#assistant`)

Not a distinct data domain — it needs read access to everything above, plus:

| Field | Type | Description |
|---|---|---|
| `citation.document_name` | string | Human-readable source document (e.g., "CCFD1 2025 Annual Report") |
| `citation.document_url_or_path` | string | Link or file path to the source |
| `citation.section_or_page` | string | Section/page/form reference within the document |
| `citation.retrieved_at` | datetime | When the figure was last pulled/verified |
| `citation.figure_field` | string | Which dictionary field (from sections 1–7) this citation backs |

Every fact the assistant can cite must resolve to one row in a `citations` table keyed by field +
period, so an answer can say "as of [date], from [document], section [X]."

---

## 9. Footer / Metadata

| Field | Type | Description | Sample value |
|---|---|---|---|
| `dashboard_last_updated` | date | Displayed in footer | September 25, 2026 |
| `data_source_list` | string[] | Named sources shown in footer | CCFD1 annual reports, Indiana Gateway, Cass County E911 |

---

## Source system summary

| Source system | Feeds | Access pattern (typical) |
|---|---|---|
| **Indiana Gateway** (DLGF) | Budget (Form 1), AFR, revenue by category | Public web portal; CSV/PDF export or scraped filings, no API confirmed — treat as manual/periodic pull |
| **CCFD1 annual reports** | Fund balance, receipts/disbursements, staffing narrative | PDF documents — manual extraction or PDF-parsing pipeline |
| **Cass County E911 CAD** | Incident records, hour-of-day, response category, mutual/auto aid | Likely a records request or scheduled export (CSV) from the CAD/RMS vendor; not a public API |
| **CCFD1 internal scheduling/payroll** | Staffing hours, overtime | Internal system export (CSV) |
| **CCFD1 asset/governance records** | Station locations, taxing township list, aid agreements | Internal records, mostly static |
| **ArcGIS Online** | Township boundaries, service area, station map layer | ArcGIS web map / feature service, embedded directly (see GIS section note) |

## Open questions to resolve before ingestion

1. Does Cass County E911 provide CAD exports on a schedule, or does each pull require a manual request?
2. Is there API/bulk-export access to Indiana Gateway filings, or is this manual PDF/CSV download per filing period?
3. Who owns the ArcGIS Online organization account CCFD1's layers would live in?
4. What is the authoritative list + effective dates for taxing vs. non-taxing townships (for historical correctness, not just current state)?
5. Does "uncompensated service" have an existing cost-per-response figure, or does that need to be derived (and by whom)?


## 10. Daily Blotter extraction output (`ocr-pipe/`)

`data/DailyBlotter/structured/<pdf stem>.csv` (git-ignored; contains PII), one row per incident,
header fields only. Columns are defined in `ocr-pipe/structure_blotter.py`:
`source_file`, `page`, `event`, `create_datetime`, `incident_no`, `disposition`, `case_nos`, `phone`,
`caller_name`, `created_by`, `caller_location`, `station`, `event_location`, `lat_long`.
Unit-response tables and narratives are not yet mapped. Cross-check entities against
`township_fire_ems_full_erd.html`.
