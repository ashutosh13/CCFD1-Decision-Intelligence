"""
CAD Daily Blotter extractor - Version 13

What changed from Version 12
----------------------------
* Unit-response tables are no longer read with page.find_tables(). That
  table finder could not reliably segment the Jasper report layout and
  silently dropped whole tables (V12: 346 rows / 71 incidents; the PDF
  holds ~1,480 unit rows across all 298 incidents).
* Unit rows are now parsed from word coordinates. Columns are located
  from each "Unit / Unit Org / ... / Clear Date/Time" header row, every
  word is assigned to a column by its x-position, and the AM/PM
  continuation line (which also carries wrapped values such as
  "EMERGENCY" / "10" or "DISCOUNT" / "TOWING") is merged into its row.
* Incident ownership follows the report order: a unit table belongs to
  the most recent "Incident#:" block, including tables that continue
  onto the next page.
* Out-of-order timestamps are kept as printed and flagged; durations
  that would be negative are left blank.
* Exact repeat rows (CAD reprints a unit after its Unit Remarks block)
  are removed and counted. Same unit + same dispatch with different
  later times are BOTH kept and logged.
* New output: *_unit_reconciliation.csv - per incident, unit rows
  detected in the PDF vs. rows written, with pages.
* Incident parsing is unchanged from V12.

Works with PyMuPDF (preferred) or falls back to pdfplumber.
"""

import os
import re
import csv
from collections import defaultdict, Counter
from datetime import datetime

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz
    except ImportError:
        fitz = None

try:
    import pdfplumber
except ImportError:
    pdfplumber = None


# ============================================================
# CONFIG
# ============================================================

LAW_ENFORCEMENT_ORGS = {"LPD", "CCSD", "ISP"}

LOOSE_INCIDENT_PATTERN = re.compile(r"(20\d{2})\s*-\s*(\d{8})")

CAD_DATETIME_PATTERN = re.compile(
    r"\*?\d{1,2}\s*-\s*[A-Za-z]{3}\s*-\s*\d{2}\s*"
    r"\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}(?:\s*(?:AM|PM))?",
    re.IGNORECASE,
)

DATE_TOKEN = re.compile(r"^\*?\d{1,2}-[A-Za-z]{3}-\d{2}$")
TIME_TOKEN = re.compile(r"^\d{1,2}:\d{2}:\d{2}$")
AMPM_TOKEN = {"AM", "PM"}

TS_COLUMNS = ("dispatch", "enroute", "onscene", "clear")

# Lines that are page furniture, not report content.
PAGE_CHROME_PREFIXES = (
    "Daily Blotter",
    "Print Date",
    "Print Time",
    "User Name:",
    "Incidents Created From:",
    "* Time is backfilled",
    "** Unit was temporarily",
    "For Official Use Only",
)

# Lines that end a unit table.
TABLE_END_PREFIXES = (
    "Event:",
    "Incident#:",
    "Narratives:",
)

LINE_TOLERANCE = 3.0     # points; words within this vertical distance share a line
COLUMN_TOLERANCE = 6.0   # points; slack when matching a word to a header column


# ============================================================
# GENERAL HELPERS
# ============================================================

def clean_cell(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).replace("\n", " ")).strip()


def normalize_incident_id(value):
    if not value:
        return ""
    text = str(value)
    match = LOOSE_INCIDENT_PATTERN.search(text)
    if match:
        return match.group(1) + "-" + match.group(2)
    compact = re.sub(r"\s+", "", text)
    match = re.search(r"(20\d{2})-(\d{8})", compact)
    if match:
        return match.group(1) + "-" + match.group(2)
    return ""


# ============================================================
# DATETIME (unchanged from V12)
# ============================================================

def normalize_datetime_text(value):
    value = clean_cell(value)
    if not value:
        return ""

    # Repair split year: 01-Jan-2 6 05:28:57 -> 01-Jan-26 05:28:57
    value = re.sub(
        r"(\*?\d{1,2})\s*-\s*([A-Za-z]{3})\s*-\s*(\d)\s+(\d)\s*",
        r"\1-\2-\3\4 ",
        value,
        flags=re.IGNORECASE,
    )

    value = re.sub(
        r"(\*?\d{1,2})\s*-\s*([A-Za-z]{3})\s*-\s*(\d{2})\s*"
        r"(\d{1,2})\s*:\s*(\d{2})\s*:\s*(\d{2})\s*(AM|PM)?",
        lambda m: (
            f"{m.group(1)}-{m.group(2)}-{m.group(3)} "
            f"{m.group(4)}:{m.group(5)}:{m.group(6)}"
            + (f" {m.group(7).upper()}" if m.group(7) else "")
        ),
        value,
        flags=re.IGNORECASE,
    )
    return value


