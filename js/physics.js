function waltherViscosityAt(cSt40, cSt100, tempC) {
  cSt40 = Math.max(cSt40, 1.01);
  cSt100 = Math.max(cSt100, 1.01);
  const T1 = 313.15,
    T2 = 373.15,
    Tq = tempC + 273.15;
  const y1 = Math.log10(Math.log10(cSt40 + 0.7)),
    y2 = Math.log10(Math.log10(cSt100 + 0.7));
  const x1 = Math.log10(T1),
    x2 = Math.log10(T2);
  const B = (y1 - y2) / (x2 - x1);
  const A = y1 + B * x1;
  const yq = A - B * Math.log10(Tq);
  return Math.max(0.5, Math.pow(10, Math.pow(10, yq)) - 0.7);
}

/* =========================================================
   PHYSICS ENGINE (always works in base mm / N / MPa / mm-s)
   ========================================================= */
export function interpArr(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const f = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] + f * (ys[i + 1] - ys[i]);
    }
  }
  return ys[ys.length - 1];
}

// Gap beneath row i at radius r, in table-stacking order: the row's own explicit Float,
// plus the thickness of every row BELOW it that doesn't physically reach out to radius r
// (a narrower shim below leaves an air cavity of its own thickness under this row's
// overhang — the "structural crossover" a wide clamp plate over a small pivot shim makes).
export function stackGapAt(rows, i, r) {
  let g = rows[i].float > 0 ? rows[i].float : 0;
  for (let j = 0; j < i; j++) {
    if (rows[j].diam / 2 < r - 1e-9) g += rows[j].count * rows[j].thickness;
  }
  return g;
}
// Is there anything below row i present at radius r to push on it? Row 0 sits on the
// valve face itself and is loaded directly by fluid pressure, so it always counts.
export function stackSupportedAt(rows, i, r) {
  if (i === 0) return true;
  for (let j = 0; j < i; j++) {
    if (rows[j].diam / 2 >= r - 1e-9) return true;
  }
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
export function buildStack(rows, geom, mech, opts) {
  const nSeg = (opts && opts.nSeg) || 350;
  const nSteps = (opts && opts.nSteps) || 150;
  const Fmax = (opts && opts.Fmax) || 400;

  // The stack bends off the CLAMP diameter (the clamp washer / piston land that pins it
  // rigid), NOT the shim's center hole. Only material outside the clamp radius flexes.
  const a = (geom.clampDia && geom.clampDia > 0 ? geom.clampDia : geom.stackID) / 2;
  const bMax = Math.max(...rows.map((r) => r.diam / 2));
  const rLoad = Math.min(geom.rPort + geom.dPort, bMax);
  const rMax = Math.max(bMax, rLoad);
  const dr = (rMax - a) / nSeg;
  if (dr <= 0) throw new Error('Clamp diameter must be smaller than the largest shim OD.');
  const Eprime = mech.E / (1 - mech.nu * mech.nu);

  // Shims in a real stack are NOT bonded to each other — they slide freely, so each shim
  // bends about its own neutral axis and the stack's bending stiffness at a radius is the
  // SUM OF CUBES of the individual engaged thicknesses, Σ(count·t³) — not the cube of the
  // summed thickness (Σt)³ a welded laminate would give. The difference is huge (factor
  // N² for N identical shims) and it's what makes a few thick shims stiffer than many
  // thin ones of equal total height — e.g. FOX's Rebound MED+ (6× .0045in) is correctly
  // firmer than Rebound LIGHT (9× .0032in), which a bonded model gets backwards.
  // Inter-shim friction would add some stiffness on top of this free-sliding lower bound.
  function cubeSumAt(r, engagedState) {
    let s = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.diam / 2 >= r - 1e-9 && engagedState[i]) s += row.count * Math.pow(row.thickness, 3);
    }
    return s;
  }
  function unitProfile(engagedState) {
    const rs = [],
      cUnit = [];
    let theta = 0,
      y = 0;
    for (let i = 0; i <= nSeg; i++) {
      const r = a + i * dr;
      rs.push(r);
      cUnit.push(y);
      const t3 = cubeSumAt(r, engagedState);
      if (t3 <= 0)
        throw new Error(
          `No always-engaged shim spans radius ${r.toFixed(2)} mm. The widest shim must be a normal bonded one (no Float, and not sitting above narrower shims that make it a floating crossover) so material bridges from the clamp out to the load. If you added a wide shim at the clamp end of the list, move it up toward the valve face (↑) or reduce its OD.`,
        );
      const I = (2 * Math.PI * r * t3) / 12;
      const M = r <= rLoad ? rLoad - r : 0;
      const kappa = M / (Eprime * I);
      theta += kappa * dr;
      y += theta * dr;
    }
    return { rs, cUnit };
  }

  // radial grid (independent of engagement state)
  const rsRef = [];
  for (let i = 0; i <= nSeg; i++) rsRef.push(a + i * dr);

  // per-row gap/support tables on the grid, and initial engagement
  const gapGrid = rows.map((row, i) => rsRef.map((r) => stackGapAt(rows, i, r)));
  const suppGrid = rows.map((row, i) => rsRef.map((r) => stackSupportedAt(rows, i, r)));
  const hasGap = rows.map((row, i) => {
    const reachI = row.diam / 2;
    return rsRef.some((r, k) => r <= reachI + 1e-9 && suppGrid[i][k] && gapGrid[i][k] > 0);
  });
  let engagedState = rows.map((row, i) => !hasGap[i]);

  const dF = Fmax / nSteps;
  let yAccum = rsRef.map(() => 0);
  const Ftab = [0],
    YtabAtLoad = [0];
  const engageLog = [];
  const snapshots = [{ F: 0, y: yAccum.slice() }];

  for (let s = 1; s <= nSteps; s++) {
    const { cUnit } = unitProfile(engagedState);
    for (let i = 0; i < yAccum.length; i++) yAccum[i] += cUnit[i] * dF;
    const F = s * dF;
    for (let i = 0; i < rows.length; i++) {
      if (engagedState[i]) continue;
      const reachI = rows[i].diam / 2;
      for (let k = 0; k < rsRef.length; k++) {
        if (rsRef[k] > reachI + 1e-9) break;
        if (suppGrid[i][k] && gapGrid[i][k] > 0 && yAccum[k] >= gapGrid[i][k]) {
          engagedState[i] = true;
          engageLog.push({ rowIndex: i, F });
          break;
        }
      }
    }
    Ftab.push(F);
    YtabAtLoad.push(interpArr(rsRef, yAccum, rLoad));
    snapshots.push({ F, y: yAccum.slice() });
  }

  function yAtLoad(F) {
    if (F <= 0) return 0;
    const Fend = Ftab[Ftab.length - 1];
    if (F <= Fend) return interpArr(Ftab, YtabAtLoad, F);
    // Beyond the built range: extrapolate with the tangent stiffness at the end of the
    // table (all engagements that will happen within the modeled range have already
    // happened) rather than clamping flat — keeps the force solver's bisection well-behaved
    // if a high shaft velocity needs more force than the "Max stack force" setting.
    const n = Ftab.length;
    const F1 = Ftab[n - 2],
      F2 = Ftab[n - 1],
      Y1 = YtabAtLoad[n - 2],
      Y2 = YtabAtLoad[n - 1];
    const slope = (Y2 - Y1) / (F2 - F1 || 1);
    return Y2 + slope * (F - F2);
  }
  function profileAt(F) {
    F = Math.max(0, Math.min(F, Ftab[Ftab.length - 1]));
    let lo = 0;
    for (let i = 0; i < snapshots.length; i++) {
      if (snapshots[i].F <= F) lo = i;
      else break;
    }
    const hi = Math.min(lo + 1, snapshots.length - 1);
    if (hi === lo) return { rs: rsRef, ys: snapshots[lo].y };
    const f = (F - snapshots[lo].F) / (snapshots[hi].F - snapshots[lo].F || 1);
    const y = snapshots[lo].y.map((v, i) => v + f * (snapshots[hi].y[i] - v));
    return { rs: rsRef, ys: y };
  }

  const engageF = rows.map((r, i) => (hasGap[i] ? Infinity : -Infinity));
  engageLog.forEach((e) => (engageF[e.rowIndex] = e.F));

  return { a, bMax, rLoad, rMax, rs: rsRef, Ftab, YtabAtLoad, yAtLoad, profileAt, engageLog, engageF };
}

