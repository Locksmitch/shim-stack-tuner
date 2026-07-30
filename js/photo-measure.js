/* =========================================================
   Pure geometry helpers for the "estimate port geometry from a photo" feature.
   Everything here works in whatever pixel space the caller's points are in -
   real-world units only enter via the mmPerPx scale factor passed into
   computePortGeometry, computed by the caller from a known reference dimension
   (this app uses D.valve) and the fitted outer-edge circle's pixel radius.
   ========================================================= */
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Circumcenter + radius of the circle through 3 points - used to fit the valve's outer
// edge from 3 clicked points without requiring them to be exactly diametrically opposite.
// Returns null if the points are (near-)collinear, since no finite circle fits those.
export function circleFrom3Points(p1, p2, p3) {
  const ax = p1.x,
    ay = p1.y,
    bx = p2.x,
    by = p2.y,
    cx = p3.x,
    cy = p3.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const center = { x: ux, y: uy };
  return { center, r: dist(center, p1) };
}

// Given the fitted valve center, a pixel->mm scale, and a freeform outline traced around
// one port's actual boundary (3+ points, in click order - any shape: sharp sector, rounded,
// kidney, D-shaped), returns r.port/d.port/w.port in mm matching the tuner's own port
// model (see drawPortFaceDiagramInner in app.js): an annular sector from r.port to
// r.port+d.port, w.port measured as an arc width at the outer edge. Generalizes the old
// fixed 3-corner-click model (inner radius = the nearest traced point to center, outer
// radius = the farthest, width = the traced points' total angular span at the outer
// radius) so any port shape reduces to the same 3 numbers, without assuming straight
// radial/tangential edges - for a plain sector this reduces to the exact classic formula.
export function computePortGeometryFromOutline(center, mmPerPx, points) {
  if (!points || points.length < 3) return null;
  const radii = points.map((p) => dist(center, p));
  const rInnerPx = Math.min(...radii);
  const rOuterPx = Math.max(...radii);
  const rawAngles = points.map((p) => Math.atan2(p.y - center.y, p.x - center.x));
  // Average the angles as unit vectors (not the raw numbers) so a port that happens to
  // straddle the +-pi seam doesn't see a spurious ~2*pi span from the wraparound.
  const meanX = rawAngles.reduce((s, a) => s + Math.cos(a), 0);
  const meanY = rawAngles.reduce((s, a) => s + Math.sin(a), 0);
  const meanAngle = Math.atan2(meanY, meanX);
  const centered = rawAngles.map((a) => {
    let d = a - meanAngle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  });
  const angularSpan = Math.max(...centered) - Math.min(...centered);
  return {
    rPort: rInnerPx * mmPerPx,
    dPort: Math.max(0, (rOuterPx - rInnerPx) * mmPerPx),
    wPort: angularSpan * rOuterPx * mmPerPx,
  };
}

// Finds the strongest nearby edge in a small image region via a 3x3 Sobel gradient, used
// to "snap" an imprecise click onto the true boundary the user meant to click. `imageData`
// is anything shaped like a browser ImageData ({data: Uint8ClampedArray RGBA, width,
// height}) - a plain object with that shape works too, so this is testable without a DOM.
// (cx, cy) are in the SAME local pixel space as imageData (not the full photo). Searches
// a circular disk of the given radius; returns null if no pixel in it clears `threshold`,
// so a click in a flat/featureless area is left alone rather than snapping to noise.
// Candidates are ranked by gradient magnitude tempered by distance from (cx, cy) (linear
// falloff to 50% weight at the disk's rim), not raw magnitude alone - near a sharp corner,
// the single strongest-gradient pixel in a disk is often out along one of the two adjoining
// edges rather than the corner vertex itself; favoring the closer candidate keeps the snap
// on the corner the user actually clicked near instead of drifting down an edge.
export function findStrongestEdgeNear(imageData, cx, cy, radius, threshold) {
  const { data, width, height } = imageData;
  const gray = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  let best = null;
  let bestScore = -Infinity;
  const r2 = radius * radius;
  const y0 = Math.max(1, Math.round(cy - radius)),
    y1 = Math.min(height - 2, Math.round(cy + radius));
  const x0 = Math.max(1, Math.round(cx - radius)),
    x1 = Math.min(width - 2, Math.round(cx + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx,
        dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const gx =
        -gray(x - 1, y - 1) -
        2 * gray(x - 1, y) -
        gray(x - 1, y + 1) +
        gray(x + 1, y - 1) +
        2 * gray(x + 1, y) +
        gray(x + 1, y + 1);
      const gy =
        -gray(x - 1, y - 1) -
        2 * gray(x, y - 1) -
        gray(x + 1, y - 1) +
        gray(x - 1, y + 1) +
        2 * gray(x, y + 1) +
        gray(x + 1, y + 1);
      const mag = Math.hypot(gx, gy);
      if (mag < threshold) continue;
      const distFactor = 1 - 0.5 * (Math.sqrt(d2) / radius);
      const score = mag * distFactor;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y, magnitude: mag };
      }
    }
  }
  return best;
}
