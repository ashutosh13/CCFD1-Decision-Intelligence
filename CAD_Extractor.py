import os
import re
import csv
from datetime import datetime

import tkinter as tk
from tkinter import filedialog, simpledialog, messagebox

try:
    import pymupdf as fitz
except ImportError:
    import fitz


# ============================================================
# SETTINGS / PATTERNS
# ============================================================

INCIDENT_PATTERN = re.compile(
    r"\b20\d{2}-\d{8}\b"
)

PHONE_PATTERN = re.compile(
    r"^\d{3}-\d{3}-\d{4}$"
)

COORD_PATTERN = re.compile(
    r"([+-]?\d{2,3}\.\d+)\s+([+-]?\d{2,3}\.\d+)"
)

DATE_TIME_PATTERN = re.compile(
    r"\*?\d{1,2}-[A-Za-z]{3}-\d{2}\s+"
    r"\d{1,2}:\d{2}:\d{2}"
    r"(?:\s+(?:AM|PM))?",
    re.IGNORECASE
)

FULL_DATETIME_PATTERN = re.compile(
    r"\*?\d{1,2}-[A-Za-z]{3}-\d{2}\s+"
    r"\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)",
    re.IGNORECASE
)


KNOWN_ORGS = {
    "CCEMS",
    "LFD",
    "GVFD",
    "WFD",
    "CVFD",
    "GTFD",
    "LVFD",
    "RCFD",
    "YAFD",
    "DIST",
    "CCSD",
    "LPD",
    "ISP",
    "NWFD",
    "TMFD",
    "RCPD",
    "GPD"
}


# ============================================================
# DATE / TIME FUNCTIONS
# ============================================================

def parse_datetime(raw_value):

    if not raw_value:
        return "", False

    raw_value = raw_value.strip()

    backfilled = raw_value.startswith("*")

    raw_value = raw_value.lstrip("*").strip()

    match = DATE_TIME_PATTERN.search(
        raw_value
    )

    if not match:
        return "", backfilled

    value = (
        match.group(0)
        .lstrip("*")
        .strip()
    )

    try:

        parts = value.split()

        if len(parts) < 2:
            return "", backfilled

        date_part = parts[0]
        time_part = parts[1]

        ampm = ""

        if len(parts) >= 3:
            ampm = parts[2].upper()

        day, month_text, year_text = (
            date_part.split("-")
        )

        hour, minute, second = map(
            int,
            time_part.split(":")
        )

        month = datetime.strptime(
            month_text,
            "%b"
        ).month

        year = 2000 + int(
            year_text
        )

        # Some CAD values contain 24-hour time
        # while also showing AM / PM.
        if ampm and hour <= 12:

            if (
                ampm == "PM"
                and hour != 12
            ):
                hour += 12

            elif (
                ampm == "AM"
                and hour == 12
            ):
                hour = 0

        dt = datetime(
            year,
            month,
            int(day),
            hour,
            minute,
            second
        )

        return (
            dt.strftime(
                "%Y-%m-%d %H:%M:%S"
            ),
            backfilled
        )

    except Exception:
        return "", backfilled


def datetime_object(value):

    if not value:
        return None

    try:

        return datetime.strptime(
            value,
            "%Y-%m-%d %H:%M:%S"
        )

    except Exception:
        return None


def seconds_between(
    start_value,
    end_value
):

    start = datetime_object(
        start_value
    )

    end = datetime_object(
        end_value
    )

    if (
        start is None
        or end is None
    ):
        return ""

    value = (
        end - start
    ).total_seconds()

    # Never calculate negative duration.
    if value < 0:
        return ""

    return int(value)


def minutes_between(
    start_value,
    end_value
):

    seconds = seconds_between(
        start_value,
        end_value
    )

    if seconds == "":
        return ""

    return round(
        seconds / 60,
        2
    )


# ============================================================
# PDF READER
# ============================================================

def read_pdf(pdf_path):

    document = fitz.open(
        pdf_path
    )

    pages = []

    for page_number, page in enumerate(
        document,
        start=1
    ):

        text = page.get_text(
            "text",
            sort=False
        )

        pages.append({
            "page_number":
                page_number,

            "text":
                text
        })

    document.close()

    return pages


# ============================================================
# CLEAN PAGE TEXT
# ============================================================

def clean_page_lines(text):

    cleaned = []

    for raw_line in text.splitlines():

        line = raw_line.strip()

        if not line:
            continue

        if line == "Daily Blotter":
            continue

        if line.startswith(
            "For Official Use Only"
        ):
            continue

        if line.startswith(
            "** Unit was temporarily assigned"
        ):
            continue

        if line == "* Time is backfilled":
            continue

        if line.startswith(
            "Incidents Created From:"
        ):
            continue

        if line in {
            "Print Date",
            "Print Time",
            "User Name:"
        }:
            continue

        cleaned.append(
            line
        )

    return cleaned


# ============================================================
# BUILD INCIDENT BLOCKS
# ============================================================