export function flowArea(yLift, geom) {
  let A = geom.nPort * (geom.wPort + geom.dPort) * Math.max(yLift, 0);
  if (geom.dThrt > 0 && geom.nThrt > 0) {
    const Athrt = ((geom.nThrt * Math.PI) / 4) * geom.dThrt * geom.dThrt;
    A = Math.min(A, Athrt);
  }
  return A;
}
export function valveArea(geom, valveType) {
  const Ar = (Math.PI / 4) * geom.dRod * geom.dRod;
  const Av = (Math.PI / 4) * geom.dValve * geom.dValve;
  if (valveType === 'base') return Ar;
  if (valveType === 'mainRebound') return Av - Ar;
  return Av;
}
export function pressurizedArea(geom) {
  return geom.nPort * geom.wPort * geom.dPort;
}

export function solveForceAtVelocity(u, stack, geom, fluid, valveType, Fmax) {
  if (u <= 0) return { F: 0, Re: 0 };
  const Avalve = valveArea(geom, valveType);
  const Apress = pressurizedArea(geom);
  const Q = u * 1e-3 * (Avalve * 1e-6);
  const cStAtTemp = waltherViscosityAt(fluid.cSt40, fluid.cSt100, fluid.tempC);
  const mu = cStAtTemp * 1e-6 * fluid.rho; // Pa*s

  let lastRe = 0;
  function Fcomputed(F) {
    const y = stack.yAtLoad(F);
    const Aflow = flowArea(y, geom);
    if (Aflow <= 1e-9) return 1e12;
    const Aflow_m2 = Aflow * 1e-6;
    const vGuess = Q / (fluid.Cd * Aflow_m2);
    const Dh = 2 * (y * 1e-3);
    const Re = Dh > 1e-9 ? (fluid.rho * Math.abs(vGuess) * Dh) / mu : 0;
    const CdUse = Math.max((fluid.Cd * Re) / (Re + fluid.Re0), 0.05 * fluid.Cd);
    lastRe = Re;
    const vActual = Q / (CdUse * Aflow_m2);
    const dP_Pa = 0.5 * fluid.rho * vActual * vActual;
    return (dP_Pa / 1e6) * Apress;
  }
  let lo = 0,
    hi = Fmax,
    guard = 0;
  while (Fcomputed(hi) > hi && guard < 40) {
    hi *= 1.5;
    guard++;
  }
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const resid = Fcomputed(mid) - mid;
    if (Math.abs(resid) < 1e-6 * Math.max(1, mid)) {
      lo = hi = mid;
      break;
    }
    if (resid > 0) lo = mid;
    else hi = mid;
  }
  const F = 0.5 * (lo + hi);
  Fcomputed(F);
  return { F, Re: lastRe };
}
