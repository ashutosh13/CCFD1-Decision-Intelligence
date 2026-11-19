/* CCFD1 dataset layer: validation and querying of the static, aggregate-only datasets in datasets/.
   Pure functions, no I/O, so the dashboard, the assistant tools and chart components share one implementation.

   A dataset is one JSON file:
     { id, title, panel?, grain, period, status, source, source_detail, note?,
       dimensions: [{ name, type: "int" | "string" }],
       measures:   [{ name, unit }],
       rows: [{ <dimension>: v, <measure>: n, _status?: status }] }
   datasets/index.json is the manifest: { datasets: [{ id, title, file, ... }] }.

   Node:    const D = require("./shared/dataset.js");  D.loadDatasets();
   Browser: <script src="shared/dataset.js"></script>  CCFD1Dataset.query(ds, {...}) */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    api.loadDatasets = function loadDatasets(dir) {
      const fs = require("fs"), path = require("path");
      const base = dir || path.join(__dirname, "..", "datasets");
      const manifest = JSON.parse(fs.readFileSync(path.join(base, "index.json"), "utf8"));
      return manifest.datasets.map(m => JSON.parse(fs.readFileSync(path.join(base, m.file), "utf8")));
    };
    module.exports = api;
  } else {
    root.CCFD1Dataset = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STATUS_ORDER = ["verified", "partner_stated", "model_output", "placeholder"]; // strongest -> weakest
  const TYPES = ["int", "string"];
  const AGGS = ["sum", "avg", "min", "max", "count"];
  const MAX_ROWS = 500;
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const weakest = (...ss) => ss.flat().filter(s => STATUS_ORDER.includes(s))
    .reduce((w, s) => (STATUS_ORDER.indexOf(s) > STATUS_ORDER.indexOf(w) ? s : w), "verified");

  /* Returns a list of problems; empty means the dataset is well formed. Rows may carry only the declared
     dimensions, the declared measures and _status, which is also the guard against record-level fields. */
  function validateDataset(ds) {
    const errs = [];
    if (!ds || typeof ds !== "object") return ["dataset must be an object"];
    for (const k of ["id", "title", "grain", "period", "source", "source_detail"])
      if (typeof ds[k] !== "string" || !ds[k]) errs.push(`${k} must be a non-empty string`);
    if (typeof ds.id === "string" && !/^[a-z][a-z0-9_]*$/.test(ds.id)) errs.push("id must be lowercase letters, digits and underscores");
    if (!STATUS_ORDER.includes(ds.status)) errs.push(`status must be one of ${STATUS_ORDER.join(", ")}`);
    if (!Array.isArray(ds.dimensions) || !ds.dimensions.length) errs.push("dimensions must be a non-empty array");
    if (!Array.isArray(ds.measures) || !ds.measures.length) errs.push("measures must be a non-empty array");
    if (!Array.isArray(ds.rows)) errs.push("rows must be an array");
    if (errs.length) return errs;
    const names = new Set();
    for (const d of ds.dimensions) {
      if (!d || typeof d.name !== "string" || !TYPES.includes(d.type)) errs.push(`dimension needs a name and type ${TYPES.join("|")}`);
      else if (names.has(d.name)) errs.push(`duplicate column ${d.name}`); else names.add(d.name);
    }
    for (const m of ds.measures) {
      if (!m || typeof m.name !== "string" || typeof m.unit !== "string") errs.push("measure needs a name and unit");
      else if (names.has(m.name)) errs.push(`duplicate column ${m.name}`); else names.add(m.name);
    }
    if (errs.length) return errs;
    const allowed = new Set([...names, "_status"]);
    ds.rows.forEach((row, i) => {
      for (const k of Object.keys(row)) if (!allowed.has(k)) errs.push(`row ${i}: unexpected field ${k}`);
      for (const d of ds.dimensions) {
        const v = row[d.name];
        if (d.type === "int" ? !Number.isInteger(v) : typeof v !== "string") errs.push(`row ${i}: ${d.name} must be ${d.type}`);
      }
      for (const m of ds.measures) if (row[m.name] !== null && !isNum(row[m.name])) errs.push(`row ${i}: ${m.name} must be a number or null`);
      if (row._status !== undefined && !STATUS_ORDER.includes(row._status)) errs.push(`row ${i}: bad _status`);
    });
    const dimKey = r => ds.dimensions.map(d => r[d.name]).join("\u0000");
    const seen = new Set();
    ds.rows.forEach((r, i) => { const k = dimKey(r); if (seen.has(k)) errs.push(`row ${i}: duplicate dimension values`); seen.add(k); });
    return errs;
  }

  /* One manifest entry per dataset: what a caller needs to decide whether to query it. */
  function describe(ds) {
    return { id: ds.id, title: ds.title, panel: ds.panel || null, grain: ds.grain, period: ds.period, status: ds.status,
      dimensions: ds.dimensions.map(d => ({ name: d.name, type: d.type })),
      measures: ds.measures.map(m => ({ name: m.name, unit: m.unit })), rows: ds.rows.length,
      source: ds.source };
  }

  function matches(value, cond) {
    if (cond === null || typeof cond !== "object") return value === cond;
    for (const [op, x] of Object.entries(cond)) {
      if (op === "eq" && value !== x) return false;
      else if (op === "ne" && value === x) return false;
      else if (op === "gt" && !(value > x)) return false;
      else if (op === "gte" && !(value >= x)) return false;
      else if (op === "lt" && !(value < x)) return false;
      else if (op === "lte" && !(value <= x)) return false;
      else if (op === "in" && !(Array.isArray(x) && x.includes(value))) return false;
      else if (!["eq", "ne", "gt", "gte", "lt", "lte", "in"].includes(op)) throw new Error(`unknown filter operator "${op}"`);
    }
    return true;
  }

  function agg(fn, values) {
    const v = values.filter(isNum);
    if (fn === "count") return v.length;
    if (!v.length) return null;
    if (fn === "sum") return v.reduce((a, b) => a + b, 0);
    if (fn === "avg") return v.reduce((a, b) => a + b, 0) / v.length;
    return fn === "min" ? Math.min(...v) : Math.max(...v);
  }

  /* query(ds, { select?, filter?, groupBy?, aggregate?, orderBy?, limit? })
       filter     { column: value | { eq, ne, gt, gte, lt, lte, in } }, all conditions must hold
       groupBy    dimension names; requires aggregate
       aggregate  { measure: "sum" | "avg" | "min" | "max" | "count" }; with no groupBy it gives one row
       orderBy    { column, desc? } on a column of the result
       select     columns to return when not aggregating (default all)
     Returns { columns: [{name, role, unit?}], rows, status, source, source_detail, period, dataset }
     or { error }. status is the weakest of the dataset's and of every returned source row. */
  function query(ds, q) {
    q = q || {};
    const bad = validateDataset(ds); if (bad.length) return { error: `dataset ${ds && ds.id} is invalid: ${bad[0]}` };
    const dims = new Map(ds.dimensions.map(d => [d.name, d]));
    const meas = new Map(ds.measures.map(m => [m.name, m]));
    const known = n => dims.has(n) || meas.has(n);
    try {
      const filter = q.filter || {};
      for (const c of Object.keys(filter)) if (!known(c)) return { error: `unknown column "${c}" in filter; columns are ${[...dims.keys(), ...meas.keys()].join(", ")}` };
      const groupBy = q.groupBy || [], aggregate = q.aggregate || {};
      for (const g of groupBy) if (!dims.has(g)) return { error: `groupBy "${g}" is not a dimension; dimensions are ${[...dims.keys()].join(", ")}` };
      for (const [m, fn] of Object.entries(aggregate)) {
        if (!meas.has(m)) return { error: `aggregate "${m}" is not a measure; measures are ${[...meas.keys()].join(", ")}` };
        if (!AGGS.includes(fn)) return { error: `aggregate function must be one of ${AGGS.join(", ")}` };
      }
      if (groupBy.length && !Object.keys(aggregate).length) return { error: "groupBy needs aggregate, e.g. {\"revenue\":\"sum\"}" };

      const kept = ds.rows.filter(r => Object.entries(filter).every(([c, cond]) => matches(r[c], cond)));
      let columns, rows;
      if (Object.keys(aggregate).length) {
        columns = [...groupBy.map(g => ({ name: g, role: "dimension" })),
          ...Object.entries(aggregate).map(([m, fn]) => ({ name: m, role: "measure", unit: fn === "count" ? "count" : meas.get(m).unit, aggregate: fn }))];
        const groups = new Map();
        for (const r of kept) { const k = groupBy.map(g => r[g]).join("\u0000"); (groups.get(k) || groups.set(k, []).get(k)).push(r); }
        if (!groupBy.length && !groups.size) groups.set("", []);
        rows = [...groups.values()].map(g => {
          const out = {}; groupBy.forEach(c => { out[c] = g[0][c]; });
          for (const [m, fn] of Object.entries(aggregate)) out[m] = agg(fn, g.map(r => r[m]));
          return out;
        });
      } else {
        const sel = q.select || [...dims.keys(), ...meas.keys()];
        for (const c of sel) if (!known(c)) return { error: `unknown column "${c}" in select` };
        columns = sel.map(c => dims.has(c) ? { name: c, role: "dimension" } : { name: c, role: "measure", unit: meas.get(c).unit });
        rows = kept.map(r => Object.fromEntries(sel.map(c => [c, r[c]])));
      }
      if (q.orderBy) {
        const { column, desc } = q.orderBy;
        if (!columns.some(c => c.name === column)) return { error: `orderBy column "${column}" is not in the result` };
        rows.sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (desc ? -1 : 1));
      }
      const limit = Number.isInteger(q.limit) && q.limit > 0 ? Math.min(q.limit, MAX_ROWS) : MAX_ROWS;
      const truncated = rows.length > limit;
      rows = rows.slice(0, limit);
      return { dataset: ds.id, columns, rows, truncated, period: ds.period, source: ds.source, source_detail: ds.source_detail,
        note: ds.note || null, status: weakest(ds.status, kept.map(r => r._status)) };
    } catch (e) {
      return { error: e.message };
    }
  }

  return { query, validateDataset, describe, weakest, STATUS_ORDER, AGGS };
});
