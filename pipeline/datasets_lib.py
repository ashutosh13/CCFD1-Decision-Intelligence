"""Write aggregate-only datasets for datasets/ (read by shared/dataset.js).

Mirrors the checks in shared/dataset.js validateDataset. A row may hold only the declared dimension and
measure columns (plus an optional _status), so record-level fields (incident numbers, addresses, names)
cannot be written by accident. Output is counts and file names only, never row values.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

STATUSES = ["verified", "partner_stated", "model_output", "placeholder"]  # strongest -> weakest
TYPES = ("int", "string")
REQUIRED_TEXT = ("id", "title", "grain", "period", "source", "source_detail")
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "datasets.candidate"


def validate(ds: dict) -> list[str]:
    errs = [f"{k} must be a non-empty string" for k in REQUIRED_TEXT if not isinstance(ds.get(k), str) or not ds.get(k)]
    if isinstance(ds.get("id"), str) and not re.fullmatch(r"[a-z][a-z0-9_]*", ds["id"]):
        errs.append("id must be lowercase letters, digits and underscores")
    if ds.get("status") not in STATUSES:
        errs.append(f"status must be one of {STATUSES}")
    dims, meas, rows = ds.get("dimensions"), ds.get("measures"), ds.get("rows")
    if not dims or not meas or not isinstance(rows, list):
        return errs + ["dimensions, measures and rows are required"]
    names: set[str] = set()
    for d in dims:
        if d.get("type") not in TYPES or not isinstance(d.get("name"), str):
            errs.append(f"dimension needs a name and type in {TYPES}")
        elif d["name"] in names:
            errs.append(f"duplicate column {d['name']}")
        else:
            names.add(d["name"])
    for m in meas:
        if not isinstance(m.get("name"), str) or not isinstance(m.get("unit"), str):
            errs.append("measure needs a name and unit")
        elif m["name"] in names:
            errs.append(f"duplicate column {m['name']}")
        else:
            names.add(m["name"])
    if errs:
        return errs
    seen = set()
    for i, r in enumerate(rows):
        for k in r:
            if k not in names and k != "_status":
                errs.append(f"row {i}: unexpected field {k}")
        for d in dims:
            v = r.get(d["name"])
            ok = (isinstance(v, int) and not isinstance(v, bool)) if d["type"] == "int" else isinstance(v, str)
            if not ok:
                errs.append(f"row {i}: {d['name']} must be {d['type']}")
        for m in meas:
            v = r.get(m["name"])
            if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))):
                errs.append(f"row {i}: {m['name']} must be a number or null")
        if r.get("_status") is not None and r["_status"] not in STATUSES:
            errs.append(f"row {i}: bad _status")
        key = tuple(r.get(d["name"]) for d in dims)
        if key in seen:
            errs.append(f"row {i}: duplicate dimension values")
        seen.add(key)
    return errs


def write_dataset(ds: dict, out_dir: Path = DEFAULT_DIR) -> Path:
    errs = validate(ds)
    if errs:
        raise ValueError(f"dataset {ds.get('id')!r} invalid ({len(errs)} problems): {errs[:3]}")
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{ds['id']}.json"
    path.write_text(json.dumps(ds, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def write_manifest(out_dir: Path = DEFAULT_DIR) -> Path:
    """Rebuild index.json from every dataset file in out_dir."""
    entries = []
    for p in sorted(out_dir.glob("*.json")):
        if p.name == "index.json":
            continue
        ds = json.loads(p.read_text(encoding="utf-8"))
        errs = validate(ds)
        if errs:
            raise ValueError(f"{p.name} invalid: {errs[0]}")
        entries.append({"id": ds["id"], "title": ds["title"], "file": p.name, "panel": ds.get("panel"),
                        "grain": ds["grain"], "period": ds["period"], "status": ds["status"],
                        "dimensions": [d["name"] for d in ds["dimensions"]],
                        "measures": [m["name"] for m in ds["measures"]], "rows": len(ds["rows"])})
    path = out_dir / "index.json"
    path.write_text(json.dumps({"datasets": entries}, indent=2) + "\n", encoding="utf-8")
    return path
