/* Run with:  node --test assistant/tools.test.js   (Node 18+; uses only built-in modules) */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTools, loadFacts, runTool, TOOL_SCHEMAS } = require("./tools.js");
const Engine = require("../shared/engine.js");

const tools = createTools(loadFacts());
const STATUSES = ["verified", "partner_stated", "model_output", "placeholder"];

/* ---------- required checks ---------- */
test("run_scenario_34 defaults: 3 hires, total 343353, gap 979111, rate 0.3184", () => {
  const out = tools.run_scenario_34({});
  assert.equal(out.status, "model_output");
  assert.equal(out.result.hires_required, 3);
  assert.equal(out.result.total_annual_change, 343353);
  assert.equal(out.result.resulting_gap, 979111);
  assert.equal(out.result.additional_rate_per_100_av, 0.3184);
  assert.equal(out.result.total_rate_per_100_av, 0.6091);
  assert.equal(out.result.above_ceiling, true);
  assert.equal(out.result.household_increase_150k_av, 477.66);
  assert.equal(out.result.years_of_fund_balance_label, "1.7");
  assert.equal(out.result.depends_on_placeholder, true, "premium 0 is a placeholder input");
  assert.ok(out.sources.includes("eng.avg_salary") && out.sources.includes("eng.perf_rate"));
});

test("run_scenario_34 posts 4, PERF off, premium 0: total 0, gap 635758", () => {
  const out = tools.run_scenario_34({ posts_proposed: 4, fund_perf: false, premium: 0 });
  assert.equal(out.result.total_annual_change, 0);
  assert.equal(out.result.resulting_gap, 635758);
  assert.equal(out.result.hires_required, 0);
});

test("run_scenario_1: defaults 635758; +10000 recurring 625758; one-time +500000 year-1 135758", () => {
  const d = tools.run_scenario_1({});
  assert.equal(d.status, "model_output");
  assert.equal(d.result.annual_gap, 635758);
  assert.equal(d.result.years_of_fund_balance_label, "2.6");
  assert.equal(d.result.recurring_revenue_adjusted, 1160192);
  assert.equal(d.result.first_year_below_zero, 2028);

  const plus = tools.run_scenario_1({ funding_change: 10000, recurring: true });
  assert.equal(plus.result.annual_gap, 625758);
  assert.equal(d.result.annual_gap - plus.result.annual_gap, 10000);

  assert.deepEqual(plus.result.baseline_no_change.first_year_below_zero, 2028);
  assert.equal(plus.result.baseline_no_change.annual_gap, 635758);
  assert.equal(tools.run_scenario_1({ funding_change: 250000 }).result.first_year_below_zero, 2030);

  const once = tools.run_scenario_1({ funding_change: 500000, recurring: false });
  assert.equal(once.result.year1_gap, 135758);
  assert.equal(once.result.annual_gap, 635758, "later years return to the baseline");
});

test('compare_to_baseline("3&4", defaults): +343353 = 178728 compensation + 164625 staffing', () => {
  const out = tools.compare_to_baseline("3&4", {});
  assert.equal(out.result.baseline_gap, 635758);
  assert.equal(out.result.difference, 343353);
  const [comp, staff] = out.result.components;
  assert.equal(comp.amount, 178728);
  assert.match(comp.component, /Compensation/);
  assert.equal(staff.amount, 164625);
  assert.match(staff.component, /staffing/);
  assert.equal(comp.amount + staff.amount, out.result.difference);
  assert.equal(staff.detail[0].amount + staff.detail[1].amount, staff.amount);
});

test("incidents_by_location includes Washington 53, Jefferson 36, Clinton 17", () => {
  const out = tools.incidents_by_location();
  assert.equal(out.status, "verified");
  const t = Object.fromEntries(out.result.by_township.map(r => [r.township, r.incidents]));
  assert.equal(t.Washington, 53);
  assert.equal(t.Jefferson, 36);
  assert.equal(t.Clinton, 17);
  assert.equal(out.result.total_incidents, 604);
});

