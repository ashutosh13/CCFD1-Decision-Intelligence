"""Build finance datasets from a hand-prepared Gateway AFR CSV (manual download, then one row per year).

Usage: python build_finance_dataset.py afr_by_year.csv [--sources afr_sources.csv --source-year 2024]
                                       [--out ../datasets.candidate]

afr_by_year.csv columns: year, operating_revenue, operating_spending, ending_balance, personnel, contracted
afr_sources.csv columns: source, amount           (revenue by source for one year)

Operating figures exclude loan proceeds, interfund transfers and payroll pass-throughs, as on the page.
Prints counts only. Output goes to a candidate folder; diff and review before copying to datasets/.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import datasets_lib as dl

YEAR_COLS = ["year", "operating_revenue", "operating_spending", "ending_balance", "personnel", "contracted"]
AFR = "Indiana Gateway Annual Financial Reports"


def read_rows(path: Path, cols: list[str]) -> list[dict]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        missing = [c for c in cols if c not in (rd.fieldnames or [])]
        if missing:
            raise ValueError(f"{path.name} is missing columns {missing}")
        return list(rd)


def num(s: str):
    s = (s or "").strip().replace(",", "").replace("$", "")
    return int(float(s)) if s else None


def build(year_rows: list[dict], source_rows: list[dict] | None, source_year: int | None) -> list[dict]:
    years = sorted(int(r["year"]) for r in year_rows)
    by_year = {int(r["year"]): r for r in year_rows}
    period = f"{years[0]}-{years[-1]}"
    out = [
        {"id": "finance_by_year", "title": "Operating revenue, spending and ending balance by year", "panel": "financial",
         "grain": "year", "period": period, "status": "verified", "source": AFR,
         "source_detail": "Receipts and disbursements; operating figures only",
         "note": "Operating figures exclude loan proceeds, interfund transfers and payroll pass-throughs.",
         "dimensions": [{"name": "year", "type": "int"}],
         "measures": [{"name": "revenue", "unit": "USD"}, {"name": "spending", "unit": "USD"}, {"name": "balance", "unit": "USD"}],
         "rows": [{"year": y, "revenue": num(by_year[y]["operating_revenue"]), "spending": num(by_year[y]["operating_spending"]),
                   "balance": num(by_year[y]["ending_balance"])} for y in years]},
        {"id": "personnel_vs_contracted", "title": "Personnel vs contracted service cost by year", "panel": "staffing",
         "grain": "year", "period": period, "status": "verified", "source": AFR,
         "source_detail": "Personnel = salaries and wages + Employee Benefits; contracted = contracted service",
         "note": "In 2020 the District moved from contracted service to employing its own staff.",
         "dimensions": [{"name": "year", "type": "int"}],
         "measures": [{"name": "personnel", "unit": "USD"}, {"name": "contracted", "unit": "USD"}],
         "rows": [{"year": y, "personnel": num(by_year[y]["personnel"]), "contracted": num(by_year[y]["contracted"])} for y in years]},
    ]
    if source_rows:
        out.append({
            "id": f"revenue_by_source_{source_year}", "title": f"{source_year} revenue by source", "panel": "revenue-sources",
            "grain": "source", "period": str(source_year), "status": "verified", "source": f"{source_year} Gateway AFR",
            "source_detail": "Revenue by source", "note": "Shares are of the listed sources.",
            "dimensions": [{"name": "source", "type": "string"}], "measures": [{"name": "amount", "unit": "USD"}],
            "rows": [{"source": r["source"].strip(), "amount": num(r["amount"])} for r in source_rows]})
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("years_csv", type=Path)
    ap.add_argument("--sources", type=Path)
    ap.add_argument("--source-year", type=int)
    ap.add_argument("--out", type=Path, default=dl.DEFAULT_DIR)
    args = ap.parse_args(argv)
    if bool(args.sources) != bool(args.source_year):
        ap.error("--sources and --source-year go together")
    sources = read_rows(args.sources, ["source", "amount"]) if args.sources else None
    datasets = build(read_rows(args.years_csv, YEAR_COLS), sources, args.source_year)
    for ds in datasets:
        path = dl.write_dataset(ds, args.out)
        print(f"wrote {path.name}: {len(ds['rows'])} rows")
    dl.write_manifest(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
