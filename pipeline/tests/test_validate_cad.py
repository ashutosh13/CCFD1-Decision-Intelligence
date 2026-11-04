"""Synthetic-data tests only; never point these at real (PII) blotter data."""
import csv
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ingest_cad_export as ing  # noqa: E402
import validate_cad as v  # noqa: E402

INC = dict(incident_id="2026-00000001", case_number="C1", event_type="FIRE ALARM",
           create_datetime="2026-04-02 13:05:00", incident_date="2026-04-02", year="2026", month="4",
           hour_of_day="13", event_location="X", latitude="40.75", longitude="-86.35", source_group="FIRE")
RESP = dict(incident_id="2026-00000001", unit_id="E1", unit_org="CCFD1",
            dispatch_datetime="2026-04-02 13:05:30", enroute_datetime="2026-04-02 13:06:00",
            onscene_datetime="2026-04-02 13:10:30", clear_datetime="2026-04-02 13:40:00",
            turnout_seconds="30", travel_seconds="270", response_seconds="300", qa_time_status="OK")


def rules(findings):
    return {r for r, _ in findings}


def test_valid_rows_clean():
    assert v.validate_incident(INC) == []
    assert v.validate_response(RESP) == []


def test_incident_errors():
    assert ("incident_id_format", v.ERROR) in v.validate_incident({**INC, "incident_id": "bad"})
    assert ("create_datetime_invalid", v.ERROR) in v.validate_incident({**INC, "create_datetime": "nope"})
    assert ("source_group_invalid", v.ERROR) in v.validate_incident({**INC, "source_group": "X"})


def test_incident_warnings():
    assert "hour_of_day_mismatch" in rules(v.validate_incident({**INC, "hour_of_day": "2"}))
    assert "latlon_out_of_bounds" in rules(v.validate_incident({**INC, "latitude": "10", "longitude": "10"}))
    assert "event_type_missing" in rules(v.validate_incident({**INC, "event_type": ""}))


def test_response_rules():
    assert ("unit_id_missing", v.ERROR) in v.validate_response({**RESP, "unit_id": ""})
    assert ("onscene_datetime_invalid", v.ERROR) in v.validate_response({**RESP, "onscene_datetime": "zz"})
    assert "time_order" in rules(v.validate_response({**RESP, "enroute_datetime": "2026-04-02 13:00:00"}))
    assert "response_seconds_mismatch" in rules(v.validate_response({**RESP, "response_seconds": "999"}))
    assert "travel_seconds_out_of_range" in rules(v.validate_response({**RESP, "travel_seconds": "-5"}))


def test_missing_header():
    assert ("missing_column:unit_id", v.ERROR) in v.check_header(["incident_id"], ["incident_id", "unit_id"])


def write(path, rows, bom=True):
    with open(path, "w", newline="", encoding="utf-8-sig" if bom else "utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


def test_end_to_end_idempotent(tmp_path):
    folder = tmp_path / "batch"
    folder.mkdir()
    write(folder / "incidents.csv", [INC, {**INC, "incident_id": "bad"}])
    write(folder / "unit_responses.csv",
          [RESP, {**RESP, "incident_id": "2026-00000099"}, {**RESP, "unit_id": "E2"}])
    args = [str(folder), "--db", str(tmp_path / "t.db"), "--report-dir", str(tmp_path / "r")]
    ing.main(args)
    ing.main(args)  # re-run: no duplicates
    c = sqlite3.connect(tmp_path / "t.db")
    assert c.execute("SELECT count(*) FROM fact_incident").fetchone()[0] == 1
    assert c.execute("SELECT count(*) FROM fact_unit_response").fetchone()[0] == 2
    assert c.execute("SELECT count(*) FROM dim_apparatus").fetchone()[0] == 2
    assert c.execute("PRAGMA foreign_key_check").fetchall() == []
    rej = {r[0] for r in c.execute("SELECT rule FROM ingest_reject")}
    assert {"incident_id_format", "orphan_incident"} <= rej


def test_schema_has_all_erd_tables(tmp_path):
    c = sqlite3.connect(tmp_path / "s.db")
    c.executescript((Path(__file__).resolve().parents[1] / "schema.sql").read_text())
    names = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"scenario", "scenario_assumptions", "scenario_township", "dim_township", "fact_financial_year",
            "fact_incident", "township_service", "fact_unit_response", "dim_apparatus", "dim_department",
            "dim_staff", "fact_staffing_year", "fact_compensation"} <= names
