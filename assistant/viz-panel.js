/* "Ask CCFD1 AI" panel on index.html (section #ai-viz, below "Ask the data").

   Same architecture as "Ask the data": the browser holds the conversation and runs the tools;
   the existing Cloudflare Worker forwards to Claude. This panel posts to the Worker's /viz route,
   which adds its own fixed system prompt and tool list (assistant/viz-tools.js).

   Charts: the model can only call show_chart with a chart type and a data-tool reference.
   assistant/viz-tools.js re-runs that tool and returns a validated spec; this file draws the
   spec as inline SVG in the dashboard's own style (the page uses hand-built SVG, no chart library).
   The model never supplies a number that is drawn.

   Reuses, without changing them, these globals from the page's main script: ASSISTANT_URL,
   FACTS_READY, AskError, ASK.friendly, bytesOf, renderAnswer. Loaded after that script. */
(function () {
  "use strict";
  const root = document.getElementById("ai-viz");
  if (!root || !window.CCFD1VizTools) return;
  const V = window.CCFD1VizTools;
  const $q = s => root.querySelector(s);

  /* ---------- Worker URL: the existing assistant Worker, /viz route ----------
     For local testing against `npm run dev` (worker/README.md), open the page on localhost with
     ?aiWorker=http://localhost:8787 . The override is accepted only on a localhost page and only
     for a localhost URL. */
  function workerUrl() {
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    const o = (new URLSearchParams(location.search).get("aiWorker") || "").trim().replace(/[./]+$/, "");   // tolerate a pasted trailing "." or "/"
    if (local && o && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(o)) return o + "/viz";
    return typeof ASSISTANT_URL === "string" && ASSISTANT_URL ? ASSISTANT_URL.replace(/\/$/, "") + "/viz" : "";
  }
  const URL_ = workerUrl();

  const CFG = {
    maxToolRounds: 8,           // the Worker refuses a 9th round trip for one question
    maxBodyBytes: 39000,        // the Worker's /viz cap is 40 KB
    freshThreadBytes: 24000,    // start a fresh thread before the history nears the cap
    maxToolResultChars: 15000,  // the Worker accepts up to 16,000 per tool result
    suggestions: {
      Historical: ["Show EMS calls by hour", "Which apparatus is busiest?", "Show incidents by township"],
      Future: ["Compare baseline and Scenario 1 with $250,000 more a year", "Show projected revenue for the next 5 years", "Show projected deficit/surplus under each scenario"]
    }
  };
  const FRIENDLY = Object.assign({
    network: "I couldn't reach the assistant. Check your connection and try again.",
    busy: "The assistant is busy. Please wait a few minutes and try again.",
    tooLong: "This conversation has grown too long. Please ask again; it will start a fresh thread.",
    rounds: "That question needed more steps than allowed. Try asking something more specific.",
    refusal: "I can't help with that one. Try asking about the dashboard's data.",
    error: "The assistant couldn't answer right now. Please try again later.",
    noData: "The assistant needs the dashboard's data file, which browsers block when the page is opened as a local file. Run python -m http.server 8000 in the repo folder."
  }, (typeof ASK === "object" && ASK.friendly) || {});
  const Err = typeof AskError === "function" ? AskError : class extends Error { constructor(k) { super(k); this.kind = k; } };
  const sizeOf = typeof bytesOf === "function" ? bytesOf : o => new TextEncoder().encode(JSON.stringify(o)).length;

  /* ---------- data: facts.json (already loaded by the page) + CAD dataset, loaded once ---------- */
  let toolsP = null;
  function getTools() {
    if (!toolsP) toolsP = (async () => {
      const doc = typeof FACTS_READY !== "undefined" ? await FACTS_READY : null;
      if (!doc) throw new Err("noData");
      let cad = null;
      try {
        const r = await fetch("data/cad-gis-detail.json");   // local, git-ignored detail; absent on the published site
        if (r.ok) cad = CCFD1Metrics.prepare(await r.json());
      } catch { /* fall back to the published layer */ }
      if (!cad && window.CCFD1GIS) cad = CCFD1Metrics.fromPublished(CCFD1GIS);
      return V.createVizTools(doc, cad);
    })().catch(e => { toolsP = null; throw e; });
    return toolsP;
  }

  /* ---------- formatting ---------- */
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = v => typeof v === "number" && Number.isFinite(v);
  const int = v => Math.round(v).toLocaleString("en-US");
  function fmt(v, unit, compact) {
    if (!isNum(v)) return "–";
    const sign = v < 0 ? "-" : "", a = Math.abs(v);
    switch (unit) {
      case "USD":
        if (compact && a >= 1e6) return sign + "$" + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
        if (compact && a >= 1e3) return sign + "$" + Math.round(a / 1e3) + "K";
        return sign + "$" + int(a);
      case "USD2": return sign + "$" + a.toFixed(2);
      case "rate": return "$" + v.toFixed(4);
      case "percent": return (Math.round(v * 10) / 10) + "%";
      case "hours": return (Math.round(v * 10) / 10).toLocaleString("en-US") + (compact ? "" : " h");
      case "minutes": return (Math.round(v * 10) / 10) + (compact ? "" : " min");
      case "years": return (Math.round(v * 10) / 10) + (compact ? "" : " yrs");
      default: return Number.isInteger(v) ? int(v) : (Math.round(v * 10) / 10).toLocaleString("en-US");
    }
  }
  const signed = (v, unit) => (isNum(v) ? (v > 0 ? "+" : "") + fmt(v, unit) : "–");
  function ticks(lo, hi, n) {
    if (lo === hi) hi = lo + 1;
    const raw = (hi - lo) / (n || 4), mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let t = Math.floor(lo / step) * step; t <= Math.ceil(hi / step) * step + step / 2; t += step) out.push(Math.round(t / step) * step);
    return out;
  }

  /* ---------- palette: the dashboard's own colours ----------
     Multi-series order validated for colour-vision deficiency (blue, amber, purple, green);
     a single historical series uses the navy the other panels use. */
  const C = { navy: "#17365D", blue: "#2F6FB3", amber: "#B26A00", purple: "#7A4FB0", green: "#3E8E5E", tint: "#E8EFF7", line: "#D9E2EC", muted: "#5B6B80", ink: "#132033" };
  const SERIES = [C.blue, C.amber, C.purple, C.green];
  const singleColor = kind => (kind === "baseline" ? C.blue : kind === "scenario" || kind === "projected" ? C.amber : C.navy);
  let uid = 0;

  /* ---------- renderers (all text escaped; values from validated specs only) ---------- */
  function hatchDef(id, color) {
    return `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${color}" fill-opacity=".28"/><line x1="0" y1="0" x2="0" y2="6" stroke="${color}" stroke-width="2.5"/></pattern>`;
  }
  /* vertical bars: bar, grouped_bar, comparison */
  function vbars(s, W) {
    const H = 250, L = 56, R = 8, T = 22, B = 34, n = s.categories.length, k = s.series.length;
    const vals = s.series.flatMap(x => x.values).filter(isNum);
    const tk = ticks(Math.min(0, ...vals), Math.max(0, ...vals), 4), lo = tk[0], hi = tk[tk.length - 1];
    const sy = v => T + (hi - v) / (hi - lo) * (H - T - B), step = (W - L - R) / n, bw = Math.min(46, step * 0.72 / k);
    const every = Math.ceil(n / Math.max(1, Math.floor((W - L) / 46)));
    const id = "aiv" + (++uid);
    let defs = "", g = "";
    tk.forEach(t => {
      g += `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" stroke="${t === 0 ? C.muted : C.line}"${t ? ' stroke-dasharray="2 3"' : ""}/>`;
      g += `<text x="${L - 5}" y="${sy(t) + 4}" font-size="10.5" text-anchor="end" fill="${C.muted}">${esc(fmt(t, s.unit, true))}</text>`;
    });
    const colorAt = (si, ci) => s.visualizationType === "comparison" && k === 1 ? SERIES[Math.min(ci, 3)] : k === 1 ? singleColor(s.series[0].kind) : SERIES[si];
    const label = k === 1 && n <= 8;
    s.categories.forEach((c, ci) => {
      const x0 = L + ci * step + (step - bw * k) / 2;
      s.series.forEach((se, si) => {
        const v = se.values[ci]; if (!isNum(v)) return;
        const col = colorAt(si, ci), proj = s.kinds[ci] === "projected", y = sy(Math.max(v, 0)), h = Math.max(1, Math.abs(sy(v) - sy(0)));
        let fill = col;
        if (proj) { const pid = `${id}h${si}_${ci}`; defs += hatchDef(pid, col); fill = `url(#${pid})`; }
        const tip = `${c}${k > 1 ? " · " + se.name : ""}: ${fmt(v, s.unit)}${proj ? " (projected)" : s.kinds[ci] === "actual" && s.dataType === "projected" ? " (actual)" : ""}` +
          (s.deltas && isNum(s.deltas[ci]) ? `, ${signed(s.deltas[ci], s.unit)} vs baseline` : "");
        g += `<rect x="${x0 + si * bw}" y="${y}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="${fill}"${proj ? ` stroke="${col}"` : ""}><title>${esc(tip)}</title></rect>`;
        if (label) {
          const ly = v >= 0 ? y - 5 : y + h + 12;
          g += `<text x="${x0 + si * bw + bw / 2 - 1}" y="${ly}" font-size="10.5" text-anchor="middle" fill="${C.ink}">${esc(fmt(v, s.unit, n > 4))}</text>`;
          if (s.deltas && isNum(s.deltas[ci])) g += `<text x="${x0 + bw / 2}" y="${v >= 0 ? ly - 13 : ly + 13}" font-size="10" font-weight="600" text-anchor="middle" fill="${C.muted}">${esc(signed(s.deltas[ci], s.unit))} vs baseline</text>`;
        }
      });
      if (ci % every === 0) {
        const t = c.length > 16 && n > 3 ? c.slice(0, 15) + "…" : c;
        g += `<text x="${L + ci * step + step / 2}" y="${H - B + 15}" font-size="10.5" text-anchor="middle" fill="${C.muted}"><title>${esc(c)}</title>${esc(t)}</text>`;
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.visualizationTitle)}"><defs>${defs}</defs>${g}</svg>`;
  }
  /* horizontal ranked bars, label above each bar (as the dashboard's own hbars) */
  function hbars(s, W) {
    const se = s.series[0], vals = se.values.map(v => (isNum(v) ? v : 0)), max = Math.max(...vals, 0) || 1;
    const col = singleColor(se.kind), track = W - 4, H = s.categories.length * 40 + 6;
    let g = "";
    s.categories.forEach((c, i) => {
      const y = 4 + i * 40, v = se.values[i], w = Math.max(3, (vals[i] / max) * track);
      const lab = `${c}: ${fmt(v, s.unit)}` + (s.deltas && isNum(s.deltas[i]) ? ` (${signed(s.deltas[i], s.unit)} vs baseline)` : "");
      g += `<text x="0" y="${y + 13}" font-size="12" fill="${C.muted}">${esc(lab)}</text>`;
      g += `<rect x="0" y="${y + 19}" width="${track}" height="11" rx="5.5" fill="${C.tint}"/>`;
      g += `<rect x="0" y="${y + 19}" width="${w}" height="11" rx="5.5" fill="${col}"><title>${esc(lab)}</title></rect>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.visualizationTitle)}">${g}</svg>`;
  }
  /* line / projection: dashed segments and hollow points for projected values */
  function lines(s, W) {
    const H = 250, L = 56, R = 12, T = 24, B = 30, n = s.categories.length;
    const vals = s.series.flatMap(x => x.values).filter(isNum);
    const tk = ticks(Math.min(0, ...vals), Math.max(...vals, 0), 4), lo = tk[0], hi = tk[tk.length - 1];
    const sx = i => L + 8 + i * (W - L - R - 16) / Math.max(1, n - 1), sy = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const every = Math.ceil(n / Math.max(1, Math.floor((W - L) / 44)));
    let g = "";
    const firstProj = s.kinds.indexOf("projected");
    if (firstProj >= 0) {
      const x = firstProj > 0 ? (sx(firstProj - 1) + sx(firstProj)) / 2 : sx(0) - 8;
      g += `<rect x="${x}" y="${T - 14}" width="${W - R - x}" height="${H - B - T + 14}" fill="${C.tint}" fill-opacity=".6"/>`;
      g += `<text x="${x + 5}" y="${T - 3}" font-size="10.5" font-weight="600" fill="${C.muted}">Projected</text>`;
    }
    tk.forEach(t => {
      g += `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" stroke="${t === 0 ? C.muted : C.line}"${t ? ' stroke-dasharray="2 3"' : ' stroke-dasharray="4 3"'}/>`;
      g += `<text x="${L - 5}" y="${sy(t) + 4}" font-size="10.5" text-anchor="end" fill="${C.muted}">${esc(fmt(t, s.unit, true))}</text>`;
    });
    s.series.forEach((se, si) => {
      const col = s.series.length === 1 ? singleColor(se.kind) : SERIES[si];
      for (let i = 1; i < n; i++) {
        const a = se.values[i - 1], b = se.values[i]; if (!isNum(a) || !isNum(b)) continue;
        const dash = s.kinds[i] === "projected" ? ' stroke-dasharray="6 4"' : "";
        g += `<line x1="${sx(i - 1)}" y1="${sy(a)}" x2="${sx(i)}" y2="${sy(b)}" stroke="${col}" stroke-width="2" stroke-linecap="round"${dash}/>`;
      }
      se.values.forEach((v, i) => {
        if (!isNum(v)) return;
        const proj = s.kinds[i] === "projected";
        const tip = `${s.categories[i]}${s.series.length > 1 ? " · " + se.name : ""}: ${fmt(v, s.unit)} (${proj ? "projected" : s.dataType === "projected" ? "actual" : "actual"})`;
        g += `<circle cx="${sx(i)}" cy="${sy(v)}" r="4" fill="${proj ? "#fff" : col}" stroke="${col}" stroke-width="2"><title>${esc(tip)}</title></circle>`;
      });
    });
    s.categories.forEach((c, i) => { if (i % every === 0 || (i === n - 1 && (n - 1) % every >= every / 2 + 0.5)) g +=`<text x="${sx(i)}" y="${H - 9}" font-size="10.5" text-anchor="middle" fill="${C.muted}">${esc(c)}</text>`; });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.visualizationTitle)}">${g}</svg>`;
  }
  function donut(s) {
    const se = s.series[0], tot = se.values.reduce((a, v) => a + (isNum(v) ? v : 0), 0) || 1;
    const cols = [C.navy, C.blue, "#8FB3DC", "#C8D6E7", C.muted, C.amber, C.purple];
    let a = -Math.PI / 2, g = ""; const cx = 110, cy = 110, R0 = 90, r0 = 56;
    const p = (ang, rad) => `${cx + rad * Math.cos(ang)} ${cy + rad * Math.sin(ang)}`;
    se.values.forEach((v, i) => {
      const f = (isNum(v) ? v : 0) / tot; if (!f) return;
      const a2 = a + f * 2 * Math.PI, l = f > 0.5 ? 1 : 0;
      g += `<path d="M${p(a, R0)}A${R0} ${R0} 0 ${l} 1 ${p(a2, R0)}L${p(a2, r0)}A${r0} ${r0} 0 ${l} 0 ${p(a, r0)}Z" fill="${cols[i % cols.length]}" stroke="#fff" stroke-width="2"><title>${esc(`${s.categories[i]}: ${fmt(v, s.unit)} (${(f * 100).toFixed(1)}%)`)}</title></path>`;
      a = a2;
    });
    g += `<text x="${cx}" y="${cy + 5}" font-size="17" font-weight="600" text-anchor="middle" fill="${C.navy}">${esc(fmt(tot, s.unit, true))}</text>`;
    const legend = s.categories.map((c, i) => `<span><i style="background:${cols[i % cols.length]}"></i>${esc(c)} ${Math.round((isNum(se.values[i]) ? se.values[i] : 0) / tot * 100)}%</span>`).join("");
    return `<svg viewBox="0 0 220 220" style="max-width:240px;margin:0 auto" role="img" aria-label="${esc(s.visualizationTitle)}">${g}</svg><div class="legend">${legend}</div>`;
  }
  /* delta: diverging bars around zero, signed labels */
  function deltas(s, W) {
    const D = s.deltas, vals = D.filter(isNum), m = Math.max(...vals.map(Math.abs), 1);
    const mid = W / 2, half = W / 2 - 4, H = s.categories.length * 40 + 6;
    let g = `<line x1="${mid}" x2="${mid}" y1="0" y2="${H}" stroke="${C.muted}"/>`;
    s.categories.forEach((c, i) => {
      const y = 4 + i * 40, v = D[i];
      const lab = isNum(v) ? `${c}: ${signed(v, s.unit)} vs baseline` : `${c}: reference (baseline)`;
      g += `<text x="0" y="${y + 13}" font-size="12" fill="${C.muted}">${esc(lab)}</text>`;
      if (isNum(v) && v !== 0) {
        const w = Math.max(3, Math.abs(v) / m * half), col = v > 0 ? C.blue : C.amber;
        g += `<rect x="${v > 0 ? mid : mid - w}" y="${y + 19}" width="${w}" height="11" rx="2" fill="${col}"><title>${esc(lab)}</title></rect>`;
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.visualizationTitle)}">${g}</svg>`;
  }
  function kpis(s) {
    return `<div class="aiviz-kpis">` + s.kpis.map(k => `<div class="kpi"><span class="label">${esc(k.label)}</span>` +
      `<span class="value">${esc(k.text || (k.signed ? signed(k.value, k.unit) : fmt(k.value, k.unit)))}</span>` +
      (k.kind ? `<span class="src">${esc(k.kind === "projected" ? "Projected (model output)" : k.kind === "scenario" ? "Scenario (model output)" : "Actual")}</span>` : "") + `</div>`).join("") + `</div>`;
  }
  function table(s) {
    const t = s.table, units = t.units || [];
    const cell = (v, j) => (isNum(v) ? fmt(v, units[j] || (/change vs baseline/i.test(t.columns[j] || "") ? s.unit : s.unit)) : esc(v == null ? "–" : v));
    const fmtCell = (v, j) => (isNum(v) && /change vs baseline/i.test(t.columns[j] || "") ? signed(v, s.unit) : cell(v, j));
    return `<div class="aiviz-table"><table><thead><tr>${t.columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
      t.rows.map(r => `<tr>${r.map((v, j) => (j === 0 ? `<th scope="row">${esc(v)}</th>` : `<td>${fmtCell(v, j)}</td>`)).join("")}</tr>`).join("") + `</tbody></table></div>`;
  }
  function legend(s) {
    const items = [];
    if (s.series.length > 1) s.series.forEach((se, i) => items.push(`<span><i style="background:${SERIES[i]}"></i>${esc(se.name)}</span>`));
    else if (s.visualizationType === "comparison") s.categories.forEach((c, i) => items.push(`<span><i style="background:${SERIES[Math.min(i, 3)]}"></i>${esc(c)}</span>`));
    if (s.kinds.includes("projected") && ["line", "projection"].includes(s.visualizationType)) items.push(`<span>Solid / filled = actual · dashed / hollow = projected</span>`);
    else if (s.kinds.includes("projected") && ["bar", "grouped_bar", "comparison"].includes(s.visualizationType)) items.push(`<span>Hatched = projected</span>`);
    return items.length ? `<div class="legend">${items.join("")}</div>` : "";
  }

  function drawSpec(s, width) {
    const W = Math.max(300, Math.min(1200, Math.round(width || 560)));   // drawn at the container's width, so text stays at its set size
    switch (s.visualizationType) {
      case "bar": case "grouped_bar": case "comparison": return vbars(s, W);
      case "hbar": return s.series[0].values.some(v => isNum(v) && v < 0) ? deltas(Object.assign({}, s, { deltas: s.series[0].values }), W) : hbars(s, W);
      case "line": case "projection": return lines(s, W);
      case "donut": return donut(s);
      case "delta": return deltas(s, W);
      case "kpi": return kpis(s);
      case "table": return table(s);
    }
    throw new Error("unknown type");
  }

  /* chart card: title, value-type badges, scenario / period labels, chart, table, notes, map link */
  function chartCard(spec, width) {
    const card = document.createElement("div");
    card.className = "aiviz-card";
    const chk = V.validateSpec(spec);
    if (!chk.ok) { card.innerHTML = `<p class="note">The chart could not be drawn (${esc(chk.errors[0])}). The answer above is unaffected.</p>`; return card; }
    let body;
    try { body = drawSpec(spec, width); }
    catch { card.innerHTML = `<p class="note">The chart could not be drawn. The answer above is unaffected.</p>`; return card; }
    const badges = spec.valueLabels.map(l => `<span class="aiviz-badge ${l.toLowerCase()}">${esc(l)}</span>`).join("");
    const meta = [];
    if (spec.scenarioName) meta.push(`<b>Scenario:</b> ${esc(spec.scenarioName)}`);
    if (spec.baselineName) meta.push(`<b>Baseline:</b> ${esc(spec.baselineName)}`);
    if (spec.projectionPeriod) meta.push(`<b>Projection period:</b> ${esc(spec.projectionPeriod)}`);
    if (spec.period) meta.push(`<b>Period:</b> ${esc(spec.period)}`);
    meta.push(`<b>Metric:</b> ${esc(spec.sourceMetric)}`);
    if (spec.filtersUsed && Object.keys(spec.filtersUsed).length)
      meta.push(`<b>Filters:</b> ${esc(Object.entries(spec.filtersUsed).map(([k, v]) => (k === "scope" ? v : `${k.replace(/_/g, " ")} = ${v}`)).join("; "))}`);
    const extra = [...(spec.fallbackNote ? [spec.fallbackNote] : []), ...spec.notes];
    card.innerHTML =
      `<div class="aiviz-head"><h3>${esc(spec.visualizationTitle)}</h3>${badges}</div>` +
      `<p class="aiviz-meta">${meta.join(" · ")}</p>` +
      `<div class="aiviz-chart">${body}</div>${["kpi", "table", "donut"].includes(spec.visualizationType) ? "" : legend(spec)}` +
      (spec.visualizationType !== "table" ? `<details><summary>Show data table</summary>${table(spec)}</details>` : "") +
      (spec.assumptions.length ? `<details><summary>Assumptions (${spec.assumptions.length})</summary><ul>${spec.assumptions.map(a => `<li>${esc(a)}</li>`).join("")}</ul></details>` : "") +
      (extra.length ? `<details><summary>Notes</summary><ul>${extra.map(a => `<li>${esc(a)}</li>`).join("")}</ul></details>` : "") +
      (spec.dataType === "projected" || spec.dataType === "scenario" ? `<p class="note" style="margin:4px 0 0">Model output from the dashboard's scenario engine: a planning comparison, not a forecast or a historical actual.</p>` : "") +
      (spec.mapLink && /^gis-map\/(#[\w=&%.+-]*)?$/.test(spec.mapLink) ? `<a class="aiviz-map" href="${esc(spec.mapLink)}">Open these filters on the GIS map</a>` : "");
    return card;
  }

  /* ---------- conversation with the Worker ---------- */
  let convo = [], busy = false;
  const msgs = $q("#aivMsgs");
  function addMsg(kind, text) {
    const d = document.createElement("div");
    d.className = "msg " + kind; if (text != null) d.textContent = text;
    msgs.append(d); msgs.scrollTop = msgs.scrollHeight; return d;
  }
  async function callWorker(messages) {
    let r;
    try { r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }) }); }
    catch { throw new Err("network"); }
    if (r.status === 429 || r.status === 503) throw new Err("busy");
    if (r.status === 413) throw new Err("tooLong");
    if (!r.ok) throw new Err("error");
    try { const j = await r.json(); if (j && j.type === "message" && Array.isArray(j.content)) return j; } catch {}
    throw new Err("error");
  }
  function toolResultBlock(id, out) {
    let content = JSON.stringify(out);
    if (content.length > CFG.maxToolResultChars) {
      const small = Object.assign({}, out, { result: out.result && out.result.rendered ? Object.assign({}, out.result, { data: "(omitted: too large; the chart shows it)" }) : null,
        error: out.result && out.result.rendered ? undefined : "The result is too large to return. Ask a narrower question (add a filter)." });
      content = JSON.stringify(small).slice(0, CFG.maxToolResultChars);
    }
    return Object.assign({ type: "tool_result", tool_use_id: id, content }, out.status === "error" ? { is_error: true } : {});
  }
  async function ask(q) {
    if (busy) return;
    addMsg("me", q);
    if (!URL_) { addMsg("bot", "The AI service is not connected."); return; }
    busy = true; setBusy(true);
    const wait = addMsg("bot wait", "Checking the data...");
    try {
      const tools = await getTools();
      let m = convo.concat([{ role: "user", content: q }]);
      if (convo.length && sizeOf({ messages: m }) > CFG.freshThreadBytes) m = [{ role: "user", content: q }];
      const used = new Set(), specs = []; let rounds = 0, res, lastData = null;
      for (;;) {
        res = await callWorker(m);
        m.push({ role: "assistant", content: res.content });            // exactly as received
        if (res.stop_reason !== "tool_use") break;
        if (rounds >= CFG.maxToolRounds) throw new Err("rounds");
        rounds++;
        const results = res.content.filter(b => b.type === "tool_use").map(b => {
          let out;
          try { out = V.runVizTool(tools, b.name, b.input); }
          catch { out = { result: null, error: "The tool failed.", sources: [], status: "error" }; }
          if (!out || typeof out !== "object") out = { result: null, error: "The tool failed.", sources: [], status: "error" };
          if (out.spec) { specs.push(out.spec); out = Object.assign({}, out); delete out.spec; }
          else if (V.DATA_TOOLS.includes(b.name) && out.status !== "error" && !(out.result && out.result.refusal)) lastData = { tool: b.name, tool_input: b.input || {} };
          (out.sources || []).forEach(id => used.add(id));
          return toolResultBlock(b.id, out);
        });
        m.push({ role: "user", content: results });
        if (sizeOf({ messages: m }) > CFG.maxBodyBytes) throw new Err("tooLong");
      }
      if (res.stop_reason === "refusal") { wait.className = "msg bot"; wait.textContent = FRIENDLY.refusal; return; }
      /* Auto-chart: the model used a data tool but did not ask for a chart (e.g. a Worker without the
         /viz route). Re-run that same tool and draw its default chart - the data the model just read. */
      if (!specs.length && lastData) {
        try { const o = tools.show_chart({ chart_type: "", title: "", tool: lastData.tool, tool_input: lastData.tool_input }); if (o.spec) specs.push(o.spec); } catch { /* answer still shown */ }
      }
      let text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      // Markdown tables do not render in the answer bubble; the chart card has its own data table.
      if (specs.length) text = text.split("\n").filter(l => !/^\s*\|.*\|\s*$/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (!text && !specs.length) throw new Err("error");
      convo = m;                                                       // session memory only
      wait.className = "msg bot aiviz-answer";
      wait.textContent = "";
      const ans = document.createElement("div");
      if (text) { if (typeof renderAnswer === "function") renderAnswer(ans, text, used); else ans.textContent = text; }
      wait.append(ans);
      if (res.stop_reason === "max_tokens") { const n = document.createElement("p"); n.className = "note"; n.style.margin = "4px 0 0"; n.textContent = "(The answer was cut short. Try a narrower question.)"; wait.append(n); }
      const width = wait.clientWidth - 22;
      specs.slice(-2).forEach(s => wait.append(chartCard(s, width)));
    } catch (e) {
      wait.className = "msg bot";
      wait.textContent = FRIENDLY[e instanceof Err ? e.kind : "error"] || FRIENDLY.error;
      if (e instanceof Err && e.kind === "tooLong") convo = [];
    } finally {
      busy = false; setBusy(false);
      msgs.scrollTop = msgs.scrollHeight;
    }
  }
  function setBusy(b) {
    root.querySelectorAll("#aivForm input,#aivForm button,#aivSuggest button").forEach(x => { x.disabled = b; });
    if (!b) $q("#aivIn").focus({ preventScroll: true });
  }

  /* ---------- wire up ---------- */
  $q("#aivForm").addEventListener("submit", e => {
    e.preventDefault();
    const q = $q("#aivIn").value.trim(); if (!q || busy) return;
    $q("#aivIn").value = ""; ask(q);
  });
  const sug = $q("#aivSuggest");
  Object.entries(CFG.suggestions).forEach(([group, qs]) => {
    const lab = document.createElement("span"); lab.className = "aiviz-group"; lab.textContent = group + ":"; sug.append(lab);
    qs.forEach(q => { const b = document.createElement("button"); b.type = "button"; b.textContent = q; b.addEventListener("click", () => ask(q)); sug.append(b); });
  });
  const tag = root.querySelector("header .tag");
  if (URL_) { root.classList.add("model"); tag.className = "tag model"; tag.textContent = "AI visual analysis (beta)"; }

  /* exposed for local tests only */
  window.CCFD1VizPanel = { drawSpec, chartCard, validateSpec: V.validateSpec };
})();
