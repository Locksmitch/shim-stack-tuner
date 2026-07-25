
/* =========================================================
   UNITS — length fields are PER-FIELD; force/velocity/modulus use one "result unit"
   ========================================================= */
const FACT_LEN = { mm: 1, in: 25.4 };
const FACT_FORCE = { mm: 1, in: 4.4482216153 };   // result-unit key 'mm' means metric(N), 'in' means imperial(lbf)
const FACT_VEL = { mm: 1, in: 25.4 };
const FACT_MOD = { MPa: 1, psi: 0.00689476 };
const DEC_LEN = { mm: 3, in: 4 };
const DEC_FORCE = { mm: 1, in: 2 };
const DEC_VEL = { mm: 1, in: 3 };

function convLen(v, fromU, toU){ if(isNaN(v)||fromU===toU) return v; return v*FACT_LEN[fromU]/FACT_LEN[toU]; }
function convForce(v, fromU, toU){ if(isNaN(v)||fromU===toU) return v; return v*FACT_FORCE[fromU]/FACT_FORCE[toU]; }
function convVel(v, fromU, toU){ if(isNaN(v)||fromU===toU) return v; return v*FACT_VEL[fromU]/FACT_VEL[toU]; }
function convMod(v, fromU, toU){ if(isNaN(v)||fromU===toU) return v; return v*FACT_MOD[fromU]/FACT_MOD[toU]; }
function fmtLen(v,u){ return v.toFixed(DEC_LEN[u]); }
function fmtForce(v,u){ return v.toFixed(DEC_FORCE[u]); }
function fmtVel(v,u){ return v.toFixed(DEC_VEL[u]); }

let resultUnit = 'mm'; // display unit for force/velocity/outputs

// ---- per-field length unit handling ----
function onFieldUnitChange(sel){
  const id = sel.dataset.for;
  const input = document.getElementById(id);
  const oldU = sel.dataset.unit, newU = sel.value;
  const v = parseFloat(input.value);
  if(!isNaN(v)) input.value = fmtLen(convLen(v, oldU, newU), newU);
  sel.dataset.unit = newU;
  input.step = newU==='mm' ? '0.1' : '0.005';
  if(id==='stackID' || id==='clampDia') drawShimRefDiagram();
  if(['rPort','dPort','wPort','dValve','dRod'].includes(id)) drawPortFaceDiagram();
}
function getFieldMM(id){
  const input = document.getElementById(id);
  const sel = document.querySelector(`.fieldUnit[data-for="${id}"]`);
  const unit = sel ? sel.dataset.unit : 'mm';
  return convLen(parseFloat(input.value)||0, unit, 'mm');
}
function onRowUnitChange(sel){
  const tr = sel.closest('tr');
  const dEl = tr.querySelector('.cDiam'), tEl = tr.querySelector('.cThick'), fEl = tr.querySelector('.cFloat');
  const oldU = sel.dataset.unit, newU = sel.value;
  const dv = parseFloat(dEl.value), tv = parseFloat(tEl.value), fv = parseFloat(fEl.value);
  if(!isNaN(dv)) dEl.value = fmtLen(convLen(dv, oldU, newU), newU);
  if(!isNaN(tv)) tEl.value = fmtLen(convLen(tv, oldU, newU), newU);
  if(!isNaN(fv)) fEl.value = fmtLen(convLen(fv, oldU, newU), newU);
  sel.dataset.unit = newU;
  // Steps follow real shim catalogs: metric 1mm OD / 0.05mm thickness increments
  // (RockShox tune shims: ODs 10,11,13,16–20,24mm; thicknesses 0.10/0.15/0.20/0.25/0.30),
  // imperial 0.025in OD / 0.0005in thickness increments (FOX-style).
  dEl.step = newU==='mm' ? '1' : '0.025';
  tEl.step = newU==='mm' ? '0.05' : '0.0005';
  fEl.step = newU==='mm' ? '0.05' : '0.0005';
  drawShimRefDiagram();
}
function setAllFieldUnits(newU){
  if(!newU) return;
  document.querySelectorAll('.fieldUnit').forEach(sel=>{ sel.value = newU; onFieldUnitChange(sel); });
  document.querySelectorAll('.rowUnit').forEach(sel=>{ sel.value = newU; onRowUnitChange(sel); });
}
function onModUnitChange(sel){
  const input = document.getElementById('eMod');
  const oldU = sel.dataset.unit, newU = sel.value;
  const v = parseFloat(input.value);
  if(!isNaN(v)) input.value = Math.round(convMod(v, oldU, newU));
  sel.dataset.unit = newU;
}
function getModMPa(){
  const sel = document.querySelector('.modUnit[data-for="eMod"]');
  const unit = sel ? sel.dataset.unit : 'MPa';
  return convMod(parseFloat(document.getElementById('eMod').value)||0, unit, 'MPa');
}

// ---- result unit (force/velocity/outputs) ----
function switchResultUnit(newU){
  const oldU = resultUnit;
  if(newU===oldU) return;
  const fEl = document.getElementById('fMax'); fEl.value = fmtForce(convForce(parseFloat(fEl.value),oldU,newU), newU);
  const uEl = document.getElementById('uMax'); uEl.value = fmtVel(convVel(parseFloat(uEl.value),oldU,newU), newU);
  const axEl = document.getElementById('axisMaxF');
  if(axEl && axEl.value) axEl.value = fmtForce(convForce(parseFloat(axEl.value),oldU,newU), newU);
  const axMinEl = document.getElementById('axisMinF');
  if(axMinEl && axMinEl.value) axMinEl.value = fmtForce(convForce(parseFloat(axMinEl.value),oldU,newU), newU);
  const axUEl = document.getElementById('axisMaxU');
  if(axUEl && axUEl.value) axUEl.value = fmtVel(convVel(parseFloat(axUEl.value),oldU,newU), newU);
  const slider = document.getElementById('forceSlider');
  slider.max = convForce(parseFloat(slider.max),oldU,newU);
  slider.value = convForce(parseFloat(slider.value),oldU,newU);
  resultUnit = newU;
  document.querySelectorAll('.uforce').forEach(el=> el.textContent = newU==='mm'?'N':'lbf');
  document.querySelectorAll('.uvel').forEach(el=> el.textContent = newU==='mm'?'mm/s':'in/s');
  document.querySelectorAll('.ulen').forEach(el=> el.textContent = newU==='mm'?'mm':'in');
  const altU = newU==='mm'?'in':'mm';
  document.getElementById('altVelHeader').textContent = `Shaft velocity (${altU==='mm'?'mm/s':'in/s'})`;
  document.getElementById('sliderVal').textContent = fmtForce(parseFloat(slider.value), newU);
  if(currentStack){ drawStackAtSlider(); }
  if(currentResults.length){ drawForceCurve(); fillTable(); }
  drawShimRefDiagram();
}

/* =========================================================
   VISCOSITY: ISO VG / SAE approx / Walther temperature correction
   ========================================================= */
const ISO_VG_TABLE = [
  [2,1.3],[3,1.6],[5,2.0],[7,2.4],[10,2.9],[15,3.6],[22,4.4],[32,5.4],
  [46,6.8],[68,8.7],[100,11.4],[150,14.8],[220,19.4],[320,24.7],[460,31.4],[680,41.0],[1000,52.0]
];
function isoVGtoCst100(vg){
  const xs = ISO_VG_TABLE.map(p=>Math.log(p[0])), ys = ISO_VG_TABLE.map(p=>Math.log(p[1]));
  const lx = Math.log(vg);
  if(lx<=xs[0]) return Math.exp(ys[0]);
  if(lx>=xs[xs.length-1]) return Math.exp(ys[ys.length-1]);
  for(let i=0;i<xs.length-1;i++){
    if(lx>=xs[i] && lx<=xs[i+1]){ const f=(lx-xs[i])/(xs[i+1]-xs[i]); return Math.exp(ys[i]+f*(ys[i+1]-ys[i])); }
  }
}
function saeToCst(sae){
  return { cSt40: Math.max(15 + 3.14*(sae-2.5), 1), cSt100: Math.max(3 + 0.629*(sae-2.5), 1) };
}
function onViscModeChange(){
  const mode = document.getElementById('viscMode').value;
  document.getElementById('viscDirectFields').style.display = mode==='direct' ? '' : 'none';
  document.getElementById('viscIsoFields').style.display = mode==='iso' ? '' : 'none';
  document.getElementById('viscSaeFields').style.display = mode==='sae' ? '' : 'none';
  let hint = '';
  if(mode==='iso'){
    const vg = parseFloat(document.getElementById('isoVG').value)||32;
    const c100 = isoVGtoCst100(vg);
    document.getElementById('cst40').value = vg.toFixed(1);
    document.getElementById('cst100').value = c100.toFixed(2);
    hint = `≈ ${vg.toFixed(1)} cSt @40°C / ${c100.toFixed(2)} cSt @100°C (typical VI≈100 mineral oil)`;
  } else if(mode==='sae'){
    const sae = parseFloat(document.getElementById('saeWt').value)||5;
    const r = saeToCst(sae);
    document.getElementById('cst40').value = r.cSt40.toFixed(1);
    document.getElementById('cst100').value = r.cSt100.toFixed(2);
    hint = `≈ ${r.cSt40.toFixed(1)} cSt @40°C / ${r.cSt100.toFixed(2)} cSt @100°C (rough average — real oils vary a lot at a given "weight")`;
  }
  document.getElementById('viscResultHint').textContent = hint;
}
function onDirectCstChange(){ document.getElementById('viscResultHint').textContent = ''; }

function waltherViscosityAt(cSt40, cSt100, tempC){
  cSt40 = Math.max(cSt40, 1.01); cSt100 = Math.max(cSt100, 1.01);
  const T1=313.15, T2=373.15, Tq=tempC+273.15;
  const y1=Math.log10(Math.log10(cSt40+0.7)), y2=Math.log10(Math.log10(cSt100+0.7));
  const x1=Math.log10(T1), x2=Math.log10(T2);
  const B=(y1-y2)/(x2-x1); const A=y1+B*x1;
  const yq=A-B*Math.log10(Tq);
  return Math.max(0.5, Math.pow(10, Math.pow(10,yq)) - 0.7);
}

/* =========================================================
   PHYSICS ENGINE (always works in base mm / N / MPa / mm-s)
   ========================================================= */
function interpArr(xs, ys, x){
  if(x<=xs[0]) return ys[0];
  if(x>=xs[xs.length-1]) return ys[ys.length-1];
  for(let i=0;i<xs.length-1;i++){
    if(x>=xs[i] && x<=xs[i+1]){ const f=(x-xs[i])/(xs[i+1]-xs[i]); return ys[i]+f*(ys[i+1]-ys[i]); }
  }
  return ys[ys.length-1];
}

// Gap beneath row i at radius r, in table-stacking order: the row's own explicit Float,
// plus the thickness of every row BELOW it that doesn't physically reach out to radius r
// (a narrower shim below leaves an air cavity of its own thickness under this row's
// overhang — the "structural crossover" a wide clamp plate over a small pivot shim makes).
function stackGapAt(rows, i, r){
  let g = rows[i].float>0 ? rows[i].float : 0;
  for(let j=0;j<i;j++){ if(rows[j].diam/2 < r-1e-9) g += rows[j].count*rows[j].thickness; }
  return g;
}
// Is there anything below row i present at radius r to push on it? Row 0 sits on the
// valve face itself and is loaded directly by fluid pressure, so it always counts.
function stackSupportedAt(rows, i, r){
  if(i===0) return true;
  for(let j=0;j<i;j++){ if(rows[j].diam/2 >= r-1e-9) return true; }
  return false;
}