def build_incident_blocks(pages):

    all_lines = []

    for page in pages:

        page_number = page[
            "page_number"
        ]

        lines = clean_page_lines(
            page["text"]
        )

        for line in lines:

            all_lines.append({
                "page":
                    page_number,

                "text":
                    line
            })

    blocks = []

    current_id = None
    current_lines = []

    for index, item in enumerate(
        all_lines
    ):

        line = item["text"]

        match = INCIDENT_PATTERN.search(
            line
        )

        if match:

            new_incident_id = (
                match.group(0)
            )

            if current_id:

                blocks.append({
                    "incident_id":
                        current_id,

                    "lines":
                        current_lines
                })

            current_id = (
                new_incident_id
            )

            current_lines = []

            # Previous line is normally event type.
            if index > 0:

                current_lines.append(
                    all_lines[
                        index - 1
                    ]
                )

            current_lines.append(
                item
            )

            continue

        if current_id:

            current_lines.append(
                item
            )

    if current_id:

        blocks.append({
            "incident_id":
                current_id,

            "lines":
                current_lines
        })

    return blocks


# ============================================================
# BASIC HELPERS
# ============================================================

def get_lines(block):

    return [
        item["text"]
        for item
        in block["lines"]
    ]


def get_incident_page(block):

    incident_id = block[
        "incident_id"
    ]

    for item in block["lines"]:

        if incident_id in item[
            "text"
        ]:

            return item[
                "page"
            ]

    return ""


# ============================================================
# EVENT TYPE CHECK
# ============================================================

def is_possible_event_type(value):

    if not value:
        return False

    value = value.strip()

    upper = value.upper()

    if upper in KNOWN_ORGS:
        return False

    if INCIDENT_PATTERN.search(
        value
    ):
        return False

    if PHONE_PATTERN.match(
        value
    ):
        return False

    if DATE_TIME_PATTERN.search(
        value
    ):
        return False

    if value.isdigit():
        return False

    if ":" in value:
        return False

    if upper.startswith(
        "UNIT"
    ):
        return False

    if upper.startswith(
        "PAGE"
    ):
        return False

    letters = sum(
        character.isalpha()
        for character in value
    )

    return letters >= 3


# ============================================================
# INCIDENT PARSER
# ============================================================

def parse_incident(
    block,
    source_group,
    source_file
):

    lines = get_lines(
        block
    )

    incident_id = block[
        "incident_id"
    ]

    page_number = (
        get_incident_page(
            block
        )
    )

    incident_index = None

    for index, line in enumerate(
        lines
    ):

        if incident_id in line:

            incident_index = (
                index
            )

            break

    # --------------------------------------------------------
    # EVENT TYPE
    # --------------------------------------------------------

    event_type = ""

    if (
        incident_index is not None
        and incident_index > 0
    ):

        candidate = (
            lines[
                incident_index - 1
            ].strip()
        )

        if is_possible_event_type(
            candidate
        ):

            event_type = (
                candidate
            )

    # --------------------------------------------------------
    # DISPOSITION
    # --------------------------------------------------------

    disposition = ""

    if incident_index is not None:

        incident_line = (
            lines[
                incident_index
            ]
        )

        remainder = (
            incident_line
            .replace(
                incident_id,
                "",
                1
            )
            .strip()
        )

        if remainder:

            candidate = (
                remainder
                .split()[0]
            )

            if re.fullmatch(
                r"[A-Za-z]{1,5}",
                candidate
            ):

                disposition = (
                    candidate
                )

        # Debug showed:
        #
        # 2026-00000010
        # C

        if (
            not disposition
            and incident_index + 1
            < len(lines)
        ):

            candidate = (
                lines[
                    incident_index + 1
                ].strip()
            )

            if re.fullmatch(
                r"[A-Za-z]{1,3}",
                candidate
            ):

                disposition = (
                    candidate
                )

    # --------------------------------------------------------
    # CASE NUMBER
    # --------------------------------------------------------

    case_number = ""

    for index, line in enumerate(
        lines
    ):

        if line.startswith(
            "Case#:"
        ):

            value = line.split(
                "Case#:",
                1
            )[1].strip()

            if value:

                case_number = value

            elif (
                index + 1
                < len(lines)
            ):

                case_number = (
                    lines[
                        index + 1
                    ].strip()
                )

            break

    # --------------------------------------------------------
    # CREATE DATETIME
    # --------------------------------------------------------

    create_datetime = ""

    if incident_index is not None:

        for index in range(
            incident_index,
            min(
                incident_index + 20,
                len(lines)
            )
        ):

            match = (
                FULL_DATETIME_PATTERN
                .search(
                    lines[index]
                )
            )

            if match:

                create_datetime, _ = (
                    parse_datetime(
                        match.group(0)
                    )
                )

                if create_datetime:
                    break

    # --------------------------------------------------------
    # EVENT LOCATION
    # --------------------------------------------------------

    event_location = ""

    for index, line in enumerate(
        lines
    ):

        if line.startswith(
            "Event Location:"
        ):

            value = line.split(
                "Event Location:",
                1
            )[1].strip()

            if value:

                event_location = (
                    value
                )

            elif (
                index + 1
                < len(lines)
            ):

                event_location = (
                    lines[
                        index + 1
                    ].strip()
                )

            break

    # --------------------------------------------------------
    # LAT / LONG
    # --------------------------------------------------------

    latitude = ""
    longitude = ""

    for index, line in enumerate(
        lines
    ):

        if "Lat / Long:" not in line:
            continue

        value = line.split(
            "Lat / Long:",
            1
        )[1].strip()

        if (
            not value
            and index + 1
            < len(lines)
        ):

            candidate = (
                lines[
                    index + 1
                ].strip()
            )

            if (
                "Created By:"
                not in candidate
                and
                "Station:"
                not in candidate
            ):

                value = (
                    candidate
                )

        match = COORD_PATTERN.search(
            value
        )

        if match:

            try:

                latitude = float(
                    match.group(1)
                )

                longitude = float(
                    match.group(2)
                )

            except ValueError:
                pass

        break

    # --------------------------------------------------------
    # STATION
    # --------------------------------------------------------

    station = ""

    for index, line in enumerate(
        lines
    ):

        if line.startswith(
            "Station:"
        ):

            candidates = (
                lines[
                    index + 1:
                    min(
                        index + 3,
                        len(lines)
                    )
                ]
            )

            for candidate in candidates:

                candidate = (
                    candidate.strip()
                )

                if re.fullmatch(
                    r"\d{3}",
                    candidate
                ):

                    station = (
                        candidate
                    )

                    break

            break

    # --------------------------------------------------------
    # DERIVED DATE FIELDS
    # --------------------------------------------------------

    incident_date = ""
    year = ""
    month = ""
    day_of_week = ""
    hour_of_day = ""

    if create_datetime:

        try:

            dt = datetime.strptime(
                create_datetime,
                "%Y-%m-%d %H:%M:%S"
            )

            incident_date = (
                dt.strftime(
                    "%Y-%m-%d"
                )
            )

            year = dt.year
            month = dt.month

            day_of_week = (
                dt.strftime(
                    "%A"
                )
            )

            hour_of_day = (
                dt.hour
            )

        except Exception:
            pass

    return {
        "incident_id":
            incident_id,

        "case_number":
            case_number,

        "event_type":
            event_type,

        "disposition":
            disposition,

        "create_datetime":
            create_datetime,

        "incident_date":
            incident_date,

        "year":
            year,

        "month":
            month,

        "day_of_week":
            day_of_week,

        "hour_of_day":
            hour_of_day,

        "event_location":
            event_location,

        "latitude":
            latitude,

        "longitude":
            longitude,

        "station":
            station,

        "source_group":
            source_group,

        "source_file":
            source_file,

        "page_number":
            page_number
    }


