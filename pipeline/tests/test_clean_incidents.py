"""Leak and correctness tests for the sanitized record-level table. All data here is synthetic."""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import clean_incidents as ci  # noqa: E402
import datasets_lib as dl  # noqa: E402

PII_NOTE = "555-867-5309 jane@example.com 12 Main Street"


def make_db():
    c = sqlite3.connect(":memory:")
    c.executescript("""
    CREATE TABLE fact_incident (incident_id INTEGER PRIMARY KEY, incident_no TEXT, case_number TEXT, event_type TEXT,
      incident_datetime TEXT, event_location TEXT, latitude REAL, longitude REAL, source_group TEXT);
    CREATE TABLE fact_unit_response (unit_response_id INTEGER PRIMARY KEY, incident_id INTEGER,
      dispatch_datetime TEXT, clear_datetime TEXT);
    """)
    inc = [
        (1, "2026-00000001", "C-1", "MEDICAL EMERGENCY", "2026-01-05 14:10:00", "12 Main Street", 40.75, -86.35, "EMS"),
        (2, "2026-00000002", "C-2", "STRUCTURE FIRE", "2026-01-06 23:50:00", "99 Oak Avenue", 40.76, -86.36, "Fire"),
        (3, "2026-00000003", "C-3", "ALARM ACTIVATION", "2026-01-07 03:00:00", "7 Elm Road", 40.77, -86.37, "Fire"),
        (4, "2026-00000004", "C-4", "WEIRD THING", "2026-01-08 zz", "x", 0, 0, "Fire"),
    ]
    c.executemany("INSERT INTO fact_incident VALUES (?,?,?,?,?,?,?,?,?)", inc)
    c.executemany("INSERT INTO fact_unit_response (incident_id, dispatch_datetime, clear_datetime) VALUES (?,?,?)", [
        (1, "2026-01-05 14:12:00", "2026-01-05 14:52:00"),   # 40 min
        (1, "2026-01-05 14:15:00", "2026-01-05 15:02:00"),   # latest clear -> 50 min overall
        (2, "2026-01-06 23:55:00", "2026-01-06 00:35:00"),   # midnight rollover: 40 min
        (3, "2026-01-07 03:05:00", "2026-01-07 02:00:00"),   # reversed, different handling: excluded
    ])
    return c


def built(locator=ci.unknown_locator):
    return ci.build(make_db(), "2026-01-01", "2026-02-01", locator)


def test_only_declared_columns_and_validates():
    ds, stats = built()
    assert dl.validate(ds) == []
    allowed = {c["name"] for c in ds["dimensions"] + ds["measures"]}
    assert all(set(r) == allowed for r in ds["rows"])
    assert stats == {"incidents": 3, "skipped_no_timestamp": 1, "no_duration": 1}


def test_no_pii_columns_or_values():
    ds, _ = built()
    assert dl.scan_pii(ds) == []
    blob = repr(ds)
    for secret in ("2026-0000", "C-1", "Main Street", "Oak Avenue", "40.75", "-86.35", "MEDICAL EMERGENCY"):
        assert secret not in blob, "leaked a source value"


def test_scanner_catches_pii():
    ds, _ = built()
    bad = {**ds, "rows": [{**ds["rows"][0], "township": PII_NOTE}], "dimensions": ds["dimensions"] + [{"name": "caller_name", "type": "string"}]}
    probs = dl.scan_pii(bad)
    assert any("caller_name" in p for p in probs) and any("matches a PII pattern" in p for p in probs)


def test_derived_fields():
    ds, _ = built()
    r1, r2, r3 = ds["rows"]
    assert (r1["hour"], r1["weekday"], r1["month"], r1["source_group"], r1["call_category"]) == (14, "Mon", 1, "EMS", "Medical")
    assert r1["duration_min"] == 50.0
    assert r2["duration_min"] == 40.0            # rollover handled
    assert r3["duration_min"] is None            # reversed on a different pattern -> excluded
    assert r3["call_category"] == "Alarm"


def test_unmapped_category_is_other_and_durations_capped():
    assert ci.categorize("zzz") == "Other"
    assert ci.incident_duration_min([("2026-01-01 00:00:00", "2026-01-01 23:00:00")]) is None


def test_in_district_uses_true_coordinates_before_anything_is_dropped():
    seen = []

    def locator(lat, lon):
        seen.append((lat, lon))
        return ("outside", "Jefferson") if lat > 40.755 else ("inside", "Washington")
    ds, _ = built(locator)
    assert (40.75, -86.35) in seen                # true, unrounded coordinates reached the locator
    assert [r["in_district"] for r in ds["rows"]] == ["inside", "outside", "outside"]
    assert all("latitude" not in r and "longitude" not in r for r in ds["rows"])


def test_public_schema_has_no_rows():
    ds, _ = built()
    pub = ci.public_schema(ds)
    assert pub["rows"] == [] and pub["remote"] is True and dl.validate(pub) == []
    assert dl.validate({**pub, "rows": ds["rows"]}), "a remote dataset must not carry rows"
