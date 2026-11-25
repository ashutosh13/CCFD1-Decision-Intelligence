/* Run with:  node --test assistant/chart.test.js   Synthetic fixtures only. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../shared/dataset.js");
const { createTools, runTool } = require("./tools.js");

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function fixtureRows() {
  const rows = []; let n = 0;
  for (let i = 0; i < 240; i++) {
    const sg = (i + Math.floor(i / 24)) % 3 === 0 ? "Fire" : "EMS";
    rows.push({ hour: i % 24, weekday: DAYS[i % 7], month: 1 + (i % 12), source_group: sg, call_category: sg === "Fire" ? "Fire" : "Medical",
      in_district: i % 8 === 0 ? "outside" : "unknown", township: "unknown", incidents: 1, duration_min: i % 10 === 0 ? null : 20 + (i % 5) * (sg === "Fire" ? 6 : 2) });
    n++;
  }
  return rows;
}
const schema = {
  id: "cad_incidents_clean", title: "t", grain: "incident", period: "2025-09-16 to 2026-09-16", status: "model_output", record_level: true, remote: true,
  source: "CCFD1 CAD extract, sanitized", source_detail: "d", note: "n",
  dimensions: ["hour:int", "weekday:string", "month:int", "source_group:string", "call_category:string", "in_district:string", "township:string"]
    .map(x => { const [name, type] = x.split(":"); return { name, type }; }),
  measures: [{ name: "incidents", unit: "count" }, { name: "duration_min", unit: "minutes" }], rows: []
};
const privateDs = { ...schema, remote: false, rows: fixtureRows() };
const hourly = D.loadDatasets().find(d => d.id === "cad_incidents_by_hour");
const calls = [];
const remoteQuery = async (id, q) => { calls.push(q); return D.query(privateDs, q); };
const make = (extra) => createTools([], [schema, hourly], { remoteQuery, ...extra });

test("the schema validates with no rows, and rows may not be published for a remote dataset", () => {
  assert.deepEqual(D.validateDataset(schema), []);
  assert.ok(D.validateDataset({ ...schema, rows: fixtureRows() }).some(e => /remote dataset/.test(e)));
  assert.deepEqual(D.validateDataset(privateDs), [], "record-level rows may repeat dimension values");
});

test("a) fire vs EMS by hour: grouped column, hours 00:00-23:00", async () => {
  const seen = []; const t = make({ onChart: e => seen.push(e) });
  const out = await runTool(t, "build_chart", { dataset: "cad_incidents_clean",
    query: { groupBy: ["hour", "source_group"], aggregate: { incidents: "sum" } },
    chart: { type: "column", x: "hour", y: "incidents", series: "source_group", title: "Calls by hour, Fire vs EMS" } });
  assert.equal(out.status, "model_output"); assert.equal(out.error, undefined);
  const o = t.charts.get(out.result.chart_id).options;
  assert.equal(o.chart.type, "column"); assert.equal(o.xAxis.categories.length, 24); assert.equal(o.xAxis.categories[0], "00:00");
  assert.deepEqual(o.series.map(s => s.name).sort(), ["EMS", "Fire"]);
  assert.equal(o.yAxis.allowDecimals, false); assert.equal(o.yAxis.min, 0);
  assert.match(o.yAxis.title.text, /count/); assert.match(o.caption.text, /model output/);
  assert.equal(o.series.reduce((a, s) => a + s.data.reduce((x, y) => x + y, 0), 0), 240);
  assert.equal(seen.length, 1); assert.equal(out.sources[0], "dataset.cad_incidents_clean");
});

test("b) volume by weekday is in calendar order", async () => {
  const t = make();
  const out = await t.build_chart({ dataset: "cad_incidents_clean", query: { groupBy: ["weekday"], aggregate: { incidents: "sum" }, orderBy: { column: "incidents", desc: true } },
    chart: { type: "column", x: "weekday", y: "incidents", title: "Calls by weekday" } });
  assert.deepEqual(t.charts.get(out.result.chart_id).options.xAxis.categories, DAYS);
});

test("c) average minutes by group: bar, decimals allowed, unit on the axis", async () => {
  const t = make();
  const out = await t.build_chart({ dataset: "cad_incidents_clean", query: { groupBy: ["source_group"], aggregate: { duration_min: "avg" } },
    chart: { type: "bar", x: "source_group", y: "duration_min", title: "Average time on call" } });
  const o = t.charts.get(out.result.chart_id).options;
  assert.equal(o.chart.type, "bar"); assert.equal(o.yAxis.allowDecimals, true); assert.match(o.yAxis.title.text, /minutes/);
  assert.match(out.result.note, /n/);
});

test("d) outside-area time by group, filtered", async () => {
  const t = make();
  const out = await t.build_chart({ dataset: "cad_incidents_clean", query: { filter: { in_district: "outside" }, groupBy: ["source_group"], aggregate: { duration_min: "avg" } },
    chart: { type: "bar", x: "source_group", y: "duration_min", title: "Outside-area time on call", y_label: "Minutes" } });
  assert.equal(t.charts.get(out.result.chart_id).options.yAxis.title.text, "Minutes");
  assert.ok(calls.at(-1).filter.in_district === "outside");
});

test("stacked and pie variants build; local dataset needs no remoteQuery", () => {
  const t = createTools([], [hourly]);
  const out = t.build_chart({ dataset: "cad_incidents_by_hour", chart: { type: "line", x: "hour", y: "incidents", title: "By hour" } });
  assert.equal(out.status, "verified"); assert.equal(t.charts.get(out.result.chart_id).options.series[0].data.length, 24);
  const pie = t.build_chart({ dataset: "cad_incidents_by_hour", query: { filter: { hour: { lt: 3 } } }, chart: { type: "pie", x: "hour", y: "incidents", title: "p" } });
  assert.equal(pie.error, undefined);
});

test("errors give hints: unknown/wrong-role columns, empty rows, too many points, multi-series pie, duplicates", async () => {
  const t = make();
  const bad = async (chart, query) => t.build_chart({ dataset: "cad_incidents_clean", query: query || { groupBy: ["hour", "source_group"], aggregate: { incidents: "sum" } }, chart: { title: "t", type: "column", x: "hour", y: "incidents", ...chart } });
  assert.match((await bad({ x: "nope" })).error, /not in the query result/);
  assert.match((await bad({ y: "hour" })).error, /dimension, not a measure/);
  assert.match((await bad({ x: "incidents", y: "incidents" })).error, /measure, not a dimension/);
  assert.match((await bad({ type: "pie", series: "source_group" })).error, /one series/);
  assert.match((await bad({}, { filter: { hour: 99 }, groupBy: ["hour"], aggregate: { incidents: "sum" } })).error, /no rows/);
  assert.match((await bad({}, { groupBy: ["hour", "source_group"], aggregate: { incidents: "sum" } })).error, /more than one row/);
  assert.match((await bad({ type: "nope" })).error, /chart.type/);
  assert.match((await bad({ title: "" })).error, /title/);
  const big = createTools([], [{ ...schema, remote: false, rows: Array.from({ length: 210 }, (_, i) => ({ ...fixtureRows()[0], hour: i % 24, month: Math.floor(i / 24) + 1, township: "t" + i })) }], {});
  const many = big.build_chart({ dataset: "cad_incidents_clean", query: { groupBy: ["township"], aggregate: { incidents: "sum" } }, chart: { type: "column", x: "township", y: "incidents", title: "t" } });
  assert.match(many.error, /max 200/); assert.ok(many.hint);
  assert.equal((await bad({ x: "hour" })).status, "error");
});

test("record-level datasets refuse row selects and unreachable data fails cleanly", async () => {
  const t = make();
  const sel = await t.query_dataset("cad_incidents_clean", { select: ["hour"] });
  assert.equal(sel.status, "error"); assert.match(sel.error, /aggregate it/);
  const down = createTools([], [schema], { remoteQuery: async () => { throw new Error("boom"); } });
  const r = await down.build_chart({ dataset: "cad_incidents_clean", query: { groupBy: ["hour"], aggregate: { incidents: "sum" } }, chart: { type: "column", x: "hour", y: "incidents", title: "t" } });
  assert.equal(r.status, "error");
  const none = createTools([], [schema]);
  assert.equal(none.query_dataset("cad_incidents_clean", { groupBy: ["hour"], aggregate: { incidents: "sum" } }).status, "error");
});

test("a failed trial render is returned to the model as an error and nothing is stored", async () => {
  const t = createTools([], [hourly], { trialRender: () => "boom" });
  const out = t.build_chart({ dataset: "cad_incidents_by_hour", chart: { type: "line", x: "hour", y: "incidents", title: "t" } });
  assert.equal(out.status, "error"); assert.match(out.error, /boom/); assert.equal(t.charts.size, 0);
});

test("unsupported still refuses record-level asks and points at charts for durations", () => {
  const t = make();
  assert.equal(t.unsupported("caller phone numbers").result.kind, "record_level");
  assert.ok(t.unsupported("response time to Clinton").result.alternatives.some(a => a.tool === "build_chart"));
});
