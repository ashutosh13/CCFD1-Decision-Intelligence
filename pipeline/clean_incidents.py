"""Build the sanitized, record-level CAD table (cad_incidents_clean) from ccfd1.db.

Tier A (this script, offline): reads fact_incident and fact_unit_response, derives coarse fields and DROPS every
identifying column. Tier B (the output): one row per incident with only the declared columns. It is never published
as a static file: the private rows go to datasets.private/ (git-ignored) and are uploaded to the Worker's KV, which
answers aggregate-only queries. The public datasets/cad_incidents_clean.json is a schema with no rows.

Dropped: incident_no, case_number, event_type free text, event_location, lat/long, any timestamp finer than the
hour. Kept: hour, weekday, month, source_group, call_category (controlled vocabulary), in_district, township,
duration_min. in_district/township come from the TRUE coordinates via `locator`; until the township-boundary join
exists they are "unknown" (CLAUDE.md blocker 1). Coordinates are never written, so there is nothing to jitter.

Usage: python clean_incidents.py [--db ccfd1.db] [--public ../datasets.candidate] [--private ../datasets.private]
Prints counts and rule names only, never field values.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

import datasets_lib as dl

MAX_DURATION_MIN = 480            # longer than 8 h is treated as a timestamp error
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
CATEGORIES = [                    # first match wins; anything unmapped becomes "Other"
    ("Medical", r"medic|ems|sick|chest|breath|cardiac|arrest|overdose|seizure|stroke|unconscious|diabet|fall|injur|assault|psych|abdom|bleed"),
    ("Vehicle crash", r"accident|crash|mvc|collision|extric|vehicle (acc|inj)"),
    ("Fire", r"fire|smoke|burn|explos|flame|brush|grass"),
    ("Alarm", r"alarm"),
    ("Hazard", r"hazmat|gas|odor|carbon|wire|electri|spill|leak"),
    ("Service", r"assist|lift|public service|standby|welfare|invest"),
]
InDistrict = Callable[[float | None, float | None], tuple[str, str]]


def unknown_locator(lat, lon):
    return "unknown", "unknown"


def categorize(event_type: str | None) -> str:
    t = event_type or ""
    for name, rx in CATEGORIES:
        if re.search(rx, t, re.I):
            return name
    return "Other"


def group_of(source_group: str | None) -> str:
    g = (source_group or "").strip().lower()
    return "Fire" if g.startswith("fire") else "EMS" if g in ("ems", "medical") or g.startswith("ems") else "Other"


def parse(ts: str | None):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.strip().replace("T", " ")[:19])
    except ValueError:
        return None


def incident_duration_min(units: list[tuple[str | None, str | None]]) -> float | None:
    """Earliest dispatch to latest clear across units. A clear earlier than its dispatch on the same date is read as
    a midnight rollover (+1 day); any other reversal, a missing stamp or an implausible length gives None."""
    starts, ends = [], []
    for disp, clear in units:
        d, c = parse(disp), parse(clear)
        if d is None or c is None:
            continue
        if c < d:
            if c.date() == d.date():
                c += timedelta(days=1)
            else:
                continue
        starts.append(d)
        ends.append(c)
    if not starts:
        return None
    mins = (max(ends) - min(starts)).total_seconds() / 60
    return round(mins, 1) if 0 <= mins <= MAX_DURATION_MIN else None


def clean_row(inc: dict, units, locator: InDistrict = unknown_locator) -> dict | None:
    """One sanitized row, or None if the incident has no usable timestamp. `inc` holds only the columns read from the DB."""
    t = parse(inc.get("incident_datetime"))
    if t is None:
        return None
    in_district, township = locator(inc.get("latitude"), inc.get("longitude"))  # TRUE coordinates, used here only
    return {"hour": t.hour, "weekday": WEEKDAYS[t.weekday()], "month": t.month, "source_group": group_of(inc.get("source_group")),
            "call_category": categorize(inc.get("event_type")), "in_district": in_district, "township": township,
            "incidents": 1, "duration_min": incident_duration_min(units)}


DIMENSIONS = [{"name": "hour", "type": "int"}, {"name": "weekday", "type": "string"}, {"name": "month", "type": "int"},
              {"name": "source_group", "type": "string"}, {"name": "call_category", "type": "string"},
              {"name": "in_district", "type": "string"}, {"name": "township", "type": "string"}]
MEASURES = [{"name": "incidents", "unit": "count"}, {"name": "duration_min", "unit": "minutes"}]


def build(conn: sqlite3.Connection, start: str, end: str, locator: InDistrict = unknown_locator) -> tuple[dict, dict]:
    """Returns (private dataset with rows, stats). Stats are counts only."""
    units: dict[int, list] = {}
    for iid, disp, clear in conn.execute("SELECT incident_id, dispatch_datetime, clear_datetime FROM fact_unit_response"):
        units.setdefault(iid, []).append((disp, clear))
    q = ("SELECT incident_id, incident_datetime, source_group, event_type, latitude, longitude FROM fact_incident "
         "WHERE substr(incident_datetime,1,10) >= ? AND substr(incident_datetime,1,10) < ?")
    rows, skipped, no_duration = [], 0, 0
    for iid, dt, sg, et, lat, lon in conn.execute(q, (start, end)):
        r = clean_row({"incident_datetime": dt, "source_group": sg, "event_type": et, "latitude": lat, "longitude": lon},
                      units.get(iid, []), locator)
        if r is None:
            skipped += 1
            continue
        no_duration += r["duration_min"] is None
        rows.append(r)
    ds = {
        "id": "cad_incidents_clean", "title": "Incidents, sanitized (one row per incident)", "panel": "cad", "grain": "incident",
        "period": f"{start} to {end}", "status": "model_output", "record_level": True,
        "source": "CCFD1 CAD extract, sanitized",
        "source_detail": "One row per incident with identifying fields removed. Hour, weekday and month come from incident creation. "
                         "duration_min runs from the earliest unit dispatch to the latest unit clear.",
        "note": f"{no_duration} of {len(rows)} incidents have no usable duration (missing, out-of-order or over "
                f"{MAX_DURATION_MIN} min timestamps) and are excluded from duration averages. in_district and township are "
                "'unknown' until the township-boundary join exists. Not a dispatch-to-arrival response time.",
        "dimensions": DIMENSIONS, "measures": MEASURES, "rows": rows,
    }
    return ds, {"incidents": len(rows), "skipped_no_timestamp": skipped, "no_duration": no_duration}


def public_schema(ds: dict) -> dict:
    """The static, row-free copy that goes in datasets/: the agent can see the columns but not the data."""
    pub = {k: v for k, v in ds.items() if k != "rows"}
    return {**pub, "remote": True, "rows": []}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    ap.add_argument("--db", type=Path, default=Path("ccfd1.db"))
    ap.add_argument("--public", type=Path, default=dl.DEFAULT_DIR)
    ap.add_argument("--private", type=Path, default=root / "datasets.private")
    ap.add_argument("--start")
    ap.add_argument("--end")
    args = ap.parse_args(argv)
    if not args.db.exists():
        print(f"database not found: {args.db}")
        return 1
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        lo, hi = conn.execute("SELECT MIN(substr(incident_datetime,1,10)), MAX(substr(incident_datetime,1,10)) FROM fact_incident").fetchone()
        if not lo:
            print("database has no incidents")
            return 1
        start = args.start or lo
        end = args.end or (datetime.fromisoformat(hi) + timedelta(days=1)).date().isoformat()
        ds, stats = build(conn, start, end)
    finally:
        conn.close()
    problems = dl.validate(ds) + dl.scan_pii(ds)
    if problems:
        print(f"refusing to write: {len(problems)} problems, first: {problems[0]}")
        return 1
    args.private.mkdir(parents=True, exist_ok=True)
    (args.private / f"{ds['id']}.json").write_text(json.dumps(ds, ensure_ascii=False) + "\n", encoding="utf-8")
    path = dl.write_dataset(public_schema(ds), args.public)
    dl.write_manifest(args.public)
    print(f"wrote private rows ({stats['incidents']} incidents, {stats['no_duration']} without duration, "
          f"{stats['skipped_no_timestamp']} skipped) and public schema {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
