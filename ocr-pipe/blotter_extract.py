"""Command-line wrapper around cad_blotter_extract_v13 (no GUI).

Usage: python blotter_extract.py --input-dir inbox --out-dir data/DailyBlotter/structured [--force]

For every PDF in --input-dir it writes <out-dir>/<pdf stem>/{incidents,unit_responses,extraction_log}.csv,
the layout pipeline/ingest_cad_export.py reads. FIRE or EMS is taken from the file name
("DailyBlotter APRIL 2026 FIRE.pdf"). PDFs whose content hash is already in <out-dir>/.processed.json
are skipped unless --force is given. Prints one JSON line per newly extracted folder on stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

import cad_blotter_extract_v13 as ex


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def source_group(name: str) -> str | None:
    up = name.upper()
    for g in ("FIRE", "EMS"):
        if g in up:
            return g
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    ledger_path = args.out_dir / ".processed.json"
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}

    status = 0
    for pdf in sorted(args.input_dir.glob("*.pdf")):
        digest = sha256(pdf)
        if not args.force and digest in ledger:
            print(f"skip (already processed): {pdf.name}", file=sys.stderr)
            continue
        group = source_group(pdf.name)
        if group is None:
            print(f"ERROR: cannot tell FIRE or EMS from the file name: {pdf.name}. "
                  f"Rename it to include FIRE or EMS.", file=sys.stderr)
            status = 1
            continue
        target = args.out_dir / pdf.stem
        with tempfile.TemporaryDirectory() as tmp:
            try:
                result = ex.process_pdf(str(pdf), group, output_folder=tmp)
            except Exception as err:  # keep going so one bad PDF does not hide the others
                print(f"ERROR: extraction failed for {pdf.name}: {err}", file=sys.stderr)
                status = 1
                continue
            target.mkdir(parents=True, exist_ok=True)
            for key, dest in (("incidents", "incidents.csv"), ("responses", "unit_responses.csv"),
                              ("log", "extraction_log.csv")):
                shutil.copyfile(result["paths"][key], target / dest)
        ledger[digest] = {"file": pdf.name, "folder": target.name}
        ledger_path.write_text(json.dumps(ledger, indent=2))
        print(json.dumps({"folder": str(target), "incidents": result["incidents"],
                          "responses": result["responses"]}))
    return status


if __name__ == "__main__":
    sys.exit(main())