def parse_datetime(raw_value, ampm_hint=""):
    if not raw_value:
        return "", False

    value = normalize_datetime_text(raw_value)
    if not value:
        return "", False

    backfilled = value.strip().startswith("*")
    value = value.lstrip("*").strip()

    match = re.search(
        r"(\d{1,2})-([A-Za-z]{3})-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?",
        value,
        re.IGNORECASE,
    )
    if not match:
        return "", backfilled

    try:
        day = int(match.group(1))
        month = datetime.strptime(match.group(2), "%b").month
        year = 2000 + int(match.group(3))
        hour = int(match.group(4))
        minute = int(match.group(5))
        second = int(match.group(6))
        ampm = (match.group(7) or ampm_hint or "").upper()

        # CAD quirk: "16:42:38 PM" is already 24-hour time.
        if ampm and hour <= 12:
            if ampm == "PM" and hour != 12:
                hour += 12
            elif ampm == "AM" and hour == 12:
                hour = 0

        if not (0 <= hour <= 23):
            return "", backfilled

        dt = datetime(year, month, day, hour, minute, second)
        return dt.strftime("%Y-%m-%d %H:%M:%S"), backfilled

    except Exception:
        return "", backfilled


def extract_first_datetime(text):
    if not text:
        return "", False
    value = normalize_datetime_text(text)
    match = CAD_DATETIME_PATTERN.search(value)
    if not match:
        return "", False
    return parse_datetime(match.group(0))


# ============================================================
# TIME CALCULATIONS
# ============================================================

def signed_seconds_between(start_text, end_text):
    """Signed difference in seconds, or None if either side is missing."""
    if not start_text or not end_text:
        return None
    try:
        start = datetime.strptime(start_text, "%Y-%m-%d %H:%M:%S")
        end = datetime.strptime(end_text, "%Y-%m-%d %H:%M:%S")
        return int((end - start).total_seconds())
    except Exception:
        return None


def seconds_between(start_text, end_text):
    """Non-negative duration in seconds; blank if missing or out of order."""
    diff = signed_seconds_between(start_text, end_text)
    if diff is None or diff < 0:
        return ""
    return diff


def minutes_between(start_text, end_text):
    seconds = seconds_between(start_text, end_text)
    if seconds == "":
        return ""
    return round(seconds / 60, 2)


# ============================================================
# READ PDF
# ============================================================

def _fitz_words(page):
    """
    PyMuPDF reports word boxes in the UNROTATED page space. This blotter's
    pages are stored portrait with /Rotate 90, so without this transform
    x and y are swapped and no table row lines up. Map every box into the
    displayed (rotated) orientation, which is what the column logic expects.
    """
    matrix = getattr(page, "rotation_matrix", None)
    if matrix is None:
        matrix = getattr(page, "rotationMatrix", None)   # very old PyMuPDF
    rotated = bool(page.rotation) and matrix is not None

    words = []
    for w in page.get_text("words", sort=False):
        text = str(w[4]).strip()
        if not text:
            continue
        x0, y0, x1, y1 = w[0], w[1], w[2], w[3]
        if rotated:
            p1 = fitz.Point(x0, y0) * matrix
            p2 = fitz.Point(x1, y1) * matrix
            x0, x1 = min(p1.x, p2.x), max(p1.x, p2.x)
            y0, y1 = min(p1.y, p2.y), max(p1.y, p2.y)
        words.append({"x0": x0, "x1": x1, "top": y0, "text": text})
    return words


def _plumber_words(page):
    return [
        {"x0": w["x0"], "x1": w["x1"], "top": w["top"], "text": w["text"]}
        for w in page.extract_words(keep_blank_chars=False, use_text_flow=False)
    ]


def read_pdf(pdf_path):
    """
    Returns (document, pages). Each page dict carries:
      text / text_lines  - used by incident parsing (same as V12 with PyMuPDF)
      words              - positioned words, used by unit-table parsing
    """
    pages = []

    if fitz is not None:
        document = fitz.open(pdf_path)
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text", sort=False)
            pages.append({
                "page_number": page_number,
                "text": text,
                "text_lines": [l.strip() for l in text.splitlines() if l.strip()],
                "words": _fitz_words(page),
            })
        return document, pages

    if pdfplumber is not None:
        document = pdfplumber.open(pdf_path)
        for page_number, page in enumerate(document.pages, start=1):
            text = page.extract_text() or ""
            pages.append({
                "page_number": page_number,
                "text": text,
                "text_lines": [l.strip() for l in text.splitlines() if l.strip()],
                "words": _plumber_words(page),
            })
        return document, pages

    raise ImportError("Install PyMuPDF (pip install pymupdf) or pdfplumber.")


def group_words_into_lines(words, tolerance=LINE_TOLERANCE):
    """Cluster positioned words into visual lines, top-to-bottom, left-to-right."""
    lines = []
    for word in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(word["top"] - lines[-1]["top"]) <= tolerance:
            lines[-1]["words"].append(word)
        else:
            lines.append({"top": word["top"], "words": [word]})
    for line in lines:
        line["words"].sort(key=lambda w: w["x0"])
        line["text"] = " ".join(w["text"] for w in line["words"])
    return lines


# ============================================================
# DISPOSITION (unchanged from V12)
# ============================================================

def disposition_candidate(value):
    value = clean_cell(value)
    if not value:
        return ""
    match = re.match(r"([A-Za-z0-9]{1,8})\b", value)
    if not match:
        return ""
    candidate = match.group(1).upper()
    invalid = {"EVENT", "INCIDENT", "PHONE", "CASE", "CALLER",
               "CREATED", "STATION", "LAT", "LONG", "UNIT"}
    if candidate in invalid or candidate.isdigit():
        return ""
    return candidate


