/* =========================================================
   VALVE-FACE VISION - classical CV, no ML and no libraries (this app runs offline).

   The whole design rests on one observation about the photo the user is asked to take:
   a valve lying on a sheet of white paper. In that picture WHITE IS NEVER VALVE - it is
   either the sheet around it, or the sheet seen THROUGH a hole. Which of the two a white
   pixel is, is a question of topology, not of brightness: the sheet around the valve
   reaches the edge of the frame, a port's white does not. Flood-filling white inwards
   from the frame therefore separates "background" from "hole" exactly, with no per-hole
   threshold, and holes fall out whatever their shape - round, oval, peanut, kidney.

   (The previous version of this file looked for DARK blobs inside the disc as ports.
   That is right for a lit-from-behind or dark-surround shot and wrong for the shot this
   tool actually asks for, which is why it found shadows and missed ports.)

   Pipeline
     1. box-downscale to ~1100px; sample the frame border for the sheet's own colour
     2. paper mask = bright enough AND no more colourful than the sheet (an Otsu split
        clamped against that sheet reference, nudged by the UI's sensitivity slider)
     3. flood-fill the mask from the border -> the outside sheet; every other paper pixel
        is landlocked -> a through-hole
     4. the valve = the largest connected run of "not outside", so the disc arrives
        already hole-filled
     5. second moments of that disc give centre, tilt direction and foreshortening; an
        affine de-skew maps it back to a circle and every measurement below is taken in
        that undistorted "face space"
     6. radial gradient rays refine the outer radius to sub-pixel. That one number is the
        scale for everything else, so it is taken off the sharpest edge in the picture
        rather than off the threshold, which a soft contact shadow would bias outwards
     7. every landlocked hole is measured: r.inner, r.outer, true area, arc width per
        radial band, perimeter, roundness

   The tuner's port numbers follow directly:
     d.port = r.outer - r.inner
     w.port = area / d.port   <- exactly the radius-averaged arc width (area = the
                                 integral of arc width over radius), which is the right
                                 "average" for a peanut/oval port whose width varies with
                                 radius, AND it makes the solver's pressurised area
                                 N*w*d reproduce the measured open port area exactly.
   ========================================================= */

// ---- buffers ------------------------------------------------------------------

export function toGrayLuma({ data, width, height }) {
  const g = new Float32Array(width * height);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) {
    g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return g;
}

// Box-average (not nearest-neighbour) downscale: averaging whole source blocks knocks
// down sensor noise and JPEG ringing before anything gets thresholded, which matters
// far more here than the couple of ms it costs.
export function downscaleRGBA({ data, width, height }, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return { data, width, height, scale: 1 };
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const bx = width / nw;
  const by = height / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * by);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * by)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * bx);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * bx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh, scale };
}

// HSV value/saturation for one RGBA pixel. Value separates "bright as the sheet" from
// "darker than the sheet"; saturation catches a coloured (anodised gold/blue/red) valve
// that happens to be as BRIGHT as the paper but is obviously not paper.
function valueSat(data, i) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  return { v: mx, s: mx > 0 ? (mx - mn) / mx : 0 };
}

function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---- the sheet ----------------------------------------------------------------

// The paper the valve sits on, measured from a band around the frame instead of assumed
// to be 255,255,255 - real sheets photograph warm/cool, shaded and never blown out.
// Medians (not means) so a valve poking into the border band doesn't drag the reference.
export function samplePaperReference({ data, width, height }, band = 0.05) {
  const bw = Math.max(2, Math.round(band * Math.min(width, height)));
  const vs = [];
  const ss = [];
  for (let y = 0; y < height; y++) {
    const edgeRow = y < bw || y >= height - bw;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= bw && x < width - bw) continue;
      const { v, s } = valueSat(data, (y * width + x) * 4);
      vs.push(v);
      ss.push(s);
    }
  }
  return { v: median(vs), s: median(ss), samples: vs.length };
}

// Otsu's method on the value channel: the split that best separates the histogram into
// two classes. Drives the paper threshold so a BRIGHT (bare steel) valve still separates
// from the sheet, where a fixed "x% of paper brightness" rule would swallow it.
export function otsuThreshold(values) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] < 0 ? 0 : values[i] > 255 ? 255 : values[i] | 0;
    hist[v]++;
  }
  const total = values.length;
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

/* One brightness threshold for the whole photo assumes the sheet is lit evenly, and it never
   is - a lamp to one side, or a lightbox under the valve, leaves the far side of the paper
   dimmer than the near side by more than the gap between paper and valve. Then no threshold
   exists that keeps the dim paper OUT of the valve: on a backlit shot the shaded half of the
   sheet joined the silhouette, dragged the rim and the scale with it, and turned a
   square-on valve into "39 degrees of tilt" that was then duly corrected out of it.

   The border of the frame is sheet by assumption (it is already trusted for the colour
   reference), so the lighting across it can be measured and extrapolated: fit a gentle
   quadratic to those border pixels and divide it out. One round of outlier rejection keeps
   something dark intruding at one edge from tipping the fit. */
export function fitIlluminationSurface(values, width, height, band = 0.06) {
  const bw = Math.max(3, Math.round(band * Math.min(width, height)));
  const sx = 2 / width;
  const sy = 2 / height;
  const samples = [];
  const stride = Math.max(1, Math.round(Math.min(width, height) / 400));
  for (let y = 0; y < height; y += stride) {
    const edgeRow = y < bw || y >= height - bw;
    for (let x = 0; x < width; x += stride) {
      if (!edgeRow && x >= bw && x < width - bw) continue;
      samples.push({ u: x * sx - 1, v: y * sy - 1, z: values[y * width + x] });
    }
  }
  if (samples.length < 60) return null;

  const basis = (u, v) => [1, u, v, u * u, u * v, v * v];
  const solve = (pts) => {
    const n = 6;
    const A = Array.from({ length: n }, () => new Float64Array(n + 1));
    for (const p of pts) {
      const b = basis(p.u, p.v);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) A[i][j] += b[i] * b[j];
        A[i][n] += b[i] * p.z;
      }
    }
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
      }
    }
    return Array.from({ length: n }, (_, i) => A[i][n] / A[i][i]);
  };

  let coef = solve(samples);
  if (!coef) return null;
  const evalAt = (c, u, v) => basis(u, v).reduce((s, b, i) => s + b * c[i], 0);
  // drop the darkest outliers (something resting at the frame edge) and fit again
  const resid = samples.map((p) => p.z - evalAt(coef, p.u, p.v));
  const med = median(resid);
  const mad = median(resid.map((r) => Math.abs(r - med))) || 1;
  const keep = samples.filter((p, i) => resid[i] > med - 2.5 * mad);
  if (keep.length > 60) coef = solve(keep) || coef;
  return { coef, sx, sy, at: (x, y) => evalAt(coef, x * sx - 1, y * sy - 1) };
}

// Divide the lighting back out, so a single threshold means the same thing everywhere.
export function flattenIllumination(values, width, height, surface) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const s = surface.at(x, y);
      if (s > 1) {
        sum += s;
        n++;
      }
    }
  }
  if (!n) return values;
  const target = sum / n;
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const s = surface.at(x, y);
      // clamped so a wild extrapolation into a corner cannot blow a pixel up
      const gain = s > 1 ? Math.max(0.5, Math.min(2, target / s)) : 1;
      out[i] = Math.min(255, values[i] * gain);
    }
  }
  return out;
}

// 1 = "this pixel is the sheet" (background OR seen through a hole). `sensitivity` is the
// UI slider: >1 is more willing to call a dim pixel paper (use it when ports read grey
// because the valve is thick and shades its own holes), <1 is stricter (use it when a
// bright valve face is being eaten away).
export function classifyPaper({ data, width, height }, ref, opts = {}) {
  const sensitivity = opts.sensitivity ?? 1;
  const raw = new Float32Array(width * height);
  const sats = new Float32Array(width * height);
  for (let p = 0, i = 0; p < raw.length; p++, i += 4) {
    const { v, s } = valueSat(data, i);
    raw[p] = v;
    sats[p] = s;
  }
  // Flatten the lighting first, so one threshold means the same thing across the whole sheet.
  // Everything downstream uses these levelled values too, so the hole passes inherit it.
  let values = raw;
  let flattened = false;
  if (opts.flatten !== false) {
    const surface = fitIlluminationSurface(raw, width, height);
    if (surface) {
      values = flattenIllumination(raw, width, height, surface);
      flattened = true;
    }
  }
  const refV = flattened ? median(Array.from({ length: 400 }, (_, k) => values[(k * 997) % values.length])) : ref.v;
  // Otsu proposes the split; the sheet reference bounds how far it may wander (a photo
  // that is nearly all paper, or nearly all valve, makes Otsu's split meaningless).
  const base = otsuThreshold(values);
  const guide = Math.max(refV, ref.v);
  const vThr = Math.max(0.3 * guide, Math.min(0.95 * guide, base / Math.max(0.2, sensitivity)));
  const sThr = Math.min(0.92, ref.s + 0.2 * sensitivity + 0.06);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) mask[p] = values[p] >= vThr && sats[p] <= sThr ? 1 : 0;
  return { mask, vThr, sThr, values, flattened };
}

// ---- topology -----------------------------------------------------------------

// Flood-fill the paper mask inward from the frame. What the fill reaches is the sheet
// AROUND the valve; every other paper pixel is landlocked, i.e. sheet seen through a
// hole in the valve. This is the step that makes hole-finding shape-agnostic.
export function floodOutside(paperMask, width, height) {
  const outside = new Uint8Array(width * height);
  const stack = [];
  const push = (i) => {
    if (paperMask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < width * height - width) push(p + width);
  }
  return outside;
}

