"""Aggregate ingest_*.json reports (counts only) into per-file and per-rule tables."""
import json, sys
from collections import defaultdict
from pathlib import Path

reports = [json.loads(p.read_text()) for p in sorted(Path(sys.argv[1]).glob("ingest_*.json"))]
print(f"{'folder / file':<42}{'read':>6}{'clean':>7}{'warn-only':>10}{'rejected':>9}")
tot = defaultdict(lambda: defaultdict(int)); rules = {}
for rep in reports:
    for f in rep["files"]:
        t = f["file"].replace(".csv", "")
        print(f"{rep['folder'][12:] + ' / ' + f['file']:<42}{f['rows_read']:>6}{f['rows_clean']:>7}"
              f"{f['rows_warn_only']:>10}{f['rows_rejected_total']:>9}")
        for k in ("rows_read", "rows_clean", "rows_warn_only", "rows_rejected_total"):
            tot[t][k] += f[k]
        for r, c in f["rule_counts"].items():
            rules.setdefault((t, r), [c["severity"], 0])[1] += c["fired"]
print()
for t, d in tot.items():
    print(f"TOTAL {t}: read={d['rows_read']} clean={d['rows_clean']} warn_only={d['rows_warn_only']} rejected={d['rows_rejected_total']}")
print(f"\n{'table':<16}{'rule':<34}{'sev':<7}{'rows hit':>9}")
for (t, r), (sev, n) in sorted(rules.items(), key=lambda x: (x[0][0], -x[1][1])):
    print(f"{t:<16}{r:<34}{sev:<7}{n:>9}{'   <- never fired' if n == 0 else ''}")