// Incremental (tangent-stiffness) nonlinear stack solver.
// Each step: compute the UNIT-load deflection shape for the CURRENT engagement state,
// scale by dF and ADD to the running accumulated deflection (never recomputed from scratch),
// then check whether any not-yet-engaged row has closed the gap beneath it and lock it in.
// A row starts disengaged if there is ANY radius within its own reach where a positive
// gap (explicit Float and/or structural cavity from a narrower shim below) separates it
// from the supported stack — so crossover clamps are detected automatically, without the
// user having to enter a Float.
function buildStack(rows, geom, mech, opts){
  const nSeg = (opts&&opts.nSeg)||350;
  const nSteps = (opts&&opts.nSteps)||150;
  const Fmax = (opts&&opts.Fmax)||400;

  // The stack bends off the CLAMP diameter (the clamp washer / piston land that pins it
  // rigid), NOT the shim's center hole. Only material outside the clamp radius flexes.
  const a = ((geom.clampDia && geom.clampDia>0) ? geom.clampDia : geom.stackID)/2;
  const bMax = Math.max(...rows.map(r=>r.diam/2));
  const rLoad = Math.min(geom.rPort+geom.dPort, bMax);
  const rMax = Math.max(bMax, rLoad);
  const dr = (rMax-a)/nSeg;
  if(dr<=0) throw new Error("Clamp diameter must be smaller than the largest shim OD.");
  const Eprime = mech.E/(1-mech.nu*mech.nu);

  // Shims in a real stack are NOT bonded to each other — they slide freely, so each shim
  // bends about its own neutral axis and the stack's bending stiffness at a radius is the
  // SUM OF CUBES of the individual engaged thicknesses, Σ(count·t³) — not the cube of the
  // summed thickness (Σt)³ a welded laminate would give. The difference is huge (factor
  // N² for N identical shims) and it's what makes a few thick shims stiffer than many
  // thin ones of equal total height — e.g. FOX's Rebound MED+ (6× .0045in) is correctly
  // firmer than Rebound LIGHT (9× .0032in), which a bonded model gets backwards.
  // Inter-shim friction would add some stiffness on top of this free-sliding lower bound.
  function cubeSumAt(r, engagedState){
    let s=0;
    for(let i=0;i<rows.length;i++){
      const row = rows[i];
      if(row.diam/2 >= r-1e-9 && engagedState[i]) s += row.count*Math.pow(row.thickness,3);
    }
    return s;
  }
  function unitProfile(engagedState){
    const rs=[], cUnit=[];
    let theta=0, y=0;
    for(let i=0;i<=nSeg;i++){
      const r=a+i*dr;
      rs.push(r); cUnit.push(y);
      const t3 = cubeSumAt(r, engagedState);
      if(t3<=0) throw new Error(`No always-engaged shim spans radius ${r.toFixed(2)} mm. The widest shim must be a normal bonded one (no Float, and not sitting above narrower shims that make it a floating crossover) so material bridges from the clamp out to the load. If you added a wide shim at the clamp end of the list, move it up toward the valve face (↑) or reduce its OD.`);
      const I=2*Math.PI*r*t3/12;
      const M = r<=rLoad ? (rLoad-r) : 0;
      const kappa = M/(Eprime*I);
      theta += kappa*dr; y += theta*dr;
    }
    return {rs, cUnit};
  }

  // radial grid (independent of engagement state)
  const rsRef = [];
  for(let i=0;i<=nSeg;i++) rsRef.push(a+i*dr);

  // per-row gap/support tables on the grid, and initial engagement
  const gapGrid = rows.map((row,i)=> rsRef.map(r=> stackGapAt(rows,i,r)));
  const suppGrid = rows.map((row,i)=> rsRef.map(r=> stackSupportedAt(rows,i,r)));
  const hasGap = rows.map((row,i)=>{
    const reachI = row.diam/2;
    return rsRef.some((r,k)=> r<=reachI+1e-9 && suppGrid[i][k] && gapGrid[i][k]>0);
  });
  let engagedState = rows.map((row,i)=> !hasGap[i]);

  const dF = Fmax/nSteps;
  let yAccum = rsRef.map(()=>0);
  const Ftab=[0], YtabAtLoad=[0];
  const engageLog=[];
  const snapshots=[{F:0, y:yAccum.slice()}];

  for(let s=1;s<=nSteps;s++){
    const {cUnit} = unitProfile(engagedState);
    for(let i=0;i<yAccum.length;i++) yAccum[i] += cUnit[i]*dF;
    const F = s*dF;
    for(let i=0;i<rows.length;i++){
      if(engagedState[i]) continue;
      const reachI = rows[i].diam/2;
      for(let k=0;k<rsRef.length;k++){
        if(rsRef[k] > reachI+1e-9) break;
        if(suppGrid[i][k] && gapGrid[i][k]>0 && yAccum[k] >= gapGrid[i][k]){
          engagedState[i]=true; engageLog.push({rowIndex:i, F});
          break;
        }
      }
    }
    Ftab.push(F);
    YtabAtLoad.push(interpArr(rsRef, yAccum, rLoad));
    snapshots.push({F, y:yAccum.slice()});
  }

  function yAtLoad(F){
    if(F<=0) return 0;
    const Fend = Ftab[Ftab.length-1];
    if(F<=Fend) return interpArr(Ftab, YtabAtLoad, F);
    // Beyond the built range: extrapolate with the tangent stiffness at the end of the
    // table (all engagements that will happen within the modeled range have already
    // happened) rather than clamping flat — keeps the force solver's bisection well-behaved
    // if a high shaft velocity needs more force than the "Max stack force" setting.
    const n = Ftab.length;
    const F1=Ftab[n-2], F2=Ftab[n-1], Y1=YtabAtLoad[n-2], Y2=YtabAtLoad[n-1];
    const slope = (Y2-Y1)/((F2-F1)||1);
    return Y2 + slope*(F-F2);
  }
  function profileAt(F){
    F = Math.max(0, Math.min(F, Ftab[Ftab.length-1]));
    let lo=0;
    for(let i=0;i<snapshots.length;i++){ if(snapshots[i].F<=F) lo=i; else break; }
    const hi = Math.min(lo+1, snapshots.length-1);
    if(hi===lo) return {rs:rsRef, ys:snapshots[lo].y};
    const f = (F-snapshots[lo].F)/(snapshots[hi].F-snapshots[lo].F || 1);
    const y = snapshots[lo].y.map((v,i)=> v + f*(snapshots[hi].y[i]-v));
    return {rs:rsRef, ys:y};
  }

  const engageF = rows.map((r,i) => hasGap[i] ? Infinity : -Infinity);
  engageLog.forEach(e=> engageF[e.rowIndex]=e.F);

  return { a, bMax, rLoad, rMax, rs:rsRef, Ftab, YtabAtLoad, yAtLoad, profileAt, engageLog, engageF };
}

function flowArea(yLift, geom){
  let A = geom.nPort*(geom.wPort+geom.dPort)*Math.max(yLift,0);
  if(geom.dThrt>0 && geom.nThrt>0){
    const Athrt = geom.nThrt*Math.PI/4*geom.dThrt*geom.dThrt;
    A = Math.min(A, Athrt);
  }
  return A;
}
function valveArea(geom, valveType){
  const Ar = Math.PI/4*geom.dRod*geom.dRod;
  const Av = Math.PI/4*geom.dValve*geom.dValve;
  if(valveType==='base') return Ar;
  if(valveType==='mainRebound') return Av-Ar;
  return Av;
}
function pressurizedArea(geom){ return geom.nPort*geom.wPort*geom.dPort; }

function solveForceAtVelocity(u, stack, geom, fluid, valveType, Fmax){
  if(u<=0) return {F:0, Re:0};
  const Avalve = valveArea(geom, valveType);
  const Apress = pressurizedArea(geom);
  const Q = (u*1e-3)*(Avalve*1e-6);
  const cStAtTemp = waltherViscosityAt(fluid.cSt40, fluid.cSt100, fluid.tempC);
  const mu = cStAtTemp*1e-6*fluid.rho; // Pa*s

  let lastRe = 0;
  function Fcomputed(F){
    const y = stack.yAtLoad(F);
    const Aflow = flowArea(y, geom);
    if(Aflow<=1e-9) return 1e12;
    const Aflow_m2 = Aflow*1e-6;
    const vGuess = Q/(fluid.Cd*Aflow_m2);
    const Dh = 2*(y*1e-3);
    const Re = Dh>1e-9 ? fluid.rho*Math.abs(vGuess)*Dh/mu : 0;
    const CdUse = Math.max(fluid.Cd*Re/(Re+fluid.Re0), 0.05*fluid.Cd);
    lastRe = Re;
    const vActual = Q/(CdUse*Aflow_m2);
    const dP_Pa = 0.5*fluid.rho*vActual*vActual;
    return (dP_Pa/1e6)*Apress;
  }
  let lo=0, hi=Fmax, guard=0;
  while(Fcomputed(hi)>hi && guard<40){ hi*=1.5; guard++; }
  for(let i=0;i<80;i++){
    const mid=0.5*(lo+hi);
    const resid=Fcomputed(mid)-mid;
    if(Math.abs(resid) < 1e-6*Math.max(1,mid)){ lo=hi=mid; break; }
    if(resid>0) lo=mid; else hi=mid;
  }
  const F = 0.5*(lo+hi);
  Fcomputed(F);
  return {F, Re:lastRe};
}

/* =========================================================
   UI STATE + TABLE HANDLING
   ========================================================= */
let currentStack = null;
let currentGeom = null;
let currentRows = null;
let currentResults = []; // {u, F, Re} always stored in BASE units (mm/s, N)
const SHIM_PALETTE = [
  {fill:'#c7d6fb', stroke:'#2f6fed'}, {fill:'#c8ecd9', stroke:'#0f9d58'},
  {fill:'#e6d3f5', stroke:'#8e44ad'}, {fill:'#ffe3b3', stroke:'#e08e0b'},
  {fill:'#bdeef0', stroke:'#16a3b0'}, {fill:'#f6c9d0', stroke:'#d1495b'},
  {fill:'#dbe6ff', stroke:'#8fa8e0'},
];
const CLAMP_COLOR = {fill:'#f4d9a0', stroke:'#b8860b'};

function addShimRow(count, diam, thickness, unit, isSpecial, float){
  const tbody = document.getElementById('shimBody');
  // Called with no arguments (the "+ Add shim row" button): clone the LAST row's unit
  // and dimensions so the new shim fits the stack being edited — an inch preset gets a
  // matching inch row, not a 30mm metric default that would dwarf the stack and (being
  // appended at the clamp end, wider than everything) leave the solver with no bonded
  // shim spanning the outer radii.
  if(count===undefined){
    const last = tbody.lastElementChild;
    if(last){
      unit = last.querySelector('.rowUnit').dataset.unit;
      diam = last.querySelector('.cDiam').value;
      thickness = last.querySelector('.cThick').value;
      count = 1; float = 0; isSpecial = null;
    }
  }
  const tr = document.createElement('tr');
  if(isSpecial) tr.className = isSpecial;
  const u = unit || 'mm';
  const lenStep = u==='mm' ? '1' : '0.025';
  const thickStep = u==='mm' ? '0.05' : '0.0005';
  tr.innerHTML = `
    <td><input type="number" value="${count??1}" step="1" class="cCount"></td>
    <td><input type="number" value="${diam??30}" step="${lenStep}" class="cDiam"></td>
    <td><input type="number" value="${thickness??0.25}" step="${thickStep}" class="cThick"></td>
    <td><input type="number" value="${float??0}" step="${thickStep}" class="cFloat" title="0 = always engaged. Positive = gap that must close before this shim contributes."></td>
    <td class="col-unit"><select class="rowUnit" data-unit="${u}" onchange="onRowUnitChange(this)"><option value="mm"${u==='mm'?' selected':''}>mm</option><option value="in"${u==='in'?' selected':''}>in</option></select></td>
    <td class="col-remove">
      <button class="small rowbtn" title="Move up (toward valve face)" onclick="moveShimRow(this,-1)">↑</button><button class="small rowbtn" title="Move down (toward clamp)" onclick="moveShimRow(this,1)">↓</button><button class="small rowbtn" title="Duplicate this row below" onclick="duplicateShimRow(this)">⧉</button><button class="small danger rowbtn" title="Remove row" onclick="removeShimRow(this)">✕</button>
    </td>`;
  tbody.appendChild(tr);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}

function removeShimRow(btn){
  btn.closest('tr').remove();
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}
function moveShimRow(btn, dir){
  const tr = btn.closest('tr');
  if(dir<0 && tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling);
  else if(dir>0 && tr.nextElementSibling) tr.parentNode.insertBefore(tr.nextElementSibling, tr);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}
function duplicateShimRow(btn){
  const tr = btn.closest('tr');
  addShimRow(
    tr.querySelector('.cCount').value,
    tr.querySelector('.cDiam').value,
    tr.querySelector('.cThick').value,
    tr.querySelector('.rowUnit').dataset.unit,
    tr.className || null,
    tr.querySelector('.cFloat').value
  );
  const newTr = tr.parentNode.lastElementChild;
  tr.parentNode.insertBefore(newTr, tr.nextSibling);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}

// The stack preview and the deflection animation are one canvas now (stackCanvas, in the
// Shim stack configuration tile). This delegate keeps all the existing "something about
// the table changed, refresh the preview" call sites working: it redraws the animation
// from the last successful solve; the debounced live recalculation that follows the same
// edit then brings it fully up to date.
function drawShimRefDiagram(){
  try{ if(currentStack && currentRows) drawStackAtSlider(); }
  catch(e){ console.error('Stack preview draw failed (non-fatal):', e); }
}
/* ---- Live valve port face diagram (drawn to scale from the geometry inputs) ---- */
function drawPortFaceDiagram(){
  try{ drawPortFaceDiagramInner(); }
  catch(e){ console.error('Port face draw failed (non-fatal):', e); }
}
function drawPortFaceDiagramInner(){
  const cv = document.getElementById('portFaceCanvas');
  if(!cv) return;
  const {ctx,w,h} = setupCanvas(cv);
  ctx.clearRect(0,0,w,h);
  const rPort = getFieldMM('rPort'), dPort = getFieldMM('dPort'), wPort = getFieldMM('wPort');
  const nPort = Math.max(0, Math.round(parseFloat(document.getElementById('nPort').value)||0));
  const dValve = getFieldMM('dValve'), dRod = getFieldMM('dRod');
  if(rPort<=0 || dPort<=0 || wPort<=0 || nPort<1 || dValve<=0){
    ctx.fillStyle='#9aa3b0'; ctx.font='12px sans-serif';
    ctx.fillText('Enter r.port, d.port, w.port, N.port and D.valve to draw the port face.', 14, h/2);
    return;
  }
  const rOut = rPort + dPort;
  const rBody = Math.max(dValve/2, rOut*1.06);
  const cx = w/2, cy = h/2;
  const k = (Math.min(w,h)/2 - 14) / rBody;   // mm -> px

  // body + shaft
  ctx.beginPath(); ctx.arc(cx,cy,rBody*k,0,2*Math.PI);
  ctx.fillStyle='#fbfcfe'; ctx.fill(); ctx.strokeStyle='#1c2430'; ctx.lineWidth=1.5; ctx.stroke();
  if(dRod>0 && dRod/2 < rBody){
    ctx.beginPath(); ctx.arc(cx,cy,(dRod/2)*k,0,2*Math.PI);
    ctx.fillStyle='#fff'; ctx.fill(); ctx.strokeStyle='#5b6472'; ctx.lineWidth=1.1; ctx.stroke();
    ctx.fillStyle='#5b6472'; ctx.font='10px sans-serif'; ctx.textAlign='center';
    ctx.fillText('shaft', cx, cy+3); ctx.textAlign='left';
  }

  // ports: angular width taken at the OUTER edge (w.port is the width there)
  const halfAng = Math.min((wPort/2)/rOut, Math.PI/nPort*0.98);
  const overlap = (wPort/rOut)*nPort > 2*Math.PI*0.98;
  for(let i=0;i<nPort;i++){
    const aC = i*2*Math.PI/nPort - Math.PI/2 + (nPort===1?Math.PI/2:0);
    ctx.beginPath();
    ctx.arc(cx,cy,rOut*k, aC-halfAng, aC+halfAng);
    ctx.arc(cx,cy,rPort*k, aC+halfAng, aC-halfAng, true);
    ctx.closePath();
    const primary = i===0;
    ctx.fillStyle = primary ? '#c7d6fb' : '#dbe6ff'; ctx.fill();
    ctx.strokeStyle = primary ? '#2f6fed' : '#8fa8e0'; ctx.lineWidth = primary?1.5:1; ctx.stroke();
  }

  // dimension callouts on the first (top) port
  const aC = -Math.PI/2 + (nPort===1?Math.PI/2:0);
  const dirX = Math.cos(aC), dirY = Math.sin(aC);
  // r.port: center -> inner edge
  ctx.strokeStyle='#c0392b'; ctx.lineWidth=1.3;
  ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+dirX*rPort*k, cy+dirY*rPort*k); ctx.stroke();
  ctx.fillStyle='#c0392b'; ctx.font='11px sans-serif';
  ctx.fillText('r.port', cx+dirX*rPort*k*0.5+4, cy+dirY*rPort*k*0.5);
  // d.port: inner edge -> outer edge
  ctx.strokeStyle='#0f9d58'; ctx.lineWidth=1.3;
  ctx.beginPath(); ctx.moveTo(cx+dirX*rPort*k, cy+dirY*rPort*k); ctx.lineTo(cx+dirX*rOut*k, cy+dirY*rOut*k); ctx.stroke();
  ctx.fillStyle='#0f9d58';
  ctx.fillText('d.port', cx+dirX*(rPort+dPort*0.5)*k+4, cy+dirY*(rPort+dPort*0.5)*k);
  // w.port: chord across the outer edge of the first port
  const px1 = cx+Math.cos(aC-halfAng)*rOut*k, py1 = cy+Math.sin(aC-halfAng)*rOut*k;
  const px2 = cx+Math.cos(aC+halfAng)*rOut*k, py2 = cy+Math.sin(aC+halfAng)*rOut*k;
  ctx.strokeStyle='#2f6fed'; ctx.lineWidth=1.3;
  ctx.beginPath(); ctx.moveTo(px1,py1); ctx.lineTo(px2,py2); ctx.stroke();
  ctx.fillStyle='#2f6fed';
  ctx.fillText('w.port', (px1+px2)/2+6, (py1+py2)/2-6);

  ctx.fillStyle='#1c2430'; ctx.font='11px sans-serif';
  ctx.fillText(`N.port = ${nPort}`, 8, 16);
  if(rOut > dValve/2 + 1e-9){
    ctx.fillStyle='#c0392b';
    ctx.fillText('note: r.port + d.port exceeds the valve radius', 8, h-8);
  } else if(overlap){
    ctx.fillStyle='#c0392b';
    ctx.fillText('note: ports this wide would overlap each other', 8, h-8);
  }
}

