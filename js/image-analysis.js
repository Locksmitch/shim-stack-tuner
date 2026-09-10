/* =========================================================
   Classical (no-ML, no-library) image analysis for the "measure the port geometry
   from a photo" tool. Given a straight-on photo of a valve/piston face and one real
   dimension (D.valve, the outer diameter), it locates:
     - the piston's circular outer edge  -> pixel->mm scale + center
     - the center rod bore               -> D.rod
     - the through-hole ports             -> r.port / d.port / w.port per port,
                                             clustered into radial groups the caller
                                             labels compression / rebound / throat / ignore
   Everything works on {data, width, height} ImageData-shaped objects (a plain object
   with those fields works too), so it is unit-testable with no DOM. Port geometry is
   handed to computePortGeometryFromOutline() from photo-measure.js - the same function
   the manual trace flow uses - so both paths produce identical r/d/w.port semantics.
   ========================================================= */
import { circleFrom3Points, computePortGeometryFromOutline } from './photo-measure.js';

// ---- pixel helpers -------------------------------------------------------------

export function toGrayLuma({ data, width, height }) {
  const g = new Float32Array(width * height);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) {
    g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return g;
}

// Nearest-neighbour downscale of a gray buffer so the (O(pixels)) component/boundary
// passes stay fast on multi-megapixel phone photos. Returns scale = new/old so the
// caller can map results back to full-image pixel space.
export function downscaleGray(gray, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { gray, w, h, scale: 1 };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      out[y * nw + x] = gray[sy * w + Math.min(w - 1, Math.floor(x / scale))];
    }
  }
  return { gray: out, w: nw, h: nh, scale };
}

// Otsu's method: the gray level that best separates the histogram into two classes.
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] < 0 ? 0 : gray[i] > 255 ? 255 : gray[i] | 0;
    hist[v]++;
  }
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const between = wB * wF * Math.pow(sumB / wB - (sum - sumB) / wF, 2);
    if (between > maxVar) {
      maxVar = between;
      thr = t;
    }
  }
  return thr;
}

// 4-connected component labelling of a binary mask (1 = foreground). Returns the label
// map plus, per component, its area, centroid and bounding box.
export function connectedComponents(binary, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const comps = [];
  const stack = [];
  for (let start = 0; start < binary.length; start++) {
    if (!binary[start] || labels[start] >= 0) continue;
    const id = comps.length;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p / width) | 0;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && binary[p - 1] && labels[p - 1] < 0) ((labels[p - 1] = id), stack.push(p - 1));
      if (x < width - 1 && binary[p + 1] && labels[p + 1] < 0) ((labels[p + 1] = id), stack.push(p + 1));
      if (y > 0 && binary[p - width] && labels[p - width] < 0) ((labels[p - width] = id), stack.push(p - width));
      if (y < height - 1 && binary[p + width] && labels[p + width] < 0)
        ((labels[p + width] = id), stack.push(p + width));
    }
    comps.push({ id, area, centroid: { x: sx / area, y: sy / area }, bbox: { minX, minY, maxX, maxY } });
  }
  return { labels, comps };
}

// The boundary pixels of one labelled component (any pixel of the component touching a
// non-component pixel or the image edge). Unordered - fine for circle fitting and for
// computePortGeometryFromOutline, which only uses per-point radius/angle.
export function componentBoundary(labels, id, width, height) {
  const pts = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (labels[i] !== id) continue;
      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        labels[i - 1] !== id ||
        labels[i + 1] !== id ||
        labels[i - width] !== id ||
        labels[i + width] !== id
      ) {
        pts.push({ x, y });
      }
    }
  }
  return pts;
}

// Angular sort of a point set around a center - a display-only ordered outline. Good
// enough for the star-convex-from-centroid port shapes this tool sees (round, kidney,
// D, sector); the measured geometry never depends on point order.
export function orderContour(points, center) {
  return [...points].sort(
    (a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x),
  );
}

// ---- circle fitting -----------------------------------------------------------