def build_disposition_map(pages):
    disposition_map = {}
    for page_info in pages:
        lines = page_info["text_lines"]
        for index, line in enumerate(lines):
            match = LOOSE_INCIDENT_PATTERN.search(line)
            if not match:
                continue
            incident_id = match.group(1) + "-" + match.group(2)
            candidate = disposition_candidate(line[match.end():].strip())
            if candidate:
                disposition_map[incident_id] = candidate
                continue
            if index + 1 < len(lines):
                next_line = lines[index + 1].strip()
                if re.fullmatch(r"[A-Za-z0-9]{1,8}", next_line):
                    candidate = disposition_candidate(next_line)
                    if candidate:
                        disposition_map[incident_id] = candidate
    return disposition_map


# ============================================================
# INCIDENT BLOCKS (unchanged from V12)
# ============================================================

def build_incident_blocks(pages):
    skip = {"Daily Blotter", "For Official Use Only", "* Time is backfilled",
            "Print Date", "Print Time", "User Name:"}

    all_lines = []
    for page_info in pages:
        for line in page_info["text_lines"]:
            value = line.strip()
            if not value or value in skip:
                continue
            all_lines.append({"page": page_info["page_number"], "text": value})

    blocks = []
    current_id = None
    current_lines = []

    for index, item in enumerate(all_lines):
        incident_id = normalize_incident_id(item["text"])
        if incident_id:
            if current_id and incident_id != current_id:
                blocks.append({"incident_id": current_id, "lines": current_lines})
                current_lines = []
            if current_id is None or incident_id != current_id:
                current_id = incident_id
                if index > 0:
                    current_lines.append(all_lines[index - 1])
            current_lines.append(item)
        elif current_id:
            current_lines.append(item)

    if current_id:
        blocks.append({"incident_id": current_id, "lines": current_lines})
    return blocks


def get_block_lines(block):
    return [item["text"] for item in block["lines"]]


def get_block_page(block):
    if not block["lines"]:
        return ""
    return block["lines"][0]["page"]


# ============================================================
# COORDINATES (unchanged from V12)
# ============================================================

def extract_coordinates(lines):
    stop_labels = ("Created By:", "Station:", "Narratives:", "Unit Unit Org",
                   "Event:", "Incident#:", "Case#:", "Caller Name:",
                   "Caller Location:", "Event Location:")

    for index, line in enumerate(lines):
        if "Lat / Long:" not in line:
            continue
        text = line.split("Lat / Long:", 1)[1].strip()
        for offset in range(1, 4):
            if index + offset >= len(lines):
                break
            next_line = lines[index + offset].strip()
            if any(next_line.startswith(label) for label in stop_labels):
                break
            text += " " + next_line

        match = re.search(r"([+-]?\d{2,3}\.\d+)\s+([+-]?\d{2,3}\.\d+)", text)
        if not match:
            return "", "", "SOURCE_MISSING"
        try:
            latitude = float(match.group(1))
            longitude = float(match.group(2))
            if abs(latitude) > 90 and abs(longitude) <= 90:
                latitude, longitude = longitude, latitude
            if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                return "", "", "INVALID"
            return latitude, longitude, "VALID"
        except Exception:
            return "", "", "PARSE_FAILED"

    return "", "", "NO_LABEL"


# ============================================================
# INCIDENT PARSER (unchanged from V12)
# ============================================================