function clearPresetSelection(){
  const sel = document.getElementById('tuneSel');
  if(sel){ const opt = sel.querySelector('option[value="__custom"]'); if(opt) opt.remove(); sel.value = ''; }
  const note = document.getElementById('presetNote');
  if(note) note.textContent = '';
  stockRowsSig = null; stockTuneInfo = null; // stop custom-tracking (no named stock baseline)
}

function loadExample(){
  clearPresetSelection();
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', 12, 'mm');
  setFieldValueAndUnit('clampDia', 12, 'mm');
  // clamp washer (20mm) is smaller than the last taper shim (22mm) — a conventional
  // fully-bonded stack with no crossover, so the default example has no engagement knee.
  const rowsMM = [
    [1,38,0.25],[1,34,0.25],[1,30,0.25],[1,26,0.25],[1,22,0.25],
    [1,20,3.0],[1,16,3.0]
  ];
  rowsMM.forEach((r,i)=>{
    addShimRow(r[0], r[1], r[2], 'mm', i>=rowsMM.length-2 ? (i===rowsMM.length-2?'clamp-row':'nut-row') : null, 0);
  });
  showWarn(null);
  scheduleLiveCalc();
}

/* =========================================================
   FOX 2025 GRIP X2 PRESET STACK LIBRARY
   Extracted from FOX Factory valve-stack assembly drawings. All shims 0.252in ID.
   rows are [count, OD_in, thickness_in], listed from the valve face (pressure side)
   outward toward the clamp, matching each drawing's assembly order. Every kit's shim
   count was cross-checked against the drawing's "VALVE STACK HEIGHT" dimension.
   ========================================================= */
/* =========================================================
   PRODUCT PROFILE LIBRARY  (Phase 1)
   A product = a shock/fork. Each valve inside it carries a fixed shim ID, OD bounds,
   a soft stack-height tolerance, editable+saved port geometry, and named stock tunes.
   Tune rows are [count, OD_in, thickness_in], valve-face first. FOX's 0.0031/0.0032
   rounding is collapsed to a single canonical 0.0031 part everywhere.
   ========================================================= */
const IN = 25.4;
const CANON_THK = [0.0031, 0.0045, 0.006, 0.010]; // real FOX catalog thicknesses (in)
function canonThk(t){
  let best=t, bd=1e9;
  for(const c of CANON_THK){ const d=Math.abs(c-t); if(d<bd){ bd=d; best=c; } }
  return bd<=0.0006 ? best : t; // snap only near-duplicates (merges .0031/.0032)
}

const PRODUCTS = {
  fox38x2: {
    label: '2025 FOX 38 Factory — Grip X2',
    valves: {
      rebound: {
        label:'Rebound', valveType:'mainRebound', shimID:0.252, odMin:0.350, odMax:0.650, faceOD:0.650, heightTolIn:0.05/IN,
        geom:{ stackID_in:0.252, clampDia_in:0.252, dRod:8, dValve:18, rPort:4, dPort:3, wPort:3.5, nPort:4, dThrt:0, nThrt:0 },
        tunes:{
          xlight:{ kit:'820-03-766-KIT', label:'X-Light', heightIn:0.023, rows:[[2,0.650,0.0031],[2,0.550,0.0031],[2,0.400,0.0031],[1,0.350,0.0045]] },
          light:{  kit:'820-03-743-KIT', label:'Light',   heightIn:0.029, rows:[[3,0.650,0.0032],[3,0.550,0.0032],[2,0.450,0.0032],[1,0.350,0.0045]] },
          medplus:{kit:'820-03-778-KIT', label:'Medium+', heightIn:0.027, rows:[[2,0.650,0.0045],[2,0.550,0.0045],[1,0.500,0.0045],[1,0.450,0.0045]] },
          firm:{   kit:'820-03-779-KIT', label:'Firm',    heightIn:0.036, rows:[[2,0.650,0.0045],[2,0.550,0.0045],[1,0.500,0.0045],[3,0.450,0.0045]] }
        }
      },
      mid: {
        label:'Mid valve (compression)', valveType:'mainComp', shimID:0.252, odMin:0.325, odMax:0.650, faceOD:0.650, heightTolIn:0.05/IN,
        geom:{ stackID_in:0.252, clampDia_in:0.252, dRod:8, dValve:18, rPort:4, dPort:3, wPort:3.5, nPort:4, dThrt:0, nThrt:0 },
        tunes:{
          light:{  kit:'820-03-765-KIT', label:'Light (CL)',  floatIn:'.006–.010', rows:[[1,0.650,0.0031],[1,0.400,0.0031],[1,0.350,0.0031],[1,0.550,0.0031],[2,0.450,0.0031]] },
          medium:{ kit:'820-03-702-KIT', label:'Medium (CM)', floatIn:'.006–.010', rows:[[1,0.650,0.0031],[1,0.400,0.0031],[1,0.550,0.0031],[2,0.450,0.0031],[1,0.400,0.0031]] }
        }
      },
      base: {
        label:'Base valve (compression)', valveType:'base', shimID:0.252, odMin:0.400, odMax:0.800, faceOD:0.800, heightTolIn:0.05/IN,
        geom:{ stackID_in:0.252, clampDia_in:0.252, dRod:8, dValve:22, rPort:5, dPort:4, wPort:5, nPort:6, dThrt:0, nThrt:0 },
        tunes:{
          light:{ kit:'820-03-764-KIT', label:'Light (CL)', heightIn:0.140, rows:[[5,0.800,0.0031],[1,0.400,0.0031],[6,0.800,0.0045],[3,0.700,0.006],[3,0.600,0.006],[3,0.500,0.006],[1,0.450,0.010],[3,0.400,0.010]] },
          firm:{  kit:'820-03-703-KIT', label:'Firm (CF)',  heightIn:0.137, rows:[[5,0.800,0.0031],[1,0.500,0.0031],[3,0.800,0.006],[3,0.700,0.006],[3,0.600,0.006],[4,0.500,0.006],[1,0.450,0.010],[3,0.400,0.010]] }
        }
      }
    }
  }
};

/* ---- global parts bin: every real (ID,OD,thickness) shim across all products ---- */
function buildPartsBin(){
  const seen = new Map();
  for(const pk in PRODUCTS){
    const prod = PRODUCTS[pk];
    for(const vk in prod.valves){
      const v = prod.valves[vk];
      for(const tk in v.tunes){
        for(const r of v.tunes[tk].rows){
          const od = r[1], thk = canonThk(r[2]);
          const key = v.shimID+'|'+od+'|'+thk;
          if(!seen.has(key)) seen.set(key, {id:v.shimID, od, thk});
        }
      }
    }
  }
  return [...seen.values()];
}
let PARTS_BIN = buildPartsBin();
function usableShims(v){
  return PARTS_BIN
    .filter(s=> Math.abs(s.id-v.shimID)<1e-6 && s.od>=v.odMin-1e-9 && s.od<=v.odMax+1e-9)
    .sort((a,b)=> a.od-b.od || a.thk-b.thk);
}
function usableByOD(v){
  const m = new Map();
  usableShims(v).forEach(s=>{ if(!m.has(s.od)) m.set(s.od, []); m.get(s.od).push(s.thk); });
  return m;
}

/* ---- product/valve/tune selection ---- */
let curProduct = 'fox38x2', curValveKey = 'rebound';
function currentValve(){ return PRODUCTS[curProduct] && PRODUCTS[curProduct].valves[curValveKey]; }

function populateProductSel(){
  const sel = document.getElementById('prodSel'); if(!sel) return;
  sel.innerHTML = '';
  for(const pk in PRODUCTS){
    const o = document.createElement('option'); o.value=pk; o.textContent=PRODUCTS[pk].label;
    sel.appendChild(o);
  }
  sel.value = curProduct;
}
function populateValveSel(){
  const sel = document.getElementById('valveSel'); if(!sel) return;
  sel.innerHTML = '';
  const valves = PRODUCTS[curProduct].valves;
  for(const vk in valves){
    const o = document.createElement('option'); o.value=vk; o.textContent=valves[vk].label;
    sel.appendChild(o);
  }
  if(!valves[curValveKey]) curValveKey = Object.keys(valves)[0];
  sel.value = curValveKey;
}
function populateTuneSel(){
  const sel = document.getElementById('tuneSel'); if(!sel) return;
  sel.innerHTML = '<option value="" selected disabled>choose stock tune…</option>';
  const tunes = currentValve().tunes;
  for(const tk in tunes){
    const t = tunes[tk];
    const o = document.createElement('option'); o.value=tk; o.textContent=`${t.label} — ${t.kit}`;
    sel.appendChild(o);
  }
}
function onProductChange(){
  curProduct = document.getElementById('prodSel').value;
  curValveKey = Object.keys(PRODUCTS[curProduct].valves)[0];
  populateValveSel(); applyValveContext();
}
function onValveChange(){
  curValveKey = document.getElementById('valveSel').value;
  applyValveContext();
}
function applyValveContext(){
  const v = currentValve(); if(!v) return;
  document.getElementById('valveType').value = v.valveType;
  loadValveGeom(v);
  populateTuneSel();
  renderCatalog();
}
function renderCatalog(){
  const v = currentValve(); if(!v) return;
  const list = usableShims(v);
  const cc = document.getElementById('catalogCount');
  if(cc) cc.textContent = `${list.length} parts`;
  const note = document.getElementById('catalogNote');
  if(note) note.innerHTML = `ID ${v.shimID}in · OD ${v.odMin}–${v.odMax}in · height target ±${(v.heightTolIn*IN).toFixed(2)}mm. Click a shim to add it to the stack:`;
  const chips = document.getElementById('catalogChips');
  if(chips){
    chips.innerHTML = list.map(s=>
      `<button class="small catchip" onclick="addCatalogShim(${s.od},${s.thk})" title="Add one ${s.od.toFixed(3)}in OD × ${s.thk.toFixed(4)}in shim">${s.od.toFixed(3)}<span style="opacity:.6">×</span>${s.thk.toFixed(4)}</button>`
    ).join('');
  }
}
// Add a catalog shim to the current stack, inserted in descending-OD order so the widest
// shim always sits at the valve face (keeps the stack solver-valid — a floating widest
// shim has nothing bonded spanning the outer radii). Reorder afterward with the row ↑↓.
function addCatalogShim(od, thk){
  const tbody = document.getElementById('shimBody');
  addShimRow(1, od, thk, 'in', null, 0);      // appends at end (canonical inch part)
  const newTr = tbody.lastElementChild;
  const odMM = od*IN;
  let ref = null;
  for(const tr of tbody.querySelectorAll('tr')){
    if(tr===newTr) continue;
    const u = tr.querySelector('.rowUnit').dataset.unit;
    const trOD = convLen(parseFloat(tr.querySelector('.cDiam').value)||0, u, 'mm');
    if(trOD < odMM - 1e-9){ ref = tr; break; }
  }
  if(ref) tbody.insertBefore(newTr, ref);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}

