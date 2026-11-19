"""Synthetic-data tests only; never point these at real (PII) data."""
import csv
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_finance_dataset as bf  # noqa: E402
import datasets_lib as dl  # noqa: E402
import export_datasets as ex  # noqa: E402

SCHEMA = (Path(__file__).resolve().parents[1] / "schema.sql").read_text()


def test_hourly_export_counts_distinct_incidents_in_period(tmp_path):
    db = tmp_path / "t.db"
    conn = sqlite3.connect(db)
    conn.executescript(SCHEMA)
    rows = [("2026-00000001", "2025-10-01 03:10:00"), ("2026-00000002", "2025-10-01 03:50:00"),
            ("2026-00000003", "2025-10-02 23:00:00"), ("2026-00000004", "2025-09-15 03:00:00"),  # before period
            ("2026-00000005", "2026-09-16 03:00:00")]                                           # end is exclusive
    conn.executemany("INSERT INTO fact_incident (incident_no, incident_datetime, source_group) VALUES (?,?,'FIRE')", rows)
    conn.commit()
    counts = ex.hourly_counts(conn, "2025-09-16", "2026-09-16")
    assert counts[3] == 2 and counts[23] == 1 and sum(counts) == 3
    assert ex.main(["--db", str(db), "--out", str(tmp_path / "out")]) == 0
    data = json.loads((tmp_path / "out" / "cad_incidents_by_hour.json").read_text())
    assert len(data["rows"]) == 24 and set(data["rows"][0]) == {"hour", "incidents"}
    assert (tmp_path / "out" / "index.json").exists()


def test_finance_builder_writes_valid_datasets(tmp_path):
    y = tmp_path / "y.csv"
    with y.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(bf.YEAR_COLS)
        w.writerow([2023, "1,238,278", 1806802, 1932643, 704746, 60898])
        w.writerow([2024, 1279649, 1524669, 1687623, 800075, 65481])
    s = tmp_path / "s.csv"
    s.write_text("source,amount\nProperty tax,882965\nLocal income tax,212041\n")
    out = tmp_path / "out"
    assert bf.main([str(y), "--sources", str(s), "--source-year", "2024", "--out", str(out)]) == 0
    fin = json.loads((out / "finance_by_year.json").read_text())
    assert fin["rows"][0] == {"year": 2023, "revenue": 1238278, "spending": 1806802, "balance": 1932643}
    assert fin["period"] == "2023-2024"
    assert (out / "revenue_by_source_2024.json").exists()


def test_missing_csv_column_is_reported(tmp_path):
    y = tmp_path / "y.csv"
    y.write_text("year,operating_revenue\n2024,1\n")
    with pytest.raises(ValueError, match="missing columns"):
        bf.read_rows(y, bf.YEAR_COLS)


def test_validate_rejects_record_level_fields_and_bad_status():
    ds = ex.build_hourly([0] * 24, "2025-09-16", "2026-09-16")
    assert dl.validate(ds) == []
    ds["rows"][0]["address"] = "x"
    assert any("unexpected field" in e for e in dl.validate(ds))
    ds = ex.build_hourly([0] * 24, "a", "b")
    ds["status"] = "great"
    assert dl.validate(ds)
    with pytest.raises(ValueError):
        dl.write_dataset(ds, Path("unused"))