def parse_incident(block, disposition_map, source_group, source_file):
    lines = get_block_lines(block)
    incident_id = block["incident_id"]
    page_number = get_block_page(block)

    incident_index = None
    for index, line in enumerate(lines):
        if normalize_incident_id(line) == incident_id:
            incident_index = index
            break

    # Event type
    event_type = ""
    if incident_index is not None and incident_index > 0:
        event_type = lines[incident_index - 1].strip()

    disposition = disposition_map.get(incident_id, "")

    # Case number
    case_number = ""
    for index, line in enumerate(lines):
        if "Case#:" not in line:
            continue
        value = line.split("Case#:", 1)[1].strip()
        if value:
            case_number = value
        elif index + 1 < len(lines):
            candidate = lines[index + 1].strip()
            invalid = {"Caller Name:", "Caller Location:", "Event Location:",
                       "Lat / Long:", "Created By:", "Station:",
                       "Narratives: Date/Time:"}
            if candidate not in invalid and not candidate.endswith(":"):
                case_number = candidate
        break

    # Create datetime
    create_datetime = ""
    if incident_index is not None:
        end = min(incident_index + 40, len(lines))
        for index in range(incident_index, end):
            if "CREATE DATE/TIME" not in lines[index].upper():
                continue
            combined = lines[index]
            for offset in range(1, 7):
                if index + offset >= end:
                    break
                combined += " " + lines[index + offset]
            value, _ = extract_first_datetime(combined)
            if value:
                create_datetime = value
                break
        if not create_datetime:
            for index in range(incident_index, end):
                value, _ = extract_first_datetime(lines[index])
                if value:
                    create_datetime = value
                    break

    # Event location
    event_location = ""
    for index, line in enumerate(lines):
        if "Event Location:" not in line:
            continue
        value = line.split("Event Location:", 1)[1].strip()
        if value:
            event_location = value
        elif index + 1 < len(lines):
            candidate = lines[index + 1]
            if "Lat / Long:" not in candidate:
                event_location = candidate
        break

    latitude, longitude, coordinate_status = extract_coordinates(lines)

    # Station
    station = ""
    for index, line in enumerate(lines):
        if "Station:" not in line:
            continue
        value = line.split("Station:", 1)[1].strip()
        if value:
            station = value
        else:
            for candidate in lines[index + 1:min(index + 5, len(lines))]:
                if re.fullmatch(r"\d{1,5}", candidate):
                    station = candidate
                    break
        break

    incident_date = year = month = day_of_week = hour_of_day = ""
    if create_datetime:
        try:
            dt = datetime.strptime(create_datetime, "%Y-%m-%d %H:%M:%S")
            incident_date = dt.strftime("%Y-%m-%d")
            year = dt.year
            month = dt.month
            day_of_week = dt.strftime("%A")
            hour_of_day = dt.hour
        except Exception:
            pass

    return {
        "incident_id": incident_id,
        "case_number": case_number,
        "event_type": event_type,
        "disposition": disposition,
        "create_datetime": create_datetime,
        "incident_date": incident_date,
        "year": year,
        "month": month,
        "day_of_week": day_of_week,
        "hour_of_day": hour_of_day,
        "event_location": event_location,
        "latitude": latitude,
        "longitude": longitude,
        "coordinate_valid": coordinate_status == "VALID",
        "coordinate_status": coordinate_status,
        "station": station,
        "source_group": source_group,
        "source_file": source_file,
        "page_number": page_number,
    }


# ============================================================
# UNIT TABLE - COLUMN LAYOUT
# ============================================================

def get_header_columns(line):
    """
    Read column start positions from a unit-table header line:
    Unit | Unit Org | Employee ID | Employee | Dispatch | Enroute | Onscene | Clear
    Returns a list of (column_name, x0) sorted by x0, or None.
    """
    if not line["text"].startswith("Unit Unit Org"):
        return None

    words = line["words"]
    unit_words = [w for w in words if w["text"] == "Unit"]
    employee_words = [w for w in words if w["text"] == "Employee"]

    def first(label):
        for w in words:
            if w["text"].lower().startswith(label):
                return w["x0"]
        return None

    starts = {
        "unit": unit_words[0]["x0"] if unit_words else None,
        "org": unit_words[1]["x0"] if len(unit_words) > 1 else None,
        "employee_id": employee_words[0]["x0"] if employee_words else None,
        "employee": employee_words[1]["x0"] if len(employee_words) > 1 else None,
        "dispatch": first("dispatch"),
        "enroute": first("enroute"),
        "onscene": first("onscen"),
        "clear": first("clear"),
    }

    if any(v is None for v in starts.values()):
        return None

    columns = sorted(starts.items(), key=lambda item: item[1])
    order = [name for name, _ in columns]
    expected = ["unit", "org", "employee_id", "employee",
                "dispatch", "enroute", "onscene", "clear"]
    if order != expected:
        return None
    return columns


def column_of(word, columns):
    """Rightmost column whose start is at or left of the word (with slack)."""
    name = columns[0][0]
    for column_name, x0 in columns:
        if word["x0"] + COLUMN_TOLERANCE >= x0:
            name = column_name
    return name


def split_into_columns(line, columns):
    cells = defaultdict(list)
    for word in line["words"]:
        cells[column_of(word, columns)].append(word["text"])
    return cells


def is_unit_data_line(cells):
    """A unit row has a date token in at least one timestamp column."""
    return any(
        any(DATE_TOKEN.match(t) for t in cells.get(col, []))
        for col in TS_COLUMNS
    )


def is_continuation_line(cells):
    """AM/PM line under a unit row: timestamp columns hold only AM/PM."""
    ts_tokens = [t for col in TS_COLUMNS for t in cells.get(col, [])]
    if not ts_tokens:
        return False
    return all(t.upper() in AMPM_TOKEN for t in ts_tokens)


def is_wrap_only_line(cells):
    """Line whose words all sit in the Unit / Unit Org columns."""
    used = [col for col, tokens in cells.items() if tokens]
    return bool(used) and all(col in ("unit", "org") for col in used)


# ============================================================
# UNIT TABLE - ROW BUILDING
# ============================================================

def clean_unit_text(tokens):
    """Join tokens, drop literal 'null' and temp-assignment '**' markers."""
    text = " ".join(tokens)
    temp_assigned = "**" in text
    text = text.replace("**", "")
    text = re.sub(r"\bnull\b", "", text, flags=re.IGNORECASE)
    return clean_cell(text), temp_assigned


def classify_record_type(unit_id, unit_org):
    unit_upper = unit_id.upper()
    org_upper = unit_org.upper()

    if "TOW" in unit_upper or "TOW" in org_upper:
        return "towing"
    if org_upper in LAW_ENFORCEMENT_ORGS:
        return "law_enforcement"
    # Agency rows print the agency in both Unit and Unit Org (e.g. LFD / LFD).
    if unit_upper and unit_upper == org_upper:
        return "agency_summary"
    return "unit"


