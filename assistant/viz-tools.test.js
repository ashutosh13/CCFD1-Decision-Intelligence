/* Run with:  node --test assistant/viz-tools.test.js   (Node 18+; built-in modules only)
   Uses the published CAD layer (shared/cad-gis.js), plus the local detail file when present. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const V = require("./viz-tools.js");
const { loadFacts, TOOL_SCHEMAS } = require("./tools.js");
const Engine = require("../shared/engine.js");
const Metrics = require("../shared/cad-metrics.js");
const GIS = require("../shared/cad-gis.js");

const facts = loadFacts();
const published = V.createVizTools(facts, Metrics.fromPublished(GIS));
const detailFile = path.join(__dirname, "..", "data", "cad-gis-detail.json");
const detail = fs.existsSync(detailFile) ? V.createVizTools(facts, Metrics.prepare(JSON.parse(fs.readFileSync(detailFile, "utf8")))) : null;

test("tool list = the nine Ask-the-data tools unchanged + four viz tools", () => {
  assert.deepEqual(V.VIZ_TOOL_SCHEMAS.slice(0, TOOL_SCHEMAS.length), TOOL_SCHEMAS);
  assert.deepEqual(V.VIZ_TOOL_SCHEMAS.slice(TOOL_SCHEMAS.length).map(t => t.name), ["cad_metric", "scenario_projection", "compare_scenarios", "show_chart"]);
});

test("baseline projection reproduces the engine: budget expenses, $635,758 gap, engine fund balances", () => {
  const out = published.scenario_projection("baseline");
  assert.equal(out.status, "model_output");
  const b = Engine.fundingEngine(Engine.DEFAULTS.funding);
  const rows = out.result.rows;
  assert.equal(rows[0].year, 2025); assert.match(rows[0].kind, /^actual/); assert.equal(rows[0].fund_balance, Engine.S1.FUND_BALANCE);
  rows.slice(1).forEach((r, k) => {
    assert.equal(r.kind, "projected");
    assert.equal(r.revenue, Engine.S1.RECURRING_REVENUE);
    assert.equal(r.expenses, Engine.S1.BUDGET_2027);
    assert.equal(r.operating_balance, -635758);
    assert.equal(r.fund_balance, Math.round(b.balances[k]));
  });
});

test("Scenario 3&4 projection = the dashboard's 'start from staffing gap' run", () => {
  const out = published.scenario_projection("3&4", {});
  const gap = Engine.costEngine(Engine.DEFAULTS.staffing).gap;
  assert.equal(out.result.rows[1].operating_balance, -Math.round(gap));
  assert.equal(out.result.rows[1].expenses, Engine.S1.RECURRING_REVENUE + Math.round(gap));
});

test("compare_scenarios deltas are scenario minus baseline from engine outputs", () => {
  const out = published.compare_scenarios([{ scenario: "1", params: { funding_change: 75000 } }]);
  const [b, s] = out.result.scenarios;
  assert.equal(b.kind, "baseline"); assert.equal(b.delta_vs_baseline, null);
  assert.equal(s.delta_vs_baseline.annual_revenue, 75000);
  assert.equal(s.delta_vs_baseline.annual_operating_balance, 75000);
  assert.equal(s.delta_vs_baseline.annual_expenses, 0);
  assert.equal(s.delta_vs_baseline.fund_balance_end, 5 * 75000);
});

test("Scenario 2 / unknown scenarios: insufficient scenario data, never a guess", () => {
  const out = published.scenario_projection("2");
  assert.equal(out.status, "error");
  assert.match(out.error, /Insufficient scenario data to calculate this metric\./);
  const chart = published.show_chart({ chart_type: "bar", tool: "scenario_projection", tool_input: { scenario: "2" } });
  assert.equal(chart.status, "error"); assert.equal(chart.spec, undefined);
});

test("projected specs are labelled Projected and carry scenario, baseline and period", () => {
  const c = published.show_chart({ chart_type: "projection", title: "Fund balance", tool: "compare_scenarios",
    tool_input: { scenarios: [{ scenario: "1", params: { funding_change: 250000 } }, { scenario: "3&4" }] } });
  const s = c.spec;
  assert.equal(s.visualizationType, "projection");
  assert.ok(s.valueLabels.includes("Projected") && s.valueLabels.includes("Baseline") && s.valueLabels.includes("Actual"));
  assert.equal(s.kinds[0], "actual"); assert.ok(s.kinds.slice(1).every(k => k === "projected"));
  assert.equal(s.projectionPeriod, "2026-2030"); assert.equal(s.baselineName, "Baseline (no change)");
  assert.ok(s.assumptions.length > 0);
  assert.ok(V.validateSpec(s).ok);
});

test("validateSpec rejects malformed specs and unlabelled projections", () => {
  const good = published.show_chart({ chart_type: "bar", tool: "incidents_by_hour", tool_input: {} }).spec;
  assert.ok(V.validateSpec(good).ok);
  for (const bad of [null, {}, { ...good, visualizationType: "script" }, { ...good, series: [{ name: "x", values: [1, 2] }] },
    { ...good, series: [{ name: "x", values: good.categories.map(() => "1") }] }, { ...good, dataType: "projected", valueLabels: ["Actual"] }])
    assert.equal(V.validateSpec(bad).ok, false);
});

test("unsuitable chart types fall back; unknown tools are refused", () => {
  const c = published.show_chart({ chart_type: "donut", tool: "incidents_by_hour", tool_input: {} });
  assert.equal(c.spec.visualizationType, "bar"); assert.match(c.spec.fallbackNote, /donut/);
  assert.equal(published.show_chart({ chart_type: "bar", tool: "eval", tool_input: {} }).status, "error");
});

test("published layer: township counts work; hour / apparatus metrics are reported unavailable", () => {
  const t = published.cad_metric("by_township");
  assert.equal(t.status, "verified");
  assert.equal(t.result.rows.reduce((a, r) => a + r.incidents, 0), GIS.incidentPoints.length);
  for (const m of ["by_hour", "apparatus", "logansport_fire"]) {
    const o = published.cad_metric(m);
    assert.equal(o.status, "error"); assert.equal(o.unavailable, true);
  }
});

test("no record-level fields leave cad_metric", () => {
  const tools = detail || published;
  for (const m of detail ? ["summary", "by_hour", "by_township", "outside_area", "apparatus", "logansport_fire"] : ["by_township", "outside_area"]) {
    const s = JSON.stringify(tools.cad_metric(m).result);
    assert.doesNotMatch(s, /"(lat|lng|id|datetime|incidentId|address)"\s*:/, m);
  }
});

test("detail file (local only): incident counts are not multiplied by units", { skip: !detail }, () => {
  const sum = detail.cad_metric("summary").result;
  assert.equal(sum.incidents, 604);                                   // KPI card: unique CCFD1 incidents
  const hours = detail.cad_metric("by_hour").result;
  assert.equal(hours.rows.reduce((a, r) => a + r.total, 0) + hours.missing_hour, 604);
  const app = detail.cad_metric("apparatus").result;
  assert.equal(app.level, "unit response");
  assert.ok(sum.apparatus_responses > sum.incidents);                 // unit rows exceed incidents; kept separate
  const ems = detail.show_chart({ chart_type: "line", tool: "cad_metric", tool_input: { metric: "by_hour", filters: { category: "ems" } } }).spec;
  assert.equal(ems.series[0].values.reduce((a, v) => a + v, 0), sum.by_category["Medical (EMS)"]);
  assert.equal(ems.mapLink, "gis-map/#group=M");
});