// Three-class Otsu: the pair of cuts that best separates a histogram into three groups.
// A lit valve face has three brightness populations, not two - shadowed metal, glare-lit
// metal, and the holes - so a single Otsu cut lands between the two halves of the BODY and
// leaves the holes stuck to the bright half. Exhaustive over both cuts: 32k steps, nothing.
export function otsuTwoThresholds(values) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i] < 0 ? 0 : values[i] > 255 ? 255 : values[i] | 0;
    hist[v]++;
  }
  const P = new Float64Array(257);
  const S = new Float64Array(257);
  for (let t = 0; t < 256; t++) {
    P[t + 1] = P[t] + hist[t];
    S[t + 1] = S[t] + t * hist[t];
  }
  const total = P[256];
  if (!total) return [85, 170];
  const cnt = (a, b) => P[b + 1] - P[a];
  const mean = (a, b) => {
    const w = cnt(a, b);
    return w ? (S[b + 1] - S[a]) / w : 0;
  };
  const mT = S[256] / total;
  let best = -1;
  let t1 = 85;
  let t2 = 170;
  for (let a = 0; a < 254; a++) {
    const w0 = cnt(0, a);
    if (!w0) continue;
    const d0 = w0 * Math.pow(mean(0, a) - mT, 2);
    for (let b = a + 1; b < 255; b++) {
      const w1 = cnt(a + 1, b);
      const w2 = cnt(b + 1, 255);
      if (!w1 || !w2) continue;
      const v = d0 + w1 * Math.pow(mean(a + 1, b) - mT, 2) + w2 * Math.pow(mean(b + 1, 255) - mT, 2);
      if (v > best) {
        best = v;
        t1 = a;
        t2 = b;
      }
    }
  }
  return [t1, t2];
}

// A second opinion on where the holes are, thresholded INSIDE the valve instead of against
// the sheet. A deep port photographs grey - the valve shades its own hole - and can read
// darker than the sheet while still being far brighter than the metal around it, which the
// global paper test cannot see. Both candidate cuts are tried and the one yielding more
// genuinely LANDLOCKED regions wins, because the rule that makes this safe is topological,
// not photometric: a bright patch that runs out to the rim is glare, not a hole.
export function detectHolesInDisc(values, width, height, solidLabels, discId, minArea) {
  const inside = [];
  for (let i = 0; i < values.length; i++) if (solidLabels[i] === discId) inside.push(values[i]);
  if (inside.length < 256) return null;
  const insideArr = Float32Array.from(inside);
  const cuts = otsuTwoThresholds(insideArr);

  const bright = new Uint8Array(width * height);
  let best = null;
  for (const thr of cuts) {
    let hiSum = 0;
    let hiN = 0;
    let loSum = 0;
    let loN = 0;
    for (let i = 0; i < insideArr.length; i++) {
      if (insideArr[i] > thr) {
        hiSum += insideArr[i];
        hiN++;
      } else {
        loSum += insideArr[i];
        loN++;
      }
    }
    if (!hiN || !loN) continue;
    for (let i = 0; i < bright.length; i++) bright[i] = solidLabels[i] === discId && values[i] > thr ? 1 : 0;
    const { labels, comps } = connectedComponents(bright, width, height);
    const touches = new Uint8Array(comps.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const id = labels[i];
        if (id < 0) continue;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
          touches[id] = 1;
        } else if (
          solidLabels[i - 1] !== discId ||
          solidLabels[i + 1] !== discId ||
          solidLabels[i - width] !== discId ||
          solidLabels[i + width] !== discId
        ) {
          touches[id] = 1;
        }
      }
    }
    const keep = comps.filter((c) => c.area >= minArea && !touches[c.id]);
    const cand = {
      labels,
      comps: keep,
      contrast: (hiSum / hiN - loSum / loN) / Math.max(1, hiSum / hiN),
      brightFraction: hiN / insideArr.length,
    };
    if (!best || keep.length > best.comps.length) best = cand;
  }
  return best;
}

// Threshold edges leave slivers of "hole" clinging to the real ones. Anything under a tenth
// of the median hole is one of those - a real ring of small bleed holes survives, because
// with several of them the median is small too.
export function dropSpecks(comps) {
  if (comps.length < 3) return comps;
  const cut = 0.1 * median(comps.map((c) => c.area));
  const keep = comps.filter((c) => c.area >= cut);
  return keep.length ? keep : comps;
}

// Spread of hole areas, as a fraction of their mean. Comparing this between two
// segmentations of the SAME photo says which one is fragmenting: real ports arrive in rings
// of near-identical holes, so the segmentation that split one port into a big piece and a
// sliver shows a visibly wider spread than the one that kept it whole.
export function areaDispersion(comps) {
  if (comps.length < 2) return 0;
  const areas = comps.map((c) => c.area);
  const m = areas.reduce((s, a) => s + a, 0) / areas.length;
  if (!(m > 0)) return 0;
  const sd = Math.sqrt(areas.reduce((s, a) => s + (a - m) * (a - m), 0) / areas.length);
  return sd / m;
}

// 4-connected component labelling of a binary mask (1 = foreground), with area, centroid
// and bounding box per component.
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
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
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
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
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
    // Second moments come along almost free here, and they give elongation - the one number
    // that separates a port from a layer line on a 3D-printed face or a machining groove.
    // A bounding box will not do it: those lines often run diagonally, so their boxes are
    // large and square while the line itself is one pixel wide.
    const cx = sx / area;
    const cy = sy / area;
    const mxx = sxx / area - cx * cx;
    const myy = syy / area - cy * cy;
    const mxy = sxy / area - cx * cy;
    const tr = mxx + myy;
    const det = Math.sqrt(Math.max(0, (mxx - myy) * (mxx - myy) + 4 * mxy * mxy));
    const l1 = (tr + det) / 2;
    const l2 = (tr - det) / 2;
    comps.push({
      id,
      area,
      centroid: { x: cx, y: cy },
      bbox: { minX, minY, maxX, maxY },
      elongation: l2 > 1e-9 ? Math.sqrt(l1 / l2) : Infinity,
    });
  }
  return { labels, comps };
}

// Moore-neighbour boundary trace: an ORDERED outline of one component, used for drawing
// the port overlay and for a real perimeter (hence roundness). Ordered tracing beats
// sorting boundary pixels by angle, which silently mangles any port that isn't
// star-convex about its own centroid.
export function traceContour(labels, id, width, height, startIdx) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === id ? 1 : 0);
  const sx = startIdx % width;
  const sy = (startIdx / width) | 0;
  if (!at(sx, sy)) return [];
  // 8 neighbours, clockwise from west
  const N = [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
  ];
  const contour = [{ x: sx, y: sy }];
  let cx = sx;
  let cy = sy;
  let dir = 0;
  const maxSteps = 8 * (width + height) + 64;
  for (let steps = 0; steps < maxSteps; steps++) {
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + k) % 8;
      const nx = cx + N[d][0];
      const ny = cy + N[d][1];
      if (!at(nx, ny)) continue;
      dir = (d + 6) % 8; // resume the search just behind where we came from
      cx = nx;
      cy = ny;
      moved = true;
      break;
    }
    if (!moved) break; // isolated pixel
    if (cx === sx && cy === sy) break;
    contour.push({ x: cx, y: cy });
  }
  return contour;
}

function contourPerimeter(contour) {
  if (contour.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % contour.length];
    p += Math.hypot(a.x - b.x, a.y - b.y);
  }
  return p;
}

// ---- circle / ellipse ---------------------------------------------------------

// Kasa algebraic least-squares circle fit - fast, closed form, accurate when the points
// cover most of the arc (which refined rim points do by construction).
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

// Boundary pixels of one labelled region, thinned to a manageable number of points. Used to
// fit the valve's edge by consensus, where anything dark stuck to the valve gets outvoted.
export function discOutline(labels, id, width, height, maxPoints = 1200) {
  const pts = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (labels[i] !== id) continue;
      if (labels[i - 1] === id && labels[i + 1] === id && labels[i - width] === id && labels[i + width] === id)
        continue;
      pts.push({ x, y });
    }
  }
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out = [];
  for (let k = 0; k < maxPoints; k++) out.push(pts[Math.floor(k * step)]);
  return out;
}

// Second moments of a labelled region -> the equivalent uniform ellipse (centre, semi-
// axes, orientation). Using every pixel of the filled disc rather than its boundary makes
// this a very stable read on HOW the circle is foreshortened, which is what the de-skew
// below needs; the absolute size it reports is not used (refineOuterRadius does that).
export function ellipseFromRegion(labels, id, width, height) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== id) continue;
      n++;
      sx += x;
      sy += y;
    }
  }
  if (n < 16) return null;
  const cx = sx / n;
  const cy = sy / n;
  let mxx = 0;
  let myy = 0;
  let mxy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== id) continue;
      const dx = x - cx;
      const dy = y - cy;
      mxx += dx * dx;
      myy += dy * dy;
      mxy += dx * dy;
    }
  }
  mxx /= n;
  myy /= n;
  mxy /= n;
  // closed-form eigenvalues/vector of the 2x2 covariance
  const tr = mxx + myy;
  const dd = Math.sqrt(Math.max(0, (mxx - myy) * (mxx - myy) + 4 * mxy * mxy));
  const l1 = (tr + dd) / 2;
  const l2 = (tr - dd) / 2;
  if (!(l1 > 0)) return null;
  const phi = 0.5 * Math.atan2(2 * mxy, mxx - myy); // direction of the major axis
  return {
    cx,
    cy,
    a: 2 * Math.sqrt(l1), // semi-major, for a uniform elliptical disc
    b: 2 * Math.sqrt(Math.max(l2, 1e-9)),
    phi,
    area: n,
    axisRatio: Math.sqrt(Math.max(l2, 0) / l1),
  };
}

/* "Face space": the co-ordinate system the valve would have been photographed in had the
   camera been exactly square to it. A circle tilted by angle t projects to an ellipse
   whose MAJOR axis is the true diameter and whose minor axis is foreshortened by cos t,
   so un-squashing the minor axis by 1/q (q = b/a) restores the circle. Every radius,
   angle and area below is computed here, which is what lets a hand-held phone shot that
   is a few degrees off square still measure correctly instead of just being warned about.
   An image pixel covers 1/q of a face-space unit area - see faceAreaPerPx. */
