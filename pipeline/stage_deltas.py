"""Aggregate stage-to-stage time deltas from unit_responses.csv files. Emits counts/aggregates only (no row values).

Timestamps are truncated to the minute first, so same-minute pairs count as normal (delta 0).
A pair is "normal" when both timestamps are present and the later one is not before the earlier.
The full sequence is "normal" when all four are present and dispatch <= enroute <= onscene <= clear.
Usage: python stage_deltas.py <structured_root> <out.json>
"""
import json
import statistics
import sys
from pathlib import Path

import validate_cad as v

STAGES = [  # name, start field, end field
    ("Turnout (dispatch → enroute)", "dispatch_datetime", "enroute_datetime"),
    ("Travel (enroute → on scene)", "enroute_datetime", "onscene_datetime"),
    ("On scene (on scene → clear)", "onscene_datetime", "clear_datetime"),
    ("Response (dispatch → on scene)", "dispatch_datetime", "onscene_datetime"),
    ("Overall (dispatch → clear)", "dispatch_datetime", "clear_datetime"),
]
BINS = [(0, 1, "0"), (1, 2, "1"), (2, 3, "2"), (3, 5, "3–4"), (5, 10, "5–9"), (10, 20, "10–19"),
        (20, 30, "20–29"), (30, 60, "30–59"), (60, 120, "60–119"), (120, float("inf"), "120+")]


def pct(sorted_vals, p):
    return sorted_vals[min(len(sorted_vals) - 1, int(p / 100 * len(sorted_vals)))] if sorted_vals else None


def main(root: Path, out: Path):
    stats = {name: {"normal": [], "negative": 0, "neg_vals": [], "missing": 0} for name, *_ in STAGES}
    n_rows = n_all4 = n_seq_normal = 0
    for csv_path in sorted(root.glob("*/unit_responses.csv")):
        _, rows = v.read_csv(csv_path)
        for _, r in rows:
            n_rows += 1
            t = {f: (lambda x: x and x.replace(second=0))(v.parse_dt(r.get(f) or "")) for f in ("dispatch_datetime", "enroute_datetime",
                                                          "onscene_datetime", "clear_datetime")}
            seq = list(t.values())
            if all(seq):
                n_all4 += 1
                if all(b >= a for a, b in zip(seq, seq[1:])):
                    n_seq_normal += 1
            for name, a, b in STAGES:
                if t[a] is None or t[b] is None:
                    stats[name]["missing"] += 1
                    continue
                d = (t[b] - t[a]).total_seconds() / 60
                if d < 0:
                    stats[name]["negative"] += 1
                    stats[name]["neg_vals"].append(-d)  # magnitude, minutes
                else:
                    stats[name]["normal"].append(d)

    result = {"rows_total": n_rows, "rows_all_four_present": n_all4, "rows_sequence_normal": n_seq_normal, "stages": []}
    for name, *_ in STAGES:
        vals = sorted(stats[name]["normal"])
        hist = [{"label": lbl, "count": sum(lo <= x < hi for x in vals)} for lo, hi, lbl in BINS]
        result["stages"].append({
            "stage": name, "n_normal": len(vals), "n_negative": stats[name]["negative"],
            "n_missing": stats[name]["missing"],
            "mean_min": round(statistics.mean(vals)) if vals else None,
            "median_min": round(pct(vals, 50)) if vals else None,
            "p90_min": round(pct(vals, 90)) if vals else None,
            "histogram": hist,
            "negative_histogram": [{"label": lbl, "count": sum(lo <= x < hi for x in stats[name]["neg_vals"])}
                                   for lo, hi, lbl in BINS],
            "negative_median_min": round(pct(sorted(stats[name]["neg_vals"]), 50)) if stats[name]["neg_vals"] else None,
        })
    out.write_text(json.dumps(result, indent=2))
    for s in result["stages"]:
        print(f"{s['stage']}: normal={s['n_normal']} negative={s['n_negative']} missing={s['n_missing']} "
              f"mean={s['mean_min']} median={s['median_min']} p90={s['p90_min']}")
    print(f"rows={n_rows} all4={n_all4} sequence_normal={n_seq_normal}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
