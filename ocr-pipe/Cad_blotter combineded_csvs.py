"""
Combine all monthly Fire + EMS extraction CSVs (Sept 2025 - Sept 2026)
into ONE incident file and ONE unit-response file.

HOW TO USE
  1. Put every *_incidents.csv and *_unit_responses.csv in one folder.
  2. Edit INPUT_FOLDER and OUTPUT_FOLDER below (or pass them on the command line).
  3. Run:  python combine_csvs.py
           python combine_csvs.py "C:/CAD/extracted" "C:/CAD/combined"

OUTPUT
  all_incidents.csv        one row per unique incident (Fire/EMS duplicates merged)
  all_unit_responses.csv   one row per unique unit response
  combine_log.csv          what was read from each file and what was removed
"""
import glob, os, sys
import pandas as pd
INPUT_FOLDER  = r"C:\Users\amsus\OneDrive\Desktop\purdue\final\output"
OUTPUT_FOLDER = r"C:\Users\amsus\OneDrive\Desktop\purdue\final\combined"

START, END = "2025-09-01", "2026-09-30 23:59:59"   # evaluation window

def read(path):
    return pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")

def group_from_name(name):
    n = name.upper()
    return "FIRE" if "FIRE" in n else "EMS" if "EMS" in n else "UNKNOWN"

log, inc_parts, unit_parts = [], [], []

# ---------- read every file ----------
for path in sorted(glob.glob(os.path.join(INPUT_FOLDER, "*_incidents.csv"))):
    df = read(path)
    df["source_group"] = df.get("source_group", group_from_name(path)).replace("", group_from_name(path))
    df["source_csv"] = os.path.basename(path)
    inc_parts.append(df)
    log.append({"file": os.path.basename(path), "table": "incidents", "rows_read": len(df)})

for path in sorted(glob.glob(os.path.join(INPUT_FOLDER, "*_unit_responses.csv"))):
    df = read(path)
    df["source_group"] = group_from_name(path)
    df["source_csv"] = os.path.basename(path)
    unit_parts.append(df)
    log.append({"file": os.path.basename(path), "table": "unit_responses", "rows_read": len(df)})

if not inc_parts or not unit_parts:
    sys.exit(f"No *_incidents.csv or *_unit_responses.csv found in {INPUT_FOLDER}")

inc = pd.concat(inc_parts, ignore_index=True)    # columns are aligned by name
un = pd.concat(unit_parts, ignore_index=True)
raw_inc, raw_un = len(inc), len(un)

# ---------- keep only the evaluation window ----------
ct = pd.to_datetime(inc.create_datetime, errors="coerce")
outside = ~ct.between(START, END)
inc = inc[~outside]

# ---------- incidents: merge Fire/EMS copies of the same incident ----------
groups = inc.groupby("incident_id").source_group.apply(lambda s: ";".join(sorted(set(s))))
inc["_has_xy"] = inc.latitude.ne("")
inc = (inc.sort_values(["incident_id", "_has_xy"], ascending=[True, False])  # keep copy with coordinates
          .drop_duplicates("incident_id")
          .drop(columns="_has_xy"))
inc["source_groups"] = inc.incident_id.map(groups)        # e.g. "EMS;FIRE"
inc = inc.drop(columns=["source_group"])

# ---------- unit responses: drop the same response seen in both blotters ----------
un = un[un.incident_id.isin(inc.incident_id)]              # same window as incidents
key = ["incident_id", "unit_id", "unit_org", "dispatch_datetime"]
seen_in = un.groupby(key).source_group.apply(lambda s: ";".join(sorted(set(s))))
un = un.drop_duplicates(key).copy()
un["source_groups"] = [seen_in[tuple(r)] for r in un[key].itertuples(index=False)]
un = un.drop(columns=["source_group"])

# ---------- sanity checks ----------
problems = []
if inc.incident_id.duplicated().any():        problems.append("duplicate incident_id after merge")
orphans = ~un.incident_id.isin(inc.incident_id)
if orphans.any():                             problems.append(f"{orphans.sum()} unit rows without an incident")
no_units = ~inc.incident_id.isin(un.incident_id)
if no_units.any():                            problems.append(f"{no_units.sum()} incidents without unit rows")

# ---------- write ----------
os.makedirs(OUTPUT_FOLDER, exist_ok=True)
inc.sort_values("create_datetime").to_csv(os.path.join(OUTPUT_FOLDER, "all_incidents.csv"), index=False)
un.sort_values(["incident_id", "dispatch_datetime"]).to_csv(os.path.join(OUTPUT_FOLDER, "all_unit_responses.csv"), index=False)
log += [
    {"file": "ALL", "table": "incidents", "rows_read": raw_inc,
     "outside_window_removed": int(outside.sum()), "fire_ems_duplicates_merged": raw_inc - int(outside.sum()) - len(inc),
     "rows_written": len(inc)},
    {"file": "ALL", "table": "unit_responses", "rows_read": raw_un,
     "duplicates_removed": raw_un - len(un), "rows_written": len(un)},
    {"file": "CHECKS", "table": "", "problems": "; ".join(problems) or "none"},
]
pd.DataFrame(log).to_csv(os.path.join(OUTPUT_FOLDER, "combine_log.csv"), index=False)

months = pd.to_datetime(inc.create_datetime).dt.to_period("M").value_counts().sort_index()
print(f"Incidents: {raw_inc} read -> {len(inc)} unique   |   Unit responses: {raw_un} read -> {len(un)} unique")
print("Incidents per month:\n" + months.to_string())
print("Checks:", "; ".join(problems) or "none")
