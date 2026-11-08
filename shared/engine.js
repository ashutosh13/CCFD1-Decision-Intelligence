/* CCFD1 scenario engine - the single source of the scenario math.
   Used by index.html (both scenario panels) and by assistant/tools.js, so the
   dashboard and the assistant can never disagree.
   Aggregates only - no individual pay. Per-employee amounts are rounded to whole
   dollars, as in private/Scenario_Requirements_Workbook_v2.xlsx (Cost Engine tab).
   Loads as a plain <script> (sets window.CCFD1Engine) or with require() in Node. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CCFD1Engine = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- Scenario 3&4: staffing and compensation (team cost engine v2) ---------- */
  const ENG = {AVG_SALARY:56204, LINE_FF:12, POSTS_NOW:4, PAYROLL_TAX:0.0765, OT_COST_CAP:61569,
    BASE_GAP:635758, AV:307471175, CURRENT_RATE:0.2907, CEILING:0.40, HOUSEHOLD_AV:150000, FUND_BALANCE:1624691};

  /* i = {posts, perf (bool), perfRate (0.20-0.30), premium ($/yr), adj (0-0.10), otd (bool)} */
  function costEngine(i){
    const E=ENG, R=Math.round;
    const peoplePerPost=E.LINE_FF/E.POSTS_NOW;
    const hires=(i.posts-E.POSTS_NOW)*peoplePerPost;
    const adjSalary=R(E.AVG_SALARY*(1+i.adj));
    const perEmployee=adjSalary+(i.perf?R(adjSalary*i.perfRate):0)+R(adjSalary*E.PAYROLL_TAX)+i.premium;
    const layer1=E.LINE_FF*perEmployee-E.LINE_FF*(E.AVG_SALARY+R(E.AVG_SALARY*E.PAYROLL_TAX));
    const gross=hires*perEmployee;
    const layer2=gross-(i.otd?Math.min(E.OT_COST_CAP*(1+i.adj),gross):0);
    const total=layer1+layer2, gap=E.BASE_GAP+total;
    const addRate=gap/E.AV*100, totalRate=E.CURRENT_RATE+addRate;
    return {hires,perEmployee,layer1,layer2,total,gap,addRate,totalRate,
      household:E.HOUSEHOLD_AV/100*addRate, householdPct:addRate/E.CURRENT_RATE*100, years:gap>0?E.FUND_BALANCE/gap:Infinity};
  }

  /* ---------- Scenario 1: funding change ----------
     Same basis as the staffing engine. Revenue-source amounts are 2024 AFR figures.
     Never adds staffing costs itself; it can only start from a staffing-scenario gap. */
  const S1 = {BUDGET_2027:1795950, RECURRING_REVENUE:1160192, BASE_GAP:ENG.BASE_GAP, FUND_BALANCE:ENG.FUND_BALANCE,
    START_YEAR:2025, YEARS:[2026,2027,2028,2029,2030],
    SOURCES:{propertyTax:["Property tax",882965], incomeTax:["Local income tax",212041],
             excise:["Vehicle excise tax",64785], contracts:["Fire protection contracts",21042]}};

  /* i = {funding ($), oneTime (bool), source (key of S1.SOURCES or ""), pct (-0.5-0.5),
          useStaffing (bool), staffingGap ($, used only when useStaffing)} */
  function fundingEngine(i){
    const src=S1.SOURCES[i.source];
    const sourceEffect=src?Math.round(src[1]*i.pct):0;                 // recurring
    const recurring=(i.oneTime?0:i.funding)+sourceEffect;
    const oneTime=i.oneTime?i.funding:0;                                // year 1 only
    const revenueChange=recurring+oneTime;
    const startGap=i.useStaffing?i.staffingGap:S1.BASE_GAP;
    const year1Gap=startGap-revenueChange, laterGap=startGap-recurring;
    let bal=S1.FUND_BALANCE; const balances=[];
    S1.YEARS.forEach((y,k)=>{bal-=(k===0?year1Gap:laterGap); balances.push(bal);});
    const firstNegative=S1.YEARS.find((y,k)=>balances[k]<0)||null;
    return {sourceEffect,recurring,oneTime,revenueChange,adjustedRevenue:S1.RECURRING_REVENUE+recurring,
      startGap,year1Gap,laterGap,balances,firstNegative,years:laterGap>0?S1.FUND_BALANCE/laterGap:Infinity};
  }

  /* Years of fund balance, shared by both scenario panels and the assistant */
  function yearsLabel(y){ return !isFinite(y)?"No drawdown":(y>10?"10+ years":y.toFixed(1)); }

  /* Default inputs, matching the dashboard controls' starting positions */
  const DEFAULTS = {
    staffing: {posts:5, perf:true, perfRate:0.265, premium:0, adj:0, otd:true},
    funding:  {funding:0, oneTime:false, source:"", pct:0, useStaffing:false, staffingGap:ENG.BASE_GAP}
  };

  return Object.freeze({ENG, S1, DEFAULTS, costEngine, fundingEngine, yearsLabel});
});