test('finance_by_year(2024, 2024, "operating_revenue") -> 1279649 with an AFR source', () => {
  const out = tools.finance_by_year(2024, 2024, "operating_revenue");
  assert.equal(out.status, "verified");
  assert.equal(out.result.rows.length, 1);
  assert.equal(out.result.rows[0].value, 1279649);
  assert.deepEqual(out.sources, ["fin.revenue.2024"]);
  assert.match(out.result.source, /Indiana Gateway AFR 2024/);
});

test('unsupported("response time") refuses and names the missing data', () => {
  const out = tools.unsupported("response time");
  assert.equal(out.result.refusal, true);
  assert.equal(out.result.kind, "response_time");
  assert.equal(out.status, "placeholder");
  assert.ok(out.result.missing_data.length > 0);
  assert.match(out.result.missing_data.join(" "), /on-scene times/);
  assert.ok(out.sources.includes("gap.response_time"));
});

test('unsupported("address of an incident") gives the aggregated-data-only refusal', () => {
  const out = tools.unsupported("address of an incident");
  assert.equal(out.result.kind, "record_level");
  assert.match(out.result.message, /only holds aggregated data/);
  assert.ok(out.result.alternatives.some(a => a.tool === "incidents_by_location"));
});

/* ---------- extra guards ---------- */
test("record-level refusals for names, phones, units and individual salaries", () => {
  for (const q of ["caller name for incident 2025-123", "phone number of the caller", "unit-level dispatch records for Medic 1",
                   "salary of the fire chief", "which employee responded"]) {
    assert.equal(tools.unsupported(q).result.kind, "record_level", q);
  }
  const sal = tools.unsupported("individual salaries");
  assert.ok(sal.result.alternatives.some(a => a.tool === "get_fact" && a.input.id === "eng.avg_salary"));
  assert.equal(tools.unsupported("Scenario 2 township contributions").result.kind, "scenario_2");
  assert.equal(tools.unsupported("circuit breaker caps for scenario 5").result.kind, "scenario_5");
});

test("tools and the dashboard share one engine (same numbers for many settings)", () => {
  for (const posts of [4, 5, 6, 8]) for (const perf of [true, false]) for (const prem of [0, 5000, 30000]) for (const sal of [0, 3, 10]) {
    const r = Engine.costEngine({ posts, perf, perfRate: 0.265, premium: prem, adj: sal / 100, otd: true });
    const t = tools.run_scenario_34({ posts_proposed: posts, fund_perf: perf, premium: prem, salary_adj: sal }).result;
    assert.equal(t.resulting_gap, Math.round(r.gap));
    assert.equal(t.total_annual_change, Math.round(r.total));
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /<script src="shared\/engine\.js"><\/script>/);
  assert.doesNotMatch(html, /function costEngine|function fundingEngine/, "index.html must not keep its own copy of the math");
});

test("every tool result carries an allowed status and fact ids that exist", () => {
  const facts = new Set(loadFacts().facts.map(f => f.id));
  const calls = [
    ["get_fact", { id: "kpi.budget_2027" }], ["search_facts", { query: "fund balance" }],
    ["finance_by_year", { year_from: 2019, year_to: 2024, metric: "personnel_vs_contracted" }],
    ["finance_by_year", { year_from: 2024, metric: "revenue_by_source" }],
    ["incidents_by_location", {}], ["incidents_by_hour", {}],
    ["run_scenario_1", { funding_change: 0, source: "property_tax", source_pct: 10, start_from_staffing: true, staffing: { posts_proposed: 6 } }],
    ["run_scenario_34", { posts_proposed: 7, premium: 12000 }],
    ["compare_to_baseline", { scenario: "1", params: { funding_change: 50000, recurring: false } }],
    ["unsupported", { topic: "response time" }]
  ];
  for (const [name, input] of calls) {
    const out = runTool(tools, name, input);
    assert.ok(STATUSES.includes(out.status), `${name} status ${out.status}`);
    assert.ok(Array.isArray(out.sources), name);
    for (const id of out.sources) assert.ok(facts.has(id), `${name} cites unknown fact ${id}`);
  }
});

