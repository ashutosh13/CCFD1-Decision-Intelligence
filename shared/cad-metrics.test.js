/* Run with:  node --test shared/cad-metrics.test.js   (Node 18+; built-in modules only)
   Synthetic fixture tests always run. Real-data checks run only when the local, git-ignored
   data/cad-gis-detail.json exists (pipeline/build_gis_detail.py). */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const M = require("./cad-metrics.js");
const GIS = require("./cad-gis.js");

/* ---------- fixture: 4 incidents, 7 response rows ---------- */
const IC = ["id", "datetime", "date", "hour", "dow", "type", "disposition", "lat", "lng", "coord_status", "cad_station", "source_groups", "township"];
const UC = ["incident_id", "unit", "org", "record_type", "temp_assigned", "dispatch", "enroute", "onscene", "clear", "backfilled",
  "turnout_s", "travel_s", "response_s", "commitment_min", "anomalies", "qa_status"];
const FIX = {
  meta: {},
  incidents: {columns: IC, rows: [
    ["A", "2026-01-05 08:10:00", "2026-01-05", 8, "Monday", "CHEST PAIN MED", "C", 40.79, -86.35, "VALID", "001", "EMS;FIRE", "Noble Township"],
    ["B", "2026-01-06 22:00:00", "2026-01-06", 22, "Tuesday", "STRUCTURE FIRE", "C", 40.8, -86.5, "VALID", "002", "FIRE", "Jefferson Township"],
    ["C", "2026-01-07 03:00:00", "2026-01-07", 3, "Wednesday", "EMS TRANSPORT SERVICE", "C", null, null, "SOURCE_MISSING", "003", "EMS", null],
    ["D", "2026-01-08 12:00:00", "2026-01-08", 12, "Thursday", "FIRE ALARM", "C", 40.75, -86.37, "VALID", "001", "FIRE", "Eel Township"]
  ]},
  units: {columns: UC, rows: [
    // A: CCFD1 agency row + 2 apparatus (incident must still count once)
    ["A", "DIST", "DIST", "agency_summary", false, "2026-01-05 08:11:00", "", "", "2026-01-05 08:40:00", "D", null, null, null, 29, "", "PARTIAL"],
    ["A", "CAR202", "DIST", "unit", false, "2026-01-05 08:11:00", "2026-01-05 08:13:00", "2026-01-05 08:17:00", "2026-01-05 08:41:00", "D", 120, 240, 360, 30, "", "PASS"],
    ["A", "ENG201", "DIST", "unit", false, "2026-01-05 08:12:00", "2026-01-05 08:14:00", "2026-01-05 08:20:00", "2026-01-05 08:52:00", "", 120, 360, 480, 40, "", "PASS"],
    // B: CCFD1 outside the area; one row with out-of-order times (excluded from time metrics)
    ["B", "ENG201", "DIST", "unit", false, "2026-01-06 22:01:00", "", "2026-01-06 22:10:00", "2026-01-06 23:01:00", "", null, null, 540, 60, "", "PARTIAL"],
    ["B", "TANK201", "DIST", "unit", false, "2026-01-06 22:05:00", "", "2026-01-06 23:30:00", "2026-01-06 23:00:00", "", null, null, 5100, 55, "clear_before_onscene", "REVIEW_TIME_ORDER"],
    // C: EMS only, no location; D: Logansport in Eel (city township)
    ["C", "MED1", "CCEMS", "unit", false, "2026-01-07 03:01:00", "", "", "2026-01-07 03:31:00", "D", null, null, null, 30, "", "PARTIAL"],
    ["D", "ENG101", "LFD", "unit", false, "2026-01-08 12:01:00", "", "2026-01-08 12:05:00", "2026-01-08 12:21:00", "D", null, null, 240, 20, "", "PARTIAL"]
  ]}
};
const ds = M.prepare(FIX);

test("classification: existing published mapping only; unknown types are 'U', never guessed", () => {
  assert.equal(M.categoryOf("CHEST PAIN MED"), "M");
  assert.equal(M.categoryOf("FALLS/ACCIDENTS MED"), "V");        // kept as published (flagged in docs)
  assert.equal(M.categoryOf("EMS TRANSPORT SERVICE"), "U");
  assert.equal(M.categoryOf("SHOTS FIRED"), "U");                // no keyword guessing
  for (const [c, lab] of Object.entries(GIS.CATEGORIES)) assert.equal(M.CATEGORY_LABEL[c], lab.label);
});

test("incident counts are not multiplied by responding units", () => {
  const incs = M.filterIncidents(ds, {agency: "DIST"});
  assert.deepEqual(incs.map(x => x.id), ["A", "B"]);
  const s = M.summary(ds, incs, {agency: "DIST"});
  assert.equal(s.incidents, 2);
  assert.equal(s.apparatusResponses, 4);                         // agency_summary row is not apparatus
  assert.equal(M.byHour(ds, incs).total.reduce((a, b) => a + b), 2);
});

test("time metrics: out-of-order rows excluded, backfilled dispatch kept, missing is null not zero", () => {
  const incs = M.filterIncidents(ds, {agency: "DIST"});
  const t = M.timeOnCall(ds, incs, {agency: "DIST"});
  assert.equal(t.M.callsWithTimes, 1);
  assert.equal(t.M.avgCallMin, 41);                              // 08:11 -> 08:52 across both apparatus
  assert.equal(t.F.apparatusResponses, 2);
  assert.equal(t.F.apparatusWithTimes, 1);                       // TANK201 excluded (clear before on scene)
  assert.equal(t.F.unitHours, 1);
  assert.equal(t.V.avgCallMin, null);
  const s = M.summary(ds, M.filterIncidents(ds, {agency: "LFD"}), {agency: "LFD"});
  assert.equal(s.avgResponseMin, 4);
});

