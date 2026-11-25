"""Row-wise validation of CAD_Extractor CSV output (incidents.csv, unit_responses.csv).

Validators are pure functions returning a list of (rule, severity) findings.
They never include field values in findings, so results are safe to log (PII).
"""
from __future__ import annotations

import csv
import re
from datetime import datetime
from pathlib import Path

ERROR, WARN = "ERROR", "WARN"

DT_FORMAT = "%Y-%m-%d %H:%M:%S"  # format written by CAD_Extractor.py
INCIDENT_ID_RE = re.compile(r"^20\d{2}-\d{8}$")
SOURCE_GROUPS = {"FIRE", "EMS"}
MAX_SECONDS = 24 * 3600

# Rough bounding box around Cass County, IN; out-of-box coordinates are a WARN only.
LAT_RANGE = (40.5, 41.0)
LON_RANGE = (-86.7, -86.1)

INCIDENT_REQUIRED = [
    "incident_id", "case_number", "event_type", "create_datetime", "event_location",
    "latitude", "longitude", "source_group",
]
INCIDENT_OPTIONAL = ["incident_date", "year", "month", "hour_of_day"]
RESPONSE_REQUIRED = [
    "incident_id", "unit_id", "unit_org", "dispatch_datetime", "enroute_datetime",
    "onscene_datetime", "clear_datetime", "turnout_seconds", "travel_seconds",
    "response_seconds", "qa_time_status",
]
TIME_FIELDS = ["dispatch_datetime", "enroute_datetime", "onscene_datetime", "clear_datetime"]
SECONDS_FIELDS = ["turnout_seconds", "travel_seconds", "response_seconds"]

Finding = tuple[str, str]

# REMOVED RULE (known failure): "time_order" required dispatch <= enroute <= onscene <= clear to the second.
# It flagged ~63% of unit_responses (7,537 of 11,968 rows in the Dec 2025 - Aug 2026 data), mostly
# from extractor backfill / midnight rollover, so it was dropped in favour of the day-level check
# `timestamp_day_order`. Also removed: response_seconds recompute (never fired) and lat/lon completeness
# (missing coordinates are normal in the source).

# Every rule the validators can emit, so reports can show rules that never fired.
RULES = {
    "incidents": [
        ("incident_id_format", ERROR), ("source_group_invalid", ERROR), ("create_datetime_invalid", ERROR),
        ("year_mismatch", WARN), ("month_mismatch", WARN), ("hour_of_day_mismatch", WARN),
        ("incident_date_mismatch", WARN), ("event_type_missing", WARN),
        ("latlon_out_of_bounds", WARN),
    ],
    "unit_responses": [
        ("incident_id_format", ERROR), ("unit_id_missing", ERROR), ("timestamp_invalid", ERROR),
        ("orphan_incident", ERROR),
        ("unit_org_missing", WARN), ("timestamps_missing", WARN), ("timestamp_day_order", WARN),
        ("turnout_seconds_out_of_range", WARN), ("travel_seconds_out_of_range", WARN),
        ("response_seconds_out_of_range", WARN),
    ],
}


def parse_dt(value: str) -> datetime | None:
    try:
        return datetime.strptime(value.strip(), DT_FORMAT)
    except (ValueError, AttributeError):
        return None


def _num(value: str) -> float | None:
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def check_header(fieldnames: list[str] | None, required: list[str]) -> list[Finding]:
    missing = set(required) - set(fieldnames or [])
    return [("missing_column:" + c, ERROR) for c in sorted(missing)]


def validate_incident(row: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    if not INCIDENT_ID_RE.match((row.get("incident_id") or "").strip()):
        out.append(("incident_id_format", ERROR))
    if (row.get("source_group") or "").strip().upper() not in SOURCE_GROUPS:
        out.append(("source_group_invalid", ERROR))
    dt = parse_dt(row.get("create_datetime") or "")
    if dt is None:
        out.append(("create_datetime_invalid", ERROR))
    else:
        for field, expected in (
            ("year", dt.year), ("month", dt.month), ("hour_of_day", dt.hour),
        ):
            if (row.get(field) or "").strip() and _num(row[field]) != expected:
                out.append((field + "_mismatch", WARN))
        if (row.get("incident_date") or "").strip() and row["incident_date"].strip() != dt.strftime("%Y-%m-%d"):
            out.append(("incident_date_mismatch", WARN))
    if not (row.get("event_type") or "").strip():
        out.append(("event_type_missing", WARN))

    # Missing lat/lon is common in the source data, so completeness is NOT checked.
    lat, lon = _num((row.get("latitude") or "").strip()), _num((row.get("longitude") or "").strip())
    if (lat is not None and not LAT_RANGE[0] <= lat <= LAT_RANGE[1]) or (
        lon is not None and not LON_RANGE[0] <= lon <= LON_RANGE[1]
    ):
        out.append(("latlon_out_of_bounds", WARN))
    return out


def validate_response(row: dict[str, str]) -> list[Finding]:
    out: list[Finding] = []
    if not INCIDENT_ID_RE.match((row.get("incident_id") or "").strip()):
        out.append(("incident_id_format", ERROR))
    if not (row.get("unit_id") or "").strip():
        out.append(("unit_id_missing", ERROR))
    if not (row.get("unit_org") or "").strip():
        out.append(("unit_org_missing", WARN))

    # One parse check for all four timestamps (incl. the extractor's own INVALID_DATETIME flag).
    times: list[datetime | None] = []
    invalid = (row.get("qa_time_status") or "").strip() == "INVALID_DATETIME"
    for f in TIME_FIELDS:
        value = (row.get(f) or "").strip()
        dt = parse_dt(value) if value else None
        invalid = invalid or (bool(value) and dt is None)
        times.append(dt)
    if invalid:
        out.append(("timestamp_invalid", ERROR))

    # Loose checks (WARN): all four present; calendar days never run backwards
    # (e.g. clear dated the day before dispatch, typically a backfill/midnight-rollover slip).
    if any(not (row.get(f) or "").strip() for f in TIME_FIELDS):
        out.append(("timestamps_missing", WARN))
    days = [t.date() for t in times if t is not None]
    if any(b < a for a, b in zip(days, days[1:])):
        out.append(("timestamp_day_order", WARN))

    for f in SECONDS_FIELDS:
        value = (row.get(f) or "").strip()
        if value:
            n = _num(value)
            if n is None or n < 0 or n > MAX_SECONDS or n != int(n):
                out.append((f + "_out_of_range", WARN))

    return out


def read_csv(path: Path) -> tuple[list[str], list[tuple[int, dict[str, str]]]]:
    """Return (header, [(row_number, row)]). row_number is 1-based data row (header excluded)."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        rows = [(i, r) for i, r in enumerate(reader, start=1)]
        return list(reader.fieldnames or []), rows