// track whether the loaded stack still matches its stock tune (for the "custom" label)
let stockRowsSig = null;   // signature of the loaded stock tune's rows (null = not tracking)
let stockTuneInfo = null;  // {kit,label,note}
let loadingStock = false;  // guard so building the stock stack doesn't flag itself custom
function rowsSig(rows){ return rows.map(r=>`${r.count}:${r.diam.toFixed(3)}:${r.thickness.toFixed(4)}:${(r.float||0).toFixed(3)}`).join('|'); }
function setTuneSelCustom(isCustom){
  const sel = document.getElementById('tuneSel'); if(!sel) return;
  let opt = sel.querySelector('option[value="__custom"]');
  if(isCustom){
    if(!opt){ opt = document.createElement('option'); opt.value='__custom'; opt.textContent='✏️ Custom (modified)'; sel.appendChild(opt); }
    sel.value = '__custom';
  } else if(opt){ opt.remove(); }
}
function refreshCustomState(){
  if(loadingStock || stockRowsSig===null) return;
  const isCustom = rowsSig(readRows()) !== stockRowsSig;
  setTuneSelCustom(isCustom);
  const note = document.getElementById('presetNote'); if(!note) return;
  if(isCustom){
    note.innerHTML = `<b>✏️ Custom</b> — modified from ${stockTuneInfo.kit} “${stockTuneInfo.label}”. Re-select that tune to restore stock.`;
  } else if(stockTuneInfo){
    if(stockTuneInfo.key) document.getElementById('tuneSel').value = stockTuneInfo.key; // reselect the stock tune
    note.innerHTML = stockTuneInfo.note;
  }
}

function onTuneChange(){
  const tk = document.getElementById('tuneSel').value;
  const v = currentValve(); if(!v) return;
  const t = v.tunes[tk]; if(!t) return;
  loadingStock = true;
  setTuneSelCustom(false);
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', 0.252, 'in');
  t.rows.forEach(r=> addShimRow(r[0], r[1], canonThk(r[2]), 'in', null, 0));
  document.getElementById('valveType').value = v.valveType;
  const total = t.rows.reduce((s,r)=> s + r[0]*canonThk(r[2]), 0);
  const heightBit = t.heightIn!=null
    ? `drawing stack height ${t.heightIn.toFixed(3)}in (tune-shim total ${total.toFixed(4)}in)`
    : (t.floatIn ? `float window ${t.floatIn}in (drawing stack height incl. spacer/spring hardware, not modeled)` : `tune-shim total ${total.toFixed(4)}in`);
  const noteHtml = `<b>${t.kit}</b> — "${PRODUCTS[curProduct].label}, ${v.label}, ${t.label}". ${heightBit}.`;
  document.getElementById('presetNote').innerHTML = noteHtml;
  showWarn(null);
  pendingStockCapture = true; // capture this stock tune's curve as the target reference
  stockHeightMM = t.rows.reduce((s,r)=> s + r[0]*canonThk(r[2]), 0) * IN; // reference height for optimizer
  // baseline for "custom" detection
  stockTuneInfo = { kit:t.kit, label:`${v.label} ${t.label}`, note:noteHtml, key:tk };
  stockRowsSig = rowsSig(readRows());
  loadingStock = false;
  scheduleLiveCalc();
}

/* ---- per product+valve geometry persistence ---- */
const GEOM_KEY = 'sst_prodGeom_v1';
function geomKeyFor(){ return curProduct + '/' + curValveKey; }
function loadValveGeom(v){
  const saved = (lsGet(GEOM_KEY)||{})[geomKeyFor()];
  const g = saved || v.geom;
  setFieldValueAndUnit('stackID', (g.stackID_in!=null ? g.stackID_in : v.shimID), 'in');
  setFieldValueAndUnit('clampDia', (g.clampDia_in!=null ? g.clampDia_in : (g.stackID_in!=null ? g.stackID_in : v.shimID)), 'in');
  ['dRod','dValve','rPort','dPort','wPort','dThrt'].forEach(id=> setFieldValueAndUnit(id, fmtLen(g[id],'mm'), 'mm'));
  document.getElementById('nPort').value = g.nPort;
  document.getElementById('nThrt').value = g.nThrt;
  const hint = document.getElementById('geomSaveHint');
  if(hint) hint.textContent = saved ? 'using your saved geometry for this valve' : 'using approximate default geometry — enter real values and save';
  drawPortFaceDiagram();
}
function saveValveGeom(){
  const all = lsGet(GEOM_KEY)||{};
  all[geomKeyFor()] = {
    stackID_in: getFieldMM('stackID')/IN,
    clampDia_in: getFieldMM('clampDia')/IN,
    dRod:getFieldMM('dRod'), dValve:getFieldMM('dValve'),
    rPort:getFieldMM('rPort'), dPort:getFieldMM('dPort'), wPort:getFieldMM('wPort'),
    dThrt:getFieldMM('dThrt'),
    nPort:parseFloat(document.getElementById('nPort').value)||0,
    nThrt:parseFloat(document.getElementById('nThrt').value)||0
  };
  const ok = lsSet(GEOM_KEY, all);
  const hint = document.getElementById('geomSaveHint');
  if(hint) hint.textContent = ok ? `saved geometry for ${PRODUCTS[curProduct].label} · ${currentValve().label}` : 'saved for this session (browser is blocking storage for local files)';
}
function initProductUX(){
  populateProductSel();
  populateValveSel();
  applyValveContext();
}

// compatibility shims for older call sites (pins, examples)
const OLD_KEY_MAP = { rebXLight:['rebound','xlight'], rebLight:['rebound','light'], rebMedPlus:['rebound','medplus'], rebFirm:['rebound','firm'],
  midLight:['mid','light'], midMedium:['mid','medium'], baseLight:['base','light'], baseFirm:['base','firm'] };
function loadFoxPreset(oldKey){
  const map = OLD_KEY_MAP[oldKey]; if(!map) return;
  curValveKey = map[0];
  document.getElementById('valveSel') && (document.getElementById('valveSel').value = curValveKey);
  applyValveContext();
  document.getElementById('tuneSel').value = map[1];
  onTuneChange();
}
function loadFoxExample(){ loadFoxPreset('rebLight'); }
// label of the currently-selected stock tune (for pin auto-naming)
function currentTuneLabel(){
  const v = currentValve(); const tk = document.getElementById('tuneSel') ? document.getElementById('tuneSel').value : '';
  if(v && v.tunes[tk]) return `${v.label} ${v.tunes[tk].label}`;
  if(tk==='__custom') return stockTuneInfo ? `${stockTuneInfo.label} (custom)` : 'Custom';
  return '';
}

// demonstrates the Float mechanism: a soft base stack plus a backup shim that only
// engages once the stack has already deflected a fair amount, producing a visible knee.
// Note: the backup shim's OD must not exceed the largest always-engaged shim's OD, or
// there'd be a real physical gap at the outer edge before it engages (see About panel —
// the model needs continuous material from the clamp ID out to the loaded radius).
function loadCrossoverExample(){
  clearPresetSelection();
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', 12, 'mm');
  setFieldValueAndUnit('clampDia', 12, 'mm');
  const rowsMM = [ [1,32,0.2],[1,28,0.2],[1,24,0.2] ];
  rowsMM.forEach(r=> addShimRow(r[0], r[1], r[2], 'mm', null, 0));
  // backup shim: bonded like a normal row (Count/Diam/Thick) but with Float>0 so it only
  // starts contributing once the bending stack beneath closes the gap under it. Note the
  // total gap at its outer edge is the 0.05 Float PLUS the thickness of the narrower
  // 24/28mm shims it overhangs (structural crossover, detected automatically) — with the
  // default 400N range it engages around a sixth of the way up the curve.
  // OD (30mm) stays within the primary stack's reach (32mm) so it never leaves the
  // solver without bridging material.
  addShimRow(1, 30, 0.3, 'mm', null, 0.05);
  document.getElementById('fMax').value = fmtForce(convForce(400,'mm',resultUnit), resultUnit);
  showWarn(null);
  scheduleLiveCalc();
}

function setFieldValueAndUnit(id, value, unit){
  document.getElementById(id).value = value;
  const sel = document.querySelector(`.fieldUnit[data-for="${id}"], .modUnit[data-for="${id}"]`);
  if(sel){ sel.value = unit; sel.dataset.unit = unit; }
}

function readRows(){
  const rows = [];
  document.querySelectorAll('#shimBody tr').forEach(tr=>{
    const count = parseFloat(tr.querySelector('.cCount').value)||0;
    const unit = tr.querySelector('.rowUnit').dataset.unit;
    const diam = convLen(parseFloat(tr.querySelector('.cDiam').value)||0, unit, 'mm');
    const thickness = convLen(parseFloat(tr.querySelector('.cThick').value)||0, unit, 'mm');
    const floatEl = tr.querySelector('.cFloat');
    const float = Math.max(0, convLen(parseFloat(floatEl ? floatEl.value : 0)||0, unit, 'mm'));
    const special = tr.className || null;
    if(count>0 && diam>0 && thickness>0) rows.push({count,diam,thickness,float,special});
  });
  return rows;
}

function readGeom(){
  return {
    dRod: getFieldMM('dRod'), dValve: getFieldMM('dValve'),
    rPort: getFieldMM('rPort'), dPort: getFieldMM('dPort'), wPort: getFieldMM('wPort'),
    nPort: parseFloat(document.getElementById('nPort').value),
    dThrt: getFieldMM('dThrt'), nThrt: parseFloat(document.getElementById('nThrt').value),
    stackID: getFieldMM('stackID'),
    clampDia: getFieldMM('clampDia'),
  };
}
function readMech(){ return { E: getModMPa(), nu: parseFloat(document.getElementById('nu').value) }; }
function readFluid(){
  return {
    rho: parseFloat(document.getElementById('rho').value),
    Cd: parseFloat(document.getElementById('cd').value),
    cSt40: parseFloat(document.getElementById('cst40').value)||30,
    cSt100: parseFloat(document.getElementById('cst100').value)||6,
    tempC: parseFloat(document.getElementById('oilTemp').value),
    Re0: parseFloat(document.getElementById('re0').value)||10,
  };
}
function readValveType(){ return document.getElementById('valveType').value; }

function showWarn(msg){
  const box = document.getElementById('warnBox');
  if(!msg){ box.style.display='none'; box.textContent=''; return; }
  box.style.display='block'; box.textContent = msg;
}

/* =========================================================
   RUN
   ========================================================= */
// runCalc({live}) — when live=true, this was triggered automatically by an edit rather
// than the Run button, so we (a) keep the force slider where the user left it instead of
// snapping it back to max, and (b) route problems to a quiet inline status line rather
// than the big red warning box, since half-finished input is expected mid-typing.
function runCalc(opts){
  const live = !!(opts && opts.live);
  if(!live) showWarn(null);
  const rows = readRows();
  if(rows.length < 2){
    if(live){ liveStatus('err','waiting for at least 2 shim rows…'); } else { showWarn("Add at least a couple of shim rows."); }
    return;
  }
  const geom = readGeom();
  const mech = readMech();
  const fluid = readFluid();
  const valveType = readValveType();
  const fMaxRaw = parseFloat(document.getElementById('fMax').value);
  const uMaxRaw = parseFloat(document.getElementById('uMax').value);
  const Fmax = convForce(fMaxRaw, resultUnit, 'mm');
  const uMax = convVel(uMaxRaw, resultUnit, 'mm');
  const nPts = Math.max(6, parseInt(document.getElementById('nPts').value)||26);

  let stack;
  try{ stack = buildStack(rows, geom, mech, {Fmax, nSteps:150, nSeg:350}); }
  catch(e){
    if(live){ liveStatus('err', e.message); } else { showWarn(e.message); }
    return;
  }
  currentStack = stack; currentGeom = geom; currentRows = rows;

  const results = [];
  for(let i=0;i<nPts;i++){
    const frac = i/(nPts-1);
    const u = uMax * Math.pow(frac, 1.8);
    const r = solveForceAtVelocity(Math.max(u,0.01), stack, geom, fluid, valveType, Fmax);
    results.push({u, F:r.F, Re:r.Re});
  }
  results[0].u = 0; results[0].F = 0; results[0].Re = 0;
  currentResults = results;

  const slider = document.getElementById('forceSlider');
  const newMax = parseFloat(fmtForce(fMaxRaw,resultUnit));
  if(live){
    // preserve the fraction of travel the user was viewing
    const oldMax = parseFloat(slider.max)||newMax;
    const frac = oldMax>0 ? Math.min(1,(parseFloat(slider.value)||0)/oldMax) : 1;
    slider.max = newMax;
    slider.value = fmtForce(newMax*frac, resultUnit);
  } else {
    slider.max = newMax;
    slider.value = fmtForce(fMaxRaw,resultUnit);
  }
  document.getElementById('sliderVal').textContent = fmtForce(parseFloat(slider.value),resultUnit);

  // snapshot the stock reference curve when a stock tune was just loaded
  if(pendingStockCapture){ stockCurve = currentResults.map(p=>({u:p.u, F:p.F})); pendingStockCapture = false; }

  drawStackAtSlider();
  drawForceCurve();
  fillTable();
  updateTargetReadout();

  const engaged = (stack.engageLog && stack.engageLog.length) ? stack.engageLog.map(e=>{
    const Fd = fmtForce(convForce(e.F,'mm',resultUnit), resultUnit);
    return `row ${e.rowIndex+1} engages at ≈${Fd} ${resultUnit==='mm'?'N':'lbf'}`;
  }) : [];

  if(live){
    const pkF = fmtForce(convForce(results[results.length-1].F,'mm',resultUnit), resultUnit);
    let msg = `updated — peak damping ≈ ${pkF} ${resultUnit==='mm'?'N':'lbf'}`;
    if(engaged.length) msg += ` · ${engaged.join('; ')}`;
    liveStatus('ok', msg);
  } else if(engaged.length){
    showWarn('Shim engagement during this run (Float gap and/or a structural crossover closing) — ' + engaged.join('; ') + '. (This is informational, not an error.)');
  }
}

/* ---- Live (auto) recalculation ---------------------------------------------
   Debounced so a burst of keystrokes only triggers one solve. The physics build
   is ~10ms so this stays snappy, but debouncing avoids running it on every digit. */