test("Scenario 1 tool matches dashboard tests (property tax +10%, staffing start)", () => {
  const pt = tools.run_scenario_1({ source: "property_tax", source_pct: 10 }).result;
  assert.equal(pt.source_effect, 88297);
  assert.equal(pt.annual_gap, 547461);
  assert.equal(tools.run_scenario_1({ start_from_staffing: true }).result.start_gap, 979111);
  const cmp = tools.compare_to_baseline("1", { funding_change: 10000 }).result;
  assert.equal(cmp.difference, -10000);
  assert.equal(cmp.components.reduce((a, c) => a + c.amount, 0), cmp.difference);
});

test("invalid inputs are rejected, not clamped or guessed", () => {
  assert.equal(tools.run_scenario_34({ posts_proposed: 9 }).status, "error");
  assert.equal(tools.run_scenario_34({ perf_rate: 35 }).status, "error");
  assert.equal(tools.run_scenario_1({ funding_change: 2000000 }).status, "error");
  assert.equal(tools.run_scenario_1({ source: "none", source_pct: 10 }).status, "error");
  assert.equal(tools.finance_by_year(2025, 2025, "operating_revenue").status, "error");
  assert.equal(tools.finance_by_year(2023, 2023, "revenue_by_source").status, "error");
  assert.equal(tools.get_fact("no.such.fact").status, "error");
  assert.equal(tools.compare_to_baseline("5", {}).status, "error");
});

test("TOOL_SCHEMAS follow the Messages API client-tool format", () => {
  const names = TOOL_SCHEMAS.map(t => t.name);
  assert.deepEqual(names.sort(), ["compare_to_baseline", "finance_by_year", "get_fact", "incidents_by_hour", "incidents_by_location",
    "run_scenario_1", "run_scenario_34", "search_facts", "unsupported"]);
  for (const t of TOOL_SCHEMAS) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(typeof t.description === "string" && t.description.length > 60, t.name);
    assert.equal(t.input_schema.type, "object");
    assert.equal(t.input_schema.additionalProperties, false);
    for (const [k, p] of Object.entries(t.input_schema.properties)) assert.ok(p.description, `${t.name}.${k} needs a description`);
    for (const r of t.input_schema.required) assert.ok(r in t.input_schema.properties);
    assert.deepEqual(Object.keys(t).sort(), ["description", "input_schema", "name"]);
  }
  const s34 = TOOL_SCHEMAS.find(t => t.name === "run_scenario_34").input_schema.properties;
  assert.deepEqual([s34.posts_proposed.minimum, s34.posts_proposed.maximum], [4, 8]);
  assert.deepEqual([s34.perf_rate.minimum, s34.perf_rate.maximum], [20, 30]);
  assert.deepEqual([s34.premium.minimum, s34.premium.maximum], [0, 30000]);
  assert.deepEqual([s34.salary_adj.minimum, s34.salary_adj.maximum], [0, 10]);
  const s1 = TOOL_SCHEMAS.find(t => t.name === "run_scenario_1").input_schema.properties;
  assert.deepEqual([s1.funding_change.minimum, s1.funding_change.maximum], [-500000, 1000000]);
  assert.deepEqual([s1.source_pct.minimum, s1.source_pct.maximum], [-50, 50]);
});

test("CAD facts cite the aggregated extract only (no source-PDF references anywhere)", () => {
  const root = path.join(__dirname, "..");
  const pdfName = new RegExp(["blot", "ter"].join(""), "i");   // the raw CAD report name, assembled so this file doesn't contain it
  for (const f of ["data/facts.json", "index.html", "assistant/tools.js", "assistant/tools.test.js", "shared/engine.js"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), "utf8"), pdfName, f);
  }
  const cad = loadFacts().facts.filter(f => f.id.startsWith("cad."));
  assert.equal(cad.length, 33);
  for (const f of cad) {
    assert.equal(f.source, "CCFD1 CAD extract (aggregated)");
    assert.equal(f.status, "verified");
  }
});