# ============================================================
# UNIT TEXT NORMALIZER
# ============================================================

def normalize_unit_lines(lines):

    normalized = []

    index = 0

    while index < len(lines):

        line = (
            lines[index]
            .strip()
        )

        if not line:

            index += 1
            continue

        # Join AM/PM line to previous timestamp.

        if (
            DATE_TIME_PATTERN.search(
                line
            )
            and index + 1 < len(lines)
            and lines[
                index + 1
            ].strip().upper()
            in {"AM", "PM"}
        ):

            normalized.append(
                line
                + " "
                + lines[
                    index + 1
                ].strip().upper()
            )

            index += 2
            continue

        if line.upper() in {
            "AM",
            "PM"
        }:

            index += 1
            continue

        normalized.append(
            line
        )

        index += 1

    return normalized


# ============================================================
# EXTRACT DATETIMES
# ============================================================

def extract_all_times(text):

    results = []

    if not text:
        return results

    for match in (
        DATE_TIME_PATTERN
        .finditer(text)
    ):

        parsed, backfilled = (
            parse_datetime(
                match.group(0)
            )
        )

        if parsed:

            results.append(
                (
                    parsed,
                    backfilled
                )
            )

    return results


# ============================================================
# ORGANIZATION
# ============================================================

def find_org_in_text(value):

    if not value:
        return ""

    upper = (
        value.upper()
    )

    for org in KNOWN_ORGS:

        if re.search(
            rf"\b{re.escape(org)}\b",
            upper
        ):

            return org

    return ""


# ============================================================
# NORMALIZE UNIT ID
# ============================================================