export function makeFaceSpace(center, phi, q) {
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const qq = q > 0 ? q : 1;
  return {
    center,
    phi,
    q: qq,
    faceAreaPerPx: 1 / qq,
    toFace(x, y) {
      const dx = x - center.x;
      const dy = y - center.y;
      return { x: dx * cos + dy * sin, y: (-dx * sin + dy * cos) / qq };
    },
    toImage(u, v) {
      const vv = v * qq;
      return { x: center.x + u * cos - vv * sin, y: center.y + u * sin + vv * cos };
    },
  };
}

function sampleBilinear(gray, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = gray[y0 * width + x0];
  const b = gray[y0 * width + x1];
  const c = gray[y1 * width + x0];
  const d = gray[y1 * width + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// Sub-pixel outer radius: walk rays outward in face space and take the strongest
// brightness step on each. The threshold that built the mask sits wherever the contact
// shadow fades, but the valve/paper EDGE is the sharpest gradient in the frame - and
// since this radius is the pixel->mm scale for every other number, it is worth measuring
// properly rather than inheriting the mask's bias.
export function refineOuterRadius(gray, width, height, face, r0, opts = {}) {
  const rays = opts.rays ?? 360;
  const span = opts.span ?? 0.15;
  const step = opts.step ?? 0.3;
  const rLo = Math.max(1, r0 * (1 - span));
  const rHi = r0 * (1 + span);
  const nS = Math.max(8, Math.floor((rHi - rLo) / step) + 1);

  // Which way does the edge go? Compare well inside the disc with well outside it, so a
  // pale valve on a slightly grey sheet works the same as a black one on bright white.
  let inSum = 0;
  let inN = 0;
  let outSum = 0;
  let outN = 0;
  for (let k = 0; k < 64; k++) {
    const th = (k / 64) * 2 * Math.PI;
    const pi = face.toImage(0.6 * r0 * Math.cos(th), 0.6 * r0 * Math.sin(th));
    const po = face.toImage(1.25 * r0 * Math.cos(th), 1.25 * r0 * Math.sin(th));
    const vi = sampleBilinear(gray, width, height, pi.x, pi.y);
    const vo = sampleBilinear(gray, width, height, po.x, po.y);
    if (isFinite(vi)) ((inSum += vi), inN++);
    if (isFinite(vo)) ((outSum += vo), outN++);
  }
  if (!inN || !outN) return null;
  const polarity = outSum / outN >= inSum / inN ? 1 : -1; // +1 = brighter outside (the usual sheet)

  const prof = new Float64Array(nS);
  const grad = new Float64Array(nS);
  const hits = [];
  const strengths = [];
  for (let k = 0; k < rays; k++) {
    const th = (k / rays) * 2 * Math.PI;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    let ok = true;
    for (let s = 0; s < nS && ok; s++) {
      const t = rLo + s * step;
      const p = face.toImage(t * ct, t * st);
      const v = sampleBilinear(gray, width, height, p.x, p.y);
      if (isFinite(v)) prof[s] = v;
      else ok = false;
    }
    if (!ok) continue; // this ray leaves the photo - skip it rather than guess
    let maxG = 0;
    for (let s = 1; s < nS - 1; s++) {
      grad[s] = polarity * (prof[s + 1] - prof[s - 1]);
      if (grad[s] > maxG) maxG = grad[s];
    }
    if (maxG <= 0) continue;
    // The strongest rise on the ray. Simply taking the maximum is right here because two
    // other guards already cover what would otherwise steal the rim: the +-15% window keeps
    // the port ring out of the search entirely, and the caller only accepts a second,
    // narrower pass if it fits BETTER (a pass that drags rays onto port edges shows up at
    // once as a far worse residual). Cleverer rules were tried - innermost-strong-edge,
    // requiring sheet-brightness beyond the candidate - and both measured worse on real
    // degradations than this does, because they misfire exactly where contrast is poor.
    let best = -1;
    let bestG = 0;
    for (let s = 1; s < nS - 1; s++) {
      if (grad[s] > bestG) {
        bestG = grad[s];
        best = s;
      }
    }
    if (best < 1) continue;
    // Parabola through the three gradient samples straddling the peak: the vertex is the
    // edge to a fraction of a pixel, which is what makes the scale worth trusting.
    let off = 0;
    if (best > 1 && best < nS - 2) {
      const d2 = grad[best - 1] - 2 * grad[best] + grad[best + 1];
      if (Math.abs(d2) > 1e-9) {
        const cand = (0.5 * (grad[best - 1] - grad[best + 1])) / d2;
        if (Math.abs(cand) <= 1) off = cand;
      }
    }
    const tEdge = rLo + (best + off) * step;
    hits.push({ x: tEdge * ct, y: tEdge * st, g: bestG });
    strengths.push(bestG);
  }
  if (hits.length < 24) return null;
  // Drop rays whose edge is weak (glare, a finger, a shadow crossing the rim).
  const medG = median(strengths);
  const keep = hits.filter((h) => h.g >= 0.3 * medG);
  let used = keep.length >= 24 ? keep : hits;
  let fit = fitCircleKasa(used);
  if (!fit || !(fit.r > 0)) return null;
  // ...then throw out rays that disagree with the consensus circle. A hard contact shadow
  // makes the metal/shadow edge vanish on one side, so those rays land on the shadow's outer
  // boundary instead - a one-sided bulge that would otherwise be read as a camera tilt.
  const inliers = used.filter((p) => Math.abs(Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.r) < 0.025 * fit.r);
  if (inliers.length >= 24 && inliers.length < used.length) {
    const refit = fitCircleKasa(inliers);
    if (refit && refit.r > 0) {
      fit = refit;
      used = inliers;
    }
  }
  let sq = 0;
  for (const p of used) {
    const d = Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.r;
    sq += d * d;
  }
  return {
    r: fit.r,
    // the fit's centre is a small correction in face space; hand it back so the caller
    // can re-centre before measuring holes
    dcx: fit.cx,
    dcy: fit.cy,
    residual: Math.sqrt(sq / used.length) / fit.r,
    rays: used.length,
    // the edge points themselves, in IMAGE space - these sit on the true metal/paper edge
    // rather than on a threshold, so they are the honest input to an ellipse fit
    points: used.map((p) => face.toImage(p.x, p.y)),
  };
}

// How much of the way round the rim did we actually get edge points? An ellipse fitted to a
// partial arc is close to meaningless - it will trade axis ratio against the missing side and
// report a confident tilt from nothing - so the de-skew only runs when the rim is covered.
export function rimCoverage(points, center, bins = 36) {
  if (!points || !points.length) return 0;
  const hit = new Uint8Array(bins);
  for (const p of points) {
    const a = Math.atan2(p.y - center.y, p.x - center.x);
    hit[Math.min(bins - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * bins))] = 1;
  }
  return hit.reduce((s, v) => s + v, 0) / bins;
}

// Least-squares ellipse through points about a KNOWN centre: solve for A,B,C in
// A.x^2 + B.xy + C.y^2 = 1 (3x3 normal equations, Gaussian elimination - no matrix library
// needed at this size). Returns the semi-axes and the major axis direction.
export function fitEllipseFixedCenter(points, center, scale = 1) {
  if (!points || points.length < 6) return null;
  let Sxxxx = 0;
  let Sxxxy = 0;
  let Sxxyy = 0;
  let Sxyyy = 0;
  let Syyyy = 0;
  let Sxx = 0;
  let Sxy = 0;
  let Syy = 0;
  for (const p of points) {
    const x = (p.x - center.x) / scale;
    const y = (p.y - center.y) / scale;
    const xx = x * x;
    const yy = y * y;
    const xy = x * y;
    Sxxxx += xx * xx;
    Sxxxy += xx * xy;
    Sxxyy += xx * yy;
    Sxyyy += xy * yy;
    Syyyy += yy * yy;
    Sxx += xx;
    Sxy += xy;
    Syy += yy;
  }
  const M = [
    [Sxxxx, Sxxxy, Sxxyy, Sxx],
    [Sxxxy, Sxxyy, Sxyyy, Sxy],
    [Sxxyy, Sxyyy, Syyyy, Syy],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
    }
  }
  const A = M[0][3] / M[0][0];
  const B = M[1][3] / M[1][1];
  const C = M[2][3] / M[2][2];
  // eigenvalues of [[A, B/2],[B/2, C]]; a semi-axis is 1/sqrt(eigenvalue), so the SMALLER
  // eigenvalue belongs to the MAJOR axis
  const tr = A + C;
  const disc = Math.sqrt(Math.max(0, (A - C) * (A - C) + B * B));
  const l1 = (tr + disc) / 2; // larger  -> minor axis
  const l2 = (tr - disc) / 2; // smaller -> major axis
  if (!(l2 > 0) || !(l1 > 0)) return null;
  const aSemi = scale / Math.sqrt(l2);
  const bSemi = scale / Math.sqrt(l1);
  // eigenvector for l2 (the major axis direction)
  const phi = Math.abs(B) > 1e-12 ? Math.atan2(l2 - A, B / 2) : A <= C ? 0 : Math.PI / 2;
  return { a: aSemi, b: bSemi, phi, axisRatio: bSemi / aSemi };
}

/* Ports don't photograph evenly. The valve has thickness, so with the light even slightly
   off-axis one side of a port is dimmed - by the bore wall, or by the valve's own shadow
   falling on the paper below - while the other side is bright sheet. Any single threshold
   cuts the hole off along that shade line, and the outline visibly hugs the shadow instead
   of the metal edge, which shrinks d.port/w.port on that side.

   So the threshold only has to find a CORE of each hole; this grows that core outward
   through the shading until it reaches metal. The stopping level is judged per hole from
   the body immediately around it (glare varies across a face, a global number would not
   fit every port), and growth is capped so a hole that breaks through into a bright patch
   of body can't run away across the valve. */