def time_order_anomalies(times):
    pairs = [
        ("dispatch", "enroute"),
        ("enroute", "onscene"),
        ("dispatch", "onscene"),
        ("dispatch", "clear"),
        ("onscene", "clear"),
        ("enroute", "clear"),
    ]
    anomalies = []
    for start, end in pairs:
        diff = signed_seconds_between(times[start], times[end])
        if diff is not None and diff < 0:
            anomalies.append(f"{end}_before_{start}")
    return anomalies


def finalize_unit_row(pending, logs, source_file):
    """Turn a raw row (+ optional continuation) into a response record."""
    cells = pending["cells"]
    cont = pending["continuation"] or {}

    wraps = pending.get("wraps", [])
    unit_tokens = cells.get("unit", []) + cont.get("unit", [])
    org_tokens = cells.get("org", []) + cont.get("org", [])
    for wrap in wraps:
        unit_tokens += wrap.get("unit", [])
        org_tokens += wrap.get("org", [])

    unit_id, unit_temp = clean_unit_text(unit_tokens)
    unit_org, org_temp = clean_unit_text(org_tokens)
    unit_org = unit_org.upper()

    times = {}
    backfilled = {}
    raw_times = {}

    for col in TS_COLUMNS:
        tokens = cells.get(col, [])
        ampm_tokens = [t for t in tokens if t.upper() in AMPM_TOKEN]
        ampm_tokens += [t for t in cont.get(col, []) if t.upper() in AMPM_TOKEN]
        value_tokens = [t for t in tokens if t.upper() not in AMPM_TOKEN]

        raw = " ".join(value_tokens)
        raw_times[col] = (raw + " " + " ".join(ampm_tokens)).strip()

        if not raw:
            times[col] = ""
            backfilled[col] = False
            continue

        parsed, was_backfilled = parse_datetime(raw, ampm_tokens[0] if ampm_tokens else "")
        times[col] = parsed
        backfilled[col] = was_backfilled

        if not parsed:
            add_warning(logs, source_file, pending["page"], pending["incident_id"],
                        f"{col}_datetime", "PARSE_FAILED",
                        f"{unit_id or '(blank unit)'}: could not parse "
                        f"'{raw_times[col]}'")

    anomalies = time_order_anomalies(times)

    if anomalies:
        qa_status = "REVIEW_TIME_ORDER"
    elif not times["dispatch"]:
        qa_status = "NO_DISPATCH"
    elif not times["enroute"] or not times["onscene"] or not times["clear"]:
        qa_status = "PARTIAL"
    else:
        qa_status = "PASS"

    return {
        "incident_id": pending["incident_id"],
        "unit_id": unit_id,
        "unit_org": unit_org,
        "record_type": classify_record_type(unit_id, unit_org),
        "temp_assigned": unit_temp or org_temp,
        "dispatch_datetime": times["dispatch"],
        "enroute_datetime": times["enroute"],
        "onscene_datetime": times["onscene"],
        "clear_datetime": times["clear"],
        "dispatch_backfilled": backfilled["dispatch"],
        "enroute_backfilled": backfilled["enroute"],
        "onscene_backfilled": backfilled["onscene"],
        "clear_backfilled": backfilled["clear"],
        "turnout_seconds": seconds_between(times["dispatch"], times["enroute"]),
        "travel_seconds": seconds_between(times["enroute"], times["onscene"]),
        "response_seconds": seconds_between(times["dispatch"], times["onscene"]),
        "commitment_minutes": minutes_between(times["dispatch"], times["clear"]),
        "time_anomalies": ";".join(anomalies),
        "qa_status": qa_status,
        "page_number": pending["page"],
        "raw_dispatch": raw_times["dispatch"],
        "raw_enroute": raw_times["enroute"],
        "raw_onscene": raw_times["onscene"],
        "raw_clear": raw_times["clear"],
    }


# ============================================================
# UNIT TABLE - DOCUMENT WALK
# ============================================================

