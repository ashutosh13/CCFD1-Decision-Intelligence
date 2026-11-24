"""
Build the detailed CAD dataset for the CAD & GIS analysis page (gis-map/).

Reads the combined CAD extract (all_incidents.csv + all_unit_responses.csv, written by
ocr-pipe/"Cad_blotter combineded_csvs.py") and writes ONE local file:

    data/cad-gis-detail.json      (git-ignored by the data/* rule: contains incident-level records)

What it does, once, so the browser never repeats it:
  * keeps every source value as-is (incident ID, coordinates, event type, unit, agency, raw
    timestamps, the CAD backfill flags, extractor QA status and time anomalies);
  * assigns each located incident to a township by point-in-polygon against the township
    boundaries in shared/cad-gis.js (the same boundaries the dashboard map draws).
    Source coordinates are not modified.

What it leaves out (not needed for the analysis): event_location (street address),
case_number, source file names and page numbers.

Run:
    python pipeline/build_gis_detail.py                       # default source folder below
    python pipeline/build_gis_detail.py "C:/path/to/combined"
"""
import csv, json, os, re, sys
from collections import Counter
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = r"C:\Users\amsus\OneDrive\Desktop\purdue\final\combined"   # combine script's OUTPUT_FOLDER
OUT = os.path.join(ROOT, "data", "cad-gis-detail.json")
GIS_JS = os.path.join(ROOT, "shared", "cad-gis.js")


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def load_townships():
    src = open(GIS_JS, encoding="utf-8").read()
    m = re.search(r"const townships = (\{.*?\});\n", src, re.S)
    if not m:
        sys.exit("Could not find the township boundaries in shared/cad-gis.js")
    return json.loads(m.group(1))["features"]


def in_ring(x, y, ring):
    c = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]; xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            c = not c
        j = i
    return c


def township_at(features, lat, lng):
    for f in features:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for rings in polys:
            if in_ring(lng, lat, rings[0]) and not any(in_ring(lng, lat, h) for h in rings[1:]):
                return f["properties"]["name"]
    return None


def num(v, cast=float):
    v = (v or "").strip()
    if v == "":
        return None
    try:
        return cast(v)
    except ValueError:
        return None


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    inc_path, un_path = os.path.join(src, "all_incidents.csv"), os.path.join(src, "all_unit_responses.csv")
    for p in (inc_path, un_path):
        if not os.path.exists(p):
            sys.exit(f"Missing {p}. Run the combine step first, or pass the folder that holds it.")
    features = load_townships()
    inc_rows, un_rows = read_csv(inc_path), read_csv(un_path)

    inc_cols = ["id", "datetime", "date", "hour", "dow", "type", "disposition", "lat", "lng",
                "coord_status", "cad_station", "source_groups", "township"]
    incidents, ids, twp_counts = [], set(), Counter()
    for r in inc_rows:
        valid = r["coordinate_valid"] == "True"
        lat, lng = (num(r["latitude"]), num(r["longitude"])) if valid else (None, None)
        twp = township_at(features, lat, lng) if lat is not None and lng is not None else None
        twp_counts[twp or ("(outside boundaries)" if lat is not None else "(no location)")] += 1
        incidents.append([r["incident_id"], r["create_datetime"], r["incident_date"], num(r["hour_of_day"], int),
                          r["day_of_week"], r["event_type"], r["disposition"], lat, lng,
                          r["coordinate_status"], r["station"], r["source_groups"], twp])
        ids.add(r["incident_id"])

    un_cols = ["incident_id", "unit", "org", "record_type", "temp_assigned",
               "dispatch", "enroute", "onscene", "clear", "backfilled",
               "turnout_s", "travel_s", "response_s", "commitment_min", "anomalies", "qa_status"]
    units, orphans = [], 0
    for r in un_rows:
        if r["incident_id"] not in ids:
            orphans += 1
        bf = "".join(k for k, c in (("D", "dispatch"), ("E", "enroute"), ("O", "onscene"), ("C", "clear"))
                     if r[f"{c}_backfilled"] == "True")
        units.append([r["incident_id"], r["unit_id"], r["unit_org"], r["record_type"], r["temp_assigned"] == "True",
                      r["dispatch_datetime"], r["enroute_datetime"], r["onscene_datetime"], r["clear_datetime"], bf,
                      num(r["turnout_seconds"], int), num(r["travel_seconds"], int), num(r["response_seconds"], int),
                      num(r["commitment_minutes"]), r["time_anomalies"], r["qa_status"]])

    dts = sorted(r[1] for r in incidents if r[1])
    out = {
        "meta": {
            "schema": 1,
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "Combined CAD extract (Fire + EMS, de-duplicated): all_incidents.csv, all_unit_responses.csv",
            "period": [dts[0], dts[-1]] if dts else None,
            "counts": {"incidents": len(incidents), "unit_rows": len(units), "orphan_unit_rows": orphans},
            "township_method": "Point-in-polygon of the source latitude/longitude against shared/cad-gis.js "
                               "township boundaries (simplified). Done once at build time.",
            "excluded_columns": ["event_location", "case_number", "source_file", "page_number", "source_csv"],
        },
        "incidents": {"columns": inc_cols, "rows": incidents},
        "units": {"columns": un_cols, "rows": units},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"Wrote {OUT}  ({os.path.getsize(OUT) / 1e6:.1f} MB)")
    print(f"Incidents {len(incidents)}  unit rows {len(units)}  orphan unit rows {orphans}")
    print("Township assignment:", dict(twp_counts.most_common()))


if __name__ == "__main__":
    main()
