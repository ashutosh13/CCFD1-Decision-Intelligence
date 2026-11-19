/* Run with:  node --test shared/dataset.test.js */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const D = require("./dataset.js");
const { createTools, runTool, TOOL_SCHEMAS } = require("../assistant/tools.js");

const ds = D.loadDatasets();
const byId = Object.fromEntries(ds.map(d => [d.id, d]));
const tools = createTools([], ds);

const toy = () => ({ id: "toy", title: "t", grain: "year", period: "p", status: "verified", source: "s", source_detail: "d",
  dimensions: [{ name: "year", type: "int" }, { name: "kind", type: "string" }], measures: [{ name: "amt", unit: "USD" }],
  rows: [{ year: 2020, kind: "a", amt: 1 }, { year: 2020, kind: "b", amt: 2 }, { year: 2021, kind: "a", amt: 4, _status: "placeholder" }] });

/* ---------- validation ---------- */
test("every published dataset validates and is listed in the manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "datasets", "index.json"), "utf8"));
  assert.equal(manifest.datasets.length, ds.length);
  for (const d of ds) assert.deepEqual(D.validateDataset(d), [], d.id);
});
test("validation rejects record-level fields, duplicate keys and bad types", () => {
  const t = toy(); t.rows[0].address = "x";
  assert.match(D.validateDataset(t)[0], /unexpected field address/);
  const dup = toy(); dup.rows[1] = { year: 2020, kind: "a", amt: 9 };
  assert.ok(D.validateDataset(dup).some(e => /duplicate dimension/.test(e)));
  const typ = toy(); typ.rows[0].amt = "1";
  assert.ok(D.validateDataset(typ).some(e => /amt must be a number/.test(e)));
});

/* ---------- query ---------- */
test("filter, select, orderBy and limit", () => {
  const r = D.query(toy(), { filter: { year: { gte: 2020 }, kind: "a" }, select: ["year", "amt"], orderBy: { column: "year", desc: true }, limit: 1 });
  assert.deepEqual(r.rows, [{ year: 2021, amt: 4 }]);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.columns.map(c => c.unit), [undefined, "USD"]);
});
test("groupBy with aggregate, and a single-row aggregate", () => {
  assert.deepEqual(D.query(toy(), { groupBy: ["year"], aggregate: { amt: "sum" } }).rows, [{ year: 2020, amt: 3 }, { year: 2021, amt: 4 }]);
  assert.deepEqual(D.query(toy(), { aggregate: { amt: "max" } }).rows, [{ amt: 4 }]);
  assert.deepEqual(D.query(toy(), { filter: { year: 1999 }, aggregate: { amt: "sum" } }).rows, [{ amt: null }]);
});
test("status is the weakest of the dataset and the rows returned", () => {
  assert.equal(D.query(toy(), { filter: { year: 2020 } }).status, "verified");
  assert.equal(D.query(toy(), {}).status, "placeholder");
});
test("bad queries return errors, not throws", () => {
  for (const q of [{ filter: { nope: 1 } }, { groupBy: ["year"] }, { groupBy: ["amt"], aggregate: { amt: "sum" } },
    { aggregate: { amt: "median" } }, { filter: { year: { like: 1 } } }, { orderBy: { column: "zzz" } }, { select: ["zzz"] }])
    assert.ok(D.query(toy(), q).error, JSON.stringify(q));
});

/* ---------- parity with the page (the DATA constant must not drift from the datasets) ---------- */
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const PAGE = new Function("return " + html.match(/const DATA = (\{[\s\S]*?\n\});/)[1])();
const col = (id, c) => byId[id].rows.map(r => r[c]);

test("datasets match the page's DATA constant", () => {
  assert.deepEqual(col("finance_by_year", "year"), PAGE.finance.years);
  assert.deepEqual(col("finance_by_year", "revenue"), PAGE.finance.operatingRevenue);
  assert.deepEqual(col("finance_by_year", "spending"), PAGE.finance.operatingSpending);
  assert.deepEqual(col("finance_by_year", "balance"), PAGE.finance.endingBalance);
  assert.deepEqual(col("personnel_vs_contracted", "personnel"), PAGE.staffingCost.personnel);
  assert.deepEqual(col("personnel_vs_contracted", "contracted"), PAGE.staffingCost.contracted);
  assert.deepEqual(byId.revenue_by_source_2024.rows.map(r => [r.source, r.amount]), PAGE.finance.sources);
  assert.deepEqual(col("cad_incidents_by_hour", "incidents"), PAGE.hourly);
  assert.equal(col("cad_incidents_by_hour", "incidents").reduce((a, b) => a + b, 0), PAGE.incidents);
});

/* ---------- assistant tools ---------- */
test("list_datasets and query_dataset return the tool envelope", () => {
  const l = tools.list_datasets();
  assert.equal(l.result.datasets.length, ds.length);
  assert.ok(l.sources.includes("dataset.finance_by_year"));
  const q = tools.query_dataset("finance_by_year", { filter: { year: { gte: 2023 } }, select: ["year", "revenue"] });
  assert.deepEqual(q.result.rows, [{ year: 2023, revenue: 1238278 }, { year: 2024, revenue: 1279649 }]);
  assert.equal(q.status, "verified");
  assert.deepEqual(q.sources, ["dataset.finance_by_year"]);
  assert.equal(q.result.source, "Indiana Gateway Annual Financial Reports");
});
test("query_dataset errors carry status error and help the model recover", () => {
  const bad = tools.query_dataset("nope", {}); assert.equal(bad.status, "error"); assert.ok(bad.available.includes("finance_by_year"));
  const col2 = tools.query_dataset("finance_by_year", { filter: { zzz: 1 } }); assert.equal(col2.status, "error"); assert.ok(col2.columns.includes("revenue"));
});
test("runTool dispatches the new tools and TOOL_SCHEMAS declares them", () => {
  assert.equal(runTool(tools, "query_dataset", { dataset: "cad_incidents_by_hour", query: { aggregate: { incidents: "sum" } } }).result.rows[0].incidents, 604);
  assert.equal(runTool(tools, "list_datasets", {}).status, "verified");
  for (const n of ["list_datasets", "query_dataset"]) assert.ok(TOOL_SCHEMAS.some(t => t.name === n), n);
});