export function growHolesIntoShade(values, width, height, labels, comps, inDisc, opts = {}) {
  const capFactor = opts.cap ?? 1.9;
  const bandOuter = opts.band ?? 7;
  /* The stopping rule that actually works is an EDGE, not a brightness level. Set the
     brightness bar low enough to sweep in a shaded side and glare-lit metal clears it too;
     set it high enough to exclude that glare and the shade is lost. There is no level that
     does both, because the shaded part of a hole and the lit part of the face genuinely
     overlap in brightness. What separates them is that a port's rim is a sharp step while
     shading inside the port is a smooth ramp - so growth flows freely down the ramp and
     stops dead at the rim. Glare on the face is smooth too, but unreachable: getting there
     from inside a hole means crossing that rim. */
  const owner = Int32Array.from(labels);
  if (!comps.length) return owner;

  const info = new Map();
  for (const c of comps) info.set(c.id, { area: c.area, cap: c.area * capFactor, vals: [] });
  for (let i = 0; i < owner.length; i++) {
    const id = owner[i];
    if (id >= 0 && info.has(id)) info.get(id).vals.push(values[i]);
  }

  // What does the metal AROUND this hole look like? Sampled by walking out from the hole and
  // keeping the band a few pixels clear of it, because the pixels right at the edge are the
  // shaded ones we are trying to absorb - include them and the reference moves to meet them,
  // and nothing ever grows. A median-absolute-deviation band then says how far a pixel has to
  // sit from that local metal level, in EITHER direction, to be hole rather than face.
  for (const c of comps) {
    const meta = info.get(c.id);
    const ring = [];
    let frontier = [];
    const seen = new Set();
    for (let y = c.bbox.minY; y <= c.bbox.maxY; y++) {
      for (let x = c.bbox.minX; x <= c.bbox.maxX; x++) {
        const i = y * width + x;
        if (owner[i] === c.id) (frontier.push(i), seen.add(i));
      }
    }
    for (let step = 1; step <= bandOuter && frontier.length; step++) {
      const next = [];
      for (const p of frontier) {
        const x = p % width;
        const y = (p / width) | 0;
        const nb = [];
        if (x > 0) nb.push(p - 1);
        if (x < width - 1) nb.push(p + 1);
        if (y > 0) nb.push(p - width);
        if (y < height - 1) nb.push(p + width);
        for (const q of nb) {
          if (seen.has(q) || !inDisc[q]) continue;
          seen.add(q);
          next.push(q);
          if (step >= 3 && owner[q] < 0) ring.push(values[q]);
        }
      }
      frontier = next;
    }
    const m = ring.length ? median(ring) : 0;
    const mad = ring.length ? median(ring.map((v) => Math.abs(v - m))) : 0;
    // Generous enough to take in a shaded side of a port; the roundness check after growth
    // is what stops a hole that finds a way out into the face from keeping the ground.
    const margin = Math.max(8, 3 * mad);
    const core = median(meta.vals);
    meta.floor = Math.min(m + margin, m + 0.35 * Math.max(0, core - m));
    meta.ceil = m - margin;
  }

  let frontier = [];
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) frontier.push(i);
  const grown = new Map(comps.map((c) => [c.id, 0]));
  // Rounds advance the frontier one pixel at a time, so this has to exceed the widest shade
  // strip we expect to swallow; the real brake is the per-hole area cap, not this.
  for (let round = 0; round < (opts.rounds ?? 96) && frontier.length; round++) {
    const next = [];
    for (const p of frontier) {
      const id = owner[p];
      const meta = info.get(id);
      if (!meta || grown.get(id) >= meta.cap - meta.area) continue;
      const x = p % width;
      const y = (p / width) | 0;
      const nb = [];
      if (x > 0) nb.push(p - 1);
      if (x < width - 1) nb.push(p + 1);
      if (y > 0) nb.push(p - width);
      if (y < height - 1) nb.push(p + width);
      for (const q of nb) {
        if (owner[q] >= 0 || !inDisc[q]) continue;
        if (values[q] < meta.floor && values[q] > meta.ceil) continue; // this pixel reads as metal
        owner[q] = id;
        grown.set(id, grown.get(id) + 1);
        next.push(q);
      }
    }
    frontier = next;
  }

  // Growth is only ever meant to restore a shape the threshold clipped, so it should make a
  // hole MORE like a clean port, not less. If it made one markedly raggeder it did not find
  // shade, it found a way out into the face - which is how the centre bore, a circle needing
  // no growth at all, came back half again too wide. Put those back.
  const startOf = (map, id) => {
    for (let i = 0; i < map.length; i++) if (map[i] === id) return i;
    return -1;
  };
  const circularity = (map, id, area) => {
    const s = startOf(map, id);
    if (s < 0 || area <= 0) return 0;
    const per = contourPerimeter(traceContour(map, id, width, height, s));
    return per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
  };
  for (const c of comps) {
    let after = 0;
    for (let i = 0; i < owner.length; i++) if (owner[i] === c.id) after++;
    if (after <= c.area) continue;
    const before = circularity(labels, c.id, c.area);
    if (circularity(owner, c.id, after) >= 0.75 * before) continue;
    for (let i = 0; i < owner.length; i++) if (owner[i] === c.id && labels[i] !== c.id) owner[i] = -1;
  }
  return owner;
}

// ---- per-hole measurement -----------------------------------------------------

// Everything the tuner needs about one hole, measured in face space. Angles are unwrapped
// about the hole's own mean direction so a port straddling the +-pi seam doesn't read as
// a full turn wide.
export function measureHole(labels, id, width, height, face, mmPerPx, opts = {}) {
  const bands = opts.bands ?? 12;
  const px = [];
  let startIdx = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (labels[i] !== id) continue;
      if (startIdx < 0) startIdx = i;
      px.push(face.toFace(x, y));
    }
  }
  if (px.length < 4) return null;
  const radii = px.map((p) => Math.hypot(p.x, p.y));
  const angles = px.map((p) => Math.atan2(p.y, p.x));
  const rInner = Math.min(...radii);
  const rOuter = Math.max(...radii);
  const meanX = angles.reduce((s, a) => s + Math.cos(a), 0);
  const meanY = angles.reduce((s, a) => s + Math.sin(a), 0);
  const meanAngle = Math.atan2(meanY, meanX);
  const rel = angles.map((a) => {
    let d = a - meanAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  });
  const angularSpan = Math.max(...rel) - Math.min(...rel);

  const areaFacePx = px.length * face.faceAreaPerPx;
  const areaMM = areaFacePx * mmPerPx * mmPerPx;
  const dPort = (rOuter - rInner) * mmPerPx;
  // w.port from area/depth: area is the integral of arc width over radius, so this IS the
  // radius-averaged width - the honest single number for a peanut port that is fat in the
  // middle and pinched at both ends.
  const wPort = dPort > 1e-9 ? areaMM / dPort : 0;

  // Arc width per radial band, purely so the UI can show how much the port tapers and
  // the user can sanity-check the average against the picture.
  const profile = [];
  const bandW = (rOuter - rInner) / bands;
  if (bandW > 0) {
    for (let k = 0; k < bands; k++) {
      const lo = rInner + k * bandW;
      const hi = lo + bandW;
      let mn = Infinity;
      let mx = -Infinity;
      let n = 0;
      for (let i = 0; i < px.length; i++) {
        if (radii[i] < lo || radii[i] > hi) continue;
        n++;
        if (rel[i] < mn) mn = rel[i];
        if (rel[i] > mx) mx = rel[i];
      }
      profile.push(n > 1 ? (mx - mn) * ((lo + hi) / 2) * mmPerPx : 0);
    }
  }
  const live = profile.filter((w) => w > 0);

  const contourPx = startIdx >= 0 ? traceContour(labels, id, width, height, startIdx) : [];
  const perimFace = contourPerimeter(contourPx.map((p) => face.toFace(p.x, p.y)));
  const roundness = perimFace > 0 ? Math.min(1, (4 * Math.PI * areaFacePx) / (perimFace * perimFace)) : 0;

  const rMid = ((rInner + rOuter) / 2) * mmPerPx;
  return {
    id,
    // geometry the tuner consumes
    rPort: rInner * mmPerPx,
    dPort,
    wPort,
    // shape/diagnostics
    rOuterMM: rOuter * mmPerPx,
    rMidMM: rMid,
    areaMM,
    perimeterMM: perimFace * mmPerPx,
    roundness,
    angularSpan,
    equivDiaMM: 2 * Math.sqrt(areaMM / Math.PI),
    widthInner: live.length ? live[0] : 0,
    widthOuter: live.length ? live[live.length - 1] : 0,
    widthMax: live.length ? Math.max(...live) : 0,
    // how close the real outline is to the annular sector the solver assumes: 1.0 = a
    // clean sector, lower = rounded ends / a pinched waist
    sectorFill: angularSpan > 0 && rMid > 0 && dPort > 0 ? areaMM / (angularSpan * rMid * dPort) : 0,
    centroidFace: { x: px.reduce((s, p) => s + p.x, 0) / px.length, y: px.reduce((s, p) => s + p.y, 0) / px.length },
    contour: contourPx,
    pixels: px.length,
  };
}

/* ---- completing a port from the arc of it that is visible -----------------------
   A thick valve shows you the wall of its own bore. Looking down a port at anything but dead
   square, one side of it is the lit floor of the hole and the other is that wall in shade -
   and the wall reads as dark as the body, so the threshold cuts the port in half and traces
   a crescent. The give-away is WHICH boundary is which: the crescent's curved side is the
   real port rim, with valve FACE on the other side of it, while the straight side is an
   internal shade line with more hole (the dark wall) behind it.

   So the test for "is this stretch of outline a real edge" is not how strong the step is -
   the shade line is often the stronger step of the two - but what is on the far side of it.
   Face means edge; anything much darker or brighter than the face means we are still inside
   the hole.

   Keep only the real-edge points and a circle through them is the whole port, which is the
   user's observation that a fifth of a circle is enough to know the rest of it. Applied only
   when the arc really does fit a circle, so a kidney or sector port is left alone. */

