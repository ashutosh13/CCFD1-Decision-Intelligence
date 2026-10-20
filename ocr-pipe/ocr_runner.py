"""Entrypoint / job control for the OCR pipeline.

    python ocr_runner.py                       # all PDFs in ../data/DailyBlotter/raw
    python ocr_runner.py --methods tesseract   # force a method
    python ocr_runner.py --workers 4

Raw text (contains PII, git-ignore it) goes to ../data/DailyBlotter/text/<pdf stem>.txt,
then is mapped to ../data/DailyBlotter/structured/<pdf stem>.csv.
Run report: <GRAD-588>/reports/run_report_<YYYYMMDD_HHMMSS>.json
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from datetime import datetime
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path

from document_extraction import extract_pages, find_cases, parse_filename, write_text_file
from structure_blotter import write_csv

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = ROOT / "data" / "DailyBlotter" / "raw"
DEFAULT_OUT = ROOT / "data" / "DailyBlotter" / "text"
DEFAULT_STRUCTURED = ROOT / "data" / "DailyBlotter" / "structured"
DEFAULT_REPORTS = ROOT.parent / "reports"

# Module level so spawned worker processes (macOS) are configured too.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("ocr_runner")


@dataclass
class JobResult:
    file: str
    ok: bool
    service: str | None = None
    month: int | None = None
    pages: int = 0
    extractor: str | None = None
    cases_found: int = 0
    cases_verified: int = 0
    csv_rows: int = 0
    seconds: float = 0.0
    error: str | None = None


def run_job(path: Path, out_dir: Path, structured_dir: Path, methods: list[str]) -> JobResult:
    t0 = time.perf_counter()
    log.info("START %s", path.name)
    try:
        meta = parse_filename(path)
        log.info("  %s: service=%s month=%d year=%s", path.name, meta.service, meta.month, meta.year or "n/a")

        pages, used = extract_pages(path, methods)
        text_path = write_text_file(path, pages, out_dir)
        log.info("  Extracted %d pages into %s (via %s)", len(pages), text_path.name, used)

        csv_path, n_rows = write_csv(text_path, structured_dir)
        log.info("  Mapped %d incidents into %s", n_rows, csv_path.name)

        cases = find_cases(pages, meta)
        log.info("  Cases found: %d, verified: %d (placeholder)", cases.found, cases.verified)
        return JobResult(path.name, True, meta.service, meta.month, len(pages), used,
                         cases.found, cases.verified, n_rows, time.perf_counter() - t0)
    except Exception as e:
        # Log exception type only; messages can echo document content (PII).
        log.error("  FAILED %s: %s", path.name, type(e).__name__)
        return JobResult(path.name, False, seconds=time.perf_counter() - t0, error=type(e).__name__)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=DEFAULT_IN)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--structured", type=Path, default=DEFAULT_STRUCTURED)
    ap.add_argument("--reports", type=Path, default=DEFAULT_REPORTS)
    ap.add_argument("--methods", nargs="+", default=["pdfplumber", "tesseract"])
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    pdfs = sorted(args.input.glob("DailyBlotter *.pdf"))
    log.info("Found %d PDF(s) in %s", len(pdfs), args.input)
    for p in pdfs:
        log.info("  - %s", p.name)
    if not pdfs:
        raise SystemExit(f"No DailyBlotter PDFs in {args.input}")

    results: list[JobResult] = []
    with ProcessPoolExecutor(args.workers) as pool:
        futs = [pool.submit(run_job, p, args.output, args.structured, args.methods) for p in pdfs]
        for fut in as_completed(futs):
            results.append(fut.result())

    ok = sum(r.ok for r in results)
    args.reports.mkdir(parents=True, exist_ok=True)
    report = args.reports / f"run_report_{datetime.now():%Y%m%d_%H%M%S}.json"
    report.write_text(json.dumps([asdict(r) for r in results], indent=2))
    log.info("Run report: %s", report)
    log.info("DONE extraction rate: %d/%d files (%.0f%%); cases found=%d verified=%d",
             ok, len(results), 100 * ok / len(results),
             sum(r.cases_found for r in results), sum(r.cases_verified for r in results))


if __name__ == "__main__":
    main()
