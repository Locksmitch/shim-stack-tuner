// Reads a color straight out of the current theme (see theme.css) so canvas drawing -
// which can't use CSS variables directly - stays in sync with the light/dark toggle
// instead of assuming one fixed palette. Falls back to the light-theme value if the
// variable isn't set (e.g. this module under test, with no real <html> element).
export function themeColor(varName, fallback) {
  if (typeof document === 'undefined' || !document.documentElement) return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName);
  return v && v.trim() ? v.trim() : fallback;
}
export function isDarkTheme() {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
}

export function setupCanvas(cv) {
  const ratio = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  cv.width = rect.width * ratio;
  cv.height = rect.height * ratio;
  const ctx = cv.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

// The historical one-size tick-label rule (4dp under 1, 2dp under 10, 0dp otherwise, no unit
// suffix). Exported so callers that need a custom fmtTick for one axis can still fall back to
// this exact formatting for the other (see drawForceCurve() in app.js).
export function defaultTickFmt(val) {
  return val < 1 ? val.toFixed(4) : val.toFixed(val < 10 ? 2 : 0);
}

export function drawAxes(ctx, w, h, pad, xMax, yMax, xLabel, yLabel, yMin, fmtTick, nTicks, tickFontPx) {
  yMin = yMin || 0;
  const fmt = fmtTick || defaultTickFmt;
  const lineColor = themeColor('--line', '#dde1e6');
  const mutedColor = themeColor('--muted', '#5b6472');
  const inkColor = themeColor('--ink', '#1c2430');
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = lineColor;
  ctx.fillStyle = mutedColor;
  ctx.font = '11px sans-serif';
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, h - pad.b);
  ctx.lineTo(w - pad.r, h - pad.b);
  ctx.stroke();
  const nx = nTicks || 5,
    ny = nTicks || 5;
  ctx.font = `${tickFontPx || 11}px sans-serif`;
  for (let i = 0; i <= nx; i++) {
    const x = pad.l + ((w - pad.l - pad.r) * i) / nx;
    const val = (xMax * i) / nx;
    ctx.strokeStyle = lineColor;
    ctx.globalAlpha = 0.5; // gridlines recede behind the main axis line, in either theme
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = mutedColor;
    ctx.fillText(fmt(val, 'x'), x - 8, h - pad.b + 14);
  }
  for (let i = 0; i <= ny; i++) {
    const y = h - pad.b - ((h - pad.t - pad.b) * i) / ny;
    const val = yMin + ((yMax - yMin) * i) / ny;
    ctx.strokeStyle = lineColor;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = mutedColor;
    ctx.fillText(fmt(val, 'y'), 4, y + 3);
  }
  ctx.font = '11px sans-serif';
  ctx.fillStyle = inkColor;
  ctx.fillText(xLabel, w / 2 - 20, h - 4);
  ctx.save();
  ctx.translate(10, h / 2 + 20);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}