// Consensus circle: sample three outline points many times, keep the circle the most points
// agree with, refit on those. The arc outvotes the chord, so no photometric test is needed -
// which matters, because the photometric one does not work. On a printed or machined face the
// "what does the valve look like" reference varies so much (texture, ribs, glare) that any
// tolerance wide enough to cover the face also covers the bore wall: tried on a real photo it
// called ~100% of every outline a real rim and completed nothing. Deterministic, so the
// tool gives the same answer twice.
export function fitCircleRANSAC(points, opts = {}) {
  const n = points.length;
  if (n < 12) return null;
  const iterations = opts.iterations ?? 240;
  let rng = (opts.seed ?? 1) >>> 0 || 1;
  const rand = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = () => points[(rand() * n) | 0];

  let cx0 = 0;
  let cy0 = 0;
  for (const p of points) {
    cx0 += p.x;
    cy0 += p.y;
  }
  cx0 /= n;
  cy0 /= n;
  let spread = 0;
  for (const p of points) spread = Math.max(spread, Math.hypot(p.x - cx0, p.y - cy0));
  const tol = Math.max(1.5, (opts.tolFrac ?? 0.04) * spread);

  let best = null;
  let bestCount = -1;
  for (let it = 0; it < iterations; it++) {
    const c = circleFromThree(pick(), pick(), pick());
    if (!c || !isFinite(c.r) || c.r <= 0 || c.r > 6 * spread) continue;
    let count = 0;
    for (const p of points) if (Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r) < tol) count++;
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  if (!best) return null;
  const inliers = points.filter((p) => Math.abs(Math.hypot(p.x - best.cx, p.y - best.cy) - best.r) < tol);
  if (inliers.length < 12) return null;
  const fit = fitCircleKasa(inliers) || best;
  let sq = 0;
  for (const p of inliers) {
    const d = Math.hypot(p.x - fit.cx, p.y - fit.cy) - fit.r;
    sq += d * d;
  }
  const bins = 48;
  const hit = new Uint8Array(bins);
  for (const p of inliers) {
    const a = Math.atan2(p.y - fit.cy, p.x - fit.cx);
    hit[Math.min(bins - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * bins))] = 1;
  }
  return {
    cx: fit.cx,
    cy: fit.cy,
    r: fit.r,
    residual: fit.r > 0 ? Math.sqrt(sq / inliers.length) / fit.r : 1,
    inlierFrac: inliers.length / n,
    arc: hit.reduce((s, v) => s + v, 0) / bins,
  };
}

function circleFromThree(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  const cx = (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d;
  const cy = (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

// A port counts as circular only if a solid majority of its outline agrees on one circle,
// over a decent sweep of it. A kidney or sector port fails both tests and is left alone.
export function fitPortCircle(contour, opts = {}) {
  const fit = fitCircleRANSAC(contour, opts);
  if (!fit) return null;
  if (fit.residual > (opts.maxResidual ?? 0.05)) return null;
  if (fit.arc < (opts.minArc ?? 0.3)) return null;
  if (fit.inlierFrac < (opts.minInliers ?? 0.45)) return null;
  return fit;
}

/* ---- recovering a port that shadow ate part of ---------------------------------
   There is a hard floor to reading a port off its own pixels: where the shade inside it is
   as dark as the metal, the edge simply is not in the picture, and no threshold, gradient or
   growth rule can conjure it back. The information is in the OTHER ports.

   A valve's ports are one port machined n times round a circle, so they are congruent under
   rotation about the valve centre. The shadow is not: the light sits at a fixed angle in
   image space while the ports sit at different angles around the face, so each port is shaded
   on a different part of ITSELF. Rotate them onto each other and the gap in one is covered by
   another. Pooling the ring therefore reconstructs the whole port, whatever its shape - round,
   oval, peanut, kidney - with no assumption about what that shape is.

   Everything below happens in a shared polar grid (radius from the valve centre, angle
   measured from each port's own centre), which is exactly the frame that makes congruent
   ports coincide. Clipping only ever REMOVES area, so a cell backed by a couple of ports is
   real even if most ports lost it; the vote threshold is set low for that reason, and a port
   that contributes area OUTSIDE the consensus is not clipped but different, so it is thrown
   out and reported rather than blended in. */

// Radial reach of one hole, for sizing the shared grid.
export function holeRadialRange(labels, id, width, height, face) {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== id) continue;
      const f = face.toFace(x, y);
      const r = Math.hypot(f.x, f.y);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
      n++;
    }
  }
  return n ? { lo, hi, n } : null;
}

