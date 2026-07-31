import { setupCanvas, themeColor } from './canvas-utils.js';
import { waltherViscAt } from './physics.js';

/* =========================================================
   OIL VISCOSITY vs. TEMPERATURE CHART
   Pure, state-driven: takes the two oils' calibration points (and their probe
   temperatures, for the crosshair dots) as arguments rather than reading page-specific
   DOM (besides the canvas element itself) - so both the main Shim Stack Tuner page and a
   pop-out window can render the identical chart from whatever state they're currently
   synced to.
   ========================================================= */
export const OIL_MIN_TEMP = -30,
  OIL_MAX_TEMP = 120;

function viscAt(oil, tempC) {
  return waltherViscAt(oil.t1, oil.v1, oil.t2, oil.v2, tempC);
}

function niceLogTicks(yMin, yMax) {
  const lo = Math.floor(Math.log10(yMin)),
    hi = Math.ceil(Math.log10(yMax));
  const ticks = [];
  for (let p = lo; p <= hi; p++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, p);
      if (v >= yMin * 0.999 && v <= yMax * 1.001) ticks.push(v);
    }
  }
  return ticks;
}

// Returns the plot's scale/geometry ({pad, pw, phh, mx, my, yMin, yMax}) - the caller
// keeps this for its own hover/click hit-testing (probing a temperature by mouse
// position); a read-only pop-out mirror can just ignore the return value.
export function drawOilChart(cv, oil1, oil2, probe1, probe2) {
  const { ctx, w, h } = setupCanvas(cv);
  const pad = { l: 56, r: 16, t: 16, b: 40 };
  const pts1 = [],
    pts2 = [];
  let yMin = Infinity,
    yMax = -Infinity;
  for (let t = OIL_MIN_TEMP; t <= OIL_MAX_TEMP; t += 2) {
    const v1 = viscAt(oil1, t),
      v2 = viscAt(oil2, t);
    pts1.push({ t, v: v1 });
    pts2.push({ t, v: v2 });
    if (isFinite(v1) && v1 > 0) {
      yMin = Math.min(yMin, v1);
      yMax = Math.max(yMax, v1);
    }
    if (isFinite(v2) && v2 > 0) {
      yMin = Math.min(yMin, v2);
      yMax = Math.max(yMax, v2);
    }
  }
  if (!isFinite(yMin) || !isFinite(yMax) || yMin <= 0) {
    yMin = 1;
    yMax = 100;
  }
  yMin = Math.pow(10, Math.floor(Math.log10(yMin)));
  yMax = Math.pow(10, Math.ceil(Math.log10(yMax)));

  const pw = w - pad.l - pad.r,
    phh = h - pad.t - pad.b;
  const mx = (t) => pad.l + ((t - OIL_MIN_TEMP) / (OIL_MAX_TEMP - OIL_MIN_TEMP)) * pw;
  const my = (v) => pad.t + phh - ((Math.log10(v) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * phh;
  const plotState = { pad, pw, phh, mx, my, yMin, yMax };

  const gridColor = themeColor('--line', '#e5e7eb');
  const textColor = themeColor('--muted', '#5b6472');

  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui';
  ctx.fillStyle = textColor;
  for (let t = Math.ceil(OIL_MIN_TEMP / 20) * 20; t <= OIL_MAX_TEMP; t += 20) {
    const x = mx(t);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + phh);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText(t + '°C', x, pad.t + phh + 16);
  }
  niceLogTicks(yMin, yMax).forEach((v) => {
    const y = my(v);
    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + pw, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 0 : 1), pad.l - 6, y + 3);
  });

  ctx.strokeStyle = themeColor('--ink', '#1c2430');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + phh);
  ctx.lineTo(pad.l + pw, pad.t + phh);
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.fillText('Temperature (°C)', pad.l + pw / 2, h - 6);
  ctx.save();
  ctx.translate(14, pad.t + phh / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Kinematic viscosity (cSt, log scale)', 0, 0);
  ctx.restore();

  function drawCurve(pts, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    pts.forEach((p) => {
      if (!isFinite(p.v) || p.v <= 0) {
        started = false;
        return;
      }
      const x = mx(p.t),
        y = my(p.v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  drawCurve(pts1, '#1c91c0');
  drawCurve(pts2, '#d33682');

  function crosshair(t, oil, color) {
    if (!isFinite(t) || t < OIL_MIN_TEMP || t > OIL_MAX_TEMP) return;
    const v = viscAt(oil, t);
    if (!isFinite(v) || v <= 0) return;
    const x = mx(t),
      y = my(v);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + phh);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  crosshair(probe1, oil1, '#1c91c0');
  crosshair(probe2, oil2, '#d33682');

  return plotState;
}