// Kåsa algebraic least-squares circle fit. Fast, closed-form, unbiased enough when the
// points cover most of the arc (which the piston rim does).
export function fitCircleKasa(points) {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let Suu = 0;
  let Svv = 0;
  let Suv = 0;
  let Suuu = 0;
  let Svvv = 0;
  let Suvv = 0;
  let Svuu = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.y - my;
    const uu = u * u;
    const vv = v * v;
    Suu += uu;
    Svv += vv;
    Suv += u * v;
    Suuu += uu * u;
    Svvv += vv * v;
    Suvv += u * vv;
    Svuu += v * uu;
  }
  const det = Suu * Svv - Suv * Suv;
  if (Math.abs(det) < 1e-9) return null;
  const e = 0.5 * (Suuu + Suvv);
  const f = 0.5 * (Svvv + Svuu);
  const uc = (Svv * e - Suv * f) / det;
  const vc = (Suu * f - Suv * e) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (Suu + Svv) / n);
  return { cx: uc + mx, cy: vc + my, r };
}

// RANSAC circle fit: sample 3 boundary points many times, keep the circle with the most
// inliers, then refit (Kåsa) on those inliers. Rejects the port-rim and background edge
// points that a plain least-squares fit would be dragged off by. Deterministic (seeded
// LCG) so tests are stable. `residual` is the inlier RMS as a fraction of the radius.
export function fitCircleRANSAC(points, { iterations = 300, threshold = 2.5, seed = 1 } = {}) {
  if (points.length < 3) return null;
  let rng = seed >>> 0 || 1;
  const rand = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = () => points[(rand() * points.length) | 0];
  let best = null;
  let bestCount = -1;
  for (let it = 0; it < iterations; it++) {
    const c = circleFrom3Points(pick(), pick(), pick());
    if (!c || !isFinite(c.r) || c.r <= 0) continue;
    let count = 0;
    for (const p of points) {
      if (Math.abs(Math.hypot(p.x - c.center.x, p.y - c.center.y) - c.r) < threshold) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  if (!best) return null;
  const inliers = points.filter(
    (p) => Math.abs(Math.hypot(p.x - best.center.x, p.y - best.center.y) - best.r) < threshold,
  );
  const refined = fitCircleKasa(inliers) || { cx: best.center.x, cy: best.center.y, r: best.r };
  let sq = 0;
  for (const p of inliers) {
    const d = Math.hypot(p.x - refined.cx, p.y - refined.cy) - refined.r;
    sq += d * d;
  }
  return {
    cx: refined.cx,
    cy: refined.cy,
    r: refined.r,
    inlierRatio: bestCount / points.length,
    residual: refined.r > 0 ? Math.sqrt(sq / inliers.length) / refined.r : 1,
  };
}

// ---- high-level detection ----------------------------------------------------

// Finds the piston's circular outer edge. If `seed` is given (the caller's dragged circle),
// that is trusted as-is. Otherwise tries the piston as the brighter region and, failing
// that, the darker region; for each takes the largest sensible component and RANSAC-fits a
// circle to its boundary, ignoring boundary points that sit on the image frame (clip
// artefacts when the piston is cropped). Returns the lowest-residual / most-circular fit,
// plus `aspect` (min/max bbox side, < 1 => tilted or cropped), or null when no rim is visible.
export function fitOuterCircle(gray, width, height, seed) {
  if (seed && seed.r > 0) return { cx: seed.cx, cy: seed.cy, r: seed.r, residual: 0, aspect: 1, seeded: true };
  const thr = otsuThreshold(gray);
  const frame = width * height;
  const results = [];
  for (const darkFg of [false, true]) {
    const bin = new Uint8Array(frame);
    for (let i = 0; i < frame; i++) bin[i] = (darkFg ? gray[i] <= thr : gray[i] > thr) ? 1 : 0;
    const { labels, comps } = connectedComponents(bin, width, height);
    if (!comps.length) continue;
    const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
    const bw = big.bbox.maxX - big.bbox.minX + 1;
    const bh = big.bbox.maxY - big.bbox.minY + 1;
    if (big.area < 0.03 * frame) continue;
    // fills the whole frame at very high density => the piston overruns the photo (no edge
    // to fit) or this is the background; the caller falls back to a manual circle.
    if (bw >= 0.985 * width && bh >= 0.985 * height && big.area > 0.9 * frame) continue;
    const boundary = componentBoundary(labels, big.id, width, height);
    const inner = boundary.filter((p) => p.x > 1 && p.y > 1 && p.x < width - 2 && p.y < height - 2);
    const pts = inner.length > 40 ? inner : boundary;
    const fit = fitCircleRANSAC(pts, { threshold: Math.max(2, 0.005 * Math.max(width, height)) });
    if (!fit || !isFinite(fit.r) || fit.r < 0.15 * Math.min(width, height) || fit.r > 1.6 * Math.max(width, height))
      continue;
    results.push({ ...fit, aspect: Math.min(bw, bh) / Math.max(bw, bh) });
  }
  if (!results.length) return null;
  results.sort((a, b) => a.residual + (1 - a.aspect) - (b.residual + (1 - b.aspect)));
  return results[0];
}

// All dark through-holes strictly inside the (slightly shrunk) outer circle: threshold
// dark, label, drop specks. Returns the label map (so callers can pull per-hole
// boundaries) and the surviving components.
export function detectHoles(gray, width, height, circle) {
  const thr = otsuThreshold(gray);
  const bin = new Uint8Array(width * height);
  const rIn2 = Math.pow(circle.r * 0.985, 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - circle.cx;
      const dy = y - circle.cy;
      if (dx * dx + dy * dy > rIn2) continue;
      const i = y * width + x;
      bin[i] = gray[i] <= thr ? 1 : 0;
    }
  }
  const { labels, comps } = connectedComponents(bin, width, height);
  const minArea = Math.max(12, 0.00012 * width * height);
  const holes = comps.filter((c) => {
    if (c.area < minArea) return false;
    const w = c.bbox.maxX - c.bbox.minX + 1;
    const h = c.bbox.maxY - c.bbox.minY + 1;
    return w < 0.6 * circle.r * 2 && h < 0.6 * circle.r * 2; // a ring of shadow isn't a port
  });
  return { labels, holes };
}

// 1-D clustering of ports by radius-from-center: sort, split at gaps that dwarf the
// typical spacing. Two concentric port rings -> two groups; a ring of tiny round holes
// separates out too. Each group carries mean radius / area / roundness for the UI.
export function groupPorts(ports, circle) {
  if (!ports.length) return [];
  const sorted = [...ports].sort((a, b) => a.meanRadius - b.meanRadius);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].meanRadius - sorted[i - 1].meanRadius);
  const medGap = gaps.length ? [...gaps].sort((a, b) => a - b)[gaps.length >> 1] : 0;
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].meanRadius - sorted[i - 1].meanRadius;
    if (gap > Math.max(0.07 * circle.r, 3.5 * medGap)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  groups.push(cur);
  return groups.map((g, i) => {
    const mean = (f) => g.reduce((s, p) => s + f(p), 0) / g.length;
    return {
      id: `g${i}`,
      ports: g,
      meanRadius: mean((p) => p.meanRadius),
      meanArea: mean((p) => p.area),
      roundness: mean((p) => p.roundness),
    };
  });
}