def normalize_unit_id(unit_id):

    if not unit_id:
        return ""

    value = (
        unit_id
        .replace("null", " ")
        .replace("NULL", " ")
    )

    value = " ".join(
        value.split()
    ).strip()

    if not value:
        return ""

    upper = value.upper()

    # --------------------------------------------------------
    # REAL APPARATUS / UNIT PATTERNS
    #
    # Use last matching actual apparatus when text became:
    #
    # LFD MED3
    # DIST ENG201
    # GVFD POV5
    # RCFD RESCUE106
    # MISFITS TOWING RESCUE51
    # --------------------------------------------------------

    unit_patterns = [
        r"EMERGENCY\s+\d+",
        r"RESCUE\d+",
        r"SQUAD\d+",
        r"ENG\d+",
        r"MED\d+",
        r"TANK\d+",
        r"TK\d+",
        r"CAR\d+",
        r"POV\d+",
        r"EMS\d+",
        r"DNR\s+\d+",
        r"RC\d+",
        r"L\d+",
        r"G\d+"
    ]

    matches_found = []

    for pattern in unit_patterns:

        for match in re.finditer(
            rf"\b({pattern})\b",
            value,
            re.IGNORECASE
        ):

            matches_found.append(
                (
                    match.start(),
                    match.group(1)
                )
            )

    if matches_found:

        matches_found.sort(
            key=lambda item:
                item[0]
        )

        # Last apparatus-looking token wins.
        return (
            matches_found[-1][1]
            .upper()
        )

    # --------------------------------------------------------
    # THREE DIGIT LAW / UNIT IDs
    # --------------------------------------------------------

    number_matches = list(
        re.finditer(
            r"\b\d{3}\b",
            value
        )
    )

    if number_matches:

        return (
            number_matches[-1]
            .group(0)
        )

    # --------------------------------------------------------
    # If last word is an agency name, this is often an
    # agency-summary record.
    #
    # COUNTY TOWING CCEMS -> CCEMS
    # DISCOUNT TOWING DIST -> DIST
    # --------------------------------------------------------

    pieces = value.split()

    if pieces:

        last = (
            pieces[-1]
            .upper()
        )

        if last in KNOWN_ORGS:

            return last

    # --------------------------------------------------------
    # Pure agency
    # --------------------------------------------------------

    if upper in KNOWN_ORGS:
        return upper

    # --------------------------------------------------------
    # Preserve towing provider
    # --------------------------------------------------------

    if "TOWING" in upper:

        # Remove organization names attached
        # after the towing provider.

        while (
            pieces
            and pieces[-1].upper()
            in KNOWN_ORGS
        ):

            pieces.pop()

        return " ".join(
            pieces
        ).strip()

    return value


# ============================================================
# RECORD TYPE
# ============================================================

def get_record_type(
    unit_id,
    unit_org
):

    if not unit_id:
        return "unknown"

    upper = (
        unit_id
        .upper()
        .strip()
    )

    org = (
        unit_org
        .upper()
        .strip()
        if unit_org
        else ""
    )

    if (
        upper in KNOWN_ORGS
        and upper == org
    ):

        return "agency_summary"

    if "TOWING" in upper:

        return "towing"

    if re.fullmatch(
        r"\d{3}",
        upper
    ):

        return "law_enforcement"

    if re.fullmatch(
        r"DNR\s+\d+",
        upper
    ):

        return "law_enforcement"

    if re.fullmatch(
        r"L\d+",
        upper
    ):

        return "law_enforcement"

    if re.fullmatch(
        r"G\d+",
        upper
    ):

        return "law_enforcement"

    if re.fullmatch(
        r"RC\d+",
        upper
    ):

        return "law_enforcement"

    return "unit"


# ============================================================
# TIME QA STATUS
# ============================================================

def get_time_qa_status(
    dispatch,
    enroute,
    onscene,
    clear,
    dispatch_backfilled,
    enroute_backfilled,
    onscene_backfilled,
    clear_backfilled
):

    values = [
        (
            dispatch,
            enroute,
            dispatch_backfilled,
            enroute_backfilled
        ),
        (
            enroute,
            onscene,
            enroute_backfilled,
            onscene_backfilled
        ),
        (
            onscene,
            clear,
            onscene_backfilled,
            clear_backfilled
        )
    ]

    missing_count = 0

    for (
        start_value,
        end_value,
        start_backfilled,
        end_backfilled
    ) in values:

        if (
            not start_value
            or not end_value
        ):

            missing_count += 1
            continue

        start = datetime_object(
            start_value
        )

        end = datetime_object(
            end_value
        )

        if (
            start is None
            or end is None
        ):

            return "INVALID_DATETIME"

        if end < start:

            if (
                start_backfilled
                or end_backfilled
            ):

                return (
                    "BACKFILLED_ORDER"
                )

            return "INVALID_ORDER"

    if missing_count > 0:

        return "PARTIAL"

    return "OK"


# ============================================================
# SPLIT UNIT TABLE HEADER
# ============================================================

def is_unit_table_header(
    lines,
    index
):

    if index >= len(lines):
        return False

    if (
        lines[index]
        .strip()
        .upper()
        != "UNIT"
    ):
        return False

    lookahead = {
        line.strip().upper()
        for line in lines[
            index:
            min(
                index + 10,
                len(lines)
            )
        ]
    }

    required = {
        "DISPATCH DATE/TIME",
        "ENROUTE DATE/TIME",
        "ONSCENE DATE/TIME",
        "CLEAR DATE/TIME",
        "EMPLOYEE",
        "EMPLOYEE ID",
        "UNIT ORG"
    }

    return required.issubset(
        lookahead
    )


def get_header_end(
    lines,
    start_index
):

    for index in range(
        start_index,
        min(
            start_index + 12,
            len(lines)
        )
    ):

        if (
            lines[index]
            .strip()
            .upper()
            == "UNIT ORG"
        ):

            return index

    return start_index


# ============================================================
# POSSIBLE UNIT NAME
# ============================================================

