import { convLen } from './units.js';
import { interpArr, stackGapAt, stackSupportedAt } from './physics.js';
import { setupCanvas, drawAxes, themeColor, isDarkTheme } from './canvas-utils.js';

/* =========================================================
   SHIM STACK BENDING VISUALIZER
   Pure, state-driven: every function here takes the stack/geom/rows it needs as
   arguments rather than reading module-level globals or page-specific DOM (besides the
   canvas element itself, passed in) - so both the main Shim Stack Tuner page and a
   pop-out window can call the exact same drawing code from whatever state they're
   currently synced to.
   ========================================================= */
export const SHIM_PALETTE = [
  { fill: '#c7d6fb', stroke: '#2f6fed' },
  { fill: '#c8ecd9', stroke: '#0f9d58' },
  { fill: '#e6d3f5', stroke: '#8e44ad' },
  { fill: '#ffe3b3', stroke: '#e08e0b' },
  { fill: '#bdeef0', stroke: '#16a3b0' },
  { fill: '#f6c9d0', stroke: '#d1495b' },
  { fill: '#dbe6ff', stroke: '#8fa8e0' },
];
export const CLAMP_COLOR = { fill: '#f4d9a0', stroke: '#b8860b' };

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
export function buildBandsAtForce(Fbase, unit, stack, geom, rows) {
  const profile = stack.profileAt(Fbase); // {rs, ys} in mm
  const aMM = (geom.clampDia && geom.clampDia > 0 ? geom.clampDia : geom.stackID) / 2;
  const shaftMM = (geom.stackID || 0) / 2;
  const engageF = stack.engageF || [];
  function liftAt(r) {
    return interpArr(profile.rs, profile.ys, r);
  }

  let base = 0; // cumulative shim material below
  let cumFloat = 0; // cumulative explicit float gaps below (incl. this row's own gap)
  const bands = [];
  rows.forEach((row, idx) => {
    cumFloat += Math.max(0, row.float || 0);
    const hRow = row.count * row.thickness;
    const yRest = base + cumFloat;
    base += hRow;
    const rOuter = row.diam / 2;
    const pal =
      row.special === 'clamp-row' || row.special === 'nut-row' ? CLAMP_COLOR : SHIM_PALETTE[idx % SHIM_PALETTE.length];
    const engagedNow = Fbase >= (engageF[idx] !== undefined ? engageF[idx] : -Infinity);
    const rs = [],
      yB = [],
      yT = [];
    if (rOuter <= aMM) {
      // Entirely inside the clamp radius (a clamp washer/nut modeled as a regular row,
      // per the D.clamp hint's own advice) — nothing here ever bends by definition, so
      // draw one flat band instead of sampling a curve. It still gets its own color and
      // shape rather than disappearing into an undifferentiated block: that's what let a
      // whole stack vanish when D.clamp was set >= every shim's OD.
      rs.push(convLen(shaftMM, 'mm', unit), convLen(rOuter, 'mm', unit));
      yB.push(convLen(yRest, 'mm', unit), convLen(yRest, 'mm', unit));
      yT.push(convLen(yRest + hRow, 'mm', unit), convLen(yRest + hRow, 'mm', unit));
    } else {
      const N = 50;
      // The material between the shaft and the clamp boundary is clamped rigid (it's what
      // the bending model treats as immovable) but it's still real shim material, so it's
      // drawn flat out to the clamp line rather than leaving a gap at the shaft.
      if (shaftMM < aMM) {
        rs.push(convLen(shaftMM, 'mm', unit));
        yB.push(convLen(yRest, 'mm', unit));
        yT.push(convLen(yRest + hRow, 'mm', unit));
      }
      let runMax = 0; // contact offset carried outward — a plate can't dip back down mid-span
      for (let s = 0; s <= N; s++) {
        const r = aMM + ((rOuter - aMM) * s) / N;
        if (stackSupportedAt(rows, idx, r)) {
          const push = liftAt(r) - stackGapAt(rows, idx, r);
          if (push > runMax) runMax = push;
        }
        rs.push(convLen(r, 'mm', unit));
        yB.push(convLen(yRest + runMax, 'mm', unit));
        yT.push(convLen(yRest + runMax + hRow, 'mm', unit));
      }
    }
    bands.push({
      rs,
      yB,
      yT,
      fill: pal.fill,
      stroke: pal.stroke,
      dashed: row.float > 0 && !engagedNow,
      faded: row.float > 0 && !engagedNow,
      delta: row.type === 'deltaT',
    });
  });

  return {
    bands,
    rLoadDisp: convLen(stack.rLoad, 'mm', unit),
    clampDisp: convLen(aMM, 'mm', unit),
    // The shaft/post the shims are actually threaded onto is sized by the shim ID (the
    // hole in the shims themselves), not D.rod — a separate, unrelated dimension further
    // up the damper at the seal. stackID is meant to stay <= clampDia (per the geometry
    // panel's own hint text), so this normally doesn't overlap the clamp-diameter line.
    shaftDisp: convLen(shaftMM, 'mm', unit),
  };
}