def extract_all_unit_responses(pages, valid_incident_ids, logs, source_file):
    """
    Walk the whole report in reading order with a small state machine.

    Returns (responses, reconciliation) where reconciliation maps
    incident_id -> {"detected": n, "pages": set()}.
    """
    print()
    print("Extracting unit-response tables (coordinate mode)...")

    raw_rows = []
    reconciliation = defaultdict(lambda: {"detected": 0, "pages": set()})

    current_incident = ""
    columns = None
    in_table = False
    in_remarks = False
    pending = None
    headers_found = 0

    def flush():
        nonlocal pending
        if pending is not None:
            raw_rows.append(finalize_unit_row(pending, logs, source_file))
            pending = None

    for page_info in pages:
        page_number = page_info["page_number"]

        for line in group_words_into_lines(page_info["words"]):
            text = line["text"]

            if text.startswith(PAGE_CHROME_PREFIXES):
                continue

            # Incident boundary
            if text.startswith("Incident#:"):
                flush()
                incident_id = normalize_incident_id(text)
                if incident_id:
                    current_incident = incident_id
                in_table = False
                in_remarks = False
                continue

            if text.startswith(TABLE_END_PREFIXES):
                flush()
                in_table = False
                in_remarks = False
                continue

            # Unit-table header (also repeated at the top of continued pages)
            header = get_header_columns(line)
            if header:
                headers_found += 1
                # A header repeated at the top of a new page must not close
                # a row whose AM/PM line was pushed onto this page, and must
                # not end a Unit Remarks block that continues here.
                if pending is not None and pending["continuation"] is not None:
                    flush()
                columns = header
                in_table = True
                continue

            if not in_table or columns is None:
                continue

            if text.startswith("Unit Remarks"):
                flush()
                in_remarks = True
                continue

            cells = split_into_columns(line, columns)

            # New unit row
            if is_unit_data_line(cells):
                flush()
                in_remarks = False

                if not current_incident:
                    add_warning(logs, source_file, page_number, "", "unit_row",
                                "ORPHAN", f"Unit row before any incident: {text}")
                    continue

                reconciliation[current_incident]["detected"] += 1
                reconciliation[current_incident]["pages"].add(page_number)

                pending = {
                    "incident_id": current_incident,
                    "page": page_number,
                    "cells": cells,
                    "continuation": None,
                    "wraps": [],
                }
                continue

            # AM/PM line (may also carry wrapped unit/org text)
            if pending is not None and pending["continuation"] is None \
                    and is_continuation_line(cells):
                pending["continuation"] = cells
                continue

            if in_remarks:
                continue

            # Extra wrap line, e.g. "CASS" / "COUNTY" / "TOWING":
            # text only in the Unit / Unit Org columns.
            if pending is not None and is_wrap_only_line(cells):
                pending["wraps"].append(cells)
                continue

            # Anything else inside a unit table is unexpected - log it.
            add_warning(logs, source_file, page_number, current_incident,
                        "unit_table_line", "REVIEW",
                        f"Unrecognized line inside unit table: {text}")

    flush()

    print(f"Unit-table headers found:  {headers_found}")
    if headers_found == 0:
        print()
        print("WARNING: no unit-table header rows were recognized.")
        print("First reconstructed lines of page 1 (check that each line reads")
        print("left-to-right across the page; if not, coordinates are rotated):")
        for line in group_words_into_lines(pages[0]["words"])[:12]:
            print(f"  y={line['top']:7.1f}  {line['text'][:100]}")
        add_warning(logs, source_file, "", "", "unit_tables", "ERROR",
                    "No unit-table header rows recognized - see console output")

    # ----------------------------------------------------------
    # Filter to incidents that were parsed, then de-duplicate.
    # ----------------------------------------------------------
    responses = []
    seen_exact = set()
    seen_dispatch = {}
    exact_duplicates = Counter()

    for row in raw_rows:
        if row["incident_id"] not in valid_incident_ids:
            add_warning(logs, source_file, row["page_number"], row["incident_id"],
                        "unit_row", "ORPHAN",
                        f"{row['unit_id']}: incident ID not in incident table")
            continue

        exact_key = (
            row["incident_id"], row["unit_id"], row["unit_org"],
            row["raw_dispatch"], row["raw_enroute"],
            row["raw_onscene"], row["raw_clear"],
        )
        if exact_key in seen_exact:
            exact_duplicates[row["incident_id"]] += 1
            continue
        seen_exact.add(exact_key)

        dispatch_key = (row["incident_id"], row["unit_id"], row["dispatch_datetime"])
        if dispatch_key in seen_dispatch:
            add_warning(logs, source_file, row["page_number"], row["incident_id"],
                        "unit_row", "REVIEW",
                        f"{row['unit_id']}: listed more than once with the same "
                        f"dispatch time but different later times - both kept")
        seen_dispatch[dispatch_key] = True

        responses.append(row)

    for incident_id, info in reconciliation.items():
        info["exact_duplicates"] = exact_duplicates.get(incident_id, 0)

    print(f"Unit rows detected in PDF: {len(raw_rows)}")
    print(f"Exact repeat rows removed: {sum(exact_duplicates.values())}")
    print(f"Unit rows kept:            {len(responses)}")

    return responses, reconciliation


# ============================================================
# QA LOG
# ============================================================

def add_warning(logs, source_file, page_number, incident_id, field_name, status, warning):
    logs.append({
        "source_file": source_file,
        "page_number": page_number,
        "incident_id": incident_id,
        "field_name": field_name,
        "status": status,
        "warning": warning,
    })


def validate_incident(incident, logs):
    for field in ["incident_id", "event_type", "create_datetime", "disposition"]:
        if not incident.get(field):
            add_warning(logs, incident["source_file"], incident["page_number"],
                        incident["incident_id"], field, "MISSING", f"{field} is missing")

    status = incident["coordinate_status"]
    if status == "SOURCE_MISSING":
        add_warning(logs, incident["source_file"], incident["page_number"],
                    incident["incident_id"], "latitude_longitude", "SOURCE_MISSING",
                    "Lat / Long field exists but source contains no coordinate value.")
    elif status in {"INVALID", "PARSE_FAILED"}:
        add_warning(logs, incident["source_file"], incident["page_number"],
                    incident["incident_id"], "latitude_longitude", "REVIEW",
                    "Coordinate value could not be validated.")