def is_unit_name_piece(value):

    value = value.strip()

    if not value:
        return False

    upper = (
        value.upper()
    )

    if DATE_TIME_PATTERN.search(
        value
    ):
        return False

    if PHONE_PATTERN.match(
        value
    ):
        return False

    if INCIDENT_PATTERN.search(
        value
    ):
        return False

    if ":" in value:
        return False

    blocked = {
        "UNIT",
        "UNIT REMARKS",
        "DISPATCH DATE/TIME",
        "ENROUTE DATE/TIME",
        "ONSCENE DATE/TIME",
        "CLEAR DATE/TIME",
        "EMPLOYEE",
        "EMPLOYEE ID",
        "UNIT ORG",
        "PRINT DATE",
        "PRINT TIME",
        "USER NAME"
    }

    if upper in blocked:
        return False

    if upper.startswith(
        "PAGE "
    ):
        return False

    if upper.startswith(
        "FOR OFFICIAL USE"
    ):
        return False

    if value == "290":
        return False

    if len(value) > 50:
        return False

    return True


# ============================================================
# FIND UNIT CANDIDATE
# ============================================================

def find_unit_candidate(
    lines,
    index
):

    pieces = []

    pointer = index

    while (
        pointer < len(lines)
        and len(pieces) < 3
    ):

        value = (
            lines[pointer]
            .strip()
        )

        if DATE_TIME_PATTERN.search(
            value
        ):

            if pieces:

                return (
                    normalize_unit_id(
                        " ".join(
                            pieces
                        )
                    ),
                    pointer
                )

            return "", index

        if not is_unit_name_piece(
            value
        ):

            return "", index

        pieces.append(
            value
        )

        pointer += 1

    if (
        pointer < len(lines)
        and DATE_TIME_PATTERN.search(
            lines[pointer]
        )
        and pieces
    ):

        return (
            normalize_unit_id(
                " ".join(
                    pieces
                )
            ),
            pointer
        )

    return "", index


# ============================================================
# BUILD UNIT RESPONSE
# ============================================================

def build_unit_response(
    incident_id,
    raw_unit_id,
    unit_org,
    timestamps,
    page_number
):

    if not raw_unit_id:
        return None

    if not timestamps:
        return None

    unit_id = normalize_unit_id(
        raw_unit_id
    )

    if not unit_id:
        return None

    unit_org = (
        unit_org.upper()
        if unit_org
        else ""
    )

    dispatch = (
        timestamps[0][0]
        if len(timestamps) >= 1
        else ""
    )

    enroute = (
        timestamps[1][0]
        if len(timestamps) >= 2
        else ""
    )

    onscene = (
        timestamps[2][0]
        if len(timestamps) >= 3
        else ""
    )

    clear = (
        timestamps[3][0]
        if len(timestamps) >= 4
        else ""
    )

    dispatch_backfilled = (
        timestamps[0][1]
        if len(timestamps) >= 1
        else False
    )

    enroute_backfilled = (
        timestamps[1][1]
        if len(timestamps) >= 2
        else False
    )

    onscene_backfilled = (
        timestamps[2][1]
        if len(timestamps) >= 3
        else False
    )

    clear_backfilled = (
        timestamps[3][1]
        if len(timestamps) >= 4
        else False
    )

    record_type = (
        get_record_type(
            unit_id,
            unit_org
        )
    )

    qa_time_status = (
        get_time_qa_status(
            dispatch,
            enroute,
            onscene,
            clear,
            dispatch_backfilled,
            enroute_backfilled,
            onscene_backfilled,
            clear_backfilled
        )
    )

    return {
        "incident_id":
            incident_id,

        "unit_id":
            unit_id,

        "unit_org":
            unit_org,

        "record_type":
            record_type,

        "dispatch_datetime":
            dispatch,

        "enroute_datetime":
            enroute,

        "onscene_datetime":
            onscene,

        "clear_datetime":
            clear,

        "dispatch_backfilled":
            dispatch_backfilled,

        "enroute_backfilled":
            enroute_backfilled,

        "onscene_backfilled":
            onscene_backfilled,

        "clear_backfilled":
            clear_backfilled,

        "turnout_seconds":
            seconds_between(
                dispatch,
                enroute
            ),

        "travel_seconds":
            seconds_between(
                enroute,
                onscene
            ),

        "response_seconds":
            seconds_between(
                dispatch,
                onscene
            ),

        "commitment_minutes":
            minutes_between(
                dispatch,
                clear
            ),

        "qa_time_status":
            qa_time_status,

        "page_number":
            page_number
    }


# ============================================================
# UNIT RESPONSE PARSER
# ============================================================

