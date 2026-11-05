/* CCFD1 "Ask the data" assistant tools.
   Pure functions over data/facts.json and shared/engine.js. Every tool returns
     { result, sources: [fact ids], status }
   where status is one of "verified" | "partner_stated" | "model_output" | "placeholder"
   (the weakest status of anything the result depends on), or "error" for invalid input.
   No tool invents a number: values come from facts.json or from the shared scenario
   engine that the dashboard panels also use. Only aggregated data is available -
   no record-level CAD, addresses, names, phone numbers or individual pay.

   Node:    const { createTools, loadFacts, TOOL_SCHEMAS, runTool } = require("./assistant/tools.js");
            const tools = createTools(loadFacts());
   Browser: <script src="shared/engine.js"></script><script src="assistant/tools.js"></script>
            const tools = CCFD1Tools.createTools(await (await fetch("data/facts.json")).json()); */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const engine = isNode ? require("../shared/engine.js") : root.CCFD1Engine;
  const api = factory(engine);
  if (isNode) {
    api.loadFacts = function loadFacts(file) {
      const fs = require("fs"), path = require("path");
      return JSON.parse(fs.readFileSync(file || path.join(__dirname, "..", "data", "facts.json"), "utf8"));
    };
    module.exports = api;
  } else {
    root.CCFD1Tools = api;
  }
})(typeof self !== "undefined" ? self : this, function (Engine) {
  "use strict";
  if (!Engine) throw new Error("shared/engine.js must be loaded before assistant/tools.js");
  const { ENG, S1, DEFAULTS, costEngine, fundingEngine, yearsLabel } = Engine;

  /* ---------- status handling ---------- */
  const STATUS_ORDER = ["verified", "partner_stated", "model_output", "placeholder"]; // strongest -> weakest
  const weakest = (...ss) => ss.flat().filter(s => STATUS_ORDER.includes(s))
    .reduce((w, s) => (STATUS_ORDER.indexOf(s) > STATUS_ORDER.indexOf(w) ? s : w), "verified");
  const ok = (result, sources, status) => ({ result, sources: [...new Set(sources)], status });
  const fail = (message, extra) => ({ result: null, error: message, ...(extra || {}), sources: [], status: "error" });

  /* ---------- small helpers ---------- */
  const dollars = v => Math.round(v);
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const r2 = v => Math.round(v * 100) / 100;
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  function checkRange(name, v, min, max) {
    if (!isNum(v)) return `${name} must be a number`;
    if (v < min || v > max) return `${name} must be between ${min} and ${max} (got ${v})`;
    return null;
  }

  /* Public tool parameter values -> engine keys */
  const SOURCE_KEYS = { none: "", property_tax: "propertyTax", local_income_tax: "incomeTax",
    vehicle_excise_tax: "excise", fire_protection_contracts: "contracts" };
  const SOURCE_FACTS = { propertyTax: "s1.source.propertyTax", incomeTax: "s1.source.incomeTax",
    excise: "s1.source.excise", contracts: "s1.source.contracts" };

  /* Fact ids each scenario depends on */
  const S34_INPUT_FACTS = ["eng.line_ff", "eng.posts_now", "eng.avg_salary", "eng.payroll_tax", "eng.ot_cost_cap",
    "kpi.structural_gap", "kpi.av_2027", "kpi.rate_2027", "kpi.fund_balance_2025", "eng.ceiling", "eng.household_av"];
  const S1_INPUT_FACTS = ["s1.budget", "s1.recurring", "kpi.structural_gap", "kpi.fund_balance_2025"];

  /* ---------- Scenario 3&4 parameter handling (shared by run_scenario_34 and compare_to_baseline) ---------- */
  function s34Inputs(p) {
    p = p || {};
    const d = DEFAULTS.staffing;
    const v = {
      posts_proposed: p.posts_proposed ?? d.posts,
      fund_perf: p.fund_perf ?? d.perf,
      perf_rate: p.perf_rate ?? d.perfRate * 100,
      premium: p.premium ?? d.premium,
      salary_adj: p.salary_adj ?? d.adj * 100,
      ot_displacement: p.ot_displacement ?? d.otd
    };
    const errs = [];
    if (!Number.isInteger(v.posts_proposed) || v.posts_proposed < 4 || v.posts_proposed > 8)
      errs.push(`posts_proposed must be a whole number from 4 to 8 (got ${v.posts_proposed})`);
    if (typeof v.fund_perf !== "boolean") errs.push("fund_perf must be true or false");
    if (typeof v.ot_displacement !== "boolean") errs.push("ot_displacement must be true or false");
    [["perf_rate", v.perf_rate, 20, 30], ["premium", v.premium, 0, 30000], ["salary_adj", v.salary_adj, 0, 10]]
      .forEach(([n, x, lo, hi]) => { const e = checkRange(n, x, lo, hi); if (e) errs.push(e); });
    if (errs.length) return { errs };
    return { v, engineInput: { posts: v.posts_proposed, perf: v.fund_perf, perfRate: v.perf_rate / 100,
      premium: v.premium, adj: v.salary_adj / 100, otd: v.ot_displacement } };
  }
  function s34InputStatus(v) {
    return [
      { input: "posts_proposed", value: v.posts_proposed, status: "user_input" },
      { input: "perf_rate", value: v.fund_perf ? v.perf_rate : null,
        status: v.fund_perf ? (v.perf_rate === 26.5 ? "partner_stated" : "user_input") : "not_used",
        note: "26.5% is partner-stated, not yet verified with INPRS." },
      { input: "premium", value: v.premium, status: v.premium === 0 ? "placeholder" : "user_input",
        note: v.premium === 0 ? "No quote exists - placeholder. $0 understates cost; it is not an estimate." : "Premium supplied by the user; no quote exists." },
      { input: "salary_adj", value: v.salary_adj, status: "user_input" },
      { input: "ot_displacement", value: v.ot_displacement, status: "user_input",
        note: "When on, the overtime offset is capped at the overtime actually recorded." }
    ];
  }

  /* ---------- Scenario 1 parameter handling ---------- */
  function s1Inputs(p) {
    p = p || {};
    const v = {
      funding_change: p.funding_change ?? 0,
      recurring: p.recurring ?? true,
      source: p.source ?? "none",
      source_pct: p.source_pct ?? 0,
      start_from_staffing: p.start_from_staffing ?? false
    };
    const errs = [];
    const e1 = checkRange("funding_change", v.funding_change, -500000, 1000000); if (e1) errs.push(e1);
    const e2 = checkRange("source_pct", v.source_pct, -50, 50); if (e2) errs.push(e2);
    if (typeof v.recurring !== "boolean") errs.push("recurring must be true or false");
    if (typeof v.start_from_staffing !== "boolean") errs.push("start_from_staffing must be true or false");
    if (!(v.source in SOURCE_KEYS)) errs.push(`source must be one of ${Object.keys(SOURCE_KEYS).join(", ")}`);
    if (v.source === "none" && v.source_pct !== 0) errs.push("source_pct needs a source other than none");
    let staffing = null;
    if (v.start_from_staffing) {
      staffing = s34Inputs(p.staffing);
      if (staffing.errs) errs.push(...staffing.errs.map(e => "staffing." + e));
    }
    if (errs.length) return { errs };
    return { v, staffing };
  }

  /* ---------- the tools ---------- */
  function createTools(factsDoc) {
    const FACTS = Array.isArray(factsDoc) ? factsDoc : (factsDoc && factsDoc.facts) || [];
    const BY_ID = new Map(FACTS.map(f => [f.id, f]));
    const fact = id => BY_ID.get(id);
    const val = id => { const f = fact(id); if (!f) throw new Error(`facts.json is missing ${id}`); return f.value; };
    const statusOf = ids => weakest(ids.map(id => (fact(id) || {}).status));

    /* 1a. get_fact */
    function get_fact(id) {
      const f = fact(id);
      if (!f) {
        const near = search_facts(String(id || "").replace(/[._-]/g, " "), 5).result.matches.map(m => m.id);
        return fail(`No fact with id "${id}".`, { suggestions: near });
      }
      return ok({ ...f }, [f.id], f.status);
    }

    /* 1b. search_facts */
    function search_facts(query, limit) {
      const terms = String(query || "").toLowerCase().split(/[^a-z0-9$%.]+/).filter(t => t.length > 1);
      if (!terms.length) return fail("query must contain at least one word");
      const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 10, 1), 50);
      const scored = FACTS.map(f => {
        const hay = [f.id, f.label, f.panel, f.year_or_period, f.source, f.note].join(" ").toLowerCase();
        const label = (f.label + " " + f.id).toLowerCase();
        let s = 0; for (const t of terms) { if (label.includes(t)) s += 3; else if (hay.includes(t)) s += 1; }
        return [s, f];
      }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, n).map(([, f]) => f);
      const matches = scored.map(f => ({ id: f.id, label: f.label, value: f.value, unit: f.unit,
        year_or_period: f.year_or_period, status: f.status, source: f.source }));
      return ok({ query, matches }, matches.map(m => m.id), matches.length ? statusOf(matches.map(m => m.id)) : "placeholder");
    }

    /* 2. finance_by_year */
    const FIN_METRICS = {
      operating_revenue: "fin.revenue", operating_spending: "fin.spending", ending_balance: "fin.balance",
      personnel: "staffcost.personnel", contracted: "staffcost.contracted"
    };
    function finance_by_year(year_from, year_to, metric) {
      year_to = year_to ?? year_from;
      const metrics = [...Object.keys(FIN_METRICS), "personnel_vs_contracted", "revenue_by_source"];
      if (!metrics.includes(metric)) return fail(`metric must be one of ${metrics.join(", ")}`);
      if (!Number.isInteger(year_from) || !Number.isInteger(year_to) || year_from > year_to)
        return fail("year_from and year_to must be whole years with year_from <= year_to");
      if (year_to > 2024 || year_from < 2011) {
        const note = "Gateway AFR data covers 2011-2024. The 2025 AFR is pending (see fact gap.afr_2025); " +
          "the end-2025 fund balance of $1,624,691 is partner-stated (fact kpi.fund_balance_2025).";
        if (year_from > 2024 || year_to < 2011) return { ...fail(note), sources: ["gap.afr_2025"] };
        year_from = Math.max(year_from, 2011); year_to = Math.min(year_to, 2024);
      }
      if (metric === "revenue_by_source") {
        if (year_to < 2024) return fail("Revenue by source is held for 2024 only (2024 Gateway AFR). Ask for 2024.");
        const ids = ["propertyTax", "incomeTax", "interestOther", "excise", "contracts"].map(k => "fin.source2024." + k);
        const total = ids.reduce((a, id) => a + val(id), 0);
        const rows = ids.map(id => ({ source: fact(id).label.replace("2024 revenue: ", ""), amount: val(id),
          share_pct: r2(val(id) / total * 100), fact_id: id }));
        return ok({ metric, year: 2024, unit: "USD", rows, total, note: "Shares are of the five listed sources. " +
          (fact("fin.source2024.interestOther").note || "") }, ids, statusOf(ids));
      }
      const years = []; for (let y = year_from; y <= year_to; y++) years.push(y);
      if (metric === "personnel_vs_contracted") {
        const ids = []; const rows = years.map(y => {
          const p = "staffcost.personnel." + y, c = "staffcost.contracted." + y; ids.push(p, c);
          return { year: y, personnel: val(p), contracted: val(c) };
        });
        return ok({ metric, unit: "USD", rows, note: fact("staffcost.personnel.2024").note +
          " In 2020 the district moved from contracted service to employing its own staff." }, ids, statusOf(ids));
      }
      const ids = years.map(y => `${FIN_METRICS[metric]}.${y}`);
      const rows = years.map((y, k) => ({ year: y, value: val(ids[k]), fact_id: ids[k] }));
      const f0 = fact(ids[0]);
      return ok({ metric, unit: "USD", rows, source: f0.source.replace(/\d{4}/, years.length > 1 ? `${year_from}-${year_to}` : String(year_from)),
        note: f0.note }, ids, statusOf(ids));
    }

    /* 3a. incidents_by_location */
    function incidents_by_location() {
      const locIds = FACTS.filter(f => /^cad\.location\.\d+$/.test(f.id)).map(f => f.id);
      const rows = locIds.map(id => ({ location: fact(id).label.replace("CCFD1 incidents: ", ""), incidents: val(id), fact_id: id }));
      const total = rows.reduce((a, r) => a + r.incidents, 0);
      rows.forEach(r => { r.share_pct = r2(r.incidents / total * 100); });
      const wash = rows.find(r => /Washington/.test(r.location));
      const outside = rows.find(r => /^Outside the District/.test(r.location));
      const ids = [...locIds, "cad.outside.jefferson", "cad.outside.clinton", "cad.incidents"];
      const by_township = [
        wash && { township: "Washington", incidents: wash.incidents, relationship: "contract", fact_id: wash.fact_id },
        { township: "Jefferson", incidents: val("cad.outside.jefferson"), relationship: "outside the District", fact_id: "cad.outside.jefferson" },
        { township: "Clinton", incidents: val("cad.outside.clinton"), relationship: "outside the District", fact_id: "cad.outside.clinton" }
      ].filter(Boolean);
      return ok({ period: fact("cad.incidents").year_or_period, total_incidents: total, rows, by_township,
        other_outside_district: outside ? outside.incidents - val("cad.outside.jefferson") - val("cad.outside.clinton") : null,
        note: "Counts of CCFD1 incidents located by township. The CAD does not record whether a call was automatic or mutual aid. " +
          "Aggregated counts only; no incident-level records." }, ids, statusOf(ids));
    }

    /* 3b. incidents_by_hour */
    function incidents_by_hour() {
      const ids = []; const rows = [];
      for (let h = 0; h < 24; h++) { const id = "cad.hourly." + String(h).padStart(2, "0"); ids.push(id); rows.push({ hour: h, incidents: val(id) }); }
      const total = rows.reduce((a, r) => a + r.incidents, 0);
      const day = rows.slice(6, 18).reduce((a, r) => a + r.incidents, 0);
      const peak = rows.reduce((m, r) => (r.incidents > m.incidents ? r : m), rows[0]);
      ids.push("cad.daytime_share");
      return ok({ period: fact("cad.incidents").year_or_period, total_incidents: total, rows,
        daytime_06_18: { incidents: day, share_pct: Math.round(day / total * 100) },
        peak_hours: rows.filter(r => r.incidents === peak.incidents).map(r => r.hour),
        note: "Hour of incident creation. Aggregated counts only." }, ids, statusOf(ids));
    }

    /* 4. run_scenario_1 */
    function run_scenario_1(params) {
      const p = s1Inputs(params);
      if (p.errs) return fail(p.errs.join("; "));
      const v = p.v;
      let staffingResult = null;
      if (v.start_from_staffing) staffingResult = costEngine(p.staffing.engineInput);
      const key = SOURCE_KEYS[v.source];
      const r = fundingEngine({ funding: v.funding_change, oneTime: !v.recurring, source: key, pct: v.source_pct / 100,
        useStaffing: v.start_from_staffing, staffingGap: staffingResult ? staffingResult.gap : S1.BASE_GAP });
      const sources = [...S1_INPUT_FACTS, ...(key ? [SOURCE_FACTS[key]] : []), ...(staffingResult ? S34_INPUT_FACTS : [])];
      const inputStatus = [
        { input: "recurring revenue baseline", value: S1.RECURRING_REVENUE, status: "partner_stated" },
        { input: "fund balance, end 2025", value: S1.FUND_BALANCE, status: "partner_stated" },
        ...(key ? [{ input: "source amount (2024 AFR)", value: S1.SOURCES[key][1], status: "verified" }] : [])
      ];
      return ok({
        scenario: "1 - funding change",
        inputs: v,
        revenue_change: dollars(r.revenueChange),
        recurring_part: dollars(r.recurring),
        one_time_part: dollars(r.oneTime),
        source_effect: dollars(r.sourceEffect),
        recurring_revenue_starting: S1.RECURRING_REVENUE,
        recurring_revenue_adjusted: dollars(r.adjustedRevenue),
        budget_2027: S1.BUDGET_2027,
        start_gap: dollars(r.startGap),
        start_gap_basis: v.start_from_staffing ? "staffing scenario's resulting gap" : "budget minus recurring revenue",
        year1_gap: dollars(r.year1Gap),
        annual_gap: dollars(r.laterGap),
        is_surplus: r.laterGap < 0,
        years_of_fund_balance: isFinite(r.years) ? r1(r.years) : null,
        years_of_fund_balance_label: yearsLabel(r.years),
        projection: [{ year: S1.START_YEAR, fund_balance: S1.FUND_BALANCE, kind: "partner-stated end-2025 balance" },
          ...S1.YEARS.map((y, k) => ({ year: y, fund_balance: dollars(r.balances[k]), kind: "projected" }))],
        first_year_below_zero: r.firstNegative,
        baseline_no_change: (() => { const b = fundingEngine(DEFAULTS.funding);
          return { annual_gap: dollars(b.laterGap), years_of_fund_balance: r1(b.years), first_year_below_zero: b.firstNegative,
            note: "Same model with no funding change, starting from the $635,758 structural gap." }; })(),
        staffing_scenario: staffingResult ? { inputs: p.staffing.v, ...summarize34(p.staffing.v, staffingResult),
          input_status: s34InputStatus(p.staffing.v) } : null,
        input_status: inputStatus,
        caveats: "Planning comparison, not a forecast. Expenses and other revenue held flat. Revenue sources use 2024 AFR amounts. " +
          "Property tax changes are limited by levy controls and circuit breakers (Scenario 5, pending)."
      }, sources, "model_output");
    }
    const r1 = v => Math.round(v * 10) / 10;

    /* 5. run_scenario_34 */
    function summarize34(v, r) {
      return {
        hires_required: r.hires,
        per_employee_cost: dollars(r.perEmployee),
        compensation_cost: dollars(r.layer1),
        staffing_net_cost: dollars(r.layer2),
        total_annual_change: dollars(r.total),
        resulting_gap: dollars(r.gap),
        additional_rate_per_100_av: r4(r.addRate),
        total_rate_per_100_av: r4(r.totalRate),
        rate_explanation: `The increase is $${r4(r.addRate).toFixed(4)} per $100 AV. Added to the current $${ENG.CURRENT_RATE.toFixed(4)}, ` +
          `the total operating rate would be $${r4(r.totalRate).toFixed(4)} per $100 AV, ` +
          `${r.totalRate > ENG.CEILING ? "above" : "within"} the $${ENG.CEILING.toFixed(2)} ceiling. Rates are gross, before circuit-breaker caps.`,
        above_ceiling: r.totalRate > ENG.CEILING,
        ceiling: ENG.CEILING,
        household_increase_150k_av: r2(r.household),
        years_of_fund_balance: isFinite(r.years) ? r1(r.years) : null,
        years_of_fund_balance_label: yearsLabel(r.years)
      };
    }
    function run_scenario_34(params) {
      const p = s34Inputs(params);
      if (p.errs) return fail(p.errs.join("; "));
      const r = costEngine(p.engineInput);
      const inputStatus = s34InputStatus(p.v);
      const sources = [...S34_INPUT_FACTS, ...(p.v.fund_perf ? ["eng.perf_rate"] : []), "eng.health_premium"];
      return ok({
        scenario: "3&4 - staffing and compensation",
        inputs: p.v,
        ...summarize34(p.v, r),
        input_status: inputStatus,
        depends_on_placeholder: inputStatus.some(x => x.status === "placeholder"),
        caveats: "Debt service is already inside the 2027 budget, so it is not added again. Rates are gross, before " +
          "circuit-breaker caps, deductions and credits. PERF rate is partner-stated, not yet verified with INPRS. " +
          "Health premium is a placeholder; see the workbook Sensitivity tab."
      }, sources, "model_output");
    }

    /* 6. compare_to_baseline */
    function compare_to_baseline(scenario, params) {
      const s = String(scenario || "").toLowerCase().replace(/\s+/g, "");
      const baseline = ENG.BASE_GAP;
      if (["3&4", "34", "3and4", "scenario_34", "scenario34", "staffing"].includes(s)) {
        const out = run_scenario_34(params);
        if (out.status === "error") return out;
        const p = s34Inputs(params); const r = costEngine(p.engineInput);
        const gross = r.hires * r.perEmployee;
        return ok({
          scenario: "3&4", baseline_gap: baseline, scenario_gap: out.result.resulting_gap,
          difference: out.result.resulting_gap - baseline,
          components: [
            { component: "Compensation decision (existing staff)", amount: out.result.compensation_cost },
            { component: "Net staffing decision (new hires)", amount: out.result.staffing_net_cost,
              detail: [{ part: "Gross cost of new hires", amount: dollars(gross) },
                       { part: "Less overtime displaced", amount: dollars(r.layer2 - gross) }] }
          ],
          check: "difference = sum of components",
          scenario_result: out.result
        }, ["kpi.structural_gap", ...out.sources], out.status);
      }
      if (["1", "scenario_1", "scenario1", "funding"].includes(s)) {
        const out = run_scenario_1(params);
        if (out.status === "error") return out;
        const R = out.result;
        const components = [];
        if (R.start_gap !== baseline) components.push({ component: "Starting from the staffing scenario's gap", amount: R.start_gap - baseline });
        const fundingRecurring = R.recurring_part - R.source_effect;
        if (fundingRecurring) components.push({ component: "Recurring funding change (more revenue lowers the gap)", amount: -fundingRecurring });
        if (R.source_effect) components.push({ component: "Revenue-source change (recurring)", amount: -R.source_effect });
        return ok({
          scenario: "1", baseline_gap: baseline, scenario_gap: R.annual_gap,
          difference: R.annual_gap - baseline,
          components,
          year1: R.one_time_part ? { year1_gap: R.year1_gap, difference: R.year1_gap - baseline,
            one_time_component: { component: "One-time funding (year 1 only)", amount: -R.one_time_part } } : null,
          check: "difference = sum of components (annual, recurring basis)",
          scenario_result: R
        }, ["kpi.structural_gap", ...out.sources], out.status);
      }
      return fail('scenario must be "3&4" (staffing and compensation) or "1" (funding change). Scenarios 2 and 5 have no data yet; use unsupported().');
    }

    /* 7. unsupported */
    const ALTS = {
      location: { tool: "incidents_by_location", gives: "CCFD1 incidents counted by township (e.g. Washington 53, Jefferson 36, Clinton 17)" },
      hour: { tool: "incidents_by_hour", gives: "CCFD1 incidents counted by hour of day" },
      salary: { tool: "get_fact", input: { id: "eng.avg_salary" }, gives: "average line firefighter salary ($56,204, aggregate) and line firefighter count (12)" },
      personnel: { tool: "finance_by_year", input: { metric: "personnel_vs_contracted" }, gives: "total personnel cost by year from the AFRs" },
      s34: { tool: "run_scenario_34", gives: "gross tax rate needed to fund staffing and compensation changes, before caps" },
      s1: { tool: "run_scenario_1", gives: "effect of a funding change on the gap and fund balance" }
    };
    function unsupported(topic) {
      const t = String(topic || "").toLowerCase();
      let kind, message, missing_data, alternatives, sources;
      if (/\baddress|\bstreet\b|\bname[sd]?\b|\bphone|\bcaller|\bpatient|individual|specific incident|incident (number|no\.?|#|id)|\bwhich house|license plate|unit[- ]level|\bunit\b.*\b(record|dispatch|time)|dispatch record|record[- ]level|\bper[- ]incident|\bsalary of\b|\bsalaries\b|\bwhat does .* (earn|make)\b|\bpay of\b|\bemployee\b|\bpersonnel (record|file|detail)|\bwho (responded|was|is)\b/.test(t)) {
        kind = "record_level";
        message = "The dashboard only holds aggregated data. It has no individual incidents, addresses, names, phone numbers, " +
          "unit-level dispatch records, individual salaries or personnel details, so it cannot answer that.";
        missing_data = ["Record-level data is deliberately excluded from the dashboard for privacy."];
        alternatives = /salar|pay|earn|employee|personnel/.test(t) ? [ALTS.salary, ALTS.personnel]
          : [ALTS.location, ALTS.hour];
        sources = [];
      } else if (/response[\s-]*time|arrival time|travel time|turnout time|time to (arrive|scene)|on[- ]scene time|minutes to/.test(t)) {
        kind = "response_time";
        message = "Response-time projections are not supported. The team excluded them because the dashboard has no data that supports them.";
        missing_data = ["Validated dispatch-to-on-scene times for each incident, with a documented method for missing or out-of-order timestamps",
          "Station and apparatus locations with a travel-time model", "Team and partner agreement on how response times would be reported"];
        alternatives = [ALTS.hour, ALTS.location];
        sources = ["gap.response_time"];
      } else if (/scenario\s*2|township (contribution|join|agreement|share|cost)|mutual aid (cost|agreement)|service agreement/.test(t)) {
        kind = "scenario_2";
        message = "Scenario 2 (township contributions and service agreements) cannot be run yet: its data has not been collected.";
        missing_data = ["Township mutual-aid and service agreements", "Township populations", "Township property tax levies",
          "Township incident demand and associated costs"];
        alternatives = [ALTS.location, ALTS.s1];
        sources = ["gap.scenario2"];
      } else if (/scenario\s*5|levy (control|limit|cap)|circuit[- ]breaker|max(imum)? levy|levy growth/.test(t)) {
        kind = "scenario_5";
        message = "Scenario 5 (levy controls and circuit-breaker caps) cannot be run yet: its data has not been collected. " +
          "Rates shown elsewhere are gross, before circuit-breaker caps, deductions and credits.";
        missing_data = ["Maximum levy and levy growth limits for CCFD1", "Circuit-breaker caps and credits by property class",
          "Net assessed value after deductions by property class"];
        alternatives = [ALTS.s34, ALTS.s1];
        sources = ["gap.scenario5"];
      } else {
        kind = "not_in_data";
        message = "That is not covered by the dashboard's data. It holds Gateway AFR finances (2011-2024), aggregated CAD incident counts " +
          "(Sep 16 2025 - Sep 16 2026), aggregate payroll constants, and the Scenario 1 and Scenario 3&4 models.";
        missing_data = ["A source document for the requested figure"];
        alternatives = [{ tool: "search_facts", gives: "keyword search across every sourced figure on the dashboard" }];
        sources = [];
      }
      return ok({ topic, kind, refusal: true, message, missing_data, alternatives }, sources, "placeholder");
    }

    return { get_fact, search_facts, finance_by_year, incidents_by_location, incidents_by_hour,
      run_scenario_1, run_scenario_34, compare_to_baseline, unsupported };
  }

  /* ---------- dispatcher for tool_use blocks: runTool(tools, block.name, block.input) ---------- */
  function runTool(tools, name, input) {
    const i = input || {};
    switch (name) {
      case "get_fact": return tools.get_fact(i.id);
      case "search_facts": return tools.search_facts(i.query, i.limit);
      case "finance_by_year": return tools.finance_by_year(i.year_from, i.year_to, i.metric);
      case "incidents_by_location": return tools.incidents_by_location();
      case "incidents_by_hour": return tools.incidents_by_hour();
      case "run_scenario_1": return tools.run_scenario_1(i);
      case "run_scenario_34": return tools.run_scenario_34(i);
      case "compare_to_baseline": return tools.compare_to_baseline(i.scenario, i.params);
      case "unsupported": return tools.unsupported(i.topic);
      default: return fail(`Unknown tool "${name}"`);
    }
  }

  /* ---------- Anthropic Messages API tool definitions ----------
     Client tools: { name, description, input_schema }. Ranges match the dashboard controls and are
     also enforced in code (strict mode is not used because it does not support minimum/maximum). */
  const S34_PROPS = {
    posts_proposed: { type: "integer", minimum: 4, maximum: 8,
      description: "Continuously staffed posts after the change. Whole number 4-8; the district staffs 4 now. Default 5. Each added post needs 3 hires." },
    fund_perf: { type: "boolean", description: "Fund PERF 77 pension for firefighters. Default true. False reproduces today's cost basis." },
    perf_rate: { type: "number", minimum: 20, maximum: 30,
      description: "PERF 77 employer rate in percent, 20-30 (dashboard steps of 0.5). Default 26.5, which is partner-stated and not yet verified with INPRS. Ignored when fund_perf is false." },
    premium: { type: "number", minimum: 0, maximum: 30000,
      description: "Health premium per employee in US dollars per year, 0-30000 (dashboard steps of 1000). Default 0, a placeholder because no quote exists - it understates cost." },
    salary_adj: { type: "number", minimum: 0, maximum: 10,
      description: "Base salary adjustment in percent, 0-10 (dashboard steps of 0.5). Default 0. Applied before PERF." },
    ot_displacement: { type: "boolean",
      description: "Let new hires displace overtime, capped at the overtime actually recorded ($61,569 a year, scaled by any salary adjustment). Default true." }
  };
  const obj = (properties, required, extra) => ({ type: "object", properties, required: required || [], additionalProperties: false, ...(extra || {}) });

  const TOOL_SCHEMAS = [
    { name: "get_fact",
      description: "Look up one sourced figure from the dashboard by its fact id (for example kpi.structural_gap, fin.revenue.2024, eng.avg_salary). Use it when you already know the id, or to cite a figure returned by another tool. Returns the value, unit, period, source document and status (verified, partner_stated, model_output or placeholder).",
      input_schema: obj({ id: { type: "string", description: "Fact id from data/facts.json, e.g. \"kpi.fund_balance_2025\"." } }, ["id"]) },
    { name: "search_facts",
      description: "Keyword search across every sourced figure on the dashboard. Use it first when the user asks about a number and you do not know which fact holds it (budget, fund balance, assessed value, tax rate, PERF rate, overtime, etc.). Returns matching facts with their values, sources and status.",
      input_schema: obj({
        query: { type: "string", description: "Keywords, e.g. \"assessed valuation 2027\" or \"fund balance\"." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum matches to return, 1-50. Default 10." }
      }, ["query"]) },
    { name: "finance_by_year",
      description: "CCFD1 finances from the Indiana Gateway Annual Financial Reports, 2011-2024 (2025 AFR pending). Use it for questions about operating revenue, operating spending, ending fund balance, personnel vs contracted service cost, or 2024 revenue by source. Operating figures exclude loan proceeds, interfund transfers and payroll pass-throughs.",
      input_schema: obj({
        year_from: { type: "integer", minimum: 2011, maximum: 2024, description: "First year, 2011-2024." },
        year_to: { type: "integer", minimum: 2011, maximum: 2024, description: "Last year, 2011-2024. Defaults to year_from." },
        metric: { type: "string", enum: ["operating_revenue", "operating_spending", "ending_balance", "revenue_by_source", "personnel", "contracted", "personnel_vs_contracted"],
          description: "Which series. revenue_by_source is available for 2024 only. All values are US dollars." }
      }, ["year_from", "metric"]) },
    { name: "incidents_by_location",
      description: "CCFD1 incident counts by location for Sep 16 2025 - Sep 16 2026 (inside the District, Washington Township contract area, outside the District with Jefferson and Clinton broken out, no location). Use it for questions about where CCFD1 responds or about calls outside its taxing area. Aggregated counts only.",
      input_schema: obj({}) },
    { name: "incidents_by_hour",
      description: "CCFD1 incident counts by hour of day for Sep 16 2025 - Sep 16 2026, with the 06:00-18:00 share and peak hours. Use it for questions about when calls happen or daytime staffing demand. Aggregated counts only.",
      input_schema: obj({}) },
    { name: "run_scenario_1",
      description: "Scenario 1 funding model: how a change in annual funding changes CCFD1's operating gap and how long the fund balance lasts (2026-2030 projection). Use it for \"what if we got $X more (or less) a year\", one-time grants, or a percent change to one revenue source. Planning comparison only, not a forecast; expenses and other revenue are held flat. Results are model_output.",
      input_schema: obj({
        funding_change: { type: "number", minimum: -500000, maximum: 1000000,
          description: "Funding change in US dollars per year, -500000 to 1000000 (dashboard slider steps of 25000; any whole-dollar amount is allowed). Default 0." },
        recurring: { type: "boolean", description: "True (default) if the funding change repeats every year; false if it is one-time and applies to year 1 (2026) only." },
        source: { type: "string", enum: Object.keys(SOURCE_KEYS),
          description: "One revenue source to change by source_pct, using its 2024 AFR amount. Default none." },
        source_pct: { type: "number", minimum: -50, maximum: 50,
          description: "Percent change to the chosen source, -50 to 50 (dashboard steps of 1). Treated as recurring. Default 0." },
        start_from_staffing: { type: "boolean",
          description: "Start from the Scenario 3&4 resulting gap instead of the $635,758 structural gap. Default false. When true, pass the staffing settings in staffing." },
        staffing: obj(S34_PROPS, [], { description: "Scenario 3&4 settings to start from, used only when start_from_staffing is true. Omitted fields use the dashboard defaults." })
      }) },
    { name: "run_scenario_34",
      description: "Scenario 3&4 team cost engine v2: annual cost of adding staffed posts and/or funding PERF 77 pension and health benefits for existing firefighters, and the gross tax rate needed to fund it. Use it for questions about hiring, adding a post or shift position, benefits, pension, or what a change would do to the tax rate or a $150,000 household. Results are model_output; inputs carry their own status.",
      input_schema: obj(S34_PROPS) },
    { name: "compare_to_baseline",
      description: "Compare a scenario's resulting annual gap with the $635,758 structural gap and break the difference into its components (compensation vs staffing for Scenario 3&4; funding, source change and starting point for Scenario 1). Use it when the user asks how much a change adds or removes, or why the gap moved.",
      input_schema: obj({
        scenario: { type: "string", enum: ["3&4", "1"], description: "\"3&4\" for staffing and compensation, \"1\" for funding change." },
        params: { type: "object", description: "The same parameters as run_scenario_34 or run_scenario_1. Omitted fields use the dashboard defaults." }
      }, ["scenario"]) },
    { name: "unsupported",
      description: "Standard answer for questions the dashboard's data cannot answer. Use it instead of guessing for: response-time projections; Scenario 2 (township contributions) or Scenario 5 (levy controls, circuit breakers); and any request for individual incidents, addresses, names, phone numbers, unit-level dispatch records, individual salaries or personnel details. Returns the explanation, the data that would be needed, and aggregated alternatives to offer.",
      input_schema: obj({ topic: { type: "string", description: "The user's request in a few words, e.g. \"response time to Clinton Township\"." } }, ["topic"]) }
  ];

  return { createTools, runTool, TOOL_SCHEMAS, STATUS_ORDER };
});
