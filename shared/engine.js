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

  /* ---------- Scenario 3&4: staffing and compensation (Scenario Build Specification v3, adapted) ----------
     Baseline personnel cost is the loaded 12 x $60,503 = $726,036 (salary + 7.65% payroll tax), which is
     the source of truth for what the 2026/2027 appropriation already carries. Items no scenario touches
     are held at 2026 levels for 2027. OT_COST_CAP is the overtime recorded in the 2026 timesheet; it is
     kept as a reference and no longer enters the math. */
  const ENG = {AVG_SALARY:56204, LINE_FF:12, POSTS_NOW:4, PAYROLL_TAX:0.0765, OT_COST_CAP:61569,
    POST_HOURS:8760, FLSA_DIVISOR:2756, OT_MULT:1.5,
    BASE_GAP:635758, AV:307471175, CURRENT_RATE:0.2907, CEILING:0.40, HOUSEHOLD_AV:150000, FUND_BALANCE:1624691};
  ENG.FTE_PER_POST = ENG.POST_HOURS/ENG.FLSA_DIVISOR;                    // 3.179 - derived, never hard-coded as 3
  ENG.BASE_LOADED = ENG.AVG_SALARY+Math.floor(ENG.AVG_SALARY*ENG.PAYROLL_TAX);   // 60,503 (tax truncated to whole dollars)
  ENG.BASE_PERSONNEL = ENG.LINE_FF*ENG.BASE_LOADED;                       // 726,036
/* Overtime hours implied by the recorded overtime cost: $61,569 at 1.5x the average hourly rate (about 2,013). Derived, not a timesheet hours total. */
ENG.OT_HOURS_LAST = Math.round(ENG.OT_COST_CAP/(ENG.OT_MULT*ENG.AVG_SALARY/ENG.FLSA_DIVISOR));

/* Partner statement: overtime is never zero, and each person is expected to work about as much as in the prior year. Prior-year
   baseline overtime per line firefighter (1,968 structural hours / 12 = 164). Used by Scenario 4 via costEngine's otPerPerson option. */
ENG.OT_HOURS_PER_FF = (ENG.POSTS_NOW*ENG.FTE_PER_POST-ENG.LINE_FF)*ENG.FLSA_DIVISOR/ENG.LINE_FF;

  /* PERF 77 reference figures (INPRS, per the pension synopsis). Context for Scenario 4's figures only; the engine
     math still uses the rate the user picks. Pensionable pay is the certified first-class salary: overtime,
     allowances, incentive and holiday pay, insurance and other premiums are excluded, so they carry no PERF cost.
     INPRS's page is inconsistent about 2026 (an older table lists 20.30%), so SCHEDULE_UNCONFIRMED marks it.
     The rate rises every year; DEFAULT_YEAR is the year the dashboard uses until told otherwise (2026). */
  const PERF = {EMPLOYER_RATES:[[2024,19.10],[2025,20.30],[2026,23.30],[2027,26.50]], SCHEDULE_UNCONFIRMED:2026, DEFAULT_YEAR:2026,
    MEMBER_RATE:6, MEMBER_PICKUP_NOTE:"The employer may pick up all or part of the 6% member contribution."};

  /* Firefighters needed to cover `posts` with no overtime; today's 12 when nothing changes */
  function defaultFirefighters(posts){
    return posts<=ENG.POSTS_NOW?ENG.LINE_FF:Math.ceil(posts*ENG.FTE_PER_POST-1e-9);
  }

  /* Structural overtime for a state: hours not covered by employed staff, at the FLSA 1.5x rate.
     Computed independently for the baseline and the scenario, then differenced. */
  function overtime(posts,firefighters,salary){
    const E=ENG, hours=Math.max(0,posts*E.FTE_PER_POST-firefighters)*E.FLSA_DIVISOR;
    return {hours, cost:hours*E.OT_MULT*(salary/E.FLSA_DIVISOR)};
  }

  /* Partner-stated: overtime is never zero; expect the prior year's overtime per person at every roster size. */
  function overtimePerPerson(firefighters,salary){
    const E=ENG, hours=firefighters*E.OT_HOURS_PER_FF;
    return {hours, cost:hours*E.OT_MULT*(salary/E.FLSA_DIVISOR)};
  }

  /* i = {posts, firefighters (optional, line firefighters employed), perf (bool), perfRate (0.20-0.30),
          premium ($/yr per employee), adj (-0.10 to 0.10),
          otPerPerson (bool, optional: overtime = employed firefighters x prior-year hours per person, never zero; Scenario 4)} */
  function costEngine(i){
    const E=ENG, R=Math.round;
    const firefighters=i.firefighters==null?defaultFirefighters(i.posts):i.firefighters;
    const hires=firefighters-E.LINE_FF;
    const salary=R(E.AVG_SALARY*(1+i.adj));
    const perfCost=i.perf?R(salary*i.perfRate):0, taxCost=Math.floor(salary*E.PAYROLL_TAX);
    const perEmployee=salary+perfCost+taxCost+i.premium;                   // loaded cost, computed once
    const layer1=E.LINE_FF*perEmployee-E.BASE_PERSONNEL;                   // existing staff only
    const layer2=hires*perEmployee;                                        // new hires only
    const otBase=overtime(E.POSTS_NOW,E.LINE_FF,E.AVG_SALARY);
    const otScen=i.otPerPerson?overtimePerPerson(firefighters,salary):overtime(i.posts,firefighters,salary);
    const otChange=otScen.cost-otBase.cost;
    const total=layer1+layer2+otChange, gap=E.BASE_GAP+total;
    const addRate=gap/E.AV*100, totalRate=E.CURRENT_RATE+addRate;
    const personnelTotal=firefighters*perEmployee+otScen.cost, healthTotal=firefighters*i.premium;
    return {firefighters,hires,perEmployee,perPerson:{salary,perf:perfCost,tax:taxCost,health:i.premium},
      ftePerPost:E.FTE_PER_POST,fteRequired:i.posts*E.FTE_PER_POST,
      layer1,layer2,otBase,otScen,otChange,total,gap,addRate,totalRate,
      personnelTotal,healthTotal,healthShare:personnelTotal>0?healthTotal/personnelTotal*100:0,
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
    staffing: {posts:5, firefighters:null, perf:true, perfRate:0.233, premium:10000, adj:0},
    funding:  {funding:0, oneTime:false, source:"", pct:0, useStaffing:false, staffingGap:ENG.BASE_GAP}
  };

  return Object.freeze({ENG, S1, PERF, DEFAULTS, defaultFirefighters, overtime, overtimePerPerson, costEngine, fundingEngine, yearsLabel});
});