def parse_unit_responses(
    block,
    pages=None,
    next_incident_id=None
):

    incident_id = block[
        "incident_id"
    ]

    page_number = (
        get_incident_page(
            block
        )
    )

    lines = (
        normalize_unit_lines(
            get_lines(
                block
            )
        )
    )

    responses = []

    seen = set()

    current_unit = ""
    current_org = ""
    current_times = []

    in_table = False
    in_remarks = False

    # --------------------------------------------------------
    # RESET
    # --------------------------------------------------------

    def reset_current():

        nonlocal current_unit
        nonlocal current_org
        nonlocal current_times

        current_unit = ""
        current_org = ""
        current_times = []

    # --------------------------------------------------------
    # SAVE
    # --------------------------------------------------------

    def save_current():

        nonlocal current_unit
        nonlocal current_org
        nonlocal current_times

        if (
            not current_unit
            or not current_times
        ):

            reset_current()
            return

        response = (
            build_unit_response(
                incident_id,
                current_unit,
                current_org,
                current_times,
                page_number
            )
        )

        if response is None:

            reset_current()
            return

        key = (
            response[
                "incident_id"
            ],
            response[
                "unit_id"
            ],
            response[
                "dispatch_datetime"
            ],
            response[
                "enroute_datetime"
            ],
            response[
                "onscene_datetime"
            ],
            response[
                "clear_datetime"
            ]
        )

        if key not in seen:

            seen.add(key)

            responses.append(
                response
            )

        reset_current()

    # --------------------------------------------------------
    # PROCESS BLOCK
    # --------------------------------------------------------

    index = 0

    while index < len(lines):

        line = (
            lines[index]
            .strip()
        )

        upper = (
            line.upper()
        )

        # ----------------------------------------------------
        # Repeated / initial table header
        # ----------------------------------------------------

        if is_unit_table_header(
            lines,
            index
        ):

            save_current()

            header_end = (
                get_header_end(
                    lines,
                    index
                )
            )

            in_table = True
            in_remarks = False

            index = (
                header_end + 1
            )

            continue

        if not in_table:

            index += 1
            continue

        # ----------------------------------------------------
        # Unit Remarks
        #
        # Ignore duplicate rendered records until another
        # repeated Unit table header is found.
        # ----------------------------------------------------

        if upper == "UNIT REMARKS":

            save_current()

            in_remarks = True

            index += 1
            continue

        if in_remarks:

            index += 1
            continue

        # ----------------------------------------------------
        # Ignore report artifacts
        # ----------------------------------------------------

        if (
            upper.startswith(
                "PAGE "
            )
            or upper.startswith(
                "FOR OFFICIAL USE"
            )
            or upper.startswith(
                "INCIDENTS CREATED FROM"
            )
            or upper in {
                "PRINT DATE",
                "PRINT TIME",
                "USER NAME"
            }
            or line == "290"
        ):

            index += 1
            continue

        # ----------------------------------------------------
        # CURRENT UNIT
        # ----------------------------------------------------

        if current_unit:

            times = (
                extract_all_times(
                    line
                )
            )

            if times:

                current_times.extend(
                    times
                )

                index += 1
                continue

            # Organization after timestamps.
            org = find_org_in_text(
                line
            )

            if org:

                current_org = org

                save_current()

                index += 1
                continue

            # Repeated towing provider / unit name.
            if (
                normalize_unit_id(
                    line
                ).upper()
                ==
                normalize_unit_id(
                    current_unit
                ).upper()
            ):

                index += 1
                continue

            # See if this starts next unit.
            candidate, time_index = (
                find_unit_candidate(
                    lines,
                    index
                )
            )

            if candidate:

                save_current()

                current_unit = (
                    candidate
                )

                if (
                    current_unit.upper()
                    in KNOWN_ORGS
                ):

                    current_org = (
                        current_unit.upper()
                    )

                index = (
                    time_index
                )

                continue

            # Employee name / phone / junk.
            index += 1
            continue

        # ----------------------------------------------------
        # NO CURRENT UNIT
        # ----------------------------------------------------

        candidate, time_index = (
            find_unit_candidate(
                lines,
                index
            )
        )

        if candidate:

            current_unit = (
                candidate
            )

            if (
                current_unit.upper()
                in KNOWN_ORGS
            ):

                current_org = (
                    current_unit.upper()
                )

            index = time_index

            continue

        index += 1

    save_current()

    return responses


# ============================================================
# QA LOG FUNCTIONS
# ============================================================

def add_warning(
    logs,
    source_file,
    page_number,
    incident_id,
    field_name,
    status,
    warning
):

    logs.append({
        "source_file":
            source_file,

        "page_number":
            page_number,

        "incident_id":
            incident_id,

        "field_name":
            field_name,

        "status":
            status,

        "warning":
            warning
    })


def validate_incident(
    incident,
    logs
):

    if not incident.get(
        "create_datetime"
    ):

        add_warning(
            logs,
            incident[
                "source_file"
            ],
            incident[
                "page_number"
            ],
            incident[
                "incident_id"
            ],
            "create_datetime",
            "MISSING",
            "Create datetime missing."
        )

    if not incident.get(
        "event_type"
    ):

        add_warning(
            logs,
            incident[
                "source_file"
            ],
            incident[
                "page_number"
            ],
            incident[
                "incident_id"
            ],
            "event_type",
            "REVIEW",
            (
                "Event type could not "
                "be safely identified."
            )
        )


