"""Validate CAD_Extractor CSVs row-wise, then load passing rows into the ERD-based SQLite DB.

Usage: python ingest_cad_export.py <structured_folder> [--db ccfd1.db] [--township NAME] [--dry-run]

Never prints field values (PII): output is counts and rule names only.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import validate_cad as v

HERE = Path(__file__).resolve().parent
DEFAULT_TOWNSHIP = "CCFD1"
MAX_REJECT_RATE = 0.05


def validate_file(path: Path, required: list[str], validator, key: str):
    """Return dict with header errors, valid rows, rejects [(row_no, incident_no, rule, sev)], warns."""
    res = {"file": path.name, "read": 0, "valid": [], "rejects": [], "warns": Counter(), "file_errors": []}
    if not path.exists():
        res["file_errors"].append("file_missing")
        return res
    header, rows = v.read_csv(path)
    res["file_errors"] = [r for r, _ in v.check_header(header, required)]
    if res["file_errors"]:
        return res
    res["read"] = len(rows)
    for row_no, row in rows:
        findings = validator(row)
        incident_no = (row.get("incident_id") or "").strip()
        errors = [r for r, s in findings if s == v.ERROR]
        for r, s in findings:
            if s == v.ERROR:
                res["rejects"].append((row_no, incident_no, r, s))
            else:
                res["warns"][r] += 1
        if not errors:
            res["valid"].append((row_no, row))
    return res


def get_or_create(conn, table, id_col, where: dict, extra: dict | None = None) -> int:
    cols, vals = list(where), list(where.values())
    cur = conn.execute(
        f"SELECT {id_col} FROM {table} WHERE " + " AND ".join(f"{c} IS ?" for c in cols), vals
    ).fetchone()
    if cur:
        return cur[0]
    data = {**where, **(extra or {})}
    cur = conn.execute(
        f"INSERT INTO {table} ({', '.join(data)}) VALUES ({', '.join('?' * len(data))})", list(data.values())
    )
    return cur.lastrowid


def to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def to_int(s):
    f = to_float(s)
    return int(f) if f is not None else None


def load(conn, inc, resp, township_name: str, run_id: int):
    township_id = get_or_create(conn, "dim_township", "township_id", {"township_name": township_name})

    for _, r in inc["valid"]:
        conn.execute(
            """INSERT INTO fact_incident (incident_no, township_id, case_number, event_type,
                   incident_datetime, event_location, latitude, longitude, source_group)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(incident_no) DO UPDATE SET
                   township_id=excluded.township_id, case_number=excluded.case_number,
                   event_type=excluded.event_type, incident_datetime=excluded.incident_datetime,
                   event_location=excluded.event_location, latitude=excluded.latitude,
                   longitude=excluded.longitude, source_group=excluded.source_group""",
            (r["incident_id"].strip(), township_id, r.get("case_number") or None,
             r.get("event_type") or None, r["create_datetime"].strip(), r.get("event_location") or None,
             to_float(r.get("latitude")), to_float(r.get("longitude")), r["source_group"].strip().upper()),
        )

    inc_ids = {no: i for no, i in conn.execute("SELECT incident_no, incident_id FROM fact_incident")}
    loaded = orphans = 0
    for row_no, r in resp["valid"]:
        incident_no = r["incident_id"].strip()
        if incident_no not in inc_ids:  # not in this batch nor already in the DB
            resp["rejects"].append((row_no, incident_no, "orphan_incident", v.ERROR))
            orphans += 1
            continue
        group = inc_group(conn, inc_ids[incident_no])
        dept_name = (r.get("unit_org") or "").strip() or group or "UNKNOWN"
        dept_id = get_or_create(conn, "dim_department", "department_id", {"department_name": dept_name},
                                {"department_type": group})
        app_id = get_or_create(conn, "dim_apparatus", "apparatus_id",
                               {"apparatus_name": r["unit_id"].strip(), "department_id": dept_id})
        conn.execute(
            """INSERT INTO fact_unit_response (incident_id, apparatus_id, department_id, dispatch_datetime,
                   enroute_datetime, onscene_datetime, clear_datetime, response_seconds, travel_seconds)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(incident_id, apparatus_id, dispatch_datetime) DO UPDATE SET
                   department_id=excluded.department_id, enroute_datetime=excluded.enroute_datetime,
                   onscene_datetime=excluded.onscene_datetime, clear_datetime=excluded.clear_datetime,
                   response_seconds=excluded.response_seconds, travel_seconds=excluded.travel_seconds""",
            (inc_ids[incident_no], app_id, dept_id,
             (r.get("dispatch_datetime") or "").strip() or None,
             (r.get("enroute_datetime") or "").strip() or None,
             (r.get("onscene_datetime") or "").strip() or None,
             (r.get("clear_datetime") or "").strip() or None,
             to_int(r.get("response_seconds")), to_int(r.get("travel_seconds"))),
        )
        loaded += 1
    return loaded, orphans


def inc_group(conn, incident_pk):
    row = conn.execute("SELECT source_group FROM fact_incident WHERE incident_id=?", (incident_pk,)).fetchone()
    return row[0] if row else None


def summarize(res, loaded):
    return {
        "file": res["file"], "rows_read": res["read"], "rows_loaded": loaded,
        "rows_rejected": len({r[0] for r in res["rejects"]}),
        "file_errors": res["file_errors"],
        "reject_rules": dict(Counter(r[2] for r in res["rejects"])),
        "warn_rules": dict(res["warns"]),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--db", type=Path, default=Path("ccfd1.db"))
    ap.add_argument("--township", default=DEFAULT_TOWNSHIP)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report-dir", type=Path, default=Path("reports"))
    args = ap.parse_args(argv)

    inc = validate_file(args.folder / "incidents.csv", v.INCIDENT_REQUIRED, v.validate_incident, "incident_id")
    resp = validate_file(args.folder / "unit_responses.csv", v.RESPONSE_REQUIRED, v.validate_response, "unit")

    inc_loaded = resp_loaded = 0
    if args.dry_run:
        # orphan check against this batch only (DB may not exist)
        batch_ids = {r["incident_id"].strip() for _, r in inc["valid"]}
        for row_no, r in resp["valid"]:
            if r["incident_id"].strip() not in batch_ids:
                resp["rejects"].append((row_no, r["incident_id"].strip(), "orphan_incident", v.ERROR))
        rejected_rows = {x[0] for x in resp["rejects"]}
        resp_loaded = len([1 for n, _ in resp["valid"] if n not in rejected_rows])
        inc_loaded = len(inc["valid"])
    elif not (inc["file_errors"] or resp["file_errors"]):
        conn = sqlite3.connect(args.db)
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript((HERE / "schema.sql").read_text())
        try:
            with conn:
                run_id = conn.execute(
                    "INSERT INTO ingest_run (run_ts, source_folder) VALUES (?,?)",
                    (datetime.now().isoformat(timespec="seconds"), args.folder.name),
                ).lastrowid
                resp_loaded_ref, _ = load(conn, inc, resp, args.township, run_id)
                inc_loaded, resp_loaded = len(inc["valid"]), resp_loaded_ref
                for name, res in (("fact_incident", inc), ("fact_unit_response", resp)):
                    conn.executemany(
                        "INSERT INTO ingest_reject (run_id, table_name, row_number, incident_no, rule, severity) "
                        "VALUES (?,?,?,?,?,?)", [(run_id, name, *x) for x in res["rejects"]])
                total_read = inc["read"] + resp["read"]
                total_rej = len({x[0] for x in inc["rejects"]}) + len({x[0] for x in resp["rejects"]})
                conn.execute("UPDATE ingest_run SET rows_read=?, rows_loaded=?, rows_rejected=? WHERE run_id=?",
                             (total_read, inc_loaded + resp_loaded, total_rej, run_id))
        finally:
            conn.close()

    summary = [summarize(inc, inc_loaded), summarize(resp, resp_loaded)]
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report = args.report_dir / f"ingest_{datetime.now():%Y%m%d_%H%M%S}.json"
    report.write_text(json.dumps({"folder": args.folder.name, "dry_run": args.dry_run, "files": summary}, indent=2))

    for s in summary:
        print(f"{s['file']}: read={s['rows_read']} loaded={s['rows_loaded']} rejected={s['rows_rejected']} "
              f"warn_rules={s['warn_rules']} reject_rules={s['reject_rules']} file_errors={s['file_errors']}")
    print(f"report: {report}")

    bad = any(s["file_errors"] for s in summary)
    for s in summary:
        if s["rows_read"] and s["rows_rejected"] / s["rows_read"] > MAX_REJECT_RATE:
            bad = True
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