def validate_unit_responses(responses, logs, source_file):
    for row in responses:
        label = row["unit_id"] or "(blank unit)"

        if not row["unit_id"]:
            add_warning(logs, source_file, row["page_number"], row["incident_id"],
                        "unit_id", "REVIEW", "Unit row has a blank Unit field")

        if not row["unit_org"] and row["record_type"] != "towing":
            add_warning(logs, source_file, row["page_number"], row["incident_id"],
                        "unit_org", "REVIEW", f"{label}: unit organization is missing.")

        if not row["dispatch_datetime"]:
            add_warning(logs, source_file, row["page_number"], row["incident_id"],
                        "dispatch_datetime", "MISSING",
                        f"{label}: no dispatch time in source row")

        if row["time_anomalies"]:
            add_warning(logs, source_file, row["page_number"], row["incident_id"],
                        "time_order", "SOURCE_ANOMALY",
                        f"{label}: source timestamps out of order "
                        f"({row['time_anomalies']}); values preserved, "
                        f"affected durations left blank")


def build_reconciliation_rows(incidents, responses, reconciliation, logs, source_file):
    kept = Counter(r["incident_id"] for r in responses)
    rows = []

    for incident in incidents:
        incident_id = incident["incident_id"]
        info = reconciliation.get(incident_id, {"detected": 0, "pages": set(),
                                                "exact_duplicates": 0})
        detected = info["detected"]
        dupes = info.get("exact_duplicates", 0)
        written = kept.get(incident_id, 0)
        pages = sorted(info["pages"])

        if detected == 0:
            status = "NO_UNIT_ROWS_IN_PDF"
            add_warning(logs, source_file, incident["page_number"], incident_id,
                        "unit_rows", "REVIEW", "No unit-response rows found for incident")
        elif detected - dupes != written:
            status = "MISMATCH"
            add_warning(logs, source_file, pages[0], incident_id, "unit_rows", "REVIEW",
                        f"Detected {detected} rows ({dupes} exact repeats) "
                        f"but wrote {written}")
        else:
            status = "OK"

        rows.append({
            "incident_id": incident_id,
            "pdf_unit_rows_detected": detected,
            "exact_repeats_removed": dupes,
            "unit_rows_written": written,
            "spans_pages": len(pages) > 1,
            "pages": ";".join(str(p) for p in pages),
            "status": status,
        })
    return rows


# ============================================================
# CSV WRITER
# ============================================================