// Derives the stack preview's locked Y-axis scale from the calc's worst case (its max
// configured force) so it can be computed once per calc and reused for every slider
// position, instead of being recomputed from whatever force the slider is currently at -
// see drawStackCanvas() for why that rescaling was the actual bug.
export function computeStackYMaxMM(FmaxMM, stack, geom, rows) {
  const { bands, rLoadDisp } = buildBandsAtForce(FmaxMM, 'mm', stack, geom, rows);
  let yMax = 1e-6;
  bands.forEach((b) => {
    for (let i = 0; i < b.yT.length; i++) {
      if (b.rs[i] <= rLoadDisp) yMax = Math.max(yMax, b.yT[i]);
    }
  });
  // The decorative "clamp" cap drawn above the stack (see drawStackCanvas) isn't real
  // modeled material — any actual clamp/nut shims are already counted via their own bands
  // above — so its reserved height is just a fixed multiple of the tallest shim, same as
  // the fallback drawStackCanvas uses when sizing that cap.
  const tallestShimH = bands.reduce((m, b) => Math.max(m, b.yT[0] - b.yB[0]), 1e-6);
  yMax = Math.max(yMax, yMax + tallestShimH * 1.5);
  return yMax * 1.18;
}

export function drawStackCanvas(cv, bands, rLoad, clampR, shaftR, yMaxLocked, resultUnit) {
  const { ctx, w, h } = setupCanvas(cv);
  // Extra left/top padding vs. the force chart's default (44px/14px) - the dual-unit tick
  // labels here ("2.50mm (0.098in)") are much longer than the shared default's bare numbers.
  const pad = { l: 88, r: 46, t: 20, b: 26 };
  let xMax = Math.max(rLoad, clampR || 0);
  bands.forEach((b) => {
    xMax = Math.max(xMax, b.rs[b.rs.length - 1]);
  });
  // Where THIS force's shim stack currently tops out — the clamp shim is drawn stacked
  // directly above this, like one more (thicker, black) shim on top of the sequence, not
  // off to the side. Grows with force, unlike yMax below - that's the whole fix: this
  // (positioning) stays dynamic, only the axis scale is locked.
  let stackTopY = 1e-6;
  bands.forEach((b) => {
    // Only the physically-loaded span (out to the port edge) counts. Beyond it, the model
    // has no applied moment, so it holds whatever rotation it had at the port and projects
    // a straight line outward — a small rotation carried over a long unsupported rim
    // amplifies into a tip height many times the real, loaded deflection. The tip still
    // draws, just clipped to the plot area below instead of pulling the clamp up with it.
    for (let i = 0; i < b.yT.length; i++) {
      if (b.rs[i] <= rLoad) stackTopY = Math.max(stackTopY, b.yT[i]);
    }
  });
  // Decorative cap only — real clamp/nut rows already get their own band above (see
  // buildBandsAtForce), so this is just a fixed multiple of the tallest shim, not a
  // measurement of any specific row.
  const tallestShimH = bands.reduce((m, b) => Math.max(m, b.yT[0] - b.yB[0]), 1e-6);
  const clampH = tallestShimH * 1.5;
  xMax *= 1.03;
  // Locked to the calc's worst-case (max configured force) state - computed once via
  // computeStackYMaxMM(), not recomputed here from the current bands. If it rescaled with
  // every slider move, the clamp block's fixed real thickness would map to fewer and fewer
  // pixels as force (and yMax) grew, making it visibly shrink even though nothing about it
  // actually changed - that illusion was the reported bug.
  const yMax = yMaxLocked;
  // Tick labels here always show both units - primary (whichever resultUnit currently is)
  // at a fixed 2dp(mm)/3dp(in), with the other unit's equivalent in brackets at its own
  // fixed decimal count - instead of the shared default rule (up to 4dp, no unit shown),
  // which was needlessly precise for these frequently-sub-1mm cross-section values.
  const fmtStackTick = (val) =>
    resultUnit === 'mm'
      ? `${val.toFixed(2)}mm (${convLen(val, 'mm', 'in').toFixed(3)}in)`
      : `${val.toFixed(3)}in (${convLen(val, 'in', 'mm').toFixed(2)}mm)`;
  drawAxes(
    ctx,
    w,
    h,
    pad,
    xMax,
    yMax,
    `radius (${resultUnit === 'mm' ? 'mm' : 'in'})`,
    `cross-section (${resultUnit === 'mm' ? 'mm' : 'in'})`,
    undefined,
    fmtStackTick,
    3, // fewer ticks than the default 5 - these dual-unit labels need more room each
    10, // slightly smaller than the default 11px tick font, same reason
  );
  const X = (r) => pad.l + (w - pad.l - pad.r) * (r / xMax);
  const Y = (y) => h - pad.b - (h - pad.t - pad.b) * (y / yMax);

  // the shaft the shims are threaded onto — always beside the stack, spanning its full
  // height, drawn first so the stack sits in front of it
  if (shaftR > 0) {
    ctx.fillStyle = '#cfd8e3';
    ctx.fillRect(X(0), pad.t, X(Math.min(shaftR, xMax)) - X(0), h - pad.t - pad.b);
    ctx.fillStyle = '#5b6472';
    ctx.font = '11px sans-serif';
    ctx.fillText('shaft', X(0) + 4, pad.t + 12);
  }

  // clamp diameter — a relatively normal (if thicker) shim that never moves, stacked
  // directly on top of the real shims rather than off to the side
  if (clampR > shaftR) {
    ctx.fillStyle = '#111318';
    ctx.fillRect(X(shaftR), Y(stackTopY + clampH), X(clampR) - X(shaftR), Y(stackTopY) - Y(stackTopY + clampH));
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.fillText('clamp', X(shaftR) + 4, Y(stackTopY + clampH / 2) + 4);
  }

  // Now that the axis no longer stretches to fit it, an unloaded overhang tip can run past
  // the top of the plot - clip to the plot rectangle so it crops there instead of drawing
  // over the axis title/labels above.
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  ctx.clip();
  bands.forEach((b) => {
    // one smooth closed polygon per shim: along the bottom edge, back along the top edge
    ctx.beginPath();
    b.rs.forEach((r, i) => {
      const x = X(r),
        y = Y(b.yB[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = b.rs.length - 1; i >= 0; i--) ctx.lineTo(X(b.rs[i]), Y(b.yT[i]));
    ctx.closePath();
    ctx.globalAlpha = b.faded ? 0.55 : 1;
    ctx.fillStyle = b.fill;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = b.stroke;
    ctx.lineWidth = 0.8;
    if (b.dashed) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // delta/triangle shims: hatch the outer half, where only the three lobes carry load
    // (see shimScaleAt in physics.js) — the inner half is still a full disc, unmarked.
    if (b.delta) {
      const n = b.rs.length,
        half = Math.floor(n / 2);
      ctx.save();
      ctx.beginPath();
      for (let i = half; i < n; i++) {
        const x = X(b.rs[i]),
          y = Y(b.yB[i]);
        if (i === half) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= half; i--) ctx.lineTo(X(b.rs[i]), Y(b.yT[i]));
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = b.stroke;
      ctx.lineWidth = 0.7;
      ctx.globalAlpha = 0.75;
      const x0 = X(b.rs[half]),
        x1 = X(b.rs[n - 1]);
      for (let x = x0 - 12; x <= x1 + 12; x += 4) {
        ctx.beginPath();
        ctx.moveTo(x, Y(0));
        ctx.lineTo(x + 12, Y(0) - 14);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  });
  ctx.restore();

  if (clampR > 0) {
    // yellow, not black — a black line would vanish against the black clamp shim above
    ctx.strokeStyle = '#eab308';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(X(clampR), pad.t);
    ctx.lineTo(X(clampR), h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    // the label itself needs more contrast than the line — a darker gold reads fine on
    // the light theme's white canvas, but is nearly invisible on the dark theme's navy one
    ctx.fillStyle = isDarkTheme() ? '#eab308' : '#8a6d1a';
    ctx.font = '11px sans-serif';
    ctx.fillText('clamp dia', X(clampR) + 4, h - pad.b - 4);
  }

  const warnColor = themeColor('--warn', '#c0392b');
  ctx.strokeStyle = warnColor;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(X(rLoad), pad.t);
  ctx.lineTo(X(rLoad), h - pad.b);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = warnColor;
  ctx.font = '11px sans-serif';
  ctx.fillText('port edge', X(rLoad) + 4, pad.t + 12);
}
