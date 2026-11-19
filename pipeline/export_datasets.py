"""Export aggregate-only CAD datasets from ccfd1.db to datasets.candidate/.

Usage: python export_datasets.py [--db ccfd1.db] [--out ../datasets.candidate]
                                 [--start 2025-09-16] [--end 2026-09-16] [--agency DIST]

Writes cad_incidents_by_hour (24 hourly counts of distinct incidents) and prints counts only. It reads
fact_incident but never writes incident-level fields. Status is "verified" only when the period matches
the page's CAD period; review the candidate against the page before merging (see CLAUDE.md).

Today the loader stamps one township label per folder, so there is no by-township dataset yet.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import datasets_lib as dl

HERE = Path(__file__).resolve().parent


def hourly_counts(conn: sqlite3.Connection, start: str, end: str) -> list[int]:
    """Distinct incident_no per hour of incident_datetime ('YYYY-MM-DD HH:MM:SS'), start inclusive, end exclusive."""
    counts = [0] * 24
    q = ("SELECT CAST(substr(incident_datetime, 12, 2) AS INTEGER) AS h, COUNT(DISTINCT incident_no) "
         "FROM fact_incident WHERE substr(incident_datetime, 1, 10) >= ? AND substr(incident_datetime, 1, 10) < ? "
         "GROUP BY h")
    for h, n in conn.execute(q, (start, end)):
        if h is not None and 0 <= h <= 23:
            counts[h] = n
    return counts


def build_hourly(counts: list[int], start: str, end: str) -> dict:
    return {
        "id": "cad_incidents_by_hour", "title": "Incidents by hour of day", "panel": "cad", "grain": "hour",
        "period": f"{start} to {end}", "status": "verified",
        "source": "CCFD1 CAD extract",
        "source_detail": "Distinct incidents by hour of incident creation, Fire and EMS combined, de-duplicated",
        "note": "Hour of incident creation. Aggregated counts only.",
        "dimensions": [{"name": "hour", "type": "int"}],
        "measures": [{"name": "incidents", "unit": "count"}],
        "rows": [{"hour": h, "incidents": n} for h, n in enumerate(counts)],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=Path("ccfd1.db"))
    ap.add_argument("--out", type=Path, default=dl.DEFAULT_DIR)
    ap.add_argument("--start", default="2025-09-16")
    ap.add_argument("--end", default="2026-09-16")
    args = ap.parse_args(argv)
    if not args.db.exists():
        print(f"database not found: {args.db}")
        return 1
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        counts = hourly_counts(conn, args.start, args.end)
    finally:
        conn.close()
    path = dl.write_dataset(build_hourly(counts, args.start, args.end), args.out)
    dl.write_manifest(args.out)
    print(f"wrote {path.name}: 24 hourly rows, {sum(counts)} incidents in period")
    return 0


if __name__ == "__main__":
    sys.exit(main())