let liveTimer = null;
function liveStatus(kind, msg){
  const el = document.getElementById('liveStatus');
  if(!el) return;
  el.className = 'live-status ' + (kind||'');
  el.textContent = msg || '';
}
function scheduleLiveCalc(){
  const box = document.getElementById('liveMode');
  if(!box || !box.checked) return;
  liveStatus('calc','calculating…');
  if(liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(()=>{ runCalc({live:true}); }, 260);
}
function onLiveModeChange(){
  const box = document.getElementById('liveMode');
  const btn = document.getElementById('recalcBtn');
  if(box && box.checked){
    if(btn) btn.style.display = 'none';
    runCalc({live:true});
  } else {
    if(btn) btn.style.display = '';
    liveStatus('', 'live update off — press Recalculate to refresh');
  }
}

// Builds smooth, curved shim bands directly from the shim table rows.
//
// Layout: each row rests in table order at the cumulative thickness of the rows below it,
// plus the cumulative Float gaps below it. Structural cavities — where a wider shim
// overhangs a narrower one beneath it — appear automatically because each row is drawn in
// its own slot across its own reach.
//
// Motion: the solver gives one deflection curve y(r) for the engaged stack. At each
// radius, the gap beneath a row is its explicit Float PLUS the thickness of any narrower
// rows below that don't reach that radius (see stackGapAt). The row is only pushed where
// the supported stack beneath has crossed that gap: push(r) = y(r) − gap(r) where
// supported. The row's offset is the RUNNING MAX of push from the clamp outward — so a
// wide clamp plate over a small pivot shim visibly stays put while the shims below bend
// up around the pivot's edge, gets contacted, and only then starts to move: correct
// order, no overlap, no tearing at cavity edges. This mirrors the solver's own
// engagement rule, so what you see matches what's computed.
function drawStackAtSlider(){
  if(!currentStack || !currentRows) return;
  const Fdisp = parseFloat(document.getElementById('forceSlider').value)||0;
  document.getElementById('sliderVal').textContent = fmtForce(Fdisp,resultUnit);
  const Fbase = convForce(Fdisp, resultUnit, 'mm');
  const profile = currentStack.profileAt(Fbase); // {rs, ys} in mm
  const aMM = ((currentGeom.clampDia && currentGeom.clampDia>0) ? currentGeom.clampDia : currentGeom.stackID)/2;
  const engageF = currentStack.engageF || [];
  function liftAt(r){ return interpArr(profile.rs, profile.ys, r); }

  let base = 0;      // cumulative shim material below
  let cumFloat = 0;  // cumulative explicit float gaps below (incl. this row's own gap)
  const bands = [];
  currentRows.forEach((row,idx)=>{
    cumFloat += Math.max(0, row.float||0);
    const hRow = row.count*row.thickness;
    const yRest = base + cumFloat;
    base += hRow;
    const rOuter = row.diam/2;
    if(rOuter<=aMM) return;
    const pal = (row.special==='clamp-row'||row.special==='nut-row') ? CLAMP_COLOR : SHIM_PALETTE[idx % SHIM_PALETTE.length];
    const engagedNow = Fbase >= (engageF[idx]!==undefined ? engageF[idx] : -Infinity);
    const N = 50;
    const rs=[], yB=[], yT=[];
    let runMax = 0; // contact offset carried outward — a plate can't dip back down mid-span
    for(let s=0;s<=N;s++){
      const r = aMM + (rOuter-aMM)*s/N;
      if(stackSupportedAt(currentRows, idx, r)){
        const push = liftAt(r) - stackGapAt(currentRows, idx, r);
        if(push > runMax) runMax = push;
      }
      rs.push(convLen(r,'mm',resultUnit));
      yB.push(convLen(yRest + runMax,'mm',resultUnit));
      yT.push(convLen(yRest + runMax + hRow,'mm',resultUnit));
    }
    bands.push({ rs, yB, yT, fill:pal.fill, stroke:pal.stroke,
                 dashed: row.float>0 && !engagedNow, faded: row.float>0 && !engagedNow });
  });

  const rLoadDisp = convLen(currentStack.rLoad,'mm',resultUnit);
  drawStackCanvas(bands, rLoadDisp);
}

/* =========================================================
   CANVAS DRAWING (no external libraries)
   ========================================================= */
function setupCanvas(cv){
  const ratio = window.devicePixelRatio||1;
  const rect = cv.getBoundingClientRect();
  cv.width = rect.width*ratio; cv.height = rect.height*ratio;
  const ctx = cv.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  return {ctx, w:rect.width, h:rect.height};
}

function drawAxes(ctx, w, h, pad, xMax, yMax, xLabel, yLabel, yMin){
  yMin = yMin || 0;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = '#dde1e6'; ctx.fillStyle = '#5b6472';
  ctx.font = '11px sans-serif';
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, h-pad.b); ctx.lineTo(w-pad.r, h-pad.b);
  ctx.stroke();
  const nx=5, ny=5;
  for(let i=0;i<=nx;i++){
    const x = pad.l + (w-pad.l-pad.r)*i/nx;
    const val = xMax*i/nx;
    ctx.strokeStyle='#eef0f3'; ctx.beginPath(); ctx.moveTo(x,pad.t); ctx.lineTo(x,h-pad.b); ctx.stroke();
    ctx.fillStyle='#5b6472'; ctx.fillText(val<1 ? val.toFixed(4) : val.toFixed(val<10?2:0), x-8, h-pad.b+14);
  }
  for(let i=0;i<=ny;i++){
    const y = h-pad.b - (h-pad.t-pad.b)*i/ny;
    const val = yMin + (yMax-yMin)*i/ny;
    ctx.strokeStyle='#eef0f3'; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke();
    ctx.fillStyle='#5b6472'; ctx.fillText(val<1 ? val.toFixed(4) : val.toFixed(val<10?2:0), 4, y+3);
  }
  ctx.fillStyle='#1c2430';
  ctx.fillText(xLabel, w/2-20, h-4);
  ctx.save(); ctx.translate(10, h/2+20); ctx.rotate(-Math.PI/2); ctx.fillText(yLabel,0,0); ctx.restore();
}

