# OCR extraction plan: local, free, PII-safe

## Constraint
911 call records contain PII. Nothing leaves the machine: no hosted OCR (Textract, Document AI, Azure), no LLM APIs, no AI-assisted reading of real documents. Every option below runs offline and is free/open source. Also keep `data/` and `data/extracted/` out of git (see below).

## Decision: tiered extraction, cheapest first
The PDFs are described as *generated*, so they most likely have an embedded text layer. Real OCR is only needed if they're scanned/rasterized.

| Tier | Tool | License | Use when | Notes |
|---|---|---|---|---|
| 1 (default) | **pdfplumber** (pdfminer.six) | MIT | Text layer present | Fast, exact (no OCR errors), keeps layout/tables. Try this first. |
| 2 (fallback) | **Tesseract** via pytesseract + pdf2image (or **OCRmyPDF**) | Apache-2.0 | Scanned/image pages | `brew install tesseract poppler`. Needs 300 dpi; fine on clean printed text. |
| 3 (if layout/tables are poor) | **Docling** (IBM) or **PaddleOCR** | MIT / Apache-2.0 | Multi-column, tables, bad scans | Heavier (PyTorch models downloaded once, then offline). Evaluate only if tiers 1-2 fail the quality bar. |

Avoid: PyMuPDF for anything redistributed (AGPL), and any cloud-API OCR.

First step: run a 30-second check on one real PDF (`pdftotext file.pdf - | head`). If text appears, tier 1 is the whole answer and "OCR" is only a safety net.

## Pipeline
1. `parse_filename`: regex `DailyBlotter <when> (Fire|EMS).pdf`; month from `01`, `APRIL`, `Apr`; optional year. Done in `document_extraction.py`.
2. `extract_pages`: tiers in order, accept the first where >=50% of pages have usable text (guards against empty text layers).
3. `split_records`: join all pages, split on the strong page break, so records spanning pages stay whole; track first/last page.
4. Emit one JSONL per PDF with `source_file`, `service`, `month`, `year`, page range, `extractor`, text.
5. `schema_builder.py` (next): chunk text -> pydantic model.

## Open items
- **Record delimiter**: `DEFAULT_RECORD_BREAK` is a placeholder. Need the real separator (a rule line? a header like "Incident #"? a page-break form feed?) from a sample, without sharing PII, e.g. a redacted single record or just the delimiter line.
- **Schema fields**: need field names (call time, address, nature, units...) to design the pydantic model. Likely regex first, since blotters are semi-structured; a **local** LLM (Ollama, e.g. Llama/Qwen) only for free-text narrative fields.
- **Year**: some filenames lack it; confirm whether year comes from the filename or document content.
- **Measuring extraction rate**: the runner reports file success; add per-chunk checks (non-empty, expected fields found) and a hand-labelled ~10-record gold set once schema exists.

## Safeguards
- `.gitignore`: `data/`, `ocr-pipe/**/*.jsonl`, `run_report.json` (report holds filenames only, but be safe).
- Errors log exception type only, not messages (they can echo document text).
- Disable network for any model tooling after first download; pin versions in `requirements.txt`.
- Do not paste real record text into chats; use synthetic/redacted samples to develop regexes.

## Dependencies
`pip install pdfplumber pytesseract pdf2image pydantic` plus `brew install tesseract poppler`.
