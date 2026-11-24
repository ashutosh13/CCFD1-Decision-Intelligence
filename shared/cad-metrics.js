/* CCFD1 CAD metrics - the single definition of every number on the CAD & GIS analysis page
   (gis-map/). Pure functions over an in-memory dataset, so a future assistant tool can call
   the same functions (e.g. run(ds, "byHour", {group: "M"})) and get the same answers.
   Loads as a plain <script> (sets window.CCFD1Metrics) or with require() in Node.

   Two kinds of record, never mixed:
     incident       one row per CAD incident: counts, type, township, hour, day, area
     unit response  one row per apparatus on an incident: workload, time committed, response time
   Incident counts are never multiplied by the number of units that responded. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CCFD1Metrics = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------- Configuration (documented; edit here, nowhere else) ---------------- */

  const DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  /* Incident category by CAD event type. This is the classification the dashboard already
     publishes (shared/cad-gis.js points): recovered exactly from the published points, one
     category per event type, no conflicts. Event types not listed here are "U" (not yet
     classified) - no category is guessed for them.
     Known issue kept as published: "FALLS/ACCIDENTS MED" is in V (vehicle accident). */
  const EVENT_TYPE_CATEGORY = {
    "ABDOMINAL/BACK PAIN MED": "M", "ALLERGIC REACTION MED": "M", "ANIMAL BITE MED": "M", "CHEST PAIN MED": "M",
    "CHOKING/OBSTRUCTED AIRWAY MED": "M", "DIABETIC ISSUE MED": "M", "DIFFICULTY BREATHING MED": "M",
    "DROWNING MED": "M", "ENVIRONMENTAL MEDICAL EMERGENCIES": "M", "GENERAL SICKNESS/MEDICAL": "M",
    "JUVENILE MEDICAL": "M", "LIFT ASSIST MED": "M", "MEDICAL": "M", "NEUROLOGICAL/HEAD INJURIES MED": "M",
    "NON-TRAUMATIC BLEEDING MED": "M", "OVERDOSE MED": "M", "SEIZURES MED": "M", "STROKE MED": "M",
    "SUICIDAL SUBJECT": "M", "UNCONSCIOUS/SYNCOPE MED": "M", "UNKNOWN MEDICAL": "M", "UNRESPONSIVE MED": "M",
    "BURN COMPLAINT": "F", "CARBON MONOXIDE ALARM": "F", "CHEMICAL SPILL": "F", "FIELD FIRE": "F",
    "FIRE ALARM": "F", "FIRE GENERAL": "F", "GAS ODOR": "F", "GAS SPILL": "F", "STRUCTURE FIRE": "F",
    "TRAFFIC HAZARD": "F", "VEHICLE FIRE": "F",
    "ACCIDENT INJURIES": "V", "ACCIDENT PROPERTY DAMAGE": "V", "ACCIDENT UNKNOWN": "V", "FALLS/ACCIDENTS MED": "V",
    "911 HANG UP/MISDIAL": "O", "ANIMAL COMPLAINT": "O", "ATTEMPT TO LOCATE": "O", "DISORDERLY CONDUCT": "O",
    "DOMESTIC": "O", "ESCORT": "O", "HIGH WATER": "O", "INTOXICATED PERSON": "O", "JUVENILE PROBLEMS": "O",
    "MISSING PERSON": "O", "RECKLESS DRIVING": "O", "SERVICE CALL": "O", "SUSPISCIOUS CIRCUMSTANCE": "O",
    "TEST CALL": "O", "TRAIN INCIDENT": "O", "WARRANT SERVICE": "O"
  };
  /* Labels match the dashboard map legend (shared/cad-gis.js CATEGORIES); U added here. */
  const CATEGORY_LABEL = {M: "Medical", F: "Fire / hazard", V: "Vehicle accident", O: "Other", U: "Not yet classified"};
  const CATEGORY_ORDER = ["M", "F", "V", "O", "U"];

  /* Service area, by township: the definition behind the dashboard's published counts
     (Inside the District = Clay, Noble, Eel; Contract = Washington; everything else outside). */
  const SERVICE_AREA = {
    district: ["Clay Township", "Noble Township", "Eel Township"],
    contract: ["Washington Township"]
  };
  const AREA_LABEL = {
    district: "Inside: CCFD1 district (Clay, Noble, Eel)", contract: "Inside: Washington Twp. (contract)",
    outside: "Outside CCFD1 service area", unknown: "No location in CAD"
  };

  /* CAD agency codes. Only DIST is defined by the project (CCFD1 = CAD agency "DIST");
     the others are expansions of the code and are marked as assumed. */
  const AGENCY = {
    DIST: {name: "CCFD1", basis: "project definition"},
    LFD: {name: "Logansport Fire", basis: "assumed from CAD code"},
    CCEMS: {name: "Cass County EMS", basis: "assumed from CAD code"}
  };
  const HOME_AGENCY = "DIST";

  /* Logansport Fire: grouped by the single CAD code LFD. One source row carries the combined
     code "LFD GTFD" (two agencies in one cell); it is kept as its own code, not added to LFD.
     The City of Logansport lies in Eel Township; city limits are not in the project, so Eel
     Township results include LFD's own city calls and are reported separately. */
  const MUTUAL_AID = {logansport: {orgs: ["LFD"], cityTownship: "Eel Township"}};

  /* Apparatus names are preserved as recorded. Pairs below look like possible duplicates; they
     are NOT merged (no approved normalization exists) and are flagged on the page. */
  const UNIT_FLAGS = [
    {org: "DIST", units: ["TK201", "TANK201"], note: "Possibly the same apparatus recorded two ways; kept separate until CCFD1 confirms."},
    {org: "LFD", units: ["EMERGENCY 10"], note: "Unit name may be truncated in the source; kept as recorded."}
  ];

  /* Stations for the coverage tool, as {name, lat, lng, source}. Coordinates are stored here once;
     the page never geocodes. CCFD1: geocoded 2026-11-24 from "1444 Holland St, Logansport, IN 46947".
     U.S. Census Geocoder (TIGER address range 1400-1450, right side) -> 40.762348, -86.382863;
     OpenStreetMap Nominatim (same address) -> 40.762298, -86.382830; the two agree within ~6 m.
     Both are address-range points, not a surveyed building point: OSM has no fire-station feature here. */
  const STATIONS = [{
    name: "CCFD1 Station", full: "Cass County Fire District No. 1",
    address: ["1444 Holland St", "Logansport, IN 46947"],
    lat: 40.76235, lng: -86.38286,
    source: "U.S. Census Geocoder, cross-checked with OpenStreetMap (2026-11-24)"
  }];

  /* Road-network drive-time areas: public Valhalla server (OpenStreetMap data), no API key, no
     cost. Standard passenger-car speeds; not adjusted for emergency driving or turnout time.
     The page calls it only when the user asks, and sends only the station coordinates. */
  const TRAVEL_TIME = {
    url: "https://valhalla1.openstreetmap.de/isochrone", costing: "auto", contours: [4, 6, 8, 12],
    bands: ["≤ 4 min", "> 4–6 min", "> 6–8 min", "> 8–12 min", "> 12 min"]
  };

  /* ---------------- Helpers ---------------- */
  const categoryOf = type => EVENT_TYPE_CATEGORY[type] || "U";
  function areaOf(township, located) {
    if (!located) return "unknown";
    if (SERVICE_AREA.district.includes(township)) return "district";
    if (SERVICE_AREA.contract.includes(township)) return "contract";
    return "outside";
  }
  const isInside = a => a === "district" || a === "contract";
  /* "YYYY-MM-DD HH:MM:SS" -> ms. Durations only, so the time zone does not matter. */
  function ts(s) {
    if (!s || s.length < 19) return null;
    const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19));
    return isNaN(t) ? null : t;
  }
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const pct = (k, n) => n ? k / n * 100 : null;
  const isExtractionErrorType = (t, orgs) => /^\d{1,2}-[A-Za-z]{3}-\d{2}/.test(t) || orgs.has(t);

  /* ---------------- Dataset ---------------- */

  /* detail = data/cad-gis-detail.json (pipeline/build_gis_detail.py). Built once per page load. */
  function prepare(detail) {
    const col = c => Object.fromEntries(c.map((k, i) => [k, i]));
    const I = col(detail.incidents.columns), U = col(detail.units.columns);
    const incidents = detail.incidents.rows.map((r, i) => {
      const lat = r[I.lat], lng = r[I.lng], located = lat != null && lng != null, type = r[I.type];
      const dt = r[I.datetime] || "";
      return {
        i, id: r[I.id], datetime: dt || null, date: r[I.date] || (dt ? dt.slice(0, 10) : null),
        hour: r[I.hour], dow: r[I.dow] || null, type: type || null, category: categoryOf(type),
        disposition: r[I.disposition] || null, lat, lng, located, coordStatus: r[I.coord_status] || null,
        sourceGroups: r[I.source_groups] || null, township: r[I.township] || null,
        townshipSource: located ? "location" : null, area: areaOf(r[I.township], located),
        units: [], orgs: new Set(), unitKeys: new Set()
      };
    });
    const byId = new Map(incidents.map(x => [x.id, x]));
    const units = detail.units.rows.map((r, j) => {
      const u = {
        j, incidentId: r[U.incident_id], unit: r[U.unit], org: r[U.org], recordType: r[U.record_type],
        temp: r[U.temp_assigned], dispatch: r[U.dispatch] || null, enroute: r[U.enroute] || null,
        onscene: r[U.onscene] || null, clear: r[U.clear] || null, backfilled: r[U.backfilled] || "",
        responseS: r[U.response_s], commitmentMin: r[U.commitment_min], anomalies: r[U.anomalies] || "", qa: r[U.qa_status]
      };
      u.key = u.org + "|" + u.unit;
      u.isApparatus = u.recordType === "unit";
      const ordered = !u.anomalies;
      /* time committed = clear - dispatch; response = dispatch -> on scene; scene = on scene -> clear.
         Rows with any out-of-order timestamp are excluded from all three (source values kept). */
      u.commitValid = u.isApparatus && ordered && !!u.dispatch && !!u.clear && u.commitmentMin != null && u.commitmentMin >= 0;
      u.responseValid = u.isApparatus && ordered && !!u.dispatch && !!u.onscene && u.responseS != null && u.responseS >= 0;
      const os = ts(u.onscene), cl = ts(u.clear);
      u.sceneMin = u.isApparatus && ordered && os != null && cl != null && cl >= os ? (cl - os) / 60000 : null;
      u.dispatchMs = ts(u.dispatch); u.clearMs = cl;
      const inc = byId.get(u.incidentId);
      if (inc) { inc.units.push(u); inc.orgs.add(u.org); if (u.isApparatus) inc.unitKeys.add(u.key); }
      return u;
    });
    return finish({meta: detail.meta || {}, incidents, units, hasDetail: true});
  }

  /* Fallback when the detailed file is not present (e.g. the published site): the de-identified
     CCFD1 layer from shared/cad-gis.js - location and category only. Every other metric is N/A. */
  function fromPublished(gis) {
    const incidents = gis.records().map((r, i) => ({
      i, id: r.id != null ? r.id : null, datetime: null, date: null, hour: null, dow: null, type: null,
      category: r.category, disposition: null, lat: r.lat, lng: r.lng, located: true, coordStatus: null,
      sourceGroups: null, township: r.township, townshipSource: r.townshipSource, area: areaOf(r.township, true),
      units: [], orgs: new Set([HOME_AGENCY]), unitKeys: new Set()
    }));
    return finish({meta: {period: null, published: true, unlocated: gis.incidentsTotal - incidents.length}, incidents, units: [], hasDetail: false});
  }

  function finish(ds) {
    const count = (arr, f) => { const m = new Map(); arr.forEach(x => { const k = f(x); if (k != null && k !== "") m.set(k, (m.get(k) || 0) + 1); }); return m; };
    const orgSet = new Set(ds.units.map(u => u.org));
    ds.options = {
      types: count(ds.incidents, x => x.type),
      orgs: count(ds.units, u => u.org),
      units: count(ds.units.filter(u => u.isApparatus), u => u.key),
      dates: ds.incidents.map(x => x.date).filter(Boolean).sort()
    };
    ds.qa = {
      unclassifiedTypes: [...ds.options.types].filter(([t]) => categoryOf(t) === "U").sort((a, b) => b[1] - a[1]),
      extractionErrorTypes: [...ds.options.types].filter(([t]) => isExtractionErrorType(t, orgSet)),
      unlocated: ds.incidents.filter(x => !x.located).length,
      outsideBoundaries: ds.incidents.filter(x => x.located && !x.township).length,
      apparatusRows: ds.units.filter(u => u.isApparatus).length,
      timeOrderExcluded: ds.units.filter(u => u.isApparatus && u.anomalies).length,
      dispatchBackfilled: ds.units.filter(u => u.isApparatus && u.backfilled.includes("D")).length,
      unitFlags: UNIT_FLAGS.filter(f => f.units.some(n => ds.options.units.has(f.org + "|" + n)))
    };
    return ds;
  }

  /* ---------------- Filtering ----------------
     f = {township, type, group, start, end, dow, hourFrom, hourTo, agency, unit, area}
     township "__outside__" = located but outside every township boundary.
     hourFrom > hourTo wraps midnight (e.g. 18 -> 6). area: inside|district|contract|outside|unknown. */
  function predicate(f = {}) {
    const hf = f.hourFrom == null || f.hourFrom === "" ? null : +f.hourFrom;
    const ht = f.hourTo == null || f.hourTo === "" ? null : +f.hourTo;
    return inc => {
      if (f.township) {
        if (f.township === "__outside__") { if (!inc.located || inc.township) return false; }
        else if (inc.township !== f.township) return false;
      }
      if (f.type && inc.type !== f.type) return false;
      if (f.group && inc.category !== f.group) return false;
      if (f.start && !(inc.date && inc.date >= f.start)) return false;
      if (f.end && !(inc.date && inc.date <= f.end)) return false;
      if (f.dow && inc.dow !== f.dow) return false;
      if (hf != null || ht != null) {
        const h = inc.hour, a = hf == null ? 0 : hf, b = ht == null ? 23 : ht;
        if (h == null) return false;
        if (a <= b ? (h < a || h > b) : (h < a && h > b)) return false;
      }
      if (f.agency && !inc.orgs.has(f.agency)) return false;
      if (f.unit && !inc.unitKeys.has(f.unit)) return false;
      if (f.area) {
        if (f.area === "inside") { if (!isInside(inc.area)) return false; }
        else if (inc.area !== f.area) return false;
      }
      return true;
    };
  }
  const filterIncidents = (ds, f) => ds.incidents.filter(predicate(f));

  /* Apparatus rows in scope: apparatus (record_type "unit") on the given incidents, limited to
     the agency / unit filter when set. Agency-summary, law-enforcement and towing rows are never
     apparatus. */
  function apparatusRows(incs, f = {}) {
    const out = [];
    for (const inc of incs) for (const u of inc.units) {
      if (!u.isApparatus) continue;
      if (f.agency && u.org !== f.agency) continue;
      if (f.unit && u.key !== f.unit) continue;
      out.push(u);
    }
    return out;
  }
  /* Time committed to one call: first dispatch -> last clear across its in-scope apparatus
     with valid times. null if none. */
  function callMinutes(inc, f) {
    let d = Infinity, c = -Infinity;
    for (const u of inc.units) {
      if (!u.commitValid || (f.agency && u.org !== f.agency) || (f.unit && u.key !== f.unit)) continue;
      if (u.dispatchMs < d) d = u.dispatchMs;
      if (u.clearMs > c) c = u.clearMs;
    }
    return d === Infinity ? null : (c - d) / 60000;
  }

  /* ---------------- Metrics ---------------- */

  function summary(ds, incs, f = {}) {
    const byCat = Object.fromEntries(CATEGORY_ORDER.map(c => [c, 0]));
    const byArea = {district: 0, contract: 0, outside: 0, unknown: 0};
    incs.forEach(x => { byCat[x.category]++; byArea[x.area]++; });
    const rows = apparatusRows(incs, f);
    const resp = rows.filter(u => u.responseValid).map(u => u.responseS / 60);
    const calls = incs.map(x => callMinutes(x, f)).filter(m => m != null);
    const located = incs.length - byArea.unknown;
    return {
      incidents: incs.length, byCategory: byCat, byArea, located,
      outsidePctOfAll: pct(byArea.outside, incs.length), outsidePctOfLocated: pct(byArea.outside, located),
      apparatusResponses: ds.hasDetail ? rows.length : null,
      avgResponseMin: mean(resp), medianResponseMin: median(resp), responseN: resp.length,
      avgCallMin: mean(calls), medianCallMin: median(calls), callsWithTimes: calls.length,
      dispatchBackfilledPct: pct(rows.filter(u => u.backfilled.includes("D")).length, rows.length)
    };
  }

  /* Incident counts by hour of call creation, per category (incident count, not unit count). */
  function byHour(ds, incs) {
    const s = Object.fromEntries(CATEGORY_ORDER.map(c => [c, Array(24).fill(0)]));
    const total = Array(24).fill(0); let missing = 0;
    incs.forEach(x => { if (x.hour == null || x.hour < 0 || x.hour > 23) { missing++; return; } s[x.category][x.hour]++; total[x.hour]++; });
    return {hours: [...Array(24).keys()], series: s, total, missing};
  }
  function byDayOfWeek(ds, incs) {
    const s = Object.fromEntries(CATEGORY_ORDER.map(c => [c, Array(7).fill(0)]));
    const total = Array(7).fill(0); let missing = 0;
    incs.forEach(x => { const d = DOW.indexOf(x.dow); if (d < 0) { missing++; return; } s[x.category][d]++; total[d]++; });
    return {days: DOW, series: s, total, missing};
  }

  /* Time on calls, by category. Per call = first dispatch -> last clear of in-scope apparatus.
     Unit-hours = sum of each apparatus's clear - dispatch. */
  function timeOnCall(ds, incs, f = {}) {
    const out = {};
    for (const c of CATEGORY_ORDER) {
      const ci = incs.filter(x => x.category === c);
      const calls = ci.map(x => callMinutes(x, f)).filter(m => m != null);
      const rows = apparatusRows(ci, f), valid = rows.filter(u => u.commitValid);
      out[c] = {
        calls: ci.length, callsWithTimes: calls.length,
        avgCallMin: mean(calls), medianCallMin: median(calls), callHours: calls.reduce((s, m) => s + m, 0) / 60,
        apparatusResponses: rows.length, apparatusWithTimes: valid.length,
        unitHours: valid.reduce((s, u) => s + u.commitmentMin, 0) / 60, avgUnitMin: mean(valid.map(u => u.commitmentMin))
      };
    }
    return out;
  }

  /* Calls outside the CCFD1 service area (township-based; see SERVICE_AREA). */
  function outsideArea(ds, incs, f = {}) {
    const s = summary(ds, incs, f);
    const outside = incs.filter(x => x.area === "outside");
    return {
      total: incs.length, located: s.located, byArea: s.byArea,
      outside: outside.length, pctOfAll: s.outsidePctOfAll, pctOfLocated: s.outsidePctOfLocated,
      time: timeOnCall(ds, outside, f),
      byTownship: [...outside.reduce((m, x) => m.set(x.township || "Outside township boundaries", (m.get(x.township || "Outside township boundaries") || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1])
    };
  }

  /* Busiest apparatus: one row per (agency, unit name) as recorded. */
  function apparatus(ds, incs, f = {}) {
    const m = new Map();
    for (const u of apparatusRows(incs, f)) {
      let a = m.get(u.key);
      if (!a) m.set(u.key, a = {key: u.key, unit: u.unit, org: u.org, responses: 0, commit: [], resp: [], backfilled: 0});
      a.responses++;
      if (u.commitValid) a.commit.push(u.commitmentMin);
      if (u.responseValid) a.resp.push(u.responseS / 60);
      if (u.backfilled.includes("D")) a.backfilled++;
    }
    return [...m.values()].map(a => {
      const flag = UNIT_FLAGS.find(x => x.org === a.org && x.units.includes(a.unit));
      return {
        key: a.key, unit: a.unit, org: a.org, responses: a.responses, withTimes: a.commit.length,
        hours: a.commit.reduce((s, x) => s + x, 0) / 60, avgMin: mean(a.commit),
        avgResponseMin: mean(a.resp), responseN: a.resp.length,
        dispatchBackfilledPct: pct(a.backfilled, a.responses), flag: flag ? flag.note : null
      };
    }).sort((x, y) => y.responses - x.responses || y.hours - x.hours);
  }

  /* Logansport Fire (or another aid agency) in the CCFD1 area. Applies every filter except
     Agency and Inside/Outside, which this question fixes itself. */
  function mutualAid(ds, f = {}, cfg = MUTUAL_AID.logansport) {
    const base = filterIncidents(ds, Object.assign({}, f, {agency: "", unit: "", area: ""}));
    const orgs = new Set(cfg.orgs);
    const hit = base.filter(x => [...x.orgs].some(o => orgs.has(o)));
    const bucket = x => !isInside(x.area) ? x.area : x.township === cfg.cityTownship ? "cityTownship" : "insideExCity";
    const out = {};
    for (const b of ["insideExCity", "cityTownship", "outside", "unknown"]) {
      const bi = hit.filter(x => bucket(x) === b);
      const rows = []; bi.forEach(x => x.units.forEach(u => { if (u.isApparatus && orgs.has(u.org)) rows.push(u); }));
      const valid = rows.filter(u => u.commitValid), scene = rows.map(u => u.sceneMin).filter(m => m != null);
      out[b] = {
        incidents: bi.length, withHomeAgency: bi.filter(x => x.orgs.has(HOME_AGENCY)).length,
        apparatusResponses: rows.length, apparatusWithTimes: valid.length,
        unitHours: valid.reduce((s, u) => s + u.commitmentMin, 0) / 60, avgUnitMin: mean(valid.map(u => u.commitmentMin)),
        avgSceneMin: mean(scene), sceneN: scene.length,
        byTownship: [...bi.reduce((m, x) => m.set(x.township || "-", (m.get(x.township || "-") || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])
      };
    }
    return {orgs: cfg.orgs, cityTownship: cfg.cityTownship, incidents: hit.length, buckets: out};
  }

  /* ---------------- Station coverage ----------------
     contours: GeoJSON features from the travel-time service, each with properties.contour (min).
     Returns a band index per incident (0..3 = within 4/6/8/12 min, 4 = beyond, null = no location).
     Computed once per station location; filters only recount. */
  function inRing(x, y, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function inGeometry(lng, lat, g) {
    const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
    return polys.some(r => inRing(lng, lat, r[0]) && !r.slice(1).some(h => inRing(lng, lat, h)));
  }
  function assignBands(ds, contours) {
    const sorted = [...contours].sort((a, b) => a.properties.contour - b.properties.contour);
    const limits = TRAVEL_TIME.contours;
    const bands = new Array(ds.incidents.length).fill(null);
    for (const x of ds.incidents) {
      if (!x.located) continue;
      let b = limits.length;
      for (const c of sorted) {
        if (inGeometry(x.lng, x.lat, c.geometry)) { b = limits.indexOf(c.properties.contour); break; }
      }
      bands[x.i] = b < 0 ? limits.length : b;
    }
    return bands;
  }
  function coverage(ds, incs, bands) {
    const rows = TRAVEL_TIME.bands.map(label => ({label, incidents: 0, M: 0, F: 0, V: 0, O: 0, U: 0}));
    let located = 0, unlocated = 0;
    incs.forEach(x => {
      const b = bands[x.i];
      if (b == null) { unlocated++; return; }
      located++; rows[b].incidents++; rows[b][x.category]++;
    });
    let cum = 0;
    rows.forEach(r => { r.pct = pct(r.incidents, located); cum += r.incidents; r.cumulativePct = pct(cum, located); });
    return {rows, located, unlocated};
  }

  /* ---------------- Query entry point for tools / an assistant ---------------- */
  const METRICS = {summary, byHour, byDayOfWeek, timeOnCall, outsideArea, apparatus};
  function run(ds, metric, f = {}) {
    if (metric === "mutualAid") return mutualAid(ds, f);
    const fn = METRICS[metric];
    if (!fn) throw new Error("Unknown metric: " + metric + ". Use one of " + Object.keys(METRICS).concat("mutualAid").join(", "));
    return fn(ds, filterIncidents(ds, f), f);
  }

  return {
    DOW, EVENT_TYPE_CATEGORY, CATEGORY_LABEL, CATEGORY_ORDER, SERVICE_AREA, AREA_LABEL, AGENCY, HOME_AGENCY,
    MUTUAL_AID, UNIT_FLAGS, STATIONS, TRAVEL_TIME,
    categoryOf, areaOf, prepare, fromPublished, predicate, filterIncidents, apparatusRows, callMinutes,
    summary, byHour, byDayOfWeek, timeOnCall, outsideArea, apparatus, mutualAid, assignBands, coverage, run
  };
});