def validate_response(
    response,
    incident,
    logs
):

    status = response.get(
        "qa_time_status",
        ""
    )

    # BACKFILLED_ORDER is NOT treated
    # as a normal error anymore.

    if status == "INVALID_ORDER":

        add_warning(
            logs,
            incident[
                "source_file"
            ],
            response.get(
                "page_number",
                incident[
                    "page_number"
                ]
            ),
            incident[
                "incident_id"
            ],
            "response_timestamps",
            "REVIEW",
            (
                "Response timestamps are "
                "out of chronological order "
                "and are not marked as "
                "backfilled for unit "
                + response[
                    "unit_id"
                ]
            )
        )

    elif status == "INVALID_DATETIME":

        add_warning(
            logs,
            incident[
                "source_file"
            ],
            response.get(
                "page_number",
                incident[
                    "page_number"
                ]
            ),
            incident[
                "incident_id"
            ],
            "response_timestamps",
            "INVALID",
            (
                "One or more response "
                "timestamps could not be "
                "parsed for unit "
                + response[
                    "unit_id"
                ]
            )
        )


# ============================================================
# CSV WRITER
# ============================================================

def write_csv(
    file_path,
    rows,
    fields
):

    with open(
        file_path,
        "w",
        newline="",
        encoding="utf-8-sig"
    ) as output_file:

        writer = csv.DictWriter(
            output_file,
            fieldnames=fields,
            extrasaction="ignore"
        )

        writer.writeheader()

        writer.writerows(
            rows
        )


# ============================================================
# MAIN PROCESSOR
# ============================================================

def process_pdf(
    pdf_path,
    source_group
):

    source_file = (
        os.path.basename(
            pdf_path
        )
    )

    output_folder = os.path.join(
        os.path.dirname(
            pdf_path
        ),
        "output"
    )

    os.makedirs(
        output_folder,
        exist_ok=True
    )

    print()
    print("Reading PDF...")

    pages = read_pdf(
        pdf_path
    )

    print(
        f"Pages read: "
        f"{len(pages)}"
    )

    # --------------------------------------------------------
    # RAW INCIDENT IDs
    # --------------------------------------------------------

    raw_ids = []

    for page in pages:

        raw_ids.extend(
            INCIDENT_PATTERN.findall(
                page["text"]
            )
        )

    print(
        f"Raw incident IDs found: "
        f"{len(raw_ids)}"
    )

    if raw_ids:

        print()
        print(
            "First 10 incident IDs:"
        )

        for incident_id in raw_ids[
            :10
        ]:

            print(
                " ",
                incident_id
            )

    # --------------------------------------------------------
    # BUILD BLOCKS
    # --------------------------------------------------------

    print()
    print(
        "Detecting incidents..."
    )

    blocks = (
        build_incident_blocks(
            pages
        )
    )

    print(
        f"Incident blocks detected: "
        f"{len(blocks)}"
    )

    incidents = []
    unit_responses = []
    logs = []

    skipped = 0

    # --------------------------------------------------------
    # PROCESS INCIDENTS
    # --------------------------------------------------------

    for index, block in enumerate(
        blocks
    ):

        try:

            incident = (
                parse_incident(
                    block,
                    source_group,
                    source_file
                )
            )

            incidents.append(
                incident
            )

            validate_incident(
                incident,
                logs
            )

            next_incident_id = None

            if (
                index + 1
                < len(blocks)
            ):

                next_incident_id = (
                    blocks[
                        index + 1
                    ][
                        "incident_id"
                    ]
                )

            responses = (
                parse_unit_responses(
                    block,
                    pages,
                    next_incident_id
                )
                or []
            )

            unit_responses.extend(
                responses
            )

            for response in responses:

                validate_response(
                    response,
                    incident,
                    logs
                )

            count = index + 1

            if count % 25 == 0:

                print(
                    f"Processed "
                    f"{count}/"
                    f"{len(blocks)} "
                    f"incidents..."
                )

        except Exception as error:

            skipped += 1

            incident_id = block.get(
                "incident_id",
                ""
            )

            print(
                "ERROR:",
                incident_id,
                str(error)
            )

            add_warning(
                logs,
                source_file,
                get_incident_page(
                    block
                ),
                incident_id,
                "record",
                "INVALID",
                str(error)
            )

    # ========================================================
    # OUTPUT COLUMNS
    # ========================================================

    incident_fields = [
        "incident_id",
        "case_number",
        "event_type",
        "disposition",
        "create_datetime",
        "incident_date",
        "year",
        "month",
        "day_of_week",
        "hour_of_day",
        "event_location",
        "latitude",
        "longitude",
        "station",
        "source_group",
        "source_file",
        "page_number"
    ]

    response_fields = [
        "incident_id",
        "unit_id",
        "unit_org",
        "record_type",
        "dispatch_datetime",
        "enroute_datetime",
        "onscene_datetime",
        "clear_datetime",
        "dispatch_backfilled",
        "enroute_backfilled",
        "onscene_backfilled",
        "clear_backfilled",
        "turnout_seconds",
        "travel_seconds",
        "response_seconds",
        "commitment_minutes",
        "qa_time_status",
        "page_number"
    ]

    log_fields = [
        "source_file",
        "page_number",
        "incident_id",
        "field_name",
        "status",
        "warning"
    ]

    # ========================================================
    # OUTPUT FILES
    # ========================================================

    incidents_path = (
        os.path.join(
            output_folder,
            "incidents.csv"
        )
    )

    responses_path = (
        os.path.join(
            output_folder,
            "unit_responses.csv"
        )
    )

    log_path = (
        os.path.join(
            output_folder,
            "extraction_log.csv"
        )
    )

    write_csv(
        incidents_path,
        incidents,
        incident_fields
    )

    write_csv(
        responses_path,
        unit_responses,
        response_fields
    )

    write_csv(
        log_path,
        logs,
        log_fields
    )

    # ========================================================
    # SUMMARY STATISTICS
    # ========================================================

    agency_count = sum(
        1
        for row in unit_responses
        if row.get(
            "record_type"
        )
        == "agency_summary"
    )

    unit_count = sum(
        1
        for row in unit_responses
        if row.get(
            "record_type"
        )
        == "unit"
    )

    law_count = sum(
        1
        for row in unit_responses
        if row.get(
            "record_type"
        )
        == "law_enforcement"
    )

    towing_count = sum(
        1
        for row in unit_responses
        if row.get(
            "record_type"
        )
        == "towing"
    )

    backfilled_count = sum(
        1
        for row in unit_responses
        if row.get(
            "qa_time_status"
        )
        == "BACKFILLED_ORDER"
    )

    invalid_count = sum(
        1
        for row in unit_responses
        if row.get(
            "qa_time_status"
        )
        == "INVALID_ORDER"
    )

    # ========================================================
    # FINAL REPORT
    # ========================================================

    print()
    print(
        "================================"
    )

    print(
        "EXTRACTION COMPLETE"
    )

    print(
        "================================"
    )

    print(
        f"Incident IDs found: "
        f"{len(raw_ids)}"
    )

    print(
        f"Incidents extracted: "
        f"{len(incidents)}"
    )

    print(
        f"Unit responses extracted: "
        f"{len(unit_responses)}"
    )

    print()
    print(
        "Response classifications:"
    )

    print(
        f"  Apparatus / units: "
        f"{unit_count}"
    )

    print(
        f"  Agency summaries: "
        f"{agency_count}"
    )

    print(
        f"  Law enforcement: "
        f"{law_count}"
    )

    print(
        f"  Towing: "
        f"{towing_count}"
    )

    print()
    print(
        f"Backfilled time order: "
        f"{backfilled_count}"
    )

    print(
        f"Invalid time order: "
        f"{invalid_count}"
    )

    print()
    print(
        f"QA warnings: "
        f"{len(logs)}"
    )

    print(
        f"Skipped incidents: "
        f"{skipped}"
    )

    print()
    print(
        "Output folder:"
    )

    print(
        output_folder
    )

    return {
        "raw_ids":
            len(raw_ids),

        "incidents":
            len(incidents),

        "responses":
            len(unit_responses),

        "units":
            unit_count,

        "agency":
            agency_count,

        "law":
            law_count,

        "towing":
            towing_count,

        "backfilled":
            backfilled_count,

        "invalid":
            invalid_count,

        "warnings":
            len(logs),

        "skipped":
            skipped,

        "output":
            output_folder
    }



