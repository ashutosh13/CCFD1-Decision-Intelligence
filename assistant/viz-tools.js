/* CCFD1 "Ask CCFD1 AI" tools: data tools plus structured, validated chart specs.

   Builds on, and never replaces, the existing pieces:
     assistant/tools.js     the "Ask the data" tools (facts.json + scenario engine), reused unchanged
     shared/engine.js       the scenario engine (Scenario 1, Scenario 3&4), reused unchanged
     shared/cad-metrics.js  the CAD metric functions behind gis-map/, reused unchanged

   Rules this file enforces:
     - No number is invented. Every value comes from facts.json, the scenario engine, or the
       CAD metric functions. The model never supplies chart data: show_chart names a data tool
       and its input, and the browser re-runs that tool and builds the chart from its result.
     - Incident-level and unit-response-level metrics are kept apart (cad-metrics.js already
       never multiplies incident counts by the number of responding units).
     - Projected / scenario values are always labelled as such; the no-change baseline is the
       reference for every scenario delta, and deltas are computed only from engine outputs.
     - Only aggregates leave this file: no incident ids, addresses, timestamps or coordinates.

   Node:    const V = require("./assistant/viz-tools.js"); const t = V.createVizTools(facts, cadDataset);
   Browser: load shared/engine.js, shared/cad-metrics.js, assistant/tools.js, then this file
            (sets window.CCFD1VizTools). */