// Pool one ring of ports into a single consensus shape. `ring` is the measured holes;
// `polar` the map from collectHolePolar. Returns the shape on its grid plus, per hole, how
// much of the consensus that hole actually saw and how much it put outside it.
export function recoverRingShape(ring, src, opts = {}) {
  if (ring.length < 3) return null;
  const { labels, width, height, face } = src;
  const rBins = opts.rBins ?? 120;
  const aBins = opts.aBins ?? 168;

  // grid spans the ring's full radial reach and a generous angular window
  let rLo = Infinity;
  let rHi = -Infinity;
  let halfSpan = 0;
  for (const h of ring) {
    const range = holeRadialRange(labels, h.id, width, height, face);
    if (!range) return null;
    rLo = Math.min(rLo, range.lo);
    rHi = Math.max(rHi, range.hi);
    halfSpan = Math.max(halfSpan, h.angularSpan / 2);
  }
  const rPad = 0.06 * (rHi - rLo);
  rLo = Math.max(0, rLo - rPad);
  rHi += rPad;
  const aHalf = Math.min(Math.PI / 2, halfSpan * 1.9 + 0.02);
  const dr = (rHi - rLo) / rBins;
  const da = (2 * aHalf) / aBins;

  /* Rasterise by GATHERING - walk the polar grid and ask the image what is at each cell -
     rather than scattering the hole's pixels into cells. Scattering silently loses area
     wherever a polar cell is smaller than a pixel, which happens on the INNER ring (its cells
     are ~1px, while the outer ring's catch two or three pixels each) and quietly shrank every
     inner port by about 15%, even in a photo with no shadow at all. */
  const masks = ring.map((h) => {
    const theta = Math.atan2(h.centroidFace.y, h.centroidFace.x);
    const m = new Uint8Array(rBins * aBins);
    let area = 0;
    for (let i = 0; i < rBins; i++) {
      const r = rLo + (i + 0.5) * dr;
      for (let j = 0; j < aBins; j++) {
        const phi = -aHalf + (j + 0.5) * da + theta;
        const p = face.toImage(r * Math.cos(phi), r * Math.sin(phi));
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (labels[y * width + x] !== h.id) continue;
        m[i * aBins + j] = 1;
        area++;
      }
    }
    return { hole: h, theta, mask: m, area };
  });

  // The least-clipped port is the best reference: shade only ever takes area away, so the
  // biggest one has lost the least and its centroid is the least dragged off centre.
  const ref = masks.reduce((a, b) => (b.area > a.area ? b : a));
  const maxShift = Math.max(2, Math.round(0.3 * aBins));
  for (const m of masks) {
    if (m === ref) {
      m.shift = 0;
      continue;
    }
    let best = 0;
    let bestScore = -1;
    for (let s = -maxShift; s <= maxShift; s++) {
      let score = 0;
      for (let i = 0; i < rBins; i++) {
        const row = i * aBins;
        for (let j = 0; j < aBins; j++) {
          if (!m.mask[row + j]) continue;
          const jj = j + s;
          if (jj >= 0 && jj < aBins && ref.mask[row + jj]) score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    m.shift = best;
  }
  const shifted = masks.map((m) => {
    if (!m.shift) return m.mask;
    const out = new Uint8Array(rBins * aBins);
    for (let i = 0; i < rBins; i++) {
      const row = i * aBins;
      for (let j = 0; j < aBins; j++) {
        const jj = j + m.shift;
        if (m.mask[row + j] && jj >= 0 && jj < aBins) out[row + jj] = 1;
      }
    }
    return out;
  });

  /* The shape is the UNION of the ports that can be trusted, because shade subtracts and
     never adds: a cell any sound port saw is real even if every other port lost it. A vote
     would be wrong here - it throws away the parts of the port only one port happened to have
     in the light, and it is the LEAST clipped port that holds most of those.

     So "trusted" cannot mean "agrees with the majority" either. The complete port is
     necessarily bigger than its clipped neighbours, and judging it against them marks the one
     good port as the odd one out and pools the ring down to the clipped shape. What actually
     separates a sound port from a leak is CORROBORATION: a complete port contains its clipped
     neighbours, so nearly all of it is backed by somebody else, whereas a port that has burst
     out into the valve face carries a chunk no other port has anywhere. */
  const votes = new Int16Array(rBins * aBins);
  for (const s of shifted) for (let c = 0; c < votes.length; c++) votes[c] += s[c];

  const per = new Map();
  const outliers = [];
  const support = masks.map((m, k) => {
    let own = 0;
    let backed = 0;
    for (let c = 0; c < votes.length; c++) {
      if (!shifted[k][c]) continue;
      own++;
      if (votes[c] > 1) backed++; // some OTHER port covers this cell too
    }
    return own ? backed / own : 0;
  });
  masks.forEach((m, k) => {
    if (support[k] < 0.8) outliers.push(m.hole.id);
  });
  const trusted = masks.map((m, k) => ({ m, k })).filter(({ k }) => support[k] >= 0.8);
  const contributors = trusted.length >= 2 ? trusted : masks.map((m, k) => ({ m, k }));

  // Two contributors, not one. A plain union would take every port's ragged last pixel and
  // grow the shape by roughly the perimeter - about 2% on a six-port ring, all of it
  // outwards. Asking for a second port to agree drops that fringe while still recovering a
  // chunk that most ports lost, because the ports are shaded in different places and any
  // given part of the port is in the light for most of them.
  const need = contributors.length >= 3 ? 2 : 1;
  const cVotes = new Int16Array(rBins * aBins);
  for (const { k } of contributors) for (let c = 0; c < cVotes.length; c++) cVotes[c] += shifted[k][c];
  const consensus = new Uint8Array(rBins * aBins);
  for (let c = 0; c < consensus.length; c++) consensus[c] = cVotes[c] >= need ? 1 : 0;

  masks.forEach((m, k) => {
    let inside = 0;
    let outside = 0;
    for (let c = 0; c < consensus.length; c++) {
      if (!shifted[k][c]) continue;
      if (consensus[c]) inside++;
      else outside++;
    }
    const own = inside + outside;
    per.set(m.hole.id, { inside, outside, own, stray: own ? outside / own : 0, support: support[k] });
  });
  if (trusted.length < 2) outliers.length = 0; // nothing to cross-check against; pool them all
  let cells = 0;
  for (let c = 0; c < consensus.length; c++) cells += consensus[c];
  if (!cells) return null;
  for (const m of masks) {
    const p = per.get(m.hole.id);
    p.seen = cells ? p.inside / cells : 0;
  }
  return { consensus, rBins, aBins, rLo, dr, aHalf, da, per, outliers, refId: ref.hole.id, ringSize: ring.length };
}

// Geometry of a pooled shape, in the same terms (and with the same area identity) as a hole
// measured directly: area is integrated exactly over the polar cells, r.dr.dphi.
export function consensusGeometry(shape, mmPerPx) {
  const { consensus, rBins, aBins, rLo, dr, da } = shape;
  let areaPx = 0;
  let rInner = Infinity;
  let rOuter = -Infinity;
  const profile = [];
  for (let i = 0; i < rBins; i++) {
    let n = 0;
    for (let j = 0; j < aBins; j++) if (consensus[i * aBins + j]) n++;
    const r0 = rLo + i * dr;
    const r1 = r0 + dr;
    if (n) {
      areaPx += ((n * da * (r1 * r1 - r0 * r0)) / 2) * 1;
      if (r0 < rInner) rInner = r0;
      if (r1 > rOuter) rOuter = r1;
      profile.push(n * da * ((r0 + r1) / 2) * mmPerPx);
    }
  }
  if (!isFinite(rInner)) return null;
  // The true edge lies somewhere inside the first and last occupied bin, so take their
  // CENTRES rather than their outer faces - using the faces adds a whole bin to d.port at
  // each end, which is a systematic over-read of a couple of tenths of a millimetre.
  rInner += dr / 2;
  rOuter -= dr / 2;
  const areaMM = areaPx * mmPerPx * mmPerPx;
  const dPort = (rOuter - rInner) * mmPerPx;
  return {
    rPort: rInner * mmPerPx,
    rOuterMM: rOuter * mmPerPx,
    rMidMM: ((rInner + rOuter) / 2) * mmPerPx,
    dPort,
    wPort: dPort > 1e-9 ? areaMM / dPort : 0,
    areaMM,
    equivDiaMM: 2 * Math.sqrt(areaMM / Math.PI),
    widthInner: profile.length ? profile[0] : 0,
    widthOuter: profile.length ? profile[profile.length - 1] : 0,
    widthMax: profile.length ? Math.max(...profile) : 0,
  };
}

// The pooled shape drawn back at one port's own position, for the overlay.
export function consensusContour(shape, theta, face, up) {
  const { consensus, rBins, aBins, rLo, dr, aHalf, da } = shape;
  const labels = new Int32Array(rBins * aBins).fill(-1);
  let start = -1;
  for (let c = 0; c < consensus.length; c++) {
    if (!consensus[c]) continue;
    labels[c] = 0;
    if (start < 0) start = c;
  }
  if (start < 0) return [];
  // trace on the (r, phi) raster, then map each step back through the face transform
  const traced = traceContour(labels, 0, aBins, rBins, start);
  return traced.map((p) => {
    const r = rLo + (p.y + 0.5) * dr;
    const phi = -aHalf + (p.x + 0.5) * da + theta;
    const img = face.toImage(r * Math.cos(phi), r * Math.sin(phi));
    return { x: img.x * up, y: img.y * up };
  });
}

// Ports sit in concentric rings; split the holes on gaps in mid-radius that dwarf the
// spread within a ring. Rings are only a convenience for bulk-labelling - every hole
// carries its own role, so the user can always override one by clicking it.
export function groupHolesByRadius(holes, rOuterMM) {
  if (!holes.length) return [];
  const sorted = [...holes].sort((a, b) => a.rMidMM - b.rMidMM);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].rMidMM - sorted[i - 1].rMidMM;
    const scale = Math.max(sorted[i].dPort, sorted[i - 1].dPort, 0.05 * rOuterMM);
    if (gap > 0.55 * scale) {
      groups.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  groups.push(cur);

  /* Radius alone does not say which holes are the same hole. A piston commonly carries two
     different ports on ONE ring - six compression and three rebound, say, alternating at
     much the same radius - and treating that as a single family is actively harmful: the
     pooling below would hand the small ones the big one's shape. Their SIZES separate
     cleanly though, so split a ring wherever the sorted areas jump by half again. */
  return groups
    .flatMap((g) => splitByAreaFamily(g))
    .map((g, i) => ({
      id: `ring${i}`,
      holes: g,
      meanRadiusMM: g.reduce((s, h) => s + h.rMidMM, 0) / g.length,
      meanAreaMM: g.reduce((s, h) => s + h.areaMM, 0) / g.length,
      meanRoundness: g.reduce((s, h) => s + h.roundness, 0) / g.length,
    }));
}

/* Split one ring at the largest jump in hole size - but only when both halves then look like
   families in their own right.

   The jump alone is not enough to go on, because shade produces jumps of the same size: a
   port clipped to 60% of itself sits 1.7x below its unclipped neighbour, which is exactly
   the ratio that separates two genuinely different ports. Splitting on that would tear a
   single family in half and hand each half to the recovery code as a separate port, which
   measured 7mm wrong on the shaded test photos.

   What tells them apart is the same principle the rest of this file leans on: identical
   ports measure identically. Two real families are each internally consistent; a pile of
   shade-clipped leftovers is all over the place. So propose the cut, then only take it if
   both sides hold together. */
export function splitByAreaFamily(holes, minRatio = 1.8, maxSpread = 0.12) {
  if (holes.length < 6) return [holes]; // a family needs 3 a side to be recognisable as one
  const sorted = [...holes].sort((a, b) => a.areaMM - b.areaMM);
  let cutAt = -1;
  let best = minRatio;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].areaMM;
    const ratio = prev > 1e-9 ? sorted[i].areaMM / prev : Infinity;
    if (ratio > best) {
      best = ratio;
      cutAt = i;
    }
  }
  // Three a side, because two clipped ports agree with each other as readily as two real
  // ones do, and a 1.8x gap, because clipping a port to 60% of itself only makes 1.7x.
  if (cutAt < 3 || sorted.length - cutAt < 3) return [holes];
  const spread = (arr) => {
    const m = arr.reduce((s, h) => s + h.areaMM, 0) / arr.length;
    if (!(m > 0)) return Infinity;
    return Math.sqrt(arr.reduce((s, h) => s + (h.areaMM - m) * (h.areaMM - m), 0) / arr.length) / m;
  };
  const lo = sorted.slice(0, cutAt);
  const hi = sorted.slice(cutAt);
  if (spread(lo) > maxSpread || spread(hi) > maxSpread) return [holes];
  return [...splitByAreaFamily(lo, minRatio, maxSpread), ...splitByAreaFamily(hi, minRatio, maxSpread)];
}

// Ports on a ring are evenly spaced, so the median angular step says how many there are
// even if glare swallowed one. Never below what was actually found.
export function inferRingCount(holes) {
  if (holes.length < 3) return holes.length;
  const angs = holes.map((h) => Math.atan2(h.centroidFace.y, h.centroidFace.x)).sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < angs.length; i++) diffs.push(angs[i] - angs[i - 1]);
  diffs.push(angs[0] + 2 * Math.PI - angs[angs.length - 1]);
  const med = median(diffs);
  const n = med > 0.02 ? Math.round((2 * Math.PI) / med) : holes.length;
  return Math.max(holes.length, Math.min(n, holes.length + 4));
}

// ---- the one call the app makes -----------------------------------------------

/**
 * @param imageData  full-resolution {data,width,height} of the photo
 * @param dValveMM   the one number the user types: the valve's outside diameter
 * @param opts       { sensitivity, maxDim, srcToNatural, deskew }
 * Every pixel coordinate that comes back is in the caller's own input-image space.
 */