test("filters combine; hour range wraps midnight; area and township", () => {
  assert.deepEqual(M.filterIncidents(ds, {hourFrom: 20, hourTo: 4}).map(x => x.id), ["B", "C"]);
  assert.deepEqual(M.filterIncidents(ds, {area: "outside"}).map(x => x.id), ["B"]);
  assert.deepEqual(M.filterIncidents(ds, {area: "unknown"}).map(x => x.id), ["C"]);
  assert.deepEqual(M.filterIncidents(ds, {area: "inside", group: "F"}).map(x => x.id), ["D"]);
  assert.deepEqual(M.filterIncidents(ds, {unit: "DIST|ENG201", dow: "Tuesday"}).map(x => x.id), ["B"]);
  assert.deepEqual(M.filterIncidents(ds, {start: "2026-01-06", end: "2026-01-07"}).map(x => x.id), ["B", "C"]);
});

test("outside area, apparatus ranking and flags, mutual aid buckets", () => {
  const o = M.outsideArea(ds, M.filterIncidents(ds, {agency: "DIST"}), {agency: "DIST"});
  assert.equal(o.outside, 1); assert.equal(o.pctOfAll, 50);
  const a = M.apparatus(ds, M.filterIncidents(ds, {agency: "DIST"}), {agency: "DIST"});
  assert.deepEqual(a.map(x => [x.unit, x.responses]), [["ENG201", 2], ["CAR202", 1], ["TANK201", 1]]);
  assert.ok(a.find(x => x.unit === "TANK201").flag);
  const ma = M.mutualAid(ds, {agency: "DIST"});                  // agency filter is ignored here
  assert.equal(ma.buckets.cityTownship.incidents, 1);
  assert.equal(ma.buckets.insideExCity.incidents, 0);
  assert.equal(ma.buckets.cityTownship.avgSceneMin, 16);
});

test("coverage bands from travel-time polygons; unlocated incidents reported separately", () => {
  const sq = (d, t) => ({properties: {contour: t}, geometry: {type: "Polygon", coordinates: [[[-86.35 - d, 40.79 - d], [-86.35 + d, 40.79 - d], [-86.35 + d, 40.79 + d], [-86.35 - d, 40.79 + d], [-86.35 - d, 40.79 - d]]]}});
  const bands = M.assignBands(ds, [sq(0.01, 4), sq(0.03, 6), sq(0.05, 8), sq(0.1, 12)]);
  assert.deepEqual(bands, [0, 4, null, 2]);
  const c = M.coverage(ds, ds.incidents, bands);
  assert.equal(c.unlocated, 1);
  assert.deepEqual(c.rows.map(r => r.incidents), [1, 0, 1, 0, 1]);
  assert.ok(Math.abs(c.rows[2].cumulativePct - 200 / 3) < 1e-9);
});

test("published fallback: location + category only, everything else N/A", () => {
  const p = M.fromPublished(GIS);
  assert.equal(p.incidents.length, GIS.incidentPoints.length);
  const s = M.summary(p, p.incidents, {});
  assert.equal(s.apparatusResponses, null);
  assert.equal(s.avgCallMin, null);
  assert.equal(M.byHour(p, p.incidents).missing, p.incidents.length);
});

test("run(): named metrics for tools", () => {
  assert.equal(M.run(ds, "summary", {group: "M"}).incidents, 1);
  assert.throws(() => M.run(ds, "nope"), /Unknown metric/);
});

/* ---------- real data (local only) ---------- */
const DETAIL = path.join(__dirname, "..", "data", "cad-gis-detail.json");
test("real CAD extract reproduces the dashboard's verified CCFD1 facts", {skip: !fs.existsSync(DETAIL) && "local data/cad-gis-detail.json not present"}, () => {
  const facts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "facts.json"), "utf8")).facts;
  const fact = id => facts.find(f => f.id === id).value;
  const real = M.prepare(JSON.parse(fs.readFileSync(DETAIL, "utf8")));
  const incs = M.filterIncidents(real, {agency: "DIST"});
  assert.equal(incs.length, fact("cad.incidents"));
  assert.equal(incs.filter(x => x.located).length, fact("cad.mapped_points"));
  assert.deepEqual(M.byHour(real, incs).total, [...Array(24).keys()].map(h => fact("cad.hourly." + String(h).padStart(2, "0"))));
  const s = M.summary(real, incs, {agency: "DIST"});
  assert.equal(s.byArea.contract, fact("cad.location.1"));
  assert.equal(s.byArea.unknown, fact("cad.location.3"));
  assert.ok(Math.abs(s.byArea.district - fact("cad.location.0")) <= 2);   // simplified boundaries
  // published categories (mapped CCFD1 points) are reproduced exactly
  const pub = {M: 0, F: 0, V: 0, O: 0}; GIS.incidentPoints.forEach(p => pub[p[2]]++);
  const mine = {M: 0, F: 0, V: 0, O: 0}; incs.filter(x => x.located).forEach(x => mine[x.category]++);
  assert.deepEqual(mine, pub);
});