def write_csv(filepath, rows, fields):
    with open(filepath, "w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


# ============================================================
# PROCESS PDF
# ============================================================

INCIDENT_FIELDS = [
    "incident_id", "case_number", "event_type", "disposition",
    "create_datetime", "incident_date", "year", "month", "day_of_week",
    "hour_of_day", "event_location", "latitude", "longitude",
    "coordinate_valid", "coordinate_status", "station",
    "source_group", "source_file", "page_number",
]

RESPONSE_FIELDS = [
    "incident_id", "unit_id", "unit_org", "record_type", "temp_assigned",
    "dispatch_datetime", "enroute_datetime", "onscene_datetime", "clear_datetime",
    "dispatch_backfilled", "enroute_backfilled", "onscene_backfilled", "clear_backfilled",
    "turnout_seconds", "travel_seconds", "response_seconds", "commitment_minutes",
    "time_anomalies", "qa_status", "page_number",
]

RECON_FIELDS = [
    "incident_id", "pdf_unit_rows_detected", "exact_repeats_removed",
    "unit_rows_written", "spans_pages", "pages", "status",
]

LOG_FIELDS = ["source_file", "page_number", "incident_id", "field_name", "status", "warning"]


def process_pdf(pdf_path, source_group, output_folder=None):
    source_file = os.path.basename(pdf_path)
    output_folder = output_folder or os.path.join(os.path.dirname(pdf_path), "output")
    os.makedirs(output_folder, exist_ok=True)

    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_",
                       os.path.splitext(source_file)[0]).strip("_")

    print()
    print("Reading PDF...")
    document, pages = read_pdf(pdf_path)
    print(f"Pages read: {len(pages)}")

    raw_ids = [m.group(1) + "-" + m.group(2)
               for page in pages
               for m in LOOSE_INCIDENT_PATTERN.finditer(page["text"])]
    unique_ids = list(dict.fromkeys(raw_ids))
    print(f"Incident IDs found: {len(unique_ids)}")

    disposition_map = build_disposition_map(pages)
    print(f"Disposition values found: {len(disposition_map)}")

    # Incidents
    blocks = build_incident_blocks(pages)
    incidents, logs, skipped = [], [], 0

    for block in blocks:
        try:
            incident = parse_incident(block, disposition_map, source_group, source_file)
            incidents.append(incident)
            validate_incident(incident, logs)
        except Exception as error:
            skipped += 1
            add_warning(logs, source_file, get_block_page(block),
                        block.get("incident_id", ""), "incident", "INVALID", str(error))

    valid_incident_ids = {row["incident_id"] for row in incidents}

    # Unit responses
    unit_responses, reconciliation = extract_all_unit_responses(
        pages, valid_incident_ids, logs, source_file)
    validate_unit_responses(unit_responses, logs, source_file)
    recon_rows = build_reconciliation_rows(
        incidents, unit_responses, reconciliation, logs, source_file)

    # Write
    paths = {
        "incidents": os.path.join(output_folder, f"{safe_name}_incidents.csv"),
        "responses": os.path.join(output_folder, f"{safe_name}_unit_responses.csv"),
        "recon": os.path.join(output_folder, f"{safe_name}_unit_reconciliation.csv"),
        "log": os.path.join(output_folder, f"{safe_name}_extraction_log.csv"),
    }
    write_csv(paths["incidents"], incidents, INCIDENT_FIELDS)
    write_csv(paths["responses"], unit_responses, RESPONSE_FIELDS)
    write_csv(paths["recon"], recon_rows, RECON_FIELDS)
    write_csv(paths["log"], logs, LOG_FIELDS)

    # Summary
    def count(rows, pred):
        return sum(1 for r in rows if pred(r))

    qa = Counter(r["qa_status"] for r in unit_responses)
    recon_status = Counter(r["status"] for r in recon_rows)

    result = {
        "incidents": len(incidents),
        "responses": len(unit_responses),
        "response_incidents": len({r["incident_id"] for r in unit_responses}),
        "missing_create": count(incidents, lambda r: not r["create_datetime"]),
        "missing_disposition": count(incidents, lambda r: not r["disposition"]),
        "valid_coordinates": count(incidents, lambda r: r["coordinate_status"] == "VALID"),
        "source_missing_coordinates": count(
            incidents, lambda r: r["coordinate_status"] == "SOURCE_MISSING"),
        "missing_orgs": count(unit_responses, lambda r: not r["unit_org"]),
        "blank_units": count(unit_responses, lambda r: not r["unit_id"]),
        "dispatch": count(unit_responses, lambda r: r["dispatch_datetime"]),
        "enroute": count(unit_responses, lambda r: r["enroute_datetime"]),
        "onscene": count(unit_responses, lambda r: r["onscene_datetime"]),
        "clear": count(unit_responses, lambda r: r["clear_datetime"]),
        "turnout": count(unit_responses, lambda r: r["turnout_seconds"] != ""),
        "travel": count(unit_responses, lambda r: r["travel_seconds"] != ""),
        "response": count(unit_responses, lambda r: r["response_seconds"] != ""),
        "commitment": count(unit_responses, lambda r: r["commitment_minutes"] != ""),
        "qa": dict(qa),
        "recon": dict(recon_status),
        "record_types": dict(Counter(r["record_type"] for r in unit_responses)),
        "warnings": len(logs),
        "skipped": skipped,
        "output": output_folder,
        "paths": paths,
    }

    print()
    print("================================")
    print("EXTRACTION COMPLETE")
    print("================================")
    for key in ["incidents", "responses", "response_incidents", "missing_create",
                "missing_disposition", "valid_coordinates", "source_missing_coordinates",
                "missing_orgs", "blank_units", "dispatch", "enroute", "onscene", "clear",
                "turnout", "travel", "response", "commitment", "warnings", "skipped"]:
        print(f"{key:28s} {result[key]}")
    print(f"{'unit QA status':28s} {result['qa']}")
    print(f"{'record types':28s} {result['record_types']}")
    print(f"{'reconciliation':28s} {result['recon']}")
    print()
    print("Files created:")
    for path in paths.values():
        print(path)

    document.close()
    return result


# ============================================================
# GUI
# ============================================================

def main():
    import tkinter as tk
    from tkinter import filedialog, simpledialog, messagebox

    root = tk.Tk()
    root.withdraw()

    pdf_path = filedialog.askopenfilename(
        title="Select Fire / EMS Daily Blotter PDF",
        filetypes=[("PDF Files", "*.pdf")])
    if not pdf_path:
        return

    source_group = simpledialog.askstring("Source Type", "Enter FIRE or EMS:")
    if not source_group:
        return
    source_group = source_group.strip().upper()
    if source_group not in {"FIRE", "EMS"}:
        messagebox.showerror("Invalid Source", "Please enter FIRE or EMS.")
        return

    try:
        r = process_pdf(pdf_path, source_group)
        messagebox.showinfo(
            "Extraction Complete",
            f"Incidents: {r['incidents']}\n"
            f"Unit responses: {r['responses']}\n"
            f"Incidents with responses: {r['response_incidents']}\n\n"
            f"Dispatch / Enroute / Onscene / Clear:\n"
            f"{r['dispatch']} / {r['enroute']} / {r['onscene']} / {r['clear']}\n\n"
            f"Unit QA: {r['qa']}\n"
            f"Reconciliation: {r['recon']}\n\n"
            f"Missing unit orgs: {r['missing_orgs']}\n"
            f"Blank unit IDs: {r['blank_units']}\n"
            f"Warnings: {r['warnings']}\n\n"
            f"Output folder:\n{r['output']}")
    except Exception as error:
        messagebox.showerror("Extraction Error", str(error))
        raise


if __name__ == "__main__":
    main()
