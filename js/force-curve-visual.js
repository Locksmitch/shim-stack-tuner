import { convVel, convForce } from './units.js';
import { setupCanvas, drawAxes, defaultTickFmt, themeColor } from './canvas-utils.js';

/* =========================================================
   DAMPING FORCE vs. SHAFT VELOCITY CHART
   Pure, state-driven: takes every piece of state it needs as arguments (current results,
   pinned comparison curves, optimizer candidates, target curve, axis prefs, which legend
   entries are hidden, which target handle is being dragged) rather than reading
   module-level globals or page-specific DOM (besides the canvas element itself) - so both
   the main Shim Stack Tuner page and a pop-out window can render the identical chart from
   whatever state they're currently synced to.

   Returns { forceChartMap, legendHits } - hit-test data for the CALLER's own pointer
   interaction (dragging target handles, clicking legend entries to hide/show a curve).
   A read-only pop-out mirror can just ignore the return value.
   ========================================================= */
export function drawForceCurve(cv, opts) {
  const {
    resultUnit,
    pinnedCurves,
    currentResults,
    optCandidates,
    targetOn,
    stockCurve,
    targetHandles,
    hiddenCurves,
    dragHandle,
    xMode,
    xFixed,
    mode,
    fixedMax,
    fixedMin,
  } = opts;
  const { ctx, w, h } = setupCanvas(cv);
  const pad = { l: 52, r: 16, t: 14, b: 26 };
  let forceChartMap = null;
  let legendHits = [];

  const curves = [];
  pinnedCurves.forEach((p) => {
    curves.push({
      label: p.name,
      color: p.color,
      width: 1.6,
      dash: [5, 3],
      dots: false,
      pts: p.results.map((q) => ({ u: convVel(q.u, 'mm', resultUnit), F: convForce(q.F, 'mm', resultUnit) })),
    });
  });
  if (currentResults.length) {
    curves.push({
      label: 'current',
      color: '#0f9d58',
      width: 2.2,
      dash: [],
      dots: true,
      pts: currentResults.map((p) => ({ u: convVel(p.u, 'mm', resultUnit), F: convForce(p.F, 'mm', resultUnit) })),
    });
  }
  optCandidates.forEach((c) => {
    curves.push({
      label: c.label,
      color: c.color,
      width: 1.8,
      dash: [2, 3],
      dots: false,
      pts: c.curve.map((p) => ({ u: convVel(p.u, 'mm', resultUnit), F: convForce(p.F, 'mm', resultUnit) })),
    });
  });
  // stock reference + target contribute to scaling and are drawn separately
  const stockPts =
    targetOn && stockCurve
      ? stockCurve.map((p) => ({ u: convVel(p.u, 'mm', resultUnit), F: convForce(p.F, 'mm', resultUnit) }))
      : [];
  const tgtPts =
    targetOn && targetHandles.length
      ? targetHandles.map((hn) => ({ u: convVel(hn.u, 'mm', resultUnit), F: convForce(hn.F, 'mm', resultUnit) }))
      : [];
  if (!curves.length && !tgtPts.length) return { forceChartMap, legendHits };

  // a curve is drawn/scaled only if not hidden (click its legend entry to toggle)
  const vis = (c) => !hiddenCurves.has(c.label);
  const stockHidden = hiddenCurves.has('stock (reference)');
  const visCurves = curves.filter(vis);
  const scaleStock = stockPts.length && !stockHidden;
  const allX = [
    ...visCurves.flatMap((c) => c.pts.map((p) => p.u)),
    ...(scaleStock ? stockPts.map((p) => p.u) : []),
    ...tgtPts.map((p) => p.u),
  ];
  const allYForAuto = [
    ...visCurves.flatMap((c) => c.pts.map((p) => p.F)),
    ...(scaleStock ? stockPts.map((p) => p.F) : []),
    ...tgtPts.map((p) => p.F),
  ];
  const xMax = xMode === 'fixed' && xFixed > 0 ? xFixed : Math.max(1, ...allX) * 1.05;
  let yMin, yMax;
  if (mode === 'fixed' && fixedMax > fixedMin) {
    yMin = fixedMin;
    yMax = fixedMax;
  } else {
    yMin = 0;
    yMax = Math.max(1, ...allYForAuto) * 1.15;
  }

  // Shaft velocity always reads in m/s (2dp) with in/s (3dp) in brackets on this chart,
  // independent of the Metric/Imperial resultUnit toggle (which still governs the Y axis -
  // force - and everything else). `val` arrives in whatever unit resultUnit currently is,
  // since that's still what the chart's own X-axis scale (xMax above) is plotted in.
  const fmtForceChartTick = (val, axis) => {
    if (axis !== 'x') return defaultTickFmt(val);
    const mm = convVel(val, resultUnit, 'mm');
    return `${(mm / 1000).toFixed(2)}m/s (${convVel(mm, 'mm', 'in').toFixed(3)}in/s)`;
  };
  drawAxes(
    ctx,
    w,
    h,
    pad,
    xMax,
    yMax,
    'shaft velocity',
    `damping force (${resultUnit === 'mm' ? 'N' : 'lbf'})`,
    yMin,
    fmtForceChartTick,
    3, // fewer ticks than the default 5 - the m/s(in/s) X labels need more room each
    10, // slightly smaller than the default 11px tick font, same reason
  );
  const X = (u) => pad.l + (w - pad.l - pad.r) * (u / xMax);
  const Y = (F) => h - pad.b - (h - pad.t - pad.b) * ((F - yMin) / (yMax - yMin));
  forceChartMap = { pad, w, h, xMax, yMax, yMin };

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  ctx.clip();

  if (stockPts.length && !stockHidden) {
    ctx.strokeStyle = themeColor('--muted', '#9aa3b0');
    ctx.lineWidth = 1.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    stockPts.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  visCurves.forEach((c) => {
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.width;
    ctx.setLineDash(c.dash);
    ctx.beginPath();
    c.pts.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    if (c.dots) {
      ctx.fillStyle = c.color;
      c.pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(X(p.u), Y(p.F), 2.2, 0, 7);
        ctx.fill();
      });
    }
  });

  if (tgtPts.length) {
    const lineP = [{ u: 0, F: 0 }, ...tgtPts];
    ctx.strokeStyle = '#c026d3';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    lineP.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  ctx.setLineDash([]);

  if (tgtPts.length) {
    tgtPts.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      ctx.fillStyle = i === dragHandle ? '#a21caf' : '#c026d3';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    });
  }

  // legend (top-left) — every entry is clickable to hide/show that line. Hidden ones are
  // greyed and struck through. Hit rectangles are returned for the caller's pointer handler.
  ctx.font = '11px sans-serif';
  let ly = pad.t + 12;
  const inkColor = themeColor('--ink', '#1c2430');
  const legend = curves.map((c) => ({ label: c.label, color: c.color, dash: c.dash }));
  if (stockPts.length)
    legend.unshift({ label: 'stock (reference)', color: themeColor('--muted', '#9aa3b0'), dash: [] });
  if (tgtPts.length) legend.push({ label: 'target', color: '#c026d3', dash: [6, 4], noHide: true });
  legend.forEach((c) => {
    const hidden = hiddenCurves.has(c.label);
    ctx.globalAlpha = hidden ? 0.4 : 1;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(c.dash || []);
    ctx.beginPath();
    ctx.moveTo(pad.l + 8, ly - 3);
    ctx.lineTo(pad.l + 30, ly - 3);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = inkColor;
    const tw = ctx.measureText(c.label).width;
    ctx.fillText(c.label, pad.l + 36, ly);
    if (hidden) {
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l + 36, ly - 3);
      ctx.lineTo(pad.l + 36 + tw, ly - 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!c.noHide) legendHits.push({ label: c.label, x0: pad.l + 4, y0: ly - 12, x1: pad.l + 40 + tw, y1: ly + 4 });
    ly += 15;
  });

  return { forceChartMap, legendHits };
}
