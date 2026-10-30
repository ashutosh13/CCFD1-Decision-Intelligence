"""Raw blotter text (data/DailyBlotter/text/*.txt) -> one CSV row per incident.

Only header-level incident fields are mapped; narratives and unit tables are not.
Output contains PII (caller name, phone); it lives under git-ignored data/.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

COLUMNS = [
    "source_file", "page", "event", "create_datetime", "incident_no", "disposition", "case_nos",
    "phone", "caller_name", "created_by", "caller_location", "station", "event_location", "lat_long",
]

PAGE_RE = re.compile(r"^===== PAGE (\d+) =====$")
NOISE_RE = re.compile(
    r"^(Daily Blotter Print Date|Print Time|User Name:|Incidents Created From:|For Official Use Only|"
    r"\* Time is backfilled|\*\* Unit was)"
)
EVENT_RE = re.compile(r"^Event:\s*(?P<event>.*?)\s+Create Date/Time:\s*(?P<create_datetime>.*)$")
FIELD_RES = [
    re.compile(r"^Incident#:\s*(?P<incident_no>.*?)\s+Disposition:\s*(?P<disposition>.*)$"),
    re.compile(r"^Case#:\s*(?P<case_nos>.*?)\s+Phone:\s*(?P<phone>.*)$"),
    re.compile(r"^Caller Name:\s*(?P<caller_name>.*?)\s+Created By:\s*(?P<created_by>.*)$"),
    re.compile(r"^Caller Location:\s*(?P<caller_location>.*?)\s*Station:\s*(?P<station>.*)$"),
    re.compile(r"^Event Location:\s*(?P<event_location>.*)$"),
    re.compile(r"^Lat / Long:\s*(?P<lat_long>.*)$"),
]


def parse_text(text: str, source_file: str) -> list[dict]:
    rows: list[dict] = []
    row: dict | None = None
    page = 0
    for line in text.splitlines():
        line = line.strip()
        if m := PAGE_RE.match(line):
            page = int(m[1])
            continue
        if not line or NOISE_RE.match(line):
            continue
        if m := EVENT_RE.match(line):
            row = dict.fromkeys(COLUMNS, "")
            row.update(source_file=source_file, page=page, **m.groupdict())
            rows.append(row)
        elif row is not None:
            for rx in FIELD_RES:
                if m := rx.match(line):
                    row.update({k: v.strip() for k, v in m.groupdict().items()})
                    break
    return rows


def write_csv(text_path: Path, out_dir: Path) -> tuple[Path, int]:
    rows = parse_text(text_path.read_text(), text_path.stem + ".pdf")
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{text_path.stem}.csv"
    with out.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    return out, len(rows)