# ============================================================
# GUI
# ============================================================

def main():

    root = tk.Tk()

    root.withdraw()

    # --------------------------------------------------------
    # SELECT PDF
    # --------------------------------------------------------

    pdf_path = (
        filedialog.askopenfilename(
            title=(
                "Select Fire / EMS "
                "Daily Blotter PDF"
            ),
            filetypes=[
                (
                    "PDF Files",
                    "*.pdf"
                )
            ]
        )
    )

    if not pdf_path:
        return

    # --------------------------------------------------------
    # SOURCE GROUP
    # --------------------------------------------------------

    source_group = (
        simpledialog.askstring(
            "Source Type",
            "Enter FIRE or EMS:"
        )
    )

    if not source_group:
        return

    source_group = (
        source_group
        .strip()
        .upper()
    )

    if source_group not in {
        "FIRE",
        "EMS"
    }:

        messagebox.showerror(
            "Invalid Source",
            "Please enter FIRE or EMS."
        )

        return

    # --------------------------------------------------------
    # RUN EXTRACTION
    # --------------------------------------------------------

    try:

        result = process_pdf(
            pdf_path,
            source_group
        )

        message = (
            f"Incident IDs found: "
            f"{result['raw_ids']}\n\n"

            f"Incidents extracted: "
            f"{result['incidents']}\n"

            f"Unit responses: "
            f"{result['responses']}\n\n"

            f"Apparatus / units: "
            f"{result['units']}\n"

            f"Agency summaries: "
            f"{result['agency']}\n"

            f"Law enforcement: "
            f"{result['law']}\n"

            f"Towing: "
            f"{result['towing']}\n\n"

            f"Backfilled time order: "
            f"{result['backfilled']}\n"

            f"Invalid time order: "
            f"{result['invalid']}\n\n"

            f"QA warnings: "
            f"{result['warnings']}\n"

            f"Skipped incidents: "
            f"{result['skipped']}\n\n"

            f"Output folder:\n"
            f"{result['output']}"
        )

        messagebox.showinfo(
            "Extraction Complete",
            message
        )

    except Exception as error:

        messagebox.showerror(
            "Extraction Error",
            str(error)
        )

        raise


# ============================================================
# START
# ============================================================

if __name__ == "__main__":
    main()