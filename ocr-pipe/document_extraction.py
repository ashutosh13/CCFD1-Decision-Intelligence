"""PDF -> chunked natural-language documents.

Everything here runs locally. No network calls, no hosted models (PII).
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol

Service = Literal["Fire", "EMS"]

FILENAME_RE = re.compile(r"^DailyBlotter\s+(?P<when>.+?)\s+(?P<service>Fire|EMS)(?:\s+(?P<year2>\d{4}))?\.pdf$", re.IGNORECASE)

_MONTH_LOOKUP: dict[str, int] = {}
for _i in range(1, 13):
    _MONTH_LOOKUP[calendar.month_name[_i].lower()] = _i
    _MONTH_LOOKUP[calendar.month_abbr[_i].lower()] = _i
_MONTH_LOOKUP["sept"] = 9


@dataclass(frozen=True)
class FileMeta:
    path: Path
    month: int
    year: int | None
    service: Service


def parse_filename(path: Path) -> FileMeta:
    """'DailyBlotter 01-2026 Fire.pdf' / 'DailyBlotter APRIL 2026 EMS.pdf' / 'DailyBlotter Apr-2026 EMS.pdf'."""
    m = FILENAME_RE.match(path.name)
    if not m:
        raise ValueError(f"Not a DailyBlotter file: {path.name}")
    tokens = [t for t in re.split(r"[\s\-_/.]+", f'{m["when"]} {m["year2"] or ""}'.strip()) if t]

    month: int | None = None
    year: int | None = None
    for tok in tokens:
        if tok.isdigit() and len(tok) == 4:
            year = int(tok)
        elif tok.isdigit() and 1 <= int(tok) <= 12 and month is None:
            month = int(tok)
        elif tok.lower() in _MONTH_LOOKUP and month is None:
            month = _MONTH_LOOKUP[tok.lower()]
        else:
            raise ValueError(f"Unrecognised date token {tok!r} in {path.name}")
    if month is None:
        raise ValueError(f"No month found in {path.name}")
    service: Service = "Fire" if m["service"].lower() == "fire" else "EMS"
    return FileMeta(path=path, month=month, year=year, service=service)


@dataclass
class Page:
    number: int  # 1-based
    text: str


@dataclass
class Chunk:
    """One blotter record (may span pages)."""
    source_file: str
    service: Service
    month: int
    year: int | None
    index: int
    first_page: int
    last_page: int
    text: str
    extractor: str
    meta: dict = field(default_factory=dict)


class PageExtractor(Protocol):
    name: str

    def extract(self, path: Path) -> list[Page]: ...


class TextLayerExtractor:
    """Fast path: read the embedded text layer (works for digitally generated PDFs)."""
    name = "pdfplumber"

    def extract(self, path: Path) -> list[Page]:
        import pdfplumber  # MIT, local

        with pdfplumber.open(path) as pdf:
            return [Page(i, p.extract_text() or "") for i, p in enumerate(pdf.pages, 1)]


class TesseractExtractor:
    """Fallback for scanned/image-only pages. Needs `tesseract` + `poppler` installed (brew)."""
    name = "tesseract"

    def __init__(self, dpi: int = 300, lang: str = "eng"):
        self.dpi, self.lang = dpi, lang

    def extract(self, path: Path) -> list[Page]:
        import pytesseract
        from pdf2image import convert_from_path

        images = convert_from_path(path, dpi=self.dpi)
        return [Page(i, pytesseract.image_to_string(img, lang=self.lang)) for i, img in enumerate(images, 1)]


EXTRACTORS: dict[str, type] = {"pdfplumber": TextLayerExtractor, "tesseract": TesseractExtractor}

# TODO: set from a real sample. Documents are separated by a "strong page break".
DEFAULT_RECORD_BREAK = re.compile(r"^\s*(?:-{5,}|={5,}|\*{5,})\s*$", re.MULTILINE)
MIN_CHARS_PER_PAGE = 40  # below this, treat the page as having no usable text layer


def extract_pages(path: Path, methods: list[str]) -> tuple[list[Page], str]:
    """Try each method in order; accept the first whose output looks like real text."""
    last_err: Exception | None = None
    for name in methods:
        try:
            pages = EXTRACTORS[name]().extract(path)
        except Exception as e:  # missing dependency / binary / corrupt PDF
            last_err = e
            continue
        if pages and sum(len(p.text.strip()) >= MIN_CHARS_PER_PAGE for p in pages) / len(pages) >= 0.5:
            return pages, name
    raise RuntimeError(f"No extractor produced usable text for {path.name}") from last_err


def split_records(pages: list[Page], record_break: re.Pattern = DEFAULT_RECORD_BREAK) -> list[tuple[int, int, str]]:
    """Join pages, split on the record break, so a record can span pages.

    Returns (first_page, last_page, text) per record.
    """
    full, offsets = "", []  # offsets[i] = char offset where page i+1 starts
    for p in pages:
        offsets.append(len(full))
        full += p.text + "\n"

    def page_at(pos: int) -> int:
        n = 1
        for i, off in enumerate(offsets, 1):
            if off <= pos:
                n = i
        return n

    out, start = [], 0
    for m in [*record_break.finditer(full), None]:
        end = m.start() if m else len(full)
        text = full[start:end].strip()
        if text:
            out.append((page_at(start + (len(full[start:end]) - len(full[start:end].lstrip()))), page_at(max(start, end - 1)), text))
        if m:
            start = m.end()
    return out


def extract_document(
    path: Path,
    methods: list[str] | None = None,
    record_break: re.Pattern = DEFAULT_RECORD_BREAK,
) -> list[Chunk]:
    meta = parse_filename(path)
    pages, used = extract_pages(path, methods or ["pdfplumber", "tesseract"])
    return [
        Chunk(
            source_file=path.name, service=meta.service, month=meta.month, year=meta.year,
            index=i, first_page=a, last_page=b, text=t, extractor=used,
        )
        for i, (a, b, t) in enumerate(split_records(pages, record_break))
    ]


def write_text_file(path: Path, pages: list[Page], text_dir: Path) -> Path:
    """Save raw per-page text so later stages (and humans) can inspect it. Contains PII."""
    text_dir.mkdir(parents=True, exist_ok=True)
    out = text_dir / f"{path.stem}.txt"
    out.write_text("".join(f"\n===== PAGE {p.number} =====\n{p.text}\n" for p in pages))
    return out


@dataclass
class CaseReport:
    found: int
    verified: int


def find_cases(pages: list[Page], meta: FileMeta) -> CaseReport:
    """PLACEHOLDER: real case/field extraction arrives with schema_builder.py.

    Will report cases found by record splitting and how many pass schema validation.
    """
    return CaseReport(found=0, verified=0)