(function (root, factory) {
  const isNode = typeof module === "object" && module.exports;
  const api = isNode
    ? factory(require("./tools.js"), require("../shared/engine.js"), require("../shared/cad-metrics.js"))
    : factory(root.CCFD1Tools, root.CCFD1Engine, root.CCFD1Metrics);
  if (isNode) module.exports = api; else root.CCFD1VizTools = api;
})(typeof self !== "undefined" ? self : this, function (Tools, Engine, Metrics) {
  "use strict";
  if (!Tools || !Engine || !Metrics) throw new Error("Load shared/engine.js, shared/cad-metrics.js and assistant/tools.js before assistant/viz-tools.js");
  const { ENG, S1 } = Engine;

  const ok = (result, sources, status) => ({ result, sources: [...new Set(sources || [])], status });
  const fail = (message, extra) => ({ result: null, error: message, ...(extra || {}), sources: [], status: "error" });
  const r1 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const r4 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const usd = v => (v < 0 ? "-" : "") + "$" + Math.abs(Math.round(v)).toLocaleString("en-US");
  const INSUFFICIENT = "Insufficient scenario data to calculate this metric.";

  /* ---------------- CAD filters ---------------- */
  const CAT_KEYS = { medical: "M", ems: "M", fire: "F", vehicle: "V", other: "O", unclassified: "U" };
  const CAT_NAME = k => (k === "M" ? "Medical (EMS)" : Metrics.CATEGORY_LABEL[k]);
  const AREAS = ["inside", "district", "contract", "outside", "unknown"];
  const AREA_NAME = { inside: "Inside CCFD1 service area (district + Washington contract)", ...Metrics.AREA_LABEL };
  const AGENCY_NAME = code => (Metrics.AGENCY[code] ? Metrics.AGENCY[code].name : code);
  const NEEDS_DETAIL = ["by_hour", "by_day_of_week", "time_on_call", "apparatus", "logansport_fire"];
  const CAD_METRICS = ["summary", "by_hour", "by_day_of_week", "by_township", "by_category", "outside_area", "time_on_call", "apparatus", "logansport_fire"];

  function cadFilters(ds, fi) {
    fi = fi || {};
    const errs = [], f = {}, used = {};
    const agency = fi.agency == null || fi.agency === "" ? Metrics.HOME_AGENCY : String(fi.agency).toUpperCase();
    if (agency === "ALL") { f.agency = ""; used.scope = "All agencies' incidents in the CAD extract"; }
    else if (ds.options.orgs.has(agency) || agency === Metrics.HOME_AGENCY) {
      f.agency = agency;
      used.scope = agency === Metrics.HOME_AGENCY ? "CCFD1 incidents (CAD agency DIST)" : `Incidents with ${AGENCY_NAME(agency)} (CAD ${agency}) responding`;
    } else errs.push(`agency must be "all" or a CAD agency code in the data (e.g. DIST, LFD, CCEMS); got "${fi.agency}"`);
    if (fi.category != null && fi.category !== "") {
      const c = CAT_KEYS[String(fi.category).toLowerCase()];
      if (!c) errs.push(`category must be one of ${Object.keys(CAT_KEYS).join(", ")}`); else { f.group = c; used.category = CAT_NAME(c); }
    }
    if (fi.area != null && fi.area !== "") {
      if (!AREAS.includes(fi.area)) errs.push(`area must be one of ${AREAS.join(", ")}`); else { f.area = fi.area; used.area = AREA_NAME[fi.area]; }
    }
    if (fi.township != null && fi.township !== "") {
      const names = [...new Set(ds.incidents.map(x => x.township).filter(Boolean))];
      const want = String(fi.township).toLowerCase().replace(/\s+township$/, "").trim();
      const hit = names.find(n => n.toLowerCase().replace(/\s+township$/, "") === want);
      if (!hit) errs.push(`township "${fi.township}" has no incidents in the data. Townships with incidents: ${names.sort().join(", ")}`);
      else { f.township = hit; used.township = hit; }
    }
    for (const k of ["start", "end"]) if (fi[k] != null && fi[k] !== "") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fi[k])) errs.push(`${k} must be YYYY-MM-DD`); else { f[k] = fi[k]; used[k] = fi[k]; }
    }
    if (fi.day_of_week != null && fi.day_of_week !== "") {
      const d = Metrics.DOW.find(x => x.toLowerCase() === String(fi.day_of_week).toLowerCase());
      if (!d) errs.push(`day_of_week must be one of ${Metrics.DOW.join(", ")}`); else { f.dow = d; used.day_of_week = d; }
    }
    for (const [k, fk] of [["hour_from", "hourFrom"], ["hour_to", "hourTo"]]) if (fi[k] != null && fi[k] !== "") {
      if (!Number.isInteger(fi[k]) || fi[k] < 0 || fi[k] > 23) errs.push(`${k} must be a whole hour 0-23`); else { f[fk] = fi[k]; used[k] = fi[k]; }
    }
    return { f, used, errs };
  }
  /* gis-map/ reads the same filter keys from its URL hash, so a map action is just a link. */
  function mapLink(f, metric) {
    const p = new URLSearchParams();
    const agency = metric === "logansport_fire" ? "LFD" : f.agency;
    if (agency !== Metrics.HOME_AGENCY) p.set("agency", agency || "");
    for (const k of ["township", "group", "area", "start", "end", "dow", "hourFrom", "hourTo"]) if (f[k] != null && f[k] !== "") p.set(k, String(f[k]));
    const s = p.toString();
    return "gis-map/" + (s ? "#" + s : "");
  }

  /* ---------------- the tools ---------------- */
  function createVizTools(factsDoc, cadDataset) {
    const base = Tools.createTools(factsDoc);
    const FACTS = Array.isArray(factsDoc) ? factsDoc : (factsDoc && factsDoc.facts) || [];
    const cadStatus = (FACTS.find(f => f.id === "cad.incidents") || {}).status || "verified";
    let CAD = cadDataset || null;

    /* ---- cad_metric: wraps CCFD1Metrics (the gis-map/ page's own metric functions) ---- */
    function cad_metric(metric, filters) {
      if (!CAD) return fail("CAD data is not loaded, so this metric is unavailable.");
      if (!CAD_METRICS.includes(metric)) return fail(`metric must be one of ${CAD_METRICS.join(", ")}`);
      const { f, used, errs } = cadFilters(CAD, filters);
      if (errs.length) return fail(errs.join("; "));
      const detailFilter = f.start || f.end || f.dow || f.hourFrom != null || f.hourTo != null || (f.agency !== Metrics.HOME_AGENCY);
      if (!CAD.hasDetail && (NEEDS_DETAIL.includes(metric) || detailFilter))
        return fail("Unavailable: this metric needs the detailed CAD file (data/cad-gis-detail.json), which is not on this site. " +
          "Only CCFD1 incident locations and categories are published here; hour, day, date, agency, apparatus and timing metrics are not available.",
          { unavailable: true });
      const period = CAD.meta && Array.isArray(CAD.meta.period) ? `${CAD.meta.period[0].slice(0, 10)} to ${CAD.meta.period[1].slice(0, 10)}` : "Sep 16, 2025 to Sep 16, 2026";
      const incs = Metrics.filterIncidents(CAD, f);
      const notes = [];
      if (!CAD.hasDetail) notes.push(`Published layer only: ${CAD.meta.unlocated || 0} CCFD1 incidents without a CAD location are not included.`);
      const qa = CAD.qa || {};
      const timingNote = () => {
        if (qa.apparatusRows) notes.push(`Dispatch time was back-filled for ${r1(qa.dispatchBackfilled / qa.apparatusRows * 100)}% of apparatus rows; ` +
          `${qa.timeOrderExcluded} rows with out-of-order timestamps are excluded from time metrics.`);
      };
      const common = { metric, period, filters_used: used, map_link: mapLink(f, metric), data_type: "actual" };
      const catRows = (series, labels, key) => labels.map((lab, i) => {
        const row = { [key]: lab, total: 0 };
        Metrics.CATEGORY_ORDER.forEach(c => { if (series[c].some(v => v)) row[CAT_NAME(c)] = series[c][i]; });
        row.total = Metrics.CATEGORY_ORDER.reduce((a, c) => a + series[c][i], 0);
        return row;
      });
      let result;
      switch (metric) {
        case "summary": {
          const s = Metrics.summary(CAD, incs, f);
          result = { ...common, level: "incident (counts) and unit response (times)", incidents: s.incidents,
            by_category: Object.fromEntries(Metrics.CATEGORY_ORDER.filter(c => s.byCategory[c]).map(c => [CAT_NAME(c), s.byCategory[c]])),
            by_area: Object.fromEntries(Object.entries(s.byArea).map(([k, v]) => [Metrics.AREA_LABEL[k], v])),
            outside_pct_of_located: r1(s.outsidePctOfLocated),
            apparatus_responses: s.apparatusResponses, median_response_min: r1(s.medianResponseMin), avg_response_min: r1(s.avgResponseMin),
            responses_with_valid_times: s.responseN, median_call_min: r1(s.medianCallMin), calls_with_times: s.callsWithTimes };
          if (CAD.hasDetail) timingNote();
          break;
        }
        case "by_hour": {
          const h = Metrics.byHour(CAD, incs);
          result = { ...common, level: "incident", total_incidents: incs.length, missing_hour: h.missing,
            rows: catRows(h.series, h.hours.map(x => String(x).padStart(2, "0") + ":00"), "hour") };
          break;
        }
        case "by_day_of_week": {
          const d = Metrics.byDayOfWeek(CAD, incs);
          result = { ...common, level: "incident", total_incidents: incs.length, missing_day: d.missing, rows: catRows(d.series, d.days, "day") };
          break;
        }
        case "by_township": {
          const m = new Map();
          incs.forEach(x => { const k = !x.located ? "No location in CAD" : x.township || "Outside township boundaries"; m.set(k, (m.get(k) || 0) + 1); });
          result = { ...common, level: "incident", total_incidents: incs.length,
            rows: [...m].map(([township, incidents]) => ({ township, incidents, area: Metrics.AREA_LABEL[Metrics.areaOf(township, township !== "No location in CAD")] }))
              .sort((a, b) => b.incidents - a.incidents) };
          break;
        }
        case "by_category": {
          const s = Metrics.summary(CAD, incs, f);
          result = { ...common, level: "incident", total_incidents: incs.length,
            rows: Metrics.CATEGORY_ORDER.filter(c => s.byCategory[c]).map(c => ({ category: CAT_NAME(c), incidents: s.byCategory[c] })) };
          break;
        }
        case "outside_area":
        case "time_on_call": {
          const o = metric === "outside_area" ? Metrics.outsideArea(CAD, incs, f) : null;
          const t = o ? o.time : Metrics.timeOnCall(CAD, incs, f);
          const time = CAD.hasDetail ? Metrics.CATEGORY_ORDER.filter(c => t[c].calls).map(c => ({ category: CAT_NAME(c), calls: t[c].calls,
            calls_with_times: t[c].callsWithTimes, call_hours: r1(t[c].callHours), avg_call_min: r1(t[c].avgCallMin),
            apparatus_responses: t[c].apparatusResponses, apparatus_hours: r1(t[c].unitHours) })) : null;
          result = o ? { ...common, level: "incident (counts) and unit response (time)", total_incidents: o.total, located: o.located,
            outside_incidents: o.outside, outside_pct_of_located: r1(o.pctOfLocated),
            by_area: Object.entries(o.byArea).map(([k, v]) => ({ area: Metrics.AREA_LABEL[k], incidents: v })),
            outside_by_township: o.byTownship.map(([township, incidents]) => ({ township, incidents })),
            outside_time_by_category: time }
            : { ...common, level: "unit response (time) per incident category", total_incidents: incs.length, rows: time };
          result.time_definitions = "call_hours: per incident, first dispatch to last clear of in-scope apparatus. apparatus_hours: sum over apparatus of clear minus dispatch.";
          if (CAD.hasDetail) timingNote(); else if (o) notes.push("Time on calls is unavailable on the published layer.");
          break;
        }
        case "apparatus": {
          const a = Metrics.apparatus(CAD, incs, f);
          const top = a.slice(0, 15);
          result = { ...common, level: "unit response", apparatus_count: a.length, shown: top.length,
            rows: top.map(u => ({ unit: u.unit, agency: AGENCY_NAME(u.org), responses: u.responses, hours_committed: r1(u.hours),
              avg_min_per_response: r1(u.avgMin), avg_response_min: r1(u.avgResponseMin), flag: u.flag || undefined })) };
          if (a.length > top.length) notes.push(`Top ${top.length} of ${a.length} apparatus shown.`);
          notes.push("Apparatus names are kept as recorded in CAD; possible duplicates are flagged, not merged.");
          timingNote();
          break;
        }
        case "logansport_fire": {
          const m = Metrics.mutualAid(CAD, Object.assign({}, f, { agency: "" }));
          const LAB = { insideExCity: "CCFD1 service area, excluding Eel Twp.", cityTownship: "Eel Twp. (includes Logansport city calls)",
            outside: "Outside CCFD1 service area", unknown: "No location in CAD" };
          result = { ...common, level: "incident (counts) and unit response (apparatus, hours)", agency: "Logansport Fire (CAD LFD)",
            incidents_with_lfd: m.incidents,
            rows: Object.entries(m.buckets).map(([k, b]) => ({ area: LAB[k], incidents: b.incidents, with_ccfd1_also: b.withHomeAgency,
              lfd_apparatus_responses: b.apparatusResponses, lfd_apparatus_hours: r1(b.unitHours), avg_scene_min: r1(b.avgSceneMin) })) };
          result.filters_used = Object.assign({}, used, { scope: "Incidents with Logansport Fire (CAD LFD) responding" });
          notes.push("City of Logansport lies in Eel Township and city limits are not in the project data, so Eel Twp. counts include LFD's own city calls.",
            "LFD = Logansport Fire is assumed from the CAD code. The CAD does not record whether a response was automatic or mutual aid.");
          timingNote();
          break;
        }
      }
      result.notes = notes;
      return ok(result, ["cad.incidents"], cadStatus);
    }

    /* ---- scenarios: projections built only from run_scenario_1 / run_scenario_34 (shared/engine.js) ---- */
    function labelFor(sc, params) {
      const p = params || {};
      if (sc === "baseline") return "Baseline (no change)";
      if (sc === "1") {
        const bits = [];
        if (p.funding_change) bits.push(`${p.funding_change > 0 ? "+" : ""}${usd(p.funding_change)}${p.recurring === false ? " once" : "/yr"}`);
        if (p.source && p.source !== "none" && p.source_pct) bits.push(`${p.source.replace(/_/g, " ")} ${p.source_pct > 0 ? "+" : ""}${p.source_pct}%`);
        if (p.start_from_staffing) bits.push("from staffing gap");
        return "Scenario 1" + (bits.length ? ` (${bits.join(", ")})` : " (no change entered)");
      }
      const d = Engine.DEFAULTS.staffing, bits = [];
      bits.push(`${p.posts_proposed ?? d.posts} posts`);
      if ((p.salary_adj ?? 0) !== 0) bits.push(`+${p.salary_adj}% salary`);
      if ((p.fund_perf ?? d.perf) === false) bits.push("no PERF");
      if (p.premium) bits.push(`${usd(p.premium)} premium`);
      return `Scenario 3&4 (${bits.join(", ")})`;
    }
    function projectionOf(sc, params) {
      sc = String(sc || "").toLowerCase().replace(/\s+/g, "");
      if (["34", "3and4", "scenario34", "scenario_34", "staffing"].includes(sc)) sc = "3&4";
      if (["scenario1", "scenario_1", "funding"].includes(sc)) sc = "1";
      if (["base", "nochange", "no_change", "none"].includes(sc)) sc = "baseline";
      let out, s34 = null;
      if (sc === "baseline") out = base.run_scenario_1({});
      else if (sc === "1") out = base.run_scenario_1(params || {});
      else if (sc === "3&4") {
        s34 = base.run_scenario_34(params || {});
        if (s34.status === "error") return { error: s34 };
        out = base.run_scenario_1({ start_from_staffing: true, staffing: params || {} }); // the dashboard's "Start from the staffing scenario's gap"
      } else return { error: fail(`scenario must be "baseline", "1" or "3&4". Scenarios 2 and 5 have no data yet: ${INSUFFICIENT}`, { insufficient: true }) };
      if (out.status === "error") return { error: out };
      const R = out.result;
      const rows = [{ year: S1.START_YEAR, kind: "actual (partner-stated end-2025 balance)", revenue: null, expenses: null, operating_balance: null, fund_balance: S1.FUND_BALANCE }];
      S1.YEARS.forEach((y, k) => {
        const revenue = R.recurring_revenue_adjusted + (k === 0 ? R.one_time_part : 0);
        const gap = k === 0 ? R.year1_gap : R.annual_gap;
        rows.push({ year: y, kind: "projected", revenue, expenses: revenue + gap, operating_balance: -gap, fund_balance: R.projection[k + 1].fund_balance });
      });
      const assumptions = [
        `Revenue: recurring revenue baseline ${usd(S1.RECURRING_REVENUE)} (partner-stated) plus the scenario's revenue change; held flat each year.`,
        `Expenses: 2027 proposed budget ${usd(S1.BUDGET_2027)}${sc === "3&4" || R.inputs.start_from_staffing ? " plus the staffing scenario's annual change" : ""}; held flat each year.`,
        `Starting fund balance: ${usd(S1.FUND_BALANCE)} at end of 2025 (partner-stated).`,
        ...((s34 || R.staffing_scenario) ? (s34 ? s34.result.input_status : R.staffing_scenario.input_status).filter(x => x.note).map(x => `${x.input}: ${x.note}`) : [])
      ];
      return { sc, label: labelFor(sc, params), kind: sc === "baseline" ? "baseline" : "scenario", out, s34, rows, assumptions,
        caveat: R.caveats, sources: [...out.sources, ...(s34 ? s34.sources : [])] };
    }
    function scenario_projection(scenario, params) {
      const p = projectionOf(scenario, params);
      if (p.error) return p.error;
      return ok({ scenario: p.label, scenario_kind: p.kind, baseline: "Baseline (no change)", projection_period: `${S1.YEARS[0]}-${S1.YEARS[S1.YEARS.length - 1]}`,
        data_type: "projected", unit: "USD", rows: p.rows,
        metrics: "revenue and expenses per year; operating_balance = revenue - expenses (negative = deficit); fund_balance = end of year",
        assumptions: p.assumptions, caveats: p.caveat }, p.sources, "model_output");
    }
    function scenarioMetrics(p) {
      const R = p.out.result, last = p.rows[p.rows.length - 1];
      const m = {
        annual_revenue: R.recurring_revenue_adjusted, annual_expenses: R.recurring_revenue_adjusted + R.annual_gap,
        annual_operating_balance: -R.annual_gap, fund_balance_end: last.fund_balance,
        years_of_fund_balance: R.years_of_fund_balance, years_of_fund_balance_label: R.years_of_fund_balance_label,
        first_year_below_zero: R.first_year_below_zero
      };
      const st = p.s34 ? p.s34.result : R.staffing_scenario;
      m.staffing_annual_change = st ? st.total_annual_change : 0;
      m.total_rate_per_100_av = st ? st.total_rate_per_100_av : (p.kind === "baseline" ? ENG.CURRENT_RATE : null);
      return m;
    }
    const DELTA_KEYS = ["annual_revenue", "annual_expenses", "annual_operating_balance", "fund_balance_end", "staffing_annual_change", "total_rate_per_100_av"];
    function compare_scenarios(scenarios) {
      const list = Array.isArray(scenarios) ? scenarios : [];
      if (!list.length || list.length > 3) return fail("scenarios must list 1 to 3 scenarios, each { scenario: \"1\" | \"3&4\", params }. The baseline is always included.");
      const projs = [projectionOf("baseline")];
      for (const s of list) {
        const p = projectionOf(s && s.scenario, s && s.params);
        if (p.error) return p.error;
        if (p.sc === "baseline") continue;
        projs.push(p);
      }
      const B = scenarioMetrics(projs[0]);
      const rows = projs.map(p => {
        const m = scenarioMetrics(p);
        const delta = p.kind === "baseline" ? null : Object.fromEntries(DELTA_KEYS.map(k => [k,
          isNum(m[k]) && isNum(B[k]) ? (k === "total_rate_per_100_av" ? r4(m[k] - B[k]) : m[k] - B[k]) : null]));
        return { name: p.label, kind: p.kind, ...m, delta_vs_baseline: delta };
      });
      const years = projs[0].rows.map(r => r.year);
      const by_year = years.map((y, k) => {
        const row = { year: y, kind: k === 0 ? "actual (partner-stated)" : "projected" };
        projs.forEach(p => { row[p.label] = p.rows[k].fund_balance; });
        return row;
      });
      const balance_by_year = years.slice(1).map((y, k) => {
        const row = { year: y };
        projs.forEach(p => { row[p.label] = p.rows[k + 1].operating_balance; });
        return row;
      });
      return ok({ baseline: projs[0].label, projection_period: `${S1.YEARS[0]}-${S1.YEARS[S1.YEARS.length - 1]}`, data_type: "projected", unit: "USD",
        scenarios: rows, fund_balance_by_year: by_year, operating_balance_by_year: balance_by_year,
        definitions: "annual_* = recurring (later-year) basis; operating balance negative = deficit; fund_balance_end = projected end of " + years[years.length - 1] +
          "; delta_vs_baseline = scenario minus baseline, from engine outputs only.",
        assumptions: [...new Set(projs.flatMap(p => p.assumptions))], caveats: projs[0].caveat },
        projs.flatMap(p => p.sources), "model_output");
    }

    /* ---- show_chart: re-runs a data tool and returns a validated chart spec ---- */
    function show_chart(input) {
      const i = input || {};
      if (!DATA_TOOLS.includes(i.tool)) return fail(`tool must be one of ${DATA_TOOLS.join(", ")}`);
      const out = runData(i.tool, i.tool_input || {});
      if (!out || out.status === "error") return Object.assign(fail((out && out.error) || "The data tool failed."), { insufficient: !!(out && out.insufficient), unavailable: !!(out && out.unavailable) });
      if (out.result && out.result.refusal) return Object.assign(fail(out.result.message), { refusal: true });
      let dset;
      try { dset = datasetFor(i.tool, i.tool_input || {}, out, i.field); }
      catch (e) { return fail("No chart can be built from that result: " + e.message); }
      if (!dset) return fail(`No chart is available for ${i.tool}${i.field ? ` with field "${i.field}"` : ""}.`);
      const spec = buildSpec(dset, i.chart_type, i.title, i.series, out);
      const v = validateSpec(spec);
      if (!v.ok) return fail("The chart specification failed validation: " + v.errors.join("; "));
      return Object.assign(ok({ rendered: true, visualization_type: spec.visualizationType, title: spec.visualizationTitle, data_type: spec.dataType,
        fallback_note: spec.fallbackNote || undefined, data: out.result }, out.sources, out.status), { spec });
    }

    function runData(name, input) {
      const x = input || {};
      switch (name) {
        case "cad_metric": return cad_metric(x.metric, x.filters);
        case "scenario_projection": return scenario_projection(x.scenario, x.params);
        case "compare_scenarios": return compare_scenarios(x.scenarios);
        default: return Tools.runTool(base, name, x);
      }
    }

    return Object.assign({}, base, { cad_metric, scenario_projection, compare_scenarios, show_chart,
      setCad(ds) { CAD = ds; }, hasCad: () => !!CAD, cadHasDetail: () => !!(CAD && CAD.hasDetail) });
  }

  const DATA_TOOLS = ["finance_by_year", "incidents_by_location", "incidents_by_hour", "run_scenario_1", "run_scenario_34",
    "compare_to_baseline", "cad_metric", "scenario_projection", "compare_scenarios"];

  /* ---------------- datasets: tool result -> chartable form (no new numbers) ----------------
     series: [{name, values, kind}]   kind: actual | baseline | scenario | projected
     kinds:  per-category kind (e.g. 2025 actual, 2026+ projected) */
  function datasetFor(tool, input, out, field) {
    const R = out.result;
    const D = o => Object.assign({ categories: [], series: [], unit: "count", ordered: false, partsOfWhole: false, dataType: "actual",
      notes: [], assumptions: [], filtersUsed: null, period: null, xLabel: "", sourceMetric: tool, defaultType: "bar" }, o);
    const one = (rows, xKey, yKey, name, o) => D(Object.assign({ categories: rows.map(r => String(r[xKey])), series: [{ name, values: rows.map(r => r[yKey]), kind: "actual" }] }, o));
    switch (tool) {
      case "incidents_by_hour":
        return one(R.rows, "hour", "incidents", "Incidents", { categories: R.rows.map(r => String(r.hour).padStart(2, "0") + ":00"), ordered: true,
          xLabel: "Hour of day", period: R.period, sourceMetric: "CCFD1 incidents by hour (facts.json)", notes: [R.note] });
      case "incidents_by_location":
        if (field === "by_township") return one(R.by_township, "township", "incidents", "Incidents", { xLabel: "Township", period: R.period, defaultType: "hbar",
          sourceMetric: "CCFD1 incidents by township (facts.json)", notes: [R.note] });
        return one(R.rows, "location", "incidents", "Incidents", { xLabel: "Location", period: R.period, partsOfWhole: true, defaultType: "hbar",
          sourceMetric: "CCFD1 incidents by location (facts.json)", notes: [R.note] });
      case "finance_by_year": {
        const src = `Indiana Gateway AFR (${R.metric.replace(/_/g, " ")})`;
        if (R.metric === "revenue_by_source") return one(R.rows, "source", "amount", "2024 revenue", { unit: "USD", partsOfWhole: true, xLabel: "Source",
          defaultType: "donut", period: "2024", sourceMetric: src, notes: [R.note] });
        if (R.metric === "personnel_vs_contracted") return D({ categories: R.rows.map(r => String(r.year)), unit: "USD", ordered: true, xLabel: "Year",
          series: [{ name: "Personnel", values: R.rows.map(r => r.personnel), kind: "actual" }, { name: "Contracted", values: R.rows.map(r => r.contracted), kind: "actual" }],
          defaultType: "grouped_bar", period: `${R.rows[0].year}-${R.rows[R.rows.length - 1].year}`, sourceMetric: src, notes: [R.note] });
        return one(R.rows, "year", "value", R.metric.replace(/_/g, " ").replace(/^./, c => c.toUpperCase()), { unit: "USD", ordered: true, xLabel: "Year",
          defaultType: "line", period: `${R.rows[0].year}-${R.rows[R.rows.length - 1].year}`, sourceMetric: src, notes: [R.note] });
      }
      case "cad_metric": {
        const base = { period: R.period, filtersUsed: R.filters_used, mapLink: R.map_link, notes: [`Level: ${R.level}.`, ...(R.notes || [])],
          sourceMetric: `CAD extract: ${R.metric.replace(/_/g, " ")}` };
        const byCat = (rows, xKey, xLabel) => {
          const names = Object.keys(rows[0] || {}).filter(k => k !== xKey && k !== "total");
          if (field === "by_category" && names.length > 1)
            return D(Object.assign({ categories: rows.map(r => r[xKey]), ordered: true, xLabel, defaultType: "grouped_bar",
              series: names.map(n => ({ name: n, values: rows.map(r => r[n] || 0), kind: "actual" })) }, base));
          return D(Object.assign({ categories: rows.map(r => r[xKey]), ordered: true, xLabel,
            series: [{ name: R.filters_used.category ? `${R.filters_used.category} incidents` : "Incidents", values: rows.map(r => r.total), kind: "actual" }] }, base));
        };
        switch (R.metric) {
          case "by_hour": return byCat(R.rows, "hour", "Hour of day");
          case "by_day_of_week": return byCat(R.rows, "day", "Day of week");
          case "by_township": return one(R.rows, "township", "incidents", "Incidents", Object.assign({ xLabel: "Township", defaultType: "hbar", partsOfWhole: true }, base));
          case "by_category": return one(R.rows, "category", "incidents", "Incidents", Object.assign({ xLabel: "Category", defaultType: "hbar", partsOfWhole: true }, base));
          case "summary": return D(Object.assign({ kpis: [
            { label: "Incidents", value: R.incidents, unit: "count" },
            { label: "Outside service area (of located)", value: R.outside_pct_of_located, unit: "percent" },
            { label: "Apparatus responses", value: R.apparatus_responses, unit: "count" },
            { label: "Median response, min", value: R.median_response_min, unit: "minutes" },
            { label: "Median time on call, min", value: R.median_call_min, unit: "minutes" }].filter(k => k.value != null),
            categories: Object.keys(R.by_category), series: [{ name: "Incidents", values: Object.values(R.by_category), kind: "actual" }],
            xLabel: "Category", defaultType: "kpi" }, base));
          case "outside_area":
            if (field === "by_township") return one(R.outside_by_township, "township", "incidents", "Outside-area incidents", Object.assign({ xLabel: "Township", defaultType: "hbar" }, base));
            if (field === "time" || field === "hours") {
              if (!R.outside_time_by_category) throw new Error("time on calls is unavailable on the published layer");
              return D(Object.assign({ categories: R.outside_time_by_category.map(r => r.category), unit: "hours", xLabel: "Category", defaultType: "grouped_bar",
                series: [{ name: "Call hours", values: R.outside_time_by_category.map(r => r.call_hours), kind: "actual" },
                         { name: "Apparatus hours", values: R.outside_time_by_category.map(r => r.apparatus_hours), kind: "actual" }] }, base,
                { notes: [...base.notes, R.time_definitions] }));
            }
            return one(R.by_area, "area", "incidents", "Incidents", Object.assign({ xLabel: "Area", defaultType: "hbar", partsOfWhole: true }, base));
          case "time_on_call":
            return D(Object.assign({ categories: R.rows.map(r => r.category), unit: "hours", xLabel: "Category", defaultType: "grouped_bar",
              series: [{ name: "Call hours", values: R.rows.map(r => r.call_hours), kind: "actual" },
                       { name: "Apparatus hours", values: R.rows.map(r => r.apparatus_hours), kind: "actual" }] }, base, { notes: [...base.notes, R.time_definitions] }));
          case "apparatus": {
            const hrs = field === "hours";
            return D(Object.assign({ categories: R.rows.map(r => `${r.unit} (${r.agency})`), xLabel: "Apparatus", defaultType: "hbar", unit: hrs ? "hours" : "count",
              series: [{ name: hrs ? "Hours committed" : "Responses", values: R.rows.map(r => hrs ? r.hours_committed : r.responses), kind: "actual" }] }, base));
          }
          case "logansport_fire": {
            const k = field === "hours" ? ["lfd_apparatus_hours", "LFD apparatus hours", "hours"] : field === "apparatus_responses"
              ? ["lfd_apparatus_responses", "LFD apparatus responses", "count"] : ["incidents", "Incidents with LFD", "count"];
            return one(R.rows, "area", k[0], k[1], Object.assign({ xLabel: "Area", defaultType: "hbar", unit: k[2] }, base));
          }
        }
        return null;
      }
      case "run_scenario_1": {
        const P = R.projection;
        return D({ categories: P.map(p => String(p.year)), unit: "USD", ordered: true, xLabel: "Year", dataType: "projected", defaultType: "projection",
          series: [{ name: "Fund balance, end of year", values: P.map(p => p.fund_balance), kind: "scenario" }],
          kinds: P.map(p => (p.kind === "projected" ? "projected" : "actual")),
          kpis: [{ label: "Resulting annual " + (R.is_surplus ? "surplus" : "gap"), value: Math.abs(R.annual_gap), unit: "USD", kind: "projected" },
                 { label: "Change vs baseline gap", value: R.annual_gap - R.baseline_no_change.annual_gap, unit: "USD", kind: "projected", signed: true },
                 { label: "Years of fund balance", value: R.years_of_fund_balance, text: R.years_of_fund_balance_label, unit: "years", kind: "projected" }],
          scenarioName: "Scenario 1 (funding change)", baselineName: "Baseline (no change)", projectionPeriod: `${S1.YEARS[0]}-${S1.YEARS[S1.YEARS.length - 1]}`,
          period: null, sourceMetric: "Scenario 1 funding model (shared/engine.js)", assumptions: (R.input_status || []).map(x => `${x.input}: ${usd(x.value)} (${x.status.replace("_", " ")})`),
          notes: [R.caveats] });
      }
      case "run_scenario_34":
        return D({ dataType: "scenario", defaultType: "kpi", unit: "USD", xLabel: "Component",
          categories: ["Compensation decision (existing staff)", "Net staffing decision (new hires)"],
          series: [{ name: "Annual change vs baseline", values: [R.compensation_cost, R.staffing_net_cost], kind: "scenario" }],
          deltas: [R.compensation_cost, R.staffing_net_cost],
          kpis: [{ label: "Total annual change vs baseline", value: R.total_annual_change, unit: "USD", kind: "scenario", signed: true },
                 { label: "Resulting operating gap", value: R.resulting_gap, unit: "USD", kind: "scenario" },
                 { label: "Hires required", value: R.hires_required, unit: "count", kind: "scenario" },
                 { label: "Total operating rate per $100 AV", value: R.total_rate_per_100_av, unit: "rate", kind: "scenario" },
                 { label: "Household increase at $150,000 AV, per year", value: R.household_increase_150k_av, unit: "USD2", kind: "scenario" }],
          scenarioName: "Scenario 3&4 (staffing and compensation)", baselineName: `Baseline gap ${usd(ENG.BASE_GAP)}`,
          sourceMetric: "Team cost engine v2 (shared/engine.js)", assumptions: (R.input_status || []).filter(x => x.note).map(x => `${x.input}: ${x.note}`), notes: [R.caveats] });
      case "compare_to_baseline": {
        const name = R.scenario === "1" ? "Scenario 1 (funding change)" : "Scenario 3&4 (staffing and compensation)";
        if (field === "components") return D({ dataType: "scenario", unit: "USD", xLabel: "Component", defaultType: "delta",
          categories: R.components.map(c => c.component), series: [{ name: "Change in annual gap vs baseline", values: R.components.map(c => c.amount), kind: "scenario" }],
          deltas: R.components.map(c => c.amount), scenarioName: name, baselineName: "Baseline (no change)", sourceMetric: "compare_to_baseline (shared/engine.js)",
          notes: ["Positive = the annual gap grows; negative = it shrinks.", R.check] });
        return D({ dataType: "scenario", unit: "USD", xLabel: "", defaultType: "comparison", baselineIndex: 0,
          categories: ["Baseline (no change)", name], series: [{ name: "Annual operating gap", values: [R.baseline_gap, R.scenario_gap], kind: "scenario" }],
          kinds: ["baseline", "scenario"], deltas: [null, R.difference], scenarioName: name, baselineName: "Baseline (no change)",
          sourceMetric: "Annual operating gap (shared/engine.js)", notes: ["A gap is a deficit: expenses above recurring revenue."] });
      }
      case "scenario_projection": {
        const F = { revenue: "Revenue", expenses: "Expenses", operating_balance: "Operating balance (deficit < 0)", fund_balance: "Fund balance, end of year" };
        const rows = field === "fund_balance" || !field || !(field in F || field === "revenue_expenses") ? R.rows : R.rows.slice(1);
        const fields = field === "revenue_expenses" ? ["revenue", "expenses"] : [field in F ? field : "fund_balance"];
        return D({ categories: rows.map(r => String(r.year)), unit: "USD", ordered: true, xLabel: "Year", dataType: "projected",
          defaultType: fields[0] === "operating_balance" ? "bar" : "projection",
          series: fields.map(k => ({ name: F[k], values: rows.map(r => r[k]), kind: R.scenario_kind })),
          kinds: rows.map(r => (r.kind === "projected" ? "projected" : "actual")),
          scenarioName: R.scenario_kind === "baseline" ? null : R.scenario, baselineName: R.baseline, projectionPeriod: R.projection_period,
          sourceMetric: `${R.scenario}: ${fields.map(k => F[k].toLowerCase()).join(" and ")} (shared/engine.js)`,
          assumptions: R.assumptions, notes: [R.caveats] });
      }
      case "compare_scenarios": {
        const S = R.scenarios, names = S.map(s => s.name);
        const common = { unit: "USD", dataType: "projected", baselineName: R.baseline, scenarioName: names.slice(1).join("; "),
          projectionPeriod: R.projection_period, assumptions: R.assumptions, notes: [R.definitions, R.caveats], baselineIndex: 0 };
        const byYear = (rows, label, firstKinds) => D(Object.assign({ categories: rows.map(r => String(r.year)), ordered: true, xLabel: "Year", defaultType: "projection",
          series: names.map((n, k) => ({ name: n, values: rows.map(r => r[n]), kind: k ? "scenario" : "baseline" })),
          kinds: rows.map((r, k) => (firstKinds && k === 0 ? "actual" : "projected")), sourceMetric: label }, common));
        if (field === "operating_balance_by_year") return byYear(R.operating_balance_by_year, "Operating balance by year (deficit < 0)", false);
        const METRIC = { annual_operating_balance: "Annual operating balance (deficit < 0)", annual_revenue: "Annual revenue", annual_expenses: "Annual expenses",
          fund_balance_end: "Fund balance, end of projection", staffing_annual_change: "Staffing cost change per year", years_of_fund_balance: "Years of fund balance" };
        if (field in METRIC) {
          const unit = field === "years_of_fund_balance" ? "years" : "USD";
          return D(Object.assign({}, common, { unit, categories: names, xLabel: "", defaultType: "comparison",
            series: [{ name: METRIC[field], values: S.map(s => s[field]), kind: "projected" }], kinds: S.map(s => s.kind),
            deltas: S.map(s => (s.delta_vs_baseline && field in s.delta_vs_baseline ? s.delta_vs_baseline[field] : (s.kind === "baseline" ? null : (isNum(s[field]) && isNum(S[0][field]) ? s[field] - S[0][field] : null)))),
            sourceMetric: METRIC[field] }));
        }
        const dset = byYear(R.fund_balance_by_year, "Projected fund balance by year", true);
        dset.table = { columns: ["Metric", ...names], rows: [
          ["Annual revenue", ...S.map(s => s.annual_revenue)], ["Annual expenses", ...S.map(s => s.annual_expenses)],
          ["Annual operating balance", ...S.map(s => s.annual_operating_balance)], ["Fund balance, end of projection", ...S.map(s => s.fund_balance_end)],
          ["Staffing cost change per year", ...S.map(s => s.staffing_annual_change)], ["Years of fund balance", ...S.map(s => s.years_of_fund_balance_label)],
          ["First year below $0", ...S.map(s => s.first_year_below_zero || "None in period")]], units: ["", ...names.map(() => "USD")] };
        return dset;
      }
    }
    return null;
  }

  /* ---------------- spec: what the renderer draws ---------------- */
  const VIZ_TYPES = ["bar", "hbar", "line", "grouped_bar", "donut", "kpi", "table", "comparison", "projection", "delta"];
  function allowedTypes(d) {
    const n = d.series.length, m = d.categories.length, t = ["table"];
    const vals = d.series.flatMap(s => s.values).filter(isNum);
    if (m && n) t.push("bar", "hbar");
    if (n >= 2) t.push("grouped_bar");
    if (d.ordered && m >= 3) t.push("line");
    if (d.ordered && m >= 3 && d.dataType === "projected") t.push("projection");
    if (d.partsOfWhole && n === 1 && m >= 2 && m <= 7 && vals.every(v => v >= 0)) t.push("donut");
    if (d.kpis && d.kpis.length) t.push("kpi");
    if (d.baselineIndex != null && n >= 1) t.push("comparison");
    if (Array.isArray(d.deltas) && d.deltas.some(isNum)) t.push("delta");
    return t;
  }
  function buildSpec(d, requested, title, keepSeries, out) {
    if (Array.isArray(keepSeries) && keepSeries.length && d.series.length > 1) {
      const want = keepSeries.map(s => String(s).toLowerCase());
      const kept = d.series.filter(s => want.some(w => s.name.toLowerCase().includes(w) || (w === "ems" && /medical/i.test(s.name))));
      if (kept.length) d.series = kept;
    }
    if (d.series.length > 4) { d.notes.push(`Showing the first 4 of ${d.series.length} series.`); d.series = d.series.slice(0, 4); }
    const allowed = allowedTypes(d);
    let type = requested, fallbackNote = null;
    if (!VIZ_TYPES.includes(type) || !allowed.includes(type)) {
      type = allowed.includes(d.defaultType) ? d.defaultType : allowed.find(x => x !== "table") || "table";
      if (requested && requested !== type) fallbackNote = `"${requested}" does not suit this data; showing ${type.replace("_", " ")} instead.`;
    }
    if (type === "grouped_bar" && d.series.length < 2) type = "bar";
    const kinds = d.kinds || d.categories.map(() => (d.dataType === "projected" ? "projected" : d.dataType));
    const kindSet = new Set([...kinds, ...d.series.map(s => s.kind)]);
    const labels = [];
    if (kindSet.has("actual")) labels.push("Actual");
    if (kindSet.has("baseline") || d.baselineIndex != null) labels.push("Baseline");
    if (kindSet.has("scenario")) labels.push("Scenario");
    if (kindSet.has("projected") || d.dataType === "projected") labels.push("Projected");
    const columns = [d.xLabel || "Item", ...d.series.map(s => s.name)];
    const hasDelta = Array.isArray(d.deltas) && d.series.length === 1;
    if (hasDelta) columns.push("Change vs baseline");
    const table = d.table || { columns, rows: d.categories.map((c, i) => [c + (kinds[i] === "actual" && d.dataType === "projected" ? " (actual)" : ""),
      ...d.series.map(s => s.values[i]), ...(hasDelta ? [d.deltas[i]] : [])]) };
    const clean = s => String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim();
    return {
      visualizationType: type, visualizationTitle: clean(title).slice(0, 110) || d.sourceMetric.replace(/\s*\((facts\.json|shared\/engine\.js)\)$/, ""), dataType: d.dataType,
      valueLabels: labels, unit: d.unit, xLabel: d.xLabel, categories: d.categories.slice(0, 60).map(String), kinds: kinds.slice(0, 60),
      series: d.series.map(s => ({ name: s.name, kind: s.kind, values: s.values.slice(0, 60).map(v => (isNum(v) ? v : null)) })),
      deltas: Array.isArray(d.deltas) ? d.deltas.slice(0, 60).map(v => (isNum(v) ? v : null)) : null, baselineIndex: d.baselineIndex ?? null,
      kpis: d.kpis || null, table, sourceMetric: d.sourceMetric, filtersUsed: d.filtersUsed, period: d.period,
      scenarioName: d.scenarioName || null, baselineName: d.baselineName || null, projectionPeriod: d.projectionPeriod || null,
      assumptions: (d.assumptions || []).filter(Boolean), notes: (d.notes || []).filter(Boolean), mapLink: d.mapLink || null,
      sources: out ? out.sources : [], status: out ? out.status : null, fallbackNote
    };
  }
  /* Defensive check before anything is drawn (also used by the browser on every spec). */
  function validateSpec(s) {
    const errors = [];
    if (!s || typeof s !== "object") return { ok: false, errors: ["no spec"] };
    if (!VIZ_TYPES.includes(s.visualizationType)) errors.push("unknown visualization type");
    if (!Array.isArray(s.categories) || !Array.isArray(s.series)) errors.push("categories and series must be arrays");
    else {
      if (s.series.length > 4) errors.push("at most 4 series");
      s.series.forEach(se => {
        if (!se || !Array.isArray(se.values) || se.values.length !== s.categories.length) errors.push(`series "${se && se.name}" length does not match categories`);
        else if (se.values.some(v => v !== null && !isNum(v))) errors.push(`series "${se.name}" has a non-numeric value`);
      });
      if (s.visualizationType !== "table" && s.visualizationType !== "kpi" && (!s.categories.length || !s.series.length)) errors.push("nothing to plot");
      if (["bar", "hbar", "line", "grouped_bar", "donut", "projection", "comparison"].includes(s.visualizationType) &&
          !s.series.some(se => se.values.some(isNum))) errors.push("no numeric values to plot");
    }
    if (s.visualizationType === "kpi" && !(Array.isArray(s.kpis) && s.kpis.length)) errors.push("kpi needs values");
    if (s.visualizationType === "delta" && !(Array.isArray(s.deltas) && s.deltas.some(isNum))) errors.push("delta needs baseline deltas");
    if (s.dataType === "projected" && !(s.valueLabels || []).includes("Projected")) errors.push("projected data must be labelled Projected");
    if (!s.table || !Array.isArray(s.table.columns) || !Array.isArray(s.table.rows)) errors.push("table view missing");
    return { ok: errors.length === 0, errors };
  }

  function runVizTool(tools, name, input) {
    const i = input || {};
    switch (name) {
      case "cad_metric": return tools.cad_metric(i.metric, i.filters);
      case "scenario_projection": return tools.scenario_projection(i.scenario, i.params);
      case "compare_scenarios": return tools.compare_scenarios(i.scenarios);
      case "show_chart": return tools.show_chart(i);
      default: return Tools.runTool(tools, name, i);
    }
  }

  /* ---------------- Anthropic tool definitions for the /viz route ----------------
     The existing nine tools unchanged, plus four. Copied into worker/src/viz-tool-schemas.js by
     worker/scripts/sync-tools.mjs. */
  const obj = (properties, required, extra) => ({ type: "object", properties, required: required || [], additionalProperties: false, ...(extra || {}) });
  const CAD_FILTERS = obj({
    category: { type: "string", enum: ["medical", "ems", "fire", "vehicle", "other", "unclassified"], description: "Incident category. EMS calls = medical. Fire = fire / hazard. Vehicle = vehicle accident." },
    area: { type: "string", enum: AREAS, description: "inside = CCFD1 district + Washington Twp. contract area; district; contract; outside = outside the CCFD1 service area; unknown = no location." },
    township: { type: "string", description: "Township name, e.g. \"Clinton\" or \"Clinton Township\"." },
    agency: { type: "string", description: "CAD agency whose incidents to count. Default DIST (CCFD1). \"all\" = every agency in the CAD extract; LFD = Logansport Fire; CCEMS = Cass County EMS." },
    start: { type: "string", description: "First date, YYYY-MM-DD." }, end: { type: "string", description: "Last date, YYYY-MM-DD." },
    day_of_week: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] },
    hour_from: { type: "integer", minimum: 0, maximum: 23 }, hour_to: { type: "integer", minimum: 0, maximum: 23, description: "hour_from > hour_to wraps midnight." }
  }, [], { description: "Optional filters. Omitted = all CCFD1 incidents." });
  const SCENARIO_PARAMS = { type: "object", description: "Same parameters as run_scenario_1 (scenario \"1\") or run_scenario_34 (scenario \"3&4\"). Omitted fields use the dashboard defaults." };
  const VIZ_TOOL_SCHEMAS = [
    ...Tools.TOOL_SCHEMAS,
    { name: "cad_metric",
      description: "Historical CAD metrics (Sep 16 2025 - Sep 16 2026) from the same functions as the dashboard's CAD & GIS page. Incident-level: summary, by_hour, by_day_of_week, by_township, by_category, outside_area (counts + time on outside calls by category). Unit-response-level: apparatus (busiest apparatus, responses and hours), time_on_call (call hours and apparatus hours by category), logansport_fire (Logansport Fire responses into / outside the CCFD1 area). Incident counts are unique incidents, never multiplied by responding units. Aggregates only. If the result says unavailable, tell the user it is unavailable.",
      input_schema: obj({ metric: { type: "string", enum: CAD_METRICS }, filters: CAD_FILTERS }, ["metric"]) },
    { name: "scenario_projection",
      description: "Year-by-year projection 2026-2030 for the no-change baseline, Scenario 1 (funding change) or Scenario 3&4 (staffing and compensation), from the dashboard's scenario engine: revenue, expenses, operating balance (deficit < 0) and end-of-year fund balance, with the 2025 actual (partner-stated) fund balance as the starting point. Expenses and revenue are held flat (planning comparison, not a forecast). Results are model_output.",
      input_schema: obj({ scenario: { type: "string", enum: ["baseline", "1", "3&4"] }, params: SCENARIO_PARAMS }, ["scenario"]) },
    { name: "compare_scenarios",
      description: "Compare the no-change baseline with 1-3 scenarios (Scenario 1 and/or Scenario 3&4 with any parameters): annual revenue, expenses, operating balance, end-of-projection fund balance, years of fund balance, staffing cost change and tax rate, each with its delta vs baseline, plus fund balance and operating balance by year. Use for 'which scenario has the best outlook' or 'change from baseline for each metric'. Results are model_output.",
      input_schema: obj({ scenarios: { type: "array", minItems: 1, maxItems: 3, items: obj({ scenario: { type: "string", enum: ["1", "3&4"] }, params: SCENARIO_PARAMS }, ["scenario"]) } }, ["scenarios"]) },
    { name: "show_chart",
      description: "Show a chart under your answer. Name a data tool and its input; the dashboard re-runs that tool and draws the chart from its result (you never supply numbers). The result also returns the tool's data, so you can call show_chart alone instead of calling the data tool first. Call it at most once per question, only when a chart helps.",
      input_schema: obj({
        chart_type: { type: "string", enum: VIZ_TYPES, description: "bar, hbar (ranked), line (over time), grouped_bar (2-4 series), donut (parts of a whole only), kpi (headline cards), table, comparison (baseline vs scenarios), projection (multi-year projected), delta (change vs baseline). Unsuitable types fall back automatically." },
        title: { type: "string", description: "Short descriptive chart title with no numbers, e.g. \"EMS incidents by hour of day\"." },
        tool: { type: "string", enum: DATA_TOOLS },
        tool_input: { type: "object", description: "The input for that tool, exactly as you would call it." },
        field: { type: "string", description: "Optional view. cad_metric by_hour/by_day_of_week: by_category (one series per category). outside_area: by_township | time. apparatus: responses | hours. logansport_fire: incidents | apparatus_responses | hours. incidents_by_location: by_township. scenario_projection: fund_balance | revenue | expenses | revenue_expenses | operating_balance. compare_scenarios: fund_balance_by_year | operating_balance_by_year | annual_operating_balance | annual_revenue | annual_expenses | fund_balance_end | staffing_annual_change | years_of_fund_balance. compare_to_baseline: components." },
        series: { type: "array", items: { type: "string" }, maxItems: 4, description: "Optional: keep only these series, e.g. [\"Medical\", \"Fire\"]." }
      }, ["chart_type", "tool", "tool_input"]) }
  ];

  return { createVizTools, runVizTool, datasetFor, buildSpec, validateSpec, allowedTypes, VIZ_TYPES, DATA_TOOLS, VIZ_TOOL_SCHEMAS, INSUFFICIENT };
});