// Ports on a ring are evenly spaced. Estimate the full count from the median angular
// step even if a few ports were missed - never below what was actually found, never
// wildly above.
export function inferPortCount(ports, circle) {
  if (ports.length < 2) return Math.max(1, ports.length);
  const angs = ports.map((p) => Math.atan2(p.centroid.y - circle.cy, p.centroid.x - circle.cx)).sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < angs.length; i++) diffs.push(angs[i] - angs[i - 1]);
  diffs.push(angs[0] + 2 * Math.PI - angs[angs.length - 1]);
  diffs.sort((a, b) => a - b);
  const med = diffs[diffs.length >> 1];
  const n = med > 0.02 ? Math.round((2 * Math.PI) / med) : ports.length;
  return Math.max(ports.length, Math.min(n, ports.length + 6));
}

// The one call app.js makes. `imageData` is the full-resolution photo; analysis runs on
// an internally-downscaled copy and every returned pixel coordinate is mapped back to
// full-image space, so the result drops straight into the manual flow's coordinate model
// (points in the photo's own natural pixels; see photoImageToCanvasPt in app.js).
export function analysePhoto(imageData, dValveMM, srcToNatural = 1, seedCircle = null) {
  if (!(dValveMM > 0)) return { ok: false, warnings: ['Enter D.valve before analysing the photo.'] };
  const grayFull = toGrayLuma(imageData);
  const ds = downscaleGray(grayFull, imageData.width, imageData.height, 1000);
  // `up` maps a detected (downscaled) pixel to the ORIGINAL photo's natural pixel space:
  // srcToNatural covers any pre-downscale the caller applied before handing us imageData.
  const up = srcToNatural / ds.scale;
  const warnings = [];

  const dsSeed = seedCircle ? { cx: seedCircle.cx / up, cy: seedCircle.cy / up, r: seedCircle.r / up } : null;
  const outer = fitOuterCircle(ds.gray, ds.w, ds.h, dsSeed);
  if (!outer) {
    // No rim visible - hand back a centred default so the UI can show a draggable circle.
    const r = 0.46 * Math.min(ds.w, ds.h);
    return {
      ok: false,
      needsCircle: true,
      fallbackCircle: { cx: (ds.w / 2) * up, cy: (ds.h / 2) * up, r: r * up },
      warnings: [
        'Couldn’t find the piston’s outer edge. Drag the 3 dots onto the rim and press “Re-detect”, or use Manual trace mode — the whole piston plus a little margin must be in frame.',
      ],
    };
  }
  const circle = { cx: outer.cx * up, cy: outer.cy * up, r: outer.r * up };
  const mmPerPx = dValveMM / (2 * circle.r);
  if (outer.seeded)
    warnings.push('Measured against the circle you set — drag the dots and Re-detect if the ports look off.');
  else if (outer.residual > 0.03)
    warnings.push('The outer-edge fit is loose — check the dashed circle, or use Adjust / Manual.');
  if (!outer.seeded && outer.aspect < 0.9)
    warnings.push('The valve looks tilted or cropped — measurements may be skewed. Shoot straighter or use Manual.');

  const dsCircle = { cx: outer.cx, cy: outer.cy, r: outer.r };
  const { labels, holes } = detectHoles(ds.gray, ds.w, ds.h, dsCircle);

  // bore = the hole nearest the center
  let bore = null;
  const boreCand = holes
    .map((h) => ({ h, d: Math.hypot(h.centroid.x - dsCircle.cx, h.centroid.y - dsCircle.cy) }))
    .filter((c) => c.d < 0.4 * dsCircle.r)
    .sort((a, b) => a.d - b.d)[0];
  if (boreCand) {
    const bf = fitCircleKasa(componentBoundary(labels, boreCand.h.id, ds.w, ds.h));
    if (bf && isFinite(bf.r) && bf.r > 0) bore = { cx: bf.cx * up, cy: bf.cy * up, r: bf.r * up };
  }
  const dRodMM = bore ? 2 * bore.r * mmPerPx : null;
  const boreRds = bore ? bore.r / up : 0.12 * dsCircle.r;

  const portComps = holes.filter((h) => {
    if (boreCand && h.id === boreCand.h.id) return false;
    const rr = Math.hypot(h.centroid.x - dsCircle.cx, h.centroid.y - dsCircle.cy);
    return rr > boreRds * 1.15 && rr < dsCircle.r * 0.98;
  });
  if (!portComps.length) {
    warnings.push('No ports detected automatically — use Add port or Manual trace mode.');
    return { ok: true, circle, bore, mmPerPx, dRodMM, groups: [], warnings };
  }

  const center = { x: circle.cx, y: circle.cy };
  const ports = portComps.map((h) => {
    const bpts = componentBoundary(labels, h.id, ds.w, ds.h).map((p) => ({ x: p.x * up, y: p.y * up }));
    const radii = bpts.map((p) => Math.hypot(p.x - circle.cx, p.y - circle.cy));
    const cen = { x: h.centroid.x * up, y: h.centroid.y * up };
    return {
      id: h.id,
      centroid: cen,
      area: h.area * up * up,
      meanRadius: (Math.min(...radii) + Math.max(...radii)) / 2,
      boundary: bpts,
      contour: orderContour(bpts, cen),
      geom: computePortGeometryFromOutline(center, mmPerPx, bpts),
      excluded: false,
    };
  });

  const raw = groupPorts(ports, circle);
  const maxGroupArea = raw.reduce((m, g) => Math.max(m, g.meanArea), 0);
  const groups = raw.map((g) => ({
    id: g.id,
    // hint only - the user relabels; a distinctly-small group is likely throat holes
    kind: raw.length > 1 && g.meanArea < 0.4 * maxGroupArea ? 'throat' : 'port',
    meanRadiusMM: g.meanRadius * mmPerPx,
    roundness: g.roundness,
    ports: g.ports,
    suggestedCount: inferPortCount(g.ports, circle),
  }));

  return { ok: true, circle, bore, mmPerPx, dRodMM, groups, warnings };
}
