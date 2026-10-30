-- Translated from township_fire_ems_full_erd.html (Mermaid ERD).
-- Types: int->INTEGER, string->TEXT, decimal->REAL, boolean->INTEGER (0/1), date/datetime->TEXT (ISO-8601).
-- Additions beyond the ERD are marked "-- ADDED".
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scenario (
  scenario_id   INTEGER PRIMARY KEY,
  scenario_name TEXT,
  is_baseline   INTEGER CHECK (is_baseline IN (0, 1)),
  created_date  TEXT
);

CREATE TABLE IF NOT EXISTS scenario_assumptions (
  assumption_id         INTEGER PRIMARY KEY,
  scenario_id           INTEGER REFERENCES scenario(scenario_id),
  revenue_growth_rate   REAL,
  expense_growth_rate   REAL,
  av_growth_rate        REAL,
  call_growth_rate      REAL,
  staffing_level        INTEGER,
  healthcare_assumption REAL,
  retirement_assumption REAL,
  income_tax_reduction  REAL
);

CREATE TABLE IF NOT EXISTS dim_township (
  township_id       INTEGER PRIMARY KEY,
  township_name     TEXT UNIQUE,            -- UNIQUE ADDED (get-or-create key)
  county_name       TEXT,
  population        INTEGER,
  assessed_valuation REAL,
  service_area_sqmi REAL
);

CREATE TABLE IF NOT EXISTS scenario_township (
  scenario_id           INTEGER REFERENCES scenario(scenario_id),
  township_id           INTEGER REFERENCES dim_township(township_id),
  included              INTEGER CHECK (included IN (0, 1)),
  participation_type    TEXT,
  contract_revenue      REAL,
  consolidation_savings REAL,
  PRIMARY KEY (scenario_id, township_id)
);

CREATE TABLE IF NOT EXISTS fact_financial_year (
  financial_id        INTEGER PRIMARY KEY,
  township_id         INTEGER REFERENCES dim_township(township_id),
  year                INTEGER,
  property_tax        REAL,
  lit_revenue         REAL,
  fire_ems_revenue    REAL,
  contract_revenue    REAL,
  county_state_support REAL,
  one_time_funding    REAL,
  total_revenue       REAL,
  total_expenditures  REAL,
  fund_balance        REAL
);

CREATE TABLE IF NOT EXISTS dim_department (
  department_id   INTEGER PRIMARY KEY,
  department_name TEXT UNIQUE,              -- UNIQUE ADDED
  department_type TEXT,
  station_name    TEXT
);

CREATE TABLE IF NOT EXISTS township_service (
  service_id         INTEGER PRIMARY KEY,
  township_id        INTEGER REFERENCES dim_township(township_id),
  department_id      INTEGER REFERENCES dim_department(department_id),
  participation_type TEXT,
  contract_status    TEXT,
  effective_date     TEXT
);

CREATE TABLE IF NOT EXISTS dim_apparatus (
  apparatus_id     INTEGER PRIMARY KEY,
  department_id    INTEGER REFERENCES dim_department(department_id),
  apparatus_name   TEXT,
  apparatus_type   TEXT,
  year_in_service  INTEGER,
  readiness_status TEXT,
  replacement_year INTEGER,
  replacement_cost REAL,
  UNIQUE (apparatus_name, department_id)    -- ADDED
);

CREATE TABLE IF NOT EXISTS dim_staff (
  staff_id        INTEGER PRIMARY KEY,
  department_id   INTEGER REFERENCES dim_department(department_id),
  firefighter_no  TEXT,
  role            TEXT,
  employment_type TEXT,
  active_status   TEXT
);

CREATE TABLE IF NOT EXISTS fact_staffing_year (
  staffing_id       INTEGER PRIMARY KEY,
  department_id     INTEGER REFERENCES dim_department(department_id),
  year              INTEGER,
  staff_per_shift   INTEGER,
  paid_staff        INTEGER,
  volunteer_staff   INTEGER,
  overtime_hours    REAL,
  staffing_capacity REAL
);

CREATE TABLE IF NOT EXISTS fact_compensation (
  compensation_id      INTEGER PRIMARY KEY,
  department_id        INTEGER REFERENCES dim_department(department_id),
  year                 INTEGER,
  wages                REAL,
  healthcare_cost      REAL,
  holiday_pay          REAL,
  retirement_cost      REAL,
  total_personnel_cost REAL
);

CREATE TABLE IF NOT EXISTS fact_incident (
  incident_id       INTEGER PRIMARY KEY,
  incident_no       TEXT NOT NULL UNIQUE,   -- ADDED: extractor ID e.g. 2026-00001234 (upsert key)
  township_id       INTEGER REFERENCES dim_township(township_id),
  case_number       TEXT,
  event_type        TEXT,
  incident_datetime TEXT,
  event_location    TEXT,
  latitude          REAL,
  longitude         REAL,
  source_group      TEXT
);

CREATE TABLE IF NOT EXISTS fact_unit_response (
  unit_response_id  INTEGER PRIMARY KEY,
  incident_id       INTEGER NOT NULL REFERENCES fact_incident(incident_id),
  apparatus_id      INTEGER REFERENCES dim_apparatus(apparatus_id),
  department_id     INTEGER REFERENCES dim_department(department_id),
  dispatch_datetime TEXT,
  enroute_datetime  TEXT,
  onscene_datetime  TEXT,
  clear_datetime    TEXT,
  response_seconds  INTEGER,
  travel_seconds    INTEGER,
  UNIQUE (incident_id, apparatus_id, dispatch_datetime)   -- ADDED
);

-- ADDED: pipeline provenance / quarantine (no field values stored; PII-safe)
CREATE TABLE IF NOT EXISTS ingest_run (
  run_id        INTEGER PRIMARY KEY,
  run_ts        TEXT,
  source_folder TEXT,
  rows_read     INTEGER,
  rows_loaded   INTEGER,
  rows_rejected INTEGER
);

CREATE TABLE IF NOT EXISTS ingest_reject (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER REFERENCES ingest_run(run_id),
  table_name  TEXT,
  row_number  INTEGER,
  incident_no TEXT,
  rule        TEXT,
  severity    TEXT
);