function drawStackCanvas(bands, rLoad){
  const cv = document.getElementById('stackCanvas');
  const {ctx,w,h} = setupCanvas(cv);
  const pad = {l:44,r:16,t:14,b:26};
  let xMax = rLoad, yMax = 1e-6;
  bands.forEach(b=>{
    xMax = Math.max(xMax, b.rs[b.rs.length-1]);
    for(let i=0;i<b.yT.length;i++) yMax = Math.max(yMax, b.yT[i]);
  });
  xMax*=1.03; yMax*=1.18;
  drawAxes(ctx,w,h,pad,xMax,yMax,`radius (${resultUnit==='mm'?'mm':'in'})`,`cross-section (${resultUnit==='mm'?'mm':'in'})`);
  const X = r => pad.l + (w-pad.l-pad.r)*(r/xMax);
  const Y = y => (h-pad.b) - (h-pad.t-pad.b)*(y/yMax);

  bands.forEach(b=>{
    // one smooth closed polygon per shim: along the bottom edge, back along the top edge
    ctx.beginPath();
    b.rs.forEach((r,i)=>{ const x=X(r), y=Y(b.yB[i]); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    for(let i=b.rs.length-1;i>=0;i--) ctx.lineTo(X(b.rs[i]), Y(b.yT[i]));
    ctx.closePath();
    ctx.globalAlpha = b.faded ? 0.55 : 1;
    ctx.fillStyle = b.fill; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = b.stroke; ctx.lineWidth = 0.8;
    if(b.dashed) ctx.setLineDash([4,3]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  ctx.strokeStyle='#c0392b'; ctx.setLineDash([4,3]);
  ctx.beginPath(); ctx.moveTo(X(rLoad), pad.t); ctx.lineTo(X(rLoad), h-pad.b); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='#c0392b'; ctx.font='11px sans-serif';
  ctx.fillText('port edge', X(rLoad)+4, pad.t+12);
}

/* ---- pinned comparison curves + force-axis control ---- */
let pinnedCurves = []; // {name, color, results:[{u,F}]} — always base units (mm/s, N)
const PIN_COLORS = ['#8e44ad','#e08e0b','#d1495b','#16a3b0','#8a6d1a','#33415c','#c2185b','#455a64'];
const PINS_KEY = 'sst_pins_v1', AXIS_KEY = 'sst_axis_v1';

function pinCurrentCurve(){
  if(!currentResults.length){ liveStatus('err','nothing to pin yet — make an edit so a curve is computed'); return; }
  const nameEl = document.getElementById('pinName');
  let name = (nameEl.value||'').trim();
  if(!name){
    name = currentTuneLabel() || ('Stack '+(pinnedCurves.length+1));
  }
  const color = PIN_COLORS[pinnedCurves.length % PIN_COLORS.length];
  pinnedCurves.push({ name, color, results: currentResults.map(p=>({u:p.u, F:p.F})) });
  if(pinnedCurves.length > 8) pinnedCurves.shift(); // keep the chart readable
  nameEl.value = '';
  lsSet(PINS_KEY, pinnedCurves);
  renderPinList();
  drawForceCurve();
}
function removePin(i){ pinnedCurves.splice(i,1); lsSet(PINS_KEY, pinnedCurves); renderPinList(); drawForceCurve(); }
function clearPins(){ pinnedCurves = []; lsSet(PINS_KEY, pinnedCurves); renderPinList(); drawForceCurve(); }
function renderPinList(){
  const el = document.getElementById('pinList');
  if(!el) return;
  el.innerHTML = '';
  pinnedCurves.forEach((p,i)=>{
    const chip = document.createElement('span');
    chip.className = 'pin-chip';
    const sw = document.createElement('span'); sw.className='sw'; sw.style.background = p.color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(p.name));
    const btn = document.createElement('button'); btn.title='remove'; btn.textContent='✕';
    btn.addEventListener('click', ()=>removePin(i));
    chip.appendChild(btn);
    el.appendChild(chip);
  });
}
function onAxisSettingChange(){
  const mode = document.getElementById('axisMode').value;
  document.getElementById('axisMaxWrap').style.display = mode==='fixed' ? '' : 'none';
  const fEl = document.getElementById('axisMaxF');
  if(mode==='fixed' && !(parseFloat(fEl.value)>0)){
    // prefill with the current chart maximum rounded up to a round number
    const maxN = Math.max(100, ...currentResults.map(p=>p.F), ...pinnedCurves.flatMap(c=>c.results.map(p=>p.F)));
    const disp = convForce(maxN,'mm',resultUnit);
    const mag = Math.pow(10, Math.floor(Math.log10(disp)));
    fEl.value = Math.ceil(disp/mag)*mag;
  }
  const fminEl = document.getElementById('axisMinF');
  // X (shaft velocity) axis
  const xMode = document.getElementById('xAxisMode').value;
  document.getElementById('xAxisMaxWrap').style.display = xMode==='fixed' ? '' : 'none';
  const xEl = document.getElementById('axisMaxU');
  if(xMode==='fixed' && !(parseFloat(xEl.value)>0)){
    const maxU = Math.max(100, ...currentResults.map(p=>p.u), ...pinnedCurves.flatMap(c=>c.results.map(p=>p.u)));
    const disp = convVel(maxU,'mm',resultUnit);
    const mag = Math.pow(10, Math.floor(Math.log10(disp)));
    xEl.value = Math.ceil(disp/mag)*mag;
  }
  lsSet(AXIS_KEY, {
    mode, maxN: convForce(parseFloat(fEl.value)||0, resultUnit, 'mm'), minN: convForce(parseFloat(fminEl.value)||0, resultUnit, 'mm'),
    xMode, maxU: convVel(parseFloat(xEl.value)||0, resultUnit, 'mm')
  });
  drawForceCurve();
}
function restoreAxisPrefs(){
  const a = lsGet(AXIS_KEY);
  if(!a) return;
  document.getElementById('axisMode').value = a.mode||'auto';
  if(a.maxN>0) document.getElementById('axisMaxF').value = fmtForce(convForce(a.maxN,'mm',resultUnit), resultUnit);
  if(a.minN>0) document.getElementById('axisMinF').value = fmtForce(convForce(a.minN,'mm',resultUnit), resultUnit);
  document.getElementById('axisMaxWrap').style.display = a.mode==='fixed' ? '' : 'none';
  document.getElementById('xAxisMode').value = a.xMode||'auto';
  if(a.maxU>0) document.getElementById('axisMaxU').value = fmtVel(convVel(a.maxU,'mm',resultUnit), resultUnit);
  document.getElementById('xAxisMaxWrap').style.display = a.xMode==='fixed' ? '' : 'none';
}

let forceChartMap = null; // {pad,w,h,xMax,yMax,yMin} in display units — for hit-testing
let hiddenCurves = new Set(); // labels of curves toggled off via the legend
let legendHits = [];          // clickable legend rects {label,x0,y0,x1,y1}
function drawForceCurve(){
  const cv = document.getElementById('forceCanvas');
  const {ctx,w,h} = setupCanvas(cv);
  const pad = {l:52,r:16,t:14,b:26};

  const curves = [];
  pinnedCurves.forEach(p=>{
    curves.push({ label:p.name, color:p.color, width:1.6, dash:[5,3], dots:false,
      pts: p.results.map(q=>({u:convVel(q.u,'mm',resultUnit), F:convForce(q.F,'mm',resultUnit)})) });
  });
  if(currentResults.length){
    curves.push({ label:'current', color:'#0f9d58', width:2.2, dash:[], dots:true,
      pts: currentResults.map(p=>({u:convVel(p.u,'mm',resultUnit), F:convForce(p.F,'mm',resultUnit)})) });
  }
  optCandidates.forEach(c=>{
    curves.push({ label:c.label, color:c.color, width:1.8, dash:[2,3], dots:false,
      pts: c.curve.map(p=>({u:convVel(p.u,'mm',resultUnit), F:convForce(p.F,'mm',resultUnit)})) });
  });
  // stock reference + target contribute to scaling and are drawn separately
  const stockPts = (targetOn && stockCurve) ? stockCurve.map(p=>({u:convVel(p.u,'mm',resultUnit), F:convForce(p.F,'mm',resultUnit)})) : [];
  const tgtPts = (targetOn && targetHandles.length) ? targetHandles.map(hn=>({u:convVel(hn.u,'mm',resultUnit), F:convForce(hn.F,'mm',resultUnit)})) : [];
  if(!curves.length && !tgtPts.length) return;

  // a curve is drawn/scaled only if not hidden (click its legend entry to toggle)
  const vis = c => !hiddenCurves.has(c.label);
  const stockHidden = hiddenCurves.has('stock (reference)');
  const visCurves = curves.filter(vis);
  const scaleStock = stockPts.length && !stockHidden;
  const allX = [...visCurves.flatMap(c=>c.pts.map(p=>p.u)), ...(scaleStock?stockPts.map(p=>p.u):[]), ...tgtPts.map(p=>p.u)];
  const allYForAuto = [...visCurves.flatMap(c=>c.pts.map(p=>p.F)), ...(scaleStock?stockPts.map(p=>p.F):[]), ...tgtPts.map(p=>p.F)];
  const xModeEl = document.getElementById('xAxisMode');
  const xMode = xModeEl ? xModeEl.value : 'auto';
  const xMaxEl = document.getElementById('axisMaxU');
  const xFixed = xMaxEl ? (parseFloat(xMaxEl.value)||0) : 0;
  const xMax = (xMode==='fixed' && xFixed>0) ? xFixed : Math.max(1, ...allX) * 1.05;
  const modeEl = document.getElementById('axisMode');
  const mode = modeEl ? modeEl.value : 'auto';
  const fEl = document.getElementById('axisMaxF'), fminEl = document.getElementById('axisMinF');
  const fixedMax = fEl ? (parseFloat(fEl.value)||0) : 0;
  const fixedMin = fminEl ? (parseFloat(fminEl.value)||0) : 0;
  let yMin, yMax;
  if(mode==='fixed' && fixedMax>fixedMin){ yMin=fixedMin; yMax=fixedMax; }
  else { yMin=0; yMax = Math.max(1, ...allYForAuto) * 1.15; }

  drawAxes(ctx,w,h,pad,xMax,yMax,`shaft velocity (${resultUnit==='mm'?'mm/s':'in/s'})`,`damping force (${resultUnit==='mm'?'N':'lbf'})`, yMin);
  const X = u => pad.l + (w-pad.l-pad.r)*(u/xMax);
  const Y = F => (h-pad.b) - (h-pad.t-pad.b)*((F-yMin)/(yMax-yMin));
  forceChartMap = { pad, w, h, xMax, yMax, yMin };

  ctx.save();
  ctx.beginPath(); ctx.rect(pad.l, pad.t, w-pad.l-pad.r, h-pad.t-pad.b); ctx.clip();

  if(stockPts.length && !stockHidden){
    ctx.strokeStyle='#9aa3b0'; ctx.lineWidth=1.4; ctx.setLineDash([]);
    ctx.beginPath();
    stockPts.forEach((p,i)=>{ const x=X(p.u), y=Y(p.F); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
  }

  visCurves.forEach(c=>{
    ctx.strokeStyle = c.color; ctx.lineWidth = c.width; ctx.setLineDash(c.dash);
    ctx.beginPath();
    c.pts.forEach((p,i)=>{ const x=X(p.u), y=Y(p.F); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
    ctx.setLineDash([]);
    if(c.dots){ ctx.fillStyle=c.color; c.pts.forEach(p=>{ ctx.beginPath(); ctx.arc(X(p.u),Y(p.F),2.2,0,7); ctx.fill(); }); }
  });

  if(tgtPts.length){
    const lineP = [{u:0, F:0}, ...tgtPts];
    ctx.strokeStyle='#c026d3'; ctx.lineWidth=2; ctx.setLineDash([6,4]);
    ctx.beginPath();
    lineP.forEach((p,i)=>{ const x=X(p.u), y=Y(p.F); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  ctx.setLineDash([]);

  if(tgtPts.length){
    tgtPts.forEach((p,i)=>{
      const x=X(p.u), y=Y(p.F);
      ctx.fillStyle = (i===dragHandle) ? '#a21caf' : '#c026d3';
      ctx.strokeStyle='#fff'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.rect(x-4, y-4, 8, 8); ctx.fill(); ctx.stroke();
    });
  }

  // legend (top-left) — every entry is clickable to hide/show that line. Hidden ones are
  // greyed and struck through. Hit rectangles are saved for the pointer handler.
  ctx.font='11px sans-serif';
  let ly = pad.t + 12;
  legendHits = [];
  const legend = curves.map(c=>({label:c.label, color:c.color, dash:c.dash}));
  if(stockPts.length) legend.unshift({label:'stock (reference)', color:'#9aa3b0', dash:[]});
  if(tgtPts.length) legend.push({label:'target', color:'#c026d3', dash:[6,4], noHide:true});
  legend.forEach(c=>{
    const hidden = hiddenCurves.has(c.label);
    ctx.globalAlpha = hidden ? 0.4 : 1;
    ctx.strokeStyle=c.color; ctx.lineWidth=2; ctx.setLineDash(c.dash||[]);
    ctx.beginPath(); ctx.moveTo(pad.l+8, ly-3); ctx.lineTo(pad.l+30, ly-3); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#1c2430';
    const tw = ctx.measureText(c.label).width;
    ctx.fillText(c.label, pad.l+36, ly);
    if(hidden){ ctx.strokeStyle='#1c2430'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(pad.l+36, ly-3); ctx.lineTo(pad.l+36+tw, ly-3); ctx.stroke(); }
    ctx.globalAlpha = 1;
    if(!c.noHide) legendHits.push({label:c.label, x0:pad.l+4, y0:ly-12, x1:pad.l+40+tw, y1:ly+4});
    ly += 15;
  });
}

/* =========================================================
   TARGET CURVE (Phase 2) — draggable desired-force line over the chart.
   Handles hold {u, F} in base units (mm/s, N). u is fixed per handle; you drag F.
   The stock reference is snapshotted whenever a stock tune loads.
   ========================================================= */
let targetOn = false, targetHandles = [], stockCurve = null, dragHandle = -1, pendingStockCapture = false;
const TARGET_KEY = 'sst_target_v2'; // v2: denser handle set + origin-anchored line

function saveTarget(){ lsSet(TARGET_KEY, { on: targetOn, handles: targetHandles }); }
function restoreTarget(){
  const t = lsGet(TARGET_KEY);
  if(!t) return;
  targetOn = !!t.on; targetHandles = t.handles || [];
  const box = document.getElementById('targetOn'); if(box) box.checked = targetOn;
}
// Handle spacing is denser at low shaft speed, where a small force change is a big feel
// change, and sparser up top. The origin (0,0) is always part of the target line but is
// not a draggable handle — at zero shaft speed there's no damping force, by definition.
const TARGET_FRACS = [0.03,0.07,0.12,0.18,0.26,0.35,0.45,0.56,0.68,0.8,0.9,1.0];
function resetTargetToCurrent(){
  if(!currentResults.length) return;
  const uMaxB = currentResults[currentResults.length-1].u;
  const us = currentResults.map(p=>p.u), fs = currentResults.map(p=>p.F);
  targetHandles = TARGET_FRACS.map(f=>{ const u=uMaxB*f; return { u, F: interpArr(us, fs, u) }; });
  saveTarget(); drawForceCurve(); updateTargetReadout();
}
function clearTarget(){
  targetHandles = []; targetOn = false;
  const box = document.getElementById('targetOn'); if(box) box.checked = false;
  const cv = document.getElementById('forceCanvas'); if(cv) cv.style.touchAction = '';
  saveTarget(); drawForceCurve(); updateTargetReadout();
}
function onTargetToggle(){
  targetOn = document.getElementById('targetOn').checked;
  const cv = document.getElementById('forceCanvas');
  if(cv) cv.style.touchAction = targetOn ? 'none' : ''; // let the handle drag win over page scroll on touch
  if(targetOn && !targetHandles.length) resetTargetToCurrent();
  saveTarget(); drawForceCurve(); updateTargetReadout();
}
function updateTargetReadout(){
  const el = document.getElementById('targetReadout'); if(!el) return;
  if(!targetOn || !targetHandles.length || !currentResults.length){ el.textContent=''; return; }
  const us = currentResults.map(p=>p.u), fs = currentResults.map(p=>p.F);
  let se=0, worst=0;
  targetHandles.forEach(hn=>{ const cur=interpArr(us,fs,hn.u); const d=hn.F-cur; const pct = cur>1e-6 ? 100*d/cur : 0; se += d*d; if(Math.abs(pct)>Math.abs(worst)) worst=pct; });
  const rms = Math.sqrt(se/targetHandles.length);
  const uf = resultUnit==='mm'?'N':'lbf';
  el.textContent = `current vs target — RMS ${fmtForce(convForce(rms,'mm',resultUnit),resultUnit)} ${uf}, worst ${worst>0?'+':''}${worst.toFixed(0)}%`;
}
// pointer on the force chart (mouse + touch via pointer events): legend clicks toggle a
// line's visibility (works any time); dragging a target handle edits the target (target mode).
function forceCanvasPointer(e, phase){
  if(!forceChartMap) return;
  const cv = document.getElementById('forceCanvas');
  const rect = cv.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const {pad,w,h,xMax,yMax,yMin} = forceChartMap;
  const Xh = u => pad.l + (w-pad.l-pad.r)*(u/xMax);
  const Yh = F => (h-pad.b) - (h-pad.t-pad.b)*((F-yMin)/(yMax-yMin));
  if(phase==='down'){
    // legend hit? toggle that curve's visibility
    for(const lh of legendHits){
      if(px>=lh.x0 && px<=lh.x1 && py>=lh.y0 && py<=lh.y1){
        if(hiddenCurves.has(lh.label)) hiddenCurves.delete(lh.label); else hiddenCurves.add(lh.label);
        e.preventDefault(); drawForceCurve(); return;
      }
    }
    if(!targetOn) return;
    let best=-1, bd=14;
    targetHandles.forEach((hn,i)=>{
      const dx = px-Xh(convVel(hn.u,'mm',resultUnit)), dy = py-Yh(convForce(hn.F,'mm',resultUnit));
      const dist = Math.hypot(dx,dy);
      if(dist<bd){ bd=dist; best=i; }
    });
    dragHandle = best;
    if(best>=0){ e.preventDefault(); cv.setPointerCapture && cv.setPointerCapture(e.pointerId); }
  } else if(phase==='move'){
    if(dragHandle<0) return;
    e.preventDefault();
    const FD = yMin + (yMax-yMin) * (h-pad.b - py)/(h-pad.t-pad.b);
    targetHandles[dragHandle].F = Math.max(0, convForce(FD, resultUnit, 'mm'));
    drawForceCurve(); updateTargetReadout();
  } else { // up
    if(dragHandle>=0){ dragHandle=-1; saveTarget(); }
  }
}

/* =========================================================
   OPTIMIZER (Phase 3) — search the valve's real-shim catalog for stacks whose damping
   curve best matches the target line. Local hill-climb from the current stack (so it
   stays close to what you loaded) with a few perturbed restarts for diversity. Every
   candidate is built ONLY from catalog parts, kept in descending-OD (widest-at-face)
   order so it's always solver-valid, and scored on curve fit plus a soft stack-height
   penalty that leans thick (never under the reference height).
   ========================================================= */
let optCandidates = [];     // [{label,color,rows:[{count,od_in,thk_in}],err,hMM,flag,curve}]
let stockHeightMM = 0;      // reference height (mm) from the last stock tune loaded
const OPT_COLORS = ['#2563eb','#0891b2','#7c3aed'];

function currentStackHeightMM(){ return readRows().reduce((s,r)=> s + r.count*r.thickness, 0); }

function optimizeToTarget(){
  const status = document.getElementById('optStatus');
  if(!targetOn || !targetHandles.length){ status.textContent='Turn on Target curve and shape it first.'; return; }
  const v = currentValve();
  const catalog = usableShims(v);
  if(!catalog.length){ status.textContent='No catalog for this valve — pick a Product/Valve first.'; return; }
  status.textContent='searching real FOX shims…';
  document.getElementById('optBtn').disabled = true;
  // let the status paint before the (blocking) search
  setTimeout(()=>{ try{ runOptimize(v, catalog); } finally { document.getElementById('optBtn').disabled=false; } }, 20);
}

function runOptimize(v, catalog){
  const geom = readGeom(), mech = readMech(), fluid = readFluid(), valveType = readValveType();
  const Fmax = convForce(parseFloat(document.getElementById('fMax').value), resultUnit, 'mm');
  const evalVels = targetHandles.map(hn=>hn.u).filter(u=>u>0);
  const txU = [0, ...targetHandles.map(h=>h.u)], txF = [0, ...targetHandles.map(h=>h.F)];
  const tgtF = u => interpArr(txU, txF, u);
  const meanTgt = Math.max(1, txF.reduce((a,b)=>a+b,0)/txF.length);
  const Href = stockHeightMM>0 ? stockHeightMM : currentStackHeightMM();
  const tolOver = (v.heightTolIn||0.05/IN)*IN; // mm the stack may exceed Href by
  const ODS = [...new Set(catalog.map(s=>s.od))].sort((a,b)=>a-b);
  const thksFor = od => catalog.filter(s=>Math.abs(s.od-od)<1e-9).map(s=>s.thk);
  const nearest = (arr,x)=> arr.reduce((b,t)=> Math.abs(t-x)<Math.abs(b-x)?t:b, arr[0]);
  // The face shim covers the valve ports, so the widest (face) OD is fixed for this valve
  // and must always be present. The optimizer may change the face shim's thickness/count
  // but never its OD, and can never leave the stack with no port-covering shim.
  const faceOD = v.faceOD || v.odMax;
  const faceCnt = c => c.reduce((s,x)=> Math.abs(x.od-faceOD)<1e-9 ? s+x.count : s, 0);
  const isFace = s => Math.abs(s.od-faceOD)<1e-9;

  const clone = c => c.map(x=>({...x}));
  // ORDER-PRESERVING normalization: merge only CONSECUTIVE identical rows, keep sequence
  // intact (order is physical — a narrow "pivot" shim above a wider one makes a crossover).
  const norm = c => {
    const out=[];
    for(const s of c){
      const last=out[out.length-1];
      if(last && Math.abs(last.od-s.od)<1e-9 && Math.abs(last.thk-s.thk)<1e-9) last.count+=s.count;
      else out.push({count:s.count, od:s.od, thk:s.thk});
    }
    return out;
  };
  // the piston-contacting shim (row 0) must be the port-covering face OD; keep it there
  const ensureFace = c => {
    let cc = clone(c);
    if(cc.length && isFace(cc[0])) return cc;
    const fi = cc.findIndex(isFace);
    if(fi>0){ const [f]=cc.splice(fi,1); cc.unshift(f); }
    else if(fi<0){ const ths=thksFor(faceOD); cc.unshift({count:1,od:faceOD,thk:ths[0]}); }
    return cc;
  };
  const prep = c => norm(ensureFace(c));
  const sig = c => prep(c).map(s=>`${s.count}x${s.od.toFixed(3)}x${s.thk.toFixed(4)}`).join('>'); // order-sensitive

  const cache = new Map();
  const BUDGET = 2400;
  function evalStack(c){
    const cn = prep(c);
    if(faceCnt(cn) < 1 || !isFace(cn[0])) return null; // ports must be covered by the contacting shim
    const rows = cn.map(s=>({count:s.count, diam:s.od*IN, thickness:s.thk*IN, float:0}));
    let stack;
    try{ stack = buildStack(rows, geom, mech, {Fmax, nSteps:55, nSeg:110}); }
    catch(e){ return null; }
    let se=0;
    for(const u of evalVels){ const r=solveForceAtVelocity(Math.max(u,0.01), stack, geom, fluid, valveType, Fmax); const d=r.F-tgtF(u); se+=d*d; }
    const err = Math.sqrt(se/evalVels.length);
    const hMM = cn.reduce((s,x)=> s + x.count*x.thk*IN, 0);
    return {err, hMM, rows:cn};
  }
  function ev(c){ const k=sig(c); if(cache.has(k)) return cache.get(k); const e=evalStack(c); cache.set(k,e); return e; }
  function score(e){
    if(!e) return Infinity;
    let pen=0;
    const under = Href - e.hMM;
    if(under > 1e-4) pen += 8*under;                     // never go under the reference
    else { const overBand = e.hMM - (Href+tolOver); if(overBand>0) pen += 3*overBand; } // mild if too thick
    return e.err + pen*meanTgt;                          // scale mm penalty into force units
  }
  // Neighborhood now explores ORDER (crossover/pivot arrangements), not just a taper:
  // per-row thickness/OD/count edits, swap adjacent shims, and insert a catalog shim at
  // several positions behind the face. The face shim (row 0) keeps its port-covering OD.
  function neighbors(c){
    const cc = prep(c);
    const out=[];
    const fc = faceCnt(cc);
    cc.forEach((s,i)=>{
      thksFor(s.od).forEach(t=>{ if(Math.abs(t-s.thk)>1e-9){ const n=clone(cc); n[i]={...s,thk:t}; out.push(n);} });
      // OD change: allowed on any non-face row (i>=1) — this is how a pivot/crossover forms
      if(i>=1){ ODS.forEach(od=>{ if(Math.abs(od-s.od)>1e-9){ const ths=thksFor(od); const nt=ths.some(t=>Math.abs(t-s.thk)<1e-9)?s.thk:nearest(ths,s.thk); const n=clone(cc); n[i]={...s,od,thk:nt}; out.push(n);} }); }
      if(s.count<8){ const n=clone(cc); n[i]={...s,count:s.count+1}; out.push(n); }
      if(s.count>1){ const n=clone(cc); n[i]={...s,count:s.count-1}; out.push(n); }
      else if(i>=1){ out.push(clone(cc).filter((_,j)=>j!==i)); } // remove a non-face row
      if(i>=1 && i<cc.length-1){ const n=clone(cc); const t=n[i]; n[i]=n[i+1]; n[i+1]=t; out.push(n); } // swap order
    });
    // insert each catalog shim at a few positions behind the face (pivot-behind-face, mid, tail)
    const positions = [...new Set([1, Math.max(1,Math.floor(cc.length/2)), cc.length])];
    catalog.forEach(s=>{ positions.forEach(p=>{ const n=clone(cc); n.splice(p,0,{count:1,od:s.od,thk:s.thk}); out.push(n); }); });
    return out;
  }
  function climb(start){
    let cur=prep(start), curS=score(ev(cur)), guard=0;
    while(guard++ < 60){
      let best=null, bestS=curS;
      for(const n of neighbors(cur)){
        if(cache.size>BUDGET) break;
        const s=score(ev(n));
        if(s < bestS - 1e-9){ bestS=s; best=n; }
      }
      if(!best || cache.size>BUDGET) break;
      cur=prep(best); curS=bestS;
    }
    return cur;
  }

  const startCand0 = ensureFace(readRows().map(r=>({count:r.count, od:r.diam/IN, thk:canonThk(r.thickness/IN)}))
                    .filter(s=>s.od>=v.odMin-1e-9 && s.od<=v.odMax+1e-9));
  if(prep(startCand0).length<2){ document.getElementById('optStatus').textContent='Load a stock tune for this valve first.'; return; }

  climb(startCand0);                                                    // from the current stack, in its real order
  if(cache.size<BUDGET) climb(ensureFace([startCand0[0], ...startCand0.slice(1).sort((a,b)=>b.od-a.od)])); // a plain-taper seed
  // structured seed: a small pivot behind the face — biases toward crossover-shaped optima
  if(cache.size<BUDGET){ const ths=thksFor(ODS[0]); climb(ensureFace([startCand0[0], {count:1,od:ODS[0],thk:ths[0]}, ...startCand0.slice(1)])); }
  for(let r=0;r<4 && cache.size<BUDGET;r++){                            // perturbed restarts for diversity
    const pert = clone(startCand0);
    for(let k=0;k<2;k++){                                               // perturb two rows for a bigger jump
      const j = 1 + Math.floor(Math.random()*Math.max(1,pert.length-1));
      if(pert[j]){ const ths = thksFor(pert[j].od); pert[j].thk = ths[Math.floor(Math.random()*ths.length)]; pert[j].count = Math.max(1, pert[j].count + (Math.random()<0.5?-1:1)); }
    }
    climb(pert);
  }

  // rank all evaluated feasible stacks by the (coarse) search score, keep the distinct top set
  const ranked = [...cache.entries()]
    .filter(([k,e])=>e)
    .map(([k,e])=>({sig:k, e, s:score(e)}))
    .sort((a,b)=> a.s-b.s);
  const seen=new Set(), shortlist=[];
  for(const r of ranked){ if(seen.has(r.sig)) continue; seen.add(r.sig); shortlist.push(r); if(shortlist.length>=18) break; }

  // re-evaluate the shortlist at FULL resolution so coarse search speed doesn't cost accuracy
  const nPts = Math.max(6, parseInt(document.getElementById('nPts').value)||26);
  const uMax = convVel(parseFloat(document.getElementById('uMax').value), resultUnit, 'mm');
  const scored = shortlist.map(r=>{
    const rowsMM = r.e.rows.map(s=>({count:s.count, diam:s.od*IN, thickness:s.thk*IN, float:0}));
    let stack; try{ stack = buildStack(rowsMM, geom, mech, {Fmax, nSteps:150, nSeg:350}); }catch(err){ return null; }
    let se=0; for(const u of evalVels){ const res=solveForceAtVelocity(Math.max(u,0.01),stack,geom,fluid,valveType,Fmax); const dd=res.F-tgtF(u); se+=dd*dd; }
    const err = Math.sqrt(se/evalVels.length);
    const curve=[];
    for(let i=0;i<nPts;i++){ const frac=i/(nPts-1); const u=uMax*Math.pow(frac,1.8); const res=solveForceAtVelocity(Math.max(u,0.01),stack,geom,fluid,valveType,Fmax); curve.push({u, F:res.F}); }
    curve[0]={u:0,F:0};
    return { rows:r.e.rows, hMM:r.e.hMM, err, score: err + Math.max(0, Href-r.e.hMM>1e-4?8*(Href-r.e.hMM):Math.max(0,r.e.hMM-(Href+tolOver))*3)*meanTgt, curve };
  }).filter(Boolean).sort((a,b)=> a.score-b.score);

  // DIVERSITY: don't show three near-identical stacks. Greedily pick the best, then the
  // next that differs by at least a few shims (count-vector L1 distance), etc.
  const stackDist = (a,b)=>{
    const m = new Map();
    a.rows.forEach(s=>{ const k=s.od.toFixed(3)+'|'+s.thk.toFixed(4); m.set(k,(m.get(k)||0)+s.count); });
    b.rows.forEach(s=>{ const k=s.od.toFixed(3)+'|'+s.thk.toFixed(4); m.set(k,(m.get(k)||0)-s.count); });
    let d=0; m.forEach(v=> d+=Math.abs(v)); return d;
  };
  const pickDiverse = (minD)=>{
    const ch=[];
    for(const c of scored){ if(ch.every(x=> stackDist(x,c)>=minD)){ ch.push(c); if(ch.length>=3) break; } }
    return ch;
  };
  let finals = pickDiverse(4);
  if(finals.length<3) finals = pickDiverse(2);
  if(finals.length<3){ const extra = scored.filter(c=>!finals.includes(c)); finals = finals.concat(extra).slice(0,3); }

  optCandidates = finals.map((r,idx)=>{
    const flag = r.hMM < Href-1e-4 ? 'under' : (r.hMM > Href+tolOver+1e-4 ? 'over' : 'in-band');
    return { label:`Opt ${idx+1}`, color:OPT_COLORS[idx%OPT_COLORS.length], rows:r.rows, err:r.err, hMM:r.hMM, flag, curve:r.curve };
  });

  renderOptResults(Href, tolOver);
  drawForceCurve();
  document.getElementById('optStatus').textContent = `searched ${cache.size} stacks · showing ${optCandidates.length} distinct options`;
}

function renderOptResults(Href, tolOver){
  const box = document.getElementById('optResults'); if(!box) return;
  if(!optCandidates.length){ box.innerHTML=''; return; }
  const uf = resultUnit==='mm'?'N':'lbf';
  const rowsTxt = rows => rows.map(s=>`${s.count}×${s.od.toFixed(3)}″/${s.thk.toFixed(4)}″`).join('  ');
  const flagChip = f => f==='in-band'
      ? `<span style="color:var(--accent2)">✓ in-band</span>`
      : (f==='under' ? `<span style="color:var(--warn)">▼ under height</span>` : `<span style="color:#e08e0b">▲ over height</span>`);
  box.innerHTML = `<p class="hint" style="margin:2px 0;">Reference height ${(Href).toFixed(3)}mm (allowed up to +${tolOver.toFixed(2)}mm, never under). Suggestions use only real FOX parts for this valve:</p>` +
    optCandidates.map((c,i)=>`
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; border:1px solid var(--line); border-radius:8px; padding:6px 8px; margin-bottom:5px;">
        <span class="sw" style="width:12px;height:12px;border-radius:2px;background:${c.color};flex:none;"></span>
        <b style="font-size:12.5px;">${c.label}</b>
        <span class="hint" style="margin:0;">fit ${fmtForce(convForce(c.err,'mm',resultUnit),resultUnit)} ${uf} RMS · height ${c.hMM.toFixed(3)}mm ${flagChip(c.flag)}</span>
        <span style="flex:1"></span>
        <span class="hint" style="margin:0; font-family:ui-monospace,monospace;">${rowsTxt(c.rows)}</span>
        <button class="small" onclick="applyCandidate(${i})">Apply to stack</button>
      </div>`).join('');
}

function applyCandidate(i){
  const c = optCandidates[i]; if(!c) return;
  loadingStock = true; // building the stack — don't let it flag itself
  document.getElementById('shimBody').innerHTML='';
  setFieldValueAndUnit('stackID', 0.252, 'in');
  c.rows.forEach(s=> addShimRow(s.count, s.od, s.thk, 'in', null, 0));
  loadingStock = false;
  // an applied optimizer suggestion isn't a named stock tune — mark the tune selector custom
  const stockNote = stockTuneInfo ? ` (from ${stockTuneInfo.label})` : '';
  stockRowsSig = null;
  setTuneSelCustom(true);
  document.getElementById('presetNote').innerHTML = `<b>✏️ Custom</b> — optimizer suggestion ${c.label}${stockNote} applied.`;
  document.getElementById('optStatus').textContent = `applied ${c.label} — edit freely or pin it to compare`;
  scheduleLiveCalc();
}

function clearSuggestions(){
  optCandidates = [];
  renderOptResults(0,0);
  document.getElementById('optStatus').textContent='';
  drawForceCurve();
}

function fillTable(){
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML='';
  const altUnit = resultUnit==='mm' ? 'in' : 'mm';
  currentResults.forEach(p=>{
    const uDisp = convVel(p.u,'mm',resultUnit);
    const uAlt = convVel(p.u,'mm',altUnit);
    const FDisp = convForce(p.F,'mm',resultUnit);
    const coeff = uDisp>0 ? FDisp/uDisp : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtVel(uDisp,resultUnit)}</td><td>${fmtVel(uAlt,altUnit)}</td><td>${fmtForce(FDisp,resultUnit)}</td><td>${coeff.toFixed(4)}</td><td>${p.Re.toFixed(0)}</td>`;
    tbody.appendChild(tr);
  });
}

/* =========================================================
   SAVE / LOAD / EXPORT  (files always store canonical mm/N/MPa values)
   ========================================================= */
function gatherConfig(){
  return {
    geom: readGeom(), mech: readMech(), fluid: readFluid(), valveType: readValveType(),
    fMax: convForce(parseFloat(document.getElementById('fMax').value), resultUnit, 'mm'),
    uMax: convVel(parseFloat(document.getElementById('uMax').value), resultUnit, 'mm'),
    nPts: document.getElementById('nPts').value, rows: readRows()
  };
}
function saveConfig(){
  const cfg = gatherConfig();
  const blob = new Blob([JSON.stringify(cfg,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shim-stack-config.json';
  a.click();
}
function loadConfig(evt){
  const file = evt.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const cfg = JSON.parse(e.target.result); // canonical mm/N/MPa
      setFieldValueAndUnit('dRod', fmtLen(cfg.geom.dRod,'mm'), 'mm');
      setFieldValueAndUnit('dValve', fmtLen(cfg.geom.dValve,'mm'), 'mm');
      setFieldValueAndUnit('rPort', fmtLen(cfg.geom.rPort,'mm'), 'mm');
      setFieldValueAndUnit('dPort', fmtLen(cfg.geom.dPort,'mm'), 'mm');
      setFieldValueAndUnit('wPort', fmtLen(cfg.geom.wPort,'mm'), 'mm');
      document.getElementById('nPort').value = cfg.geom.nPort;
      setFieldValueAndUnit('dThrt', fmtLen(cfg.geom.dThrt,'mm'), 'mm');
      document.getElementById('nThrt').value = cfg.geom.nThrt;
      setFieldValueAndUnit('stackID', fmtLen(cfg.geom.stackID,'mm'), 'mm');
      setFieldValueAndUnit('clampDia', fmtLen(cfg.geom.clampDia!=null?cfg.geom.clampDia:cfg.geom.stackID,'mm'), 'mm');
      setFieldValueAndUnit('eMod', Math.round(cfg.mech.E), 'MPa');
      document.getElementById('nu').value = cfg.mech.nu;
      document.getElementById('rho').value = cfg.fluid.rho;
      document.getElementById('cd').value = cfg.fluid.Cd;
      document.getElementById('cst40').value = cfg.fluid.cSt40;
      document.getElementById('cst100').value = cfg.fluid.cSt100;
      document.getElementById('oilTemp').value = cfg.fluid.tempC;
      document.getElementById('re0').value = cfg.fluid.Re0;
      document.getElementById('viscMode').value = 'direct';
      onViscModeChange();
      document.getElementById('valveType').value = cfg.valveType;
      resultUnit = 'mm';
      document.getElementById('resultUnit').value = 'mm';
      document.querySelectorAll('.uforce').forEach(el=> el.textContent='N');
      document.querySelectorAll('.uvel').forEach(el=> el.textContent='mm/s');
      document.querySelectorAll('.ulen').forEach(el=> el.textContent='mm');
      document.getElementById('fMax').value = fmtForce(cfg.fMax,'mm');
      document.getElementById('uMax').value = fmtVel(cfg.uMax,'mm');
      document.getElementById('nPts').value = cfg.nPts;
      clearPresetSelection();
      document.getElementById('shimBody').innerHTML='';
      cfg.rows.forEach(r=> addShimRow(r.count, fmtLen(r.diam,'mm'), fmtLen(r.thickness,'mm'), 'mm', null, fmtLen(r.float||0,'mm')));
      showWarn(null);
      scheduleLiveCalc();
    }catch(err){ showWarn('Could not read that file: '+err.message); }
  };
  reader.readAsText(file);
  evt.target.value = '';
}
function exportCSV(){
  if(!currentResults.length){ showWarn('Run a calculation first.'); return; }
  const altUnit = resultUnit==='mm' ? 'in' : 'mm';
  const vLabel = resultUnit==='mm'?'mm_s':'in_s', vAltLabel = altUnit==='mm'?'mm_s':'in_s';
  const fLabel = resultUnit==='mm'?'N':'lbf';
  let csv = `shaft_velocity_${vLabel},shaft_velocity_${vAltLabel},damping_force_${fLabel},damping_coeff_${fLabel}_s_per_${resultUnit==='mm'?'mm':'in'},reynolds\n`;
  currentResults.forEach(p=>{
    const uDisp = convVel(p.u,'mm',resultUnit);
    const uAlt = convVel(p.u,'mm',altUnit);
    const FDisp = convForce(p.F,'mm',resultUnit);
    const coeff = uDisp>0 ? FDisp/uDisp : 0;
    csv += `${uDisp.toFixed(4)},${uAlt.toFixed(4)},${FDisp.toFixed(4)},${coeff.toFixed(5)},${p.Re.toFixed(1)}\n`;
  });
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'damping-force-curve.csv';
  a.click();
}

/* =========================================================
   PERSISTENCE (browser localStorage) — valve setups, panel collapse, tile layout.
   All guarded: if storage is unavailable (some browsers restrict it for file:// pages),
   every feature degrades gracefully to "works for this session only".
   ========================================================= */
function lsGet(key){ try{ const v = localStorage.getItem(key); return v===null ? null : JSON.parse(v); }catch(e){ return null; } }
function lsSet(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); return true; }catch(e){ return false; } }

/* ---- named valve-dimension setups ---- */
const VS_KEY = 'sst_valveSetups_v1';
function refreshValveSetupList(selectName){
  const sel = document.getElementById('valveSetups');
  const setups = lsGet(VS_KEY) || {};
  sel.innerHTML = '<option value="" selected disabled>saved valve setups…</option>';
  Object.keys(setups).sort().forEach(name=>{
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  });
  if(selectName && setups[selectName]) sel.value = selectName;
}
function saveValveSetup(){
  const nameEl = document.getElementById('valveSetupName');
  const selEl = document.getElementById('valveSetups');
  const name = (nameEl.value || selEl.value || '').trim();
  if(!name){ document.getElementById('valveSetupHint').textContent = 'Type a name first (or pick an existing setup to overwrite), then press Save setup.'; return; }
  const setups = lsGet(VS_KEY) || {};
  // canonical mm values, same convention as saved config files
  setups[name] = {
    dRod:getFieldMM('dRod'), dValve:getFieldMM('dValve'),
    rPort:getFieldMM('rPort'), dPort:getFieldMM('dPort'), wPort:getFieldMM('wPort'),
    nPort:parseFloat(document.getElementById('nPort').value)||0,
    dThrt:getFieldMM('dThrt'), nThrt:parseFloat(document.getElementById('nThrt').value)||0,
    clampDia:getFieldMM('clampDia'),
    valveType: readValveType()
  };
  const ok = lsSet(VS_KEY, setups);
  refreshValveSetupList(name);
  nameEl.value = '';
  document.getElementById('valveSetupHint').textContent = ok
    ? `Saved "${name}". It will be available next time you open this file in this browser.`
    : `Saved "${name}" for this session — but this browser is blocking storage for local files, so it won't survive closing the page.`;
}
function loadValveSetup(name){
  const setups = lsGet(VS_KEY) || {};
  const s = setups[name];
  if(!s) return;
  setFieldValueAndUnit('dRod', fmtLen(s.dRod,'mm'), 'mm');
  setFieldValueAndUnit('dValve', fmtLen(s.dValve,'mm'), 'mm');
  setFieldValueAndUnit('rPort', fmtLen(s.rPort,'mm'), 'mm');
  setFieldValueAndUnit('dPort', fmtLen(s.dPort,'mm'), 'mm');
  setFieldValueAndUnit('wPort', fmtLen(s.wPort,'mm'), 'mm');
  document.getElementById('nPort').value = s.nPort;
  setFieldValueAndUnit('dThrt', fmtLen(s.dThrt,'mm'), 'mm');
  document.getElementById('nThrt').value = s.nThrt;
  if(s.clampDia!=null) setFieldValueAndUnit('clampDia', fmtLen(s.clampDia,'mm'), 'mm');
  document.getElementById('valveType').value = s.valveType;
  document.getElementById('valveSetupHint').textContent = `Loaded "${name}" (values shown in mm).`;
  drawPortFaceDiagram();
  scheduleLiveCalc();
}
function deleteValveSetup(){
  const sel = document.getElementById('valveSetups');
  const name = sel.value;
  if(!name){ document.getElementById('valveSetupHint').textContent = 'Pick a setup in the dropdown first, then press Delete.'; return; }
  const setups = lsGet(VS_KEY) || {};
  delete setups[name];
  lsSet(VS_KEY, setups);
  refreshValveSetupList();
  document.getElementById('valveSetupHint').textContent = `Deleted "${name}".`;
}

/* ---- collapsible + draggable panels, saved layout ---- */
const LAYOUT_KEY = 'sst_layout_v1';
const COLLAPSE_KEY = 'sst_collapsed_v1';
const DEFAULT_LAYOUT = { colLeft:['p-geom','p-stack'], colRight:['p-oil','p-calc'], colBottom:['p-force'] };

function redrawAllVisuals(){
  drawShimRefDiagram();
  drawPortFaceDiagram();
  if(currentStack){ drawStackAtSlider(); }
  if(currentResults.length){ drawForceCurve(); }
}
function togglePanel(panel){
  panel.classList.toggle('collapsed');
  const collapsed = [...document.querySelectorAll('.panel.collapsed')].map(p=>p.id).filter(Boolean);
  lsSet(COLLAPSE_KEY, collapsed);
  if(!panel.classList.contains('collapsed')) redrawAllVisuals(); // canvases need a redraw after being display:none
}
function applyCollapsed(){
  const collapsed = lsGet(COLLAPSE_KEY) || [];
  collapsed.forEach(id=>{ const p=document.getElementById(id); if(p) p.classList.add('collapsed'); });
}
function gatherLayout(){
  const ids = col => [...document.getElementById(col).children].map(p=>p.id).filter(Boolean);
  return { colLeft:ids('colLeft'), colRight:ids('colRight'), colBottom:ids('colBottom') };
}
function applyLayout(layout){
  if(!layout) return;
  ['colLeft','colRight','colBottom'].forEach(colId=>{
    const col = document.getElementById(colId);
    (layout[colId]||[]).forEach(pid=>{
      const p = document.getElementById(pid);
      if(p && col) col.appendChild(p);
    });
  });
}
function saveLayout(){ lsSet(LAYOUT_KEY, gatherLayout()); }
function resetLayout(){
  applyLayout(DEFAULT_LAYOUT);
  document.querySelectorAll('.panel.collapsed').forEach(p=>p.classList.remove('collapsed'));
  lsSet(LAYOUT_KEY, DEFAULT_LAYOUT);
  lsSet(COLLAPSE_KEY, []);
  redrawAllVisuals();
}

let dragPanel = null;
function initPanelUX(){
  document.querySelectorAll('.panel[id^="p-"]').forEach(p=>{
    const h2 = p.querySelector('h2');
    if(!h2) return;
    // click header (not the grip) toggles collapse
    h2.addEventListener('click', e=>{
      if(e.target.classList.contains('grip')) return;
      togglePanel(p);
    });
    // grip drags the whole panel
    const grip = h2.querySelector('.grip');
    if(grip){
      grip.setAttribute('draggable','true');
      grip.addEventListener('dragstart', e=>{
        dragPanel = p; p.classList.add('dragging');
        try{ e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed='move'; }catch(err){}
      });
      grip.addEventListener('dragend', ()=>{
        if(dragPanel) dragPanel.classList.remove('dragging');
        dragPanel = null;
        saveLayout();
        redrawAllVisuals();
      });
    }
  });
  document.querySelectorAll('.dropcol').forEach(col=>{
    col.addEventListener('dragover', e=>{
      if(!dragPanel) return;
      e.preventDefault();
      const panels = [...col.querySelectorAll(':scope > .panel:not(.dragging)')];
      let placed = false;
      for(const el of panels){
        const r = el.getBoundingClientRect();
        if(e.clientY < r.top + r.height/2){ col.insertBefore(dragPanel, el); placed = true; break; }
      }
      if(!placed) col.appendChild(dragPanel);
    });
    col.addEventListener('drop', e=> e.preventDefault());
  });
}

// init
document.getElementById('shimBody').addEventListener('input', ()=>{ drawShimRefDiagram(); refreshCustomState(); });
document.getElementById('shimBody').addEventListener('change', ()=>{ drawShimRefDiagram(); refreshCustomState(); });
document.getElementById('stackID').addEventListener('input', drawShimRefDiagram);
document.getElementById('clampDia').addEventListener('input', drawShimRefDiagram);
['rPort','dPort','wPort','nPort','dValve','dRod'].forEach(id=>{
  document.getElementById(id).addEventListener('input', drawPortFaceDiagram);
});

// Live recalculation: any edit to an input/select schedules a debounced solve.
// Listens on document.body — NOT a specific container — so edits keep triggering
// recalcs no matter which column/area a tile has been dragged into. Controls with
// their own handlers (unit switchers, presets, axis, pins, live toggle, slider)
// are excluded so they don't double-fire or recalc needlessly.
(function wireLiveInputs(){
  const SKIP_IDS = ['liveMode','loadFile','forceSlider','bulkUnit','resultUnit',
                    'prodSel','valveSel','tuneSel','valveSetups','valveSetupName','pinName','axisMode','axisMaxF','axisMinF','xAxisMode','axisMaxU'];
  const isLiveTrigger = (t)=>{
    if(!t || (t.tagName!=='INPUT' && t.tagName!=='SELECT')) return false;
    if(SKIP_IDS.includes(t.id)) return false;
    return true;
  };
  ['input','change'].forEach(evt=>{
    document.body.addEventListener(evt, e=>{ if(isLiveTrigger(e.target)) scheduleLiveCalc(); });
  });
})();

initPanelUX();
document.querySelectorAll('details.diagram-box').forEach(det=>{
  det.addEventListener('toggle', ()=>{ if(det.open) redrawAllVisuals(); });
});
applyLayout(lsGet(LAYOUT_KEY));
applyCollapsed();
refreshValveSetupList();
initProductUX();
pinnedCurves = lsGet(PINS_KEY) || [];
renderPinList();
restoreAxisPrefs();
restoreTarget();
(function wireTargetDrag(){
  const cv = document.getElementById('forceCanvas');
  if(!cv) return;
  cv.addEventListener('pointerdown', e=> forceCanvasPointer(e,'down'));
  cv.addEventListener('pointermove', e=> forceCanvasPointer(e,'move'));
  window.addEventListener('pointerup',   e=> forceCanvasPointer(e,'up'));
  if(targetOn) cv.style.touchAction = 'none';
})();
loadExample();
onViscModeChange();
drawPortFaceDiagram();
runCalc({live:true}); // populate outputs immediately on load
window.addEventListener('resize', ()=>{ if(currentStack){ drawStackAtSlider(); drawForceCurve(); } drawShimRefDiagram(); drawPortFaceDiagram(); });

