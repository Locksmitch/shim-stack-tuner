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

// 1 = "this pixel is the sheet" (background OR seen through a hole). `sensitivity` is the
// UI slider: >1 is more willing to call a dim pixel paper (use it when ports read grey
// because the valve is thick and shades its own holes), <1 is stricter (use it when a
// bright valve face is being eaten away).
export function classifyPaper({ data, width, height }, ref, opts = {}) {
  const sensitivity = opts.sensitivity ?? 1;
  const values = new Float32Array(width * height);
  const sats = new Float32Array(width * height);
  for (let p = 0, i = 0; p < values.length; p++, i += 4) {
    const { v, s } = valueSat(data, i);
    values[p] = v;
    sats[p] = s;
  }
  // Otsu proposes the split; the sheet reference bounds how far it may wander (a photo
  // that is nearly all paper, or nearly all valve, makes Otsu's split meaningless).
  const base = otsuThreshold(values);
  const vThr = Math.max(0.3 * ref.v, Math.min(0.95 * ref.v, base / Math.max(0.2, sensitivity)));
  const sThr = Math.min(0.92, ref.s + 0.2 * sensitivity + 0.06);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) mask[p] = values[p] >= vThr && sats[p] <= sThr ? 1 : 0;
  return { mask, vThr, sThr, values };
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
    let best = -1;
    let bestG = 0;
    for (let s = 1; s < nS - 1; s++) {
      grad[s] = polarity * (prof[s + 1] - prof[s - 1]);
      if (grad[s] > bestG) {
        bestG = grad[s];
        best = s;
      }
    }
    if (best < 1 || bestG <= 0) continue;
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
  const fit = fitCircleKasa(keep.length >= 24 ? keep : hits);
  if (!fit || !(fit.r > 0)) return null;
  const used = keep.length >= 24 ? keep : hits;
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
  };
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
  return groups.map((g, i) => ({
    id: `ring${i}`,
    holes: g,
    meanRadiusMM: g.reduce((s, h) => s + h.rMidMM, 0) / g.length,
    meanAreaMM: g.reduce((s, h) => s + h.areaMM, 0) / g.length,
    meanRoundness: g.reduce((s, h) => s + h.roundness, 0) / g.length,
  }));
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

  // 3. how the circle is foreshortened -> the face space everything is measured in
  const ell = ellipseFromRegion(solidLabels, disc.id, W, H);
  if (!ell) return { ok: false, warnings: ['Could not measure the valve outline — try another photo.'] };
  const wantDeskew = opts.deskew !== false;
  const q = wantDeskew && ell.axisRatio > 0.75 && ell.axisRatio < 0.997 ? ell.axisRatio : 1;
  const tiltDeg = (Math.acos(Math.max(-1, Math.min(1, ell.axisRatio))) * 180) / Math.PI;
  if (ell.axisRatio < 0.75)
    warnings.push(
      `That is a steep angle (about ${tiltDeg.toFixed(0)}° off square) — the numbers will be skewed. Shoot straight down on the valve.`,
    );
  else if (q < 1) warnings.push(`Corrected for a ${tiltDeg.toFixed(0)}° camera tilt.`);

  let face = makeFaceSpace({ x: ell.cx, y: ell.cy }, ell.phi, q);

  // 4. sub-pixel rim -> the scale
  const r0 = ell.a;
  let rFace = r0;
  let rimResidual = null;
  const refined = refineOuterRadius(gray, W, H, face, r0);
  if (refined && refined.r > 0.5 * r0 && refined.r < 1.6 * r0) {
    const c = face.toImage(refined.dcx, refined.dcy);
    face = makeFaceSpace({ x: c.x, y: c.y }, ell.phi, q);
    rFace = refined.r;
    rimResidual = refined.residual;
    if (refined.residual > 0.02)
      warnings.push('The outer edge reads soft — check the dashed circle sits on the rim, and avoid a hard shadow.');
  } else {
    warnings.push('Could not sharpen the outer edge; measuring off the silhouette instead.');
  }
  const mmPerPx = dValveMM / (2 * rFace);

  // 5. the landlocked sheet = through-holes
  const enclosed = new Uint8Array(W * H);
  for (let i = 0; i < enclosed.length; i++) enclosed[i] = paper[i] && !outside[i] && solidLabels[i] === disc.id ? 1 : 0;
  const { labels: holeLabels, comps: holeComps } = connectedComponents(enclosed, W, H);
  const minHoleArea = Math.max(24, 0.00004 * W * H);
  let kept = dropSpecks(holeComps.filter((c) => c.area >= minHoleArea));
  let labelsForHoles = holeLabels;

  // Shaded ports: thresholding the disc's own interior can see holes the sheet test can't.
  // Take that reading when the sheet test found nothing at all, or when it is visibly
  // cleaner - "cleaner" meaning less fragmented (see areaDispersion), never merely "more
  // blobs", since a shredded port counts as several blobs. Gated on the split looking like
  // holes rather than a glare sweep: a clear brightness gap, holes a minority of the face.
  const local = detectHolesInDisc(values, W, H, solidLabels, disc.id, minHoleArea);
  const localOk = local && local.comps.length && local.brightFraction < 0.45 && local.contrast > 0.12;
  if (localOk) {
    const localKept = dropSpecks(local.comps);
    const better = !kept.length || areaDispersion(localKept) < areaDispersion(kept) - 0.05;
    if (better) {
      kept = localKept;
      labelsForHoles = local.labels;
      const liveIds = new Set(localKept.map((c) => c.id));
      for (let i = 0; i < enclosed.length; i++) enclosed[i] = liveIds.has(local.labels[i]) ? 1 : 0;
      warnings.push('Ports found by contrast against the valve face — they photographed darker than the sheet.');
    }
  }

  const measured = kept
    .map((c) => measureHole(labelsForHoles, c.id, W, H, face, mmPerPx))
    .filter(Boolean)
    .filter((h) => h.rOuterMM <= (dValveMM / 2) * 1.02);

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
    contour: h.contour.map(toImg),
    centroidImg: toImg(face.toImage(h.centroidFace.x, h.centroidFace.y)),
  });

  return {
    ok: true,
    warnings,
    // scale + frame
    circle: { cx: face.center.x * up, cy: face.center.y * up, r: rFace * up },
    ellipse: { axisRatio: ell.axisRatio, phi: ell.phi, tiltDeg, corrected: q < 1 },
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
    })),
    // preview mask
    preview: { width: W, height: H, classes, up },
  };
}
