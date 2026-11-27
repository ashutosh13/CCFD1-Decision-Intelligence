# OCR ingestion pipeline (Daily Blotter)

PDF -> page text -> per-incident header CSV, all local. See PLAN.md.

```
pip install -r requirements.txt
python ocr_runner.py [--methods pdfplumber tesseract] [--workers 2]
```

Input `../data/DailyBlotter/raw/DailyBlotter <when> (Fire|EMS).pdf`; outputs under `../data/DailyBlotter/{text,structured}/`; run reports in `../../reports/`.

| File | Role |
|---|---|
| `ocr_runner.py` | entrypoint, job control, run report |
| `document_extraction.py` | filename parsing, pdfplumber / tesseract extractors |
| `structure_blotter.py` | page text -> incident header CSV |

## Log
- Rebased on origin/master history; `CAD_Extractor.py` (PyMuPDF, standalone GUI) is kept unmodified and is not used by this pipeline.
- Dropped the PyMuPDF-based integration: AGPL licence risk, and it must not be validated against PII output.
- Filename parser now accepts the service before the year (`DEC EMS 2025`).
- Not yet run on this version; no real documents or outputs have been inspected by the assistant (PII).
- Future: unit-response and QA parsing from `CAD_Extractor.py` could be ported onto pdfplumber text.


## Current extractor (used by `python run.py`)

`blotter_extract.py` is a command-line wrapper around `cad_blotter_extract_v13.py` (pdfplumber). It is the only extractor that produces unit responses, so it is what the one-command pipeline uses; `ocr_runner.py` is legacy. PyMuPDF (AGPL) is no longer used.
