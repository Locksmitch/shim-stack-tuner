export function setupCanvas(cv) {
  const ratio = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  cv.width = rect.width * ratio;
  cv.height = rect.height * ratio;
  const ctx = cv.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

export function drawAxes(ctx, w, h, pad, xMax, yMax, xLabel, yLabel, yMin) {
  yMin = yMin || 0;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#dde1e6';
  ctx.fillStyle = '#5b6472';
  ctx.font = '11px sans-serif';
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, h - pad.b);
  ctx.lineTo(w - pad.r, h - pad.b);
  ctx.stroke();
  const nx = 5,
    ny = 5;
  for (let i = 0; i <= nx; i++) {
    const x = pad.l + ((w - pad.l - pad.r) * i) / nx;
    const val = (xMax * i) / nx;
    ctx.strokeStyle = '#eef0f3';
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
    ctx.fillStyle = '#5b6472';
    ctx.fillText(val < 1 ? val.toFixed(4) : val.toFixed(val < 10 ? 2 : 0), x - 8, h - pad.b + 14);
  }
  for (let i = 0; i <= ny; i++) {
    const y = h - pad.b - ((h - pad.t - pad.b) * i) / ny;
    const val = yMin + ((yMax - yMin) * i) / ny;
    ctx.strokeStyle = '#eef0f3';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#5b6472';
    ctx.fillText(val < 1 ? val.toFixed(4) : val.toFixed(val < 10 ? 2 : 0), 4, y + 3);
  }
  ctx.fillStyle = '#1c2430';
  ctx.fillText(xLabel, w / 2 - 20, h - 4);
  ctx.save();
  ctx.translate(10, h / 2 + 20);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}