export function analyseValvePhoto(imageData, dValveMM, opts = {}) {
  const warnings = [];
  if (!(dValveMM > 0))
    return { ok: false, warnings: ['Enter the valve diameter (D.valve) first — it sets the scale.'] };

  const srcToNatural = opts.srcToNatural ?? 1;
  const ds = downscaleRGBA(imageData, opts.maxDim ?? 1100);
  const up = srcToNatural / ds.scale; // detected pixel -> caller's pixel
  const W = ds.width;
  const H = ds.height;
  const gray = toGrayLuma(ds);

  const paperRef = samplePaperReference(ds);
  const { mask: paper, vThr, values } = classifyPaper(ds, paperRef, { sensitivity: opts.sensitivity ?? 1 });

  // 1. what the sheet reaches from the frame is background; the rest is valve-or-hole
  const outside = floodOutside(paper, W, H);
  const solid = new Uint8Array(W * H);
  for (let i = 0; i < solid.length; i++) solid[i] = outside[i] ? 0 : 1;

  // 2. the valve is the biggest such blob, holes already filled in
  const { labels: solidLabels, comps: solidComps } = connectedComponents(solid, W, H);
  if (!solidComps.length) {
    return {
      ok: false,
      warnings: ['Nothing but background in that photo — is the valve in frame, and is the sheet behind it white?'],
    };
  }
  const disc = solidComps.reduce((a, b) => (b.area > a.area ? b : a));
  if (disc.area < 0.02 * W * H) {
    return {
      ok: false,
      warnings: [
        'The valve came out tiny (or the sheet came out dark). Fill more of the frame with the valve, or nudge the white sensitivity slider.',
      ],
    };
  }
  const touchesFrame = disc.bbox.minX <= 1 || disc.bbox.minY <= 1 || disc.bbox.maxX >= W - 2 || disc.bbox.maxY >= H - 2;
  if (touchesFrame)
    warnings.push(
      'The valve runs off the edge of the photo — leave a margin of paper all round so the rim is visible.',
    );
  if (disc.area > 0.92 * W * H)
    warnings.push('The valve fills the frame; back off so a border of white paper shows around it.');

  // 3. how the circle is foreshortened -> the face space everything is measured in.
  // The silhouette's moments only SEED this: a contact shadow hugging one side of the valve
  // joins the silhouette and tips those moments, which would read as a tilt that isn't there
  // and skew every measurement through the de-skew. The shape is settled below against the
  // rim's real gradient edge instead, which the shadow cannot move.
  const seed = ellipseFromRegion(solidLabels, disc.id, W, H);
  if (!seed) return { ok: false, warnings: ['Could not measure the valve outline — try another photo.'] };
  const wantDeskew = opts.deskew !== false;
  const useQ = (r) => (wantDeskew && r > 0.75 && r < 0.985 ? r : 1);

  let centre = { x: seed.cx, y: seed.cy };
  let phi = seed.phi;
  let q = useQ(seed.axisRatio);
  let rFace = seed.a;
  let axisRatio = seed.axisRatio;

  /* Moments describe the blob they are given, and the blob is not always just the valve:
     anything dark that touches it joins it - the valve's own cast shadow, a dark edge of the
     lightbox, whatever else is on the bench. Then the moments describe valve-plus-junk, and
     a round valve reads as a steep ellipse (a backlit shot with a dark band in one corner
     came out "39 degrees of tilt" and had that duly corrected out of it).

     A circle fitted by consensus to the silhouette's outline does not care: the valve's own
     edge is the one thing most of those points agree on, and an attached blob is outvoted.
     Take that when it fits better than the moments do, and let the rays and the ellipse fit
     below refine it from there. */
  const outline = discOutline(solidLabels, disc.id, W, H);
  const byConsensus = outline.length >= 24 ? fitCircleRANSAC(outline, { tolFrac: 0.02, iterations: 400 }) : null;
  if (byConsensus && byConsensus.arc > 0.8 && byConsensus.inlierFrac > 0.6) {
    const momentsFitWorse = seed.axisRatio < 0.93 || byConsensus.inlierFrac > 0.9;
    if (momentsFitWorse) {
      centre = { x: byConsensus.cx, y: byConsensus.cy };
      phi = 0;
      q = 1;
      rFace = byConsensus.r;
      axisRatio = 1;
    }
  }
  let face = makeFaceSpace(centre, phi, q);
  let rimResidual = null;
  let sharpened = false;

  // 4. sub-pixel rim -> the scale, and a shadow-proof read on the tilt. Two passes: the
  // first finds the true edge under the seed's guess at the shape, the second re-measures
  // it with the shape that edge implies.
  for (let pass = 0; pass < 2; pass++) {
    const refined = refineOuterRadius(gray, W, H, face, rFace);
    if (!refined || !(refined.r > 0.5 * rFace) || !(refined.r < 1.6 * rFace)) break;
    // The second pass exists to REFINE, so take it only if it actually fits better. Narrowing
    // the search around a corrected radius can sweep a port ring into the window, and then
    // some rays stop on a port's edge instead of the rim - which shows up immediately as a
    // far worse circle residual. Keeping the better of the two makes the extra pass strictly
    // an improvement instead of a gamble.
    if (pass > 0 && rimResidual != null && refined.residual > rimResidual) break;
    const c = face.toImage(refined.dcx, refined.dcy);
    centre = { x: c.x, y: c.y };
    rFace = refined.r;
    rimResidual = refined.residual;
    sharpened = true;
    if (pass === 0 && wantDeskew && rimCoverage(refined.points, centre) > 0.82) {
      const fitted = fitEllipseFixedCenter(refined.points, centre, refined.r);
      if (fitted && fitted.axisRatio > 0.6 && fitted.axisRatio <= 1.02) {
        axisRatio = Math.min(1, fitted.axisRatio);
        phi = fitted.phi;
        q = useQ(axisRatio);
        rFace = fitted.a;
      }
    }
    face = makeFaceSpace(centre, phi, q);
    if (q === 1) break; // nothing to re-measure: the second pass would repeat the first
  }
  if (!sharpened) warnings.push('Could not sharpen the outer edge; measuring off the silhouette instead.');
  else if (rimResidual > 0.02)
    warnings.push('The outer edge reads soft — check the dashed circle sits on the rim, and avoid a hard shadow.');

  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, axisRatio))) * 180) / Math.PI;
  if (axisRatio < 0.75)
    warnings.push(
      `That is a steep angle (about ${tiltDeg.toFixed(0)}° off square) — the numbers will be skewed. Shoot straight down on the valve.`,
    );
  else if (q < 1)
    warnings.push(
      `Corrected for an apparent ${tiltDeg.toFixed(0)}° camera tilt. If the valve WAS square to the camera, that is a shadow round the rim being read as foreshortening — even the lighting and re-shoot.`,
    );
  const mmPerPx = dValveMM / (2 * rFace);

  // 5. the landlocked sheet = through-holes
  const enclosed = new Uint8Array(W * H);
  for (let i = 0; i < enclosed.length; i++) enclosed[i] = paper[i] && !outside[i] && solidLabels[i] === disc.id ? 1 : 0;
  const { labels: holeLabels, comps: holeComps } = connectedComponents(enclosed, W, H);
  // Size the smallest believable hole against the VALVE, not the photo frame: a port is a
  // meaningful fraction of the face however the shot was cropped. And throw out anything
  // long and thin, which on a 3D-printed or machined face means a layer line or a tool mark
  // catching the light - the rebound face of a printed piston produced 364 of them.
  const discAreaPx = Math.PI * rFace * rFace;
  const minHoleArea = Math.max(24, 0.00035 * discAreaPx);
  const isPortShaped = (c) => c.area >= minHoleArea && c.elongation <= 4;
  let kept = dropSpecks(holeComps.filter(isPortShaped));
  let labelsForHoles = holeLabels;

  // Shaded ports: thresholding the disc's own interior can see holes the sheet test can't.
  // Take that reading when the sheet test found nothing at all, or when it is visibly
  // cleaner - "cleaner" meaning less fragmented (see areaDispersion), never merely "more
  // blobs", since a shredded port counts as several blobs. Gated on the split looking like
  // holes rather than a glare sweep: a clear brightness gap, holes a minority of the face.
  const local = detectHolesInDisc(values, W, H, solidLabels, disc.id, minHoleArea);
  const localOk = local && local.comps.length && local.brightFraction < 0.45 && local.contrast > 0.12;
  if (localOk) {
    const localKept = dropSpecks(local.comps.filter(isPortShaped));
    const better = !kept.length || areaDispersion(localKept) < areaDispersion(kept) - 0.05;
    if (better) {
      kept = localKept;
      labelsForHoles = local.labels;
      const liveIds = new Set(localKept.map((c) => c.id));
      for (let i = 0; i < enclosed.length; i++) enclosed[i] = liveIds.has(local.labels[i]) ? 1 : 0;
      warnings.push('Ports found by contrast against the valve face — they photographed darker than the sheet.');
    }
  }

  // Whichever pass found them, the threshold only located a CORE of each hole - one side of
  // a port is usually dimmed by its own bore wall or the valve's shadow. Grow each core out
  // to the metal so the outline stops tracing the shade line.
  const inDisc = new Uint8Array(W * H);
  for (let i = 0; i < inDisc.length; i++) inDisc[i] = solidLabels[i] === disc.id ? 1 : 0;
  const grownLabels = growHolesIntoShade(values, W, H, labelsForHoles, kept, inDisc);
  const grownAreas = new Map(kept.map((c) => [c.id, 0]));
  for (let i = 0; i < grownLabels.length; i++) {
    const id = grownLabels[i];
    if (grownAreas.has(id)) grownAreas.set(id, grownAreas.get(id) + 1);
  }
  for (let i = 0; i < enclosed.length; i++) enclosed[i] = grownAreas.has(grownLabels[i]) ? 1 : 0;
  const grewBy = kept.length
    ? kept.reduce((s, c) => s + grownAreas.get(c.id) / Math.max(1, c.area), 0) / kept.length
    : 1;
  if (grewBy > 1.25)
    warnings.push(
      `Ports read ${Math.round((grewBy - 1) * 100)}% wider once shading inside them was included — light the valve more evenly if the outlines look off.`,
    );

  const measured = kept
    .map((c) => measureHole(grownLabels, c.id, W, H, face, mmPerPx))
    .filter(Boolean)
    // A port has to have sealing land outside it, so nothing that reaches the very edge of
    // the valve is one. What does live out there is the bright highlight along a chamfered
    // rim, which is landlocked by the body and so passes every topological test - it arrives
    // as a crowd of thin slivers hugging the edge.
    .filter((h) => h.rOuterMM <= (dValveMM / 2) * 0.95);

  // Complete any hole whose visible outline is an arc of a circle (see fitPortCircle). This
  // is what rescues a thick valve shot slightly off-square, where every port is traced as the
  // lit crescent of itself and the bore wall behind the shade line is lost to the body.
  if (opts.completeCircles !== false) {
    const byId = new Map(kept.map((c) => [c.id, c]));
    for (const h of measured) {
      const comp = byId.get(h.id);
      if (!comp) continue;
      const inFace = h.contour.map((p) => face.toFace(p.x, p.y));
      h.circleFit = { ok: false, pts: inFace.length };
      const fit = fitPortCircle(inFace);
      if (!fit) {
        h.circleFit.why = 'outline does not agree on a circle';
        continue;
      }
      Object.assign(h.circleFit, { arc: fit.arc, residual: fit.residual, inlierFrac: fit.inlierFrac });
      const areaMM = Math.PI * fit.r * fit.r * mmPerPx * mmPerPx;
      if (areaMM < h.areaMM * 1.15) {
        h.circleFit.why = `circle no bigger (${areaMM.toFixed(1)} vs ${h.areaMM.toFixed(1)}mm2)`;
        continue;
      }
      const rc = Math.hypot(fit.cx, fit.cy);
      if ((rc + fit.r) * mmPerPx > (dValveMM / 2) * 0.95) {
        h.circleFit.why = 'circle runs past the rim';
        continue;
      }
      h.circleFit.ok = true;
      const dPort = 2 * fit.r * mmPerPx;
      h.completedFrom = { arc: fit.arc, inlierFrac: fit.inlierFrac, residual: fit.residual, wasAreaMM: h.areaMM };
      h.rPort = (rc - fit.r) * mmPerPx;
      h.rOuterMM = (rc + fit.r) * mmPerPx;
      h.rMidMM = rc * mmPerPx;
      h.dPort = dPort;
      h.areaMM = areaMM;
      h.wPort = areaMM / dPort;
      h.equivDiaMM = dPort;
      h.roundness = 1;
      h.widthInner = 0;
      h.widthMax = dPort;
      h.widthOuter = 0;
      h.centroidFace = { x: fit.cx, y: fit.cy };
      h.recoveredContour = Array.from({ length: 72 }, (_, k) => {
        const t = (k / 72) * 2 * Math.PI;
        return face.toImage(fit.cx + fit.r * Math.cos(t), fit.cy + fit.r * Math.sin(t));
      });
    }
  }

  // 6. the shaft hole: round, and on the centre by definition
  let shaft = null;
  let shaftIdx = -1;
  measured.forEach((h, i) => {
    const rc = Math.hypot(h.centroidFace.x, h.centroidFace.y) * mmPerPx;
    if (rc > 0.22 * (dValveMM / 2)) return;
    if (shaft && shaft.rc <= rc) return;
    shaft = { ...h, rc };
    shaftIdx = i;
  });
  const ports = measured.filter((_, i) => i !== shaftIdx);

  // 7. rings, and a first guess at what each one is
  const groups = groupHolesByRadius(ports, (dValveMM / 2) * 1.0);
  // A bleed/throat hole is a small drilled round hole, so judge it against the BIGGEST
  // ring rather than the median hole - a valve with 8 bleeds and 6 ports has a median
  // that sits among the bleeds and would call the whole face throat.
  const maxRingArea = groups.reduce((m, g) => Math.max(m, g.meanAreaMM), 0);
  groups.forEach((g) => {
    const throatish = groups.length > 1 && g.meanAreaMM < 0.3 * maxRingArea && g.meanRoundness > 0.55;
    g.suggestedRole = throatish ? 'throat' : 'compression';
    g.count = inferRingCount(g.holes);
  });
  // Ports on a ring are the same port repeated, so if they come back different sizes the
  // segmentation lost part of some of them - which is what happens when shade inside a port
  // is as dark as the metal (you are seeing down the bore, not a shadow on paper, and no
  // brightness rule can separate the two). Rather than just report that, pool the ring and
  // put back what the shadow took: see recoverRingShape above for why that works.
  if (opts.pool !== false) {
    const src = { labels: grownLabels, width: W, height: H, face };
    for (const g of groups) {
      // A hole already completed from its own arc is settled - and better settled than
      // pooling could manage, since pooling assumes every port on the ring is the same port.
      // That assumption breaks on a face carrying two sizes of port at the same radius, where
      // pooling would hand the small ones the big one's shape.
      const poolable = g.holes.filter((h) => !h.completedFrom);
      if (poolable.length < 3) continue;
      // Only pool a ring that disagrees with itself. If its ports already measure the same,
      // there is nothing hidden to recover and pooling can only add its own bias - and worse,
      // if the de-skew is off (a contact shadow faking a tilt) the ports are no longer truly
      // congruent, so combining them inflates the shape. Leave a self-consistent ring alone.
      const areas = poolable.map((h) => h.areaMM);
      const mean = areas.reduce((s, a) => s + a, 0) / areas.length;
      const sd = Math.sqrt(areas.reduce((s, a) => s + (a - mean) * (a - mean), 0) / areas.length);
      if (!(mean > 0) || sd / mean < 0.08) continue;
      const shape = recoverRingShape(poolable, src);
      if (!shape) continue;
      const geom = consensusGeometry(shape, mmPerPx);
      if (!geom || !(geom.areaMM > 0)) continue;
      const strays = shape.outliers.filter((id) => poolable.some((h) => h.id === id));
      for (const h of poolable) {
        const p = shape.per.get(h.id);
        const odd = strays.includes(h.id);
        h.measuredOnly = {
          rPort: h.rPort,
          dPort: h.dPort,
          wPort: h.wPort,
          areaMM: h.areaMM,
        };
        h.seenFraction = p ? p.seen : 0;
        h.strayFraction = p ? p.stray : 0;
        h.pooled = !odd;
        if (odd) continue; // shape differs from its ring-mates: leave it as measured, flagged
        Object.assign(h, geom);
        h.recoveredContour = consensusContour(shape, Math.atan2(h.centroidFace.y, h.centroidFace.x), face, 1);
      }
      g.pooled = { from: poolable.length - strays.length, of: poolable.length, strays };
      if (strays.length)
        warnings.push(
          `${strays.length} hole${strays.length === 1 ? '' : 's'} on one ring ${strays.length === 1 ? 'is' : 'are'} a different shape from the rest — left as measured, check the outline${strays.length === 1 ? '' : 's'}.`,
        );
      const worst = Math.min(...poolable.filter((h) => h.pooled).map((h) => h.seenFraction ?? 1));
      if (isFinite(worst) && worst < 0.85)
        warnings.push(
          `Shadow hid part of some ports (as little as ${Math.round(worst * 100)}% of one was visible); their shape was reconstructed from the other ports on the same ring.`,
        );
    }
  }

  const portRings = groups.filter((g) => g.suggestedRole !== 'throat');
  // Two real port rings on one face is the classic compression-outside / rebound-inside
  // piston; anything else the user labels themselves.
  if (portRings.length === 2) {
    portRings.sort((a, b) => a.meanRadiusMM - b.meanRadiusMM);
    portRings[0].suggestedRole = 'rebound';
    portRings[1].suggestedRole = 'compression';
  }

  // 8. Does the picture add up? Not "is D.valve right" - nothing in the photo can tell us
  // that, it is the user's own reference - but "did the segmentation actually cover the
  // valve", which is the failure the sensitivity slider exists to fix. Pixels beyond the rim
  // (a contact shadow) are deliberately not counted, or every good photo would read ~110%.
  let insideDisc = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (solidLabels[y * W + x] !== disc.id) continue;
      const f = face.toFace(x, y);
      if (f.x * f.x + f.y * f.y <= rFace * rFace) insideDisc++;
    }
  }
  const coverage = (insideDisc * face.faceAreaPerPx) / (Math.PI * rFace * rFace);
  if (coverage < 0.93)
    warnings.push(
      `Only ${(coverage * 100).toFixed(0)}% of the valve face was detected — the white sensitivity is eating into it, or something is lying across the valve.`,
    );
  if (!ports.length)
    warnings.push('No through-holes found inside the valve. Nudge the white sensitivity slider, or use Manual trace.');

  // Overlay classes for the "show what you detected" preview: 0 sheet, 1 valve, 2 hole.
  const classes = new Uint8Array(W * H);
  for (let i = 0; i < classes.length; i++) {
    classes[i] = enclosed[i] ? 2 : solidLabels[i] === disc.id ? 1 : 0;
  }

  const toImg = (p) => ({ x: p.x * up, y: p.y * up });
  const dress = (h) => ({
    ...h,
    // what the threshold actually saw, kept separate from the pooled outline so the UI can
    // draw "seen" and "reconstructed" differently and never pass one off as the other
    contour: h.contour.map(toImg),
    recoveredContour: h.recoveredContour ? h.recoveredContour.map(toImg) : null,
    centroidImg: toImg(face.toImage(h.centroidFace.x, h.centroidFace.y)),
  });

  return {
    ok: true,
    warnings,
    // scale + frame
    circle: { cx: face.center.x * up, cy: face.center.y * up, r: rFace * up },
    ellipse: { axisRatio, phi, tiltDeg, corrected: q < 1 },
    mmPerPx: mmPerPx / up,
    rimResidual,
    coverage,
    paper: { v: paperRef.v, s: paperRef.s, threshold: vThr },
    // findings
    shaft: shaft ? { ...dress(shaft), dRodMM: shaft.equivDiaMM } : null,
    dRodMM: shaft ? shaft.equivDiaMM : null,
    holes: ports.map(dress),
    groups: groups.map((g) => ({
      id: g.id,
      suggestedRole: g.suggestedRole,
      count: g.count,
      meanRadiusMM: g.meanRadiusMM,
      meanAreaMM: g.meanAreaMM,
      meanRoundness: g.meanRoundness,
      holeIds: g.holes.map((h) => h.id),
      pooled: g.pooled || null,
    })),
    // preview mask
    preview: { width: W, height: H, classes, up },
  };
}
