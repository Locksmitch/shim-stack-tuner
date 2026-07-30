import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dist, circleFrom3Points, computePortGeometryFromOutline, findStrongestEdgeNear } from '../js/photo-measure.js';

describe('dist', () => {
  test('computes straight-line distance', () => {
    assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  });
});

describe('circleFrom3Points', () => {
  test('fits the exact circle through 3 points on a known circle', () => {
    const center = { x: 100, y: 50 };
    const r = 40;
    const p = (deg) => ({
      x: center.x + r * Math.cos((deg * Math.PI) / 180),
      y: center.y + r * Math.sin((deg * Math.PI) / 180),
    });
    const fit = circleFrom3Points(p(0), p(130), p(260));
    assert.ok(Math.abs(fit.center.x - center.x) < 1e-6);
    assert.ok(Math.abs(fit.center.y - center.y) < 1e-6);
    assert.ok(Math.abs(fit.r - r) < 1e-6);
  });

  test('is order-independent (same 3 points, different order, same fit)', () => {
    const center = { x: -20, y: 15 };
    const r = 12;
    const p = (deg) => ({
      x: center.x + r * Math.cos((deg * Math.PI) / 180),
      y: center.y + r * Math.sin((deg * Math.PI) / 180),
    });
    const [a, b, c] = [p(10), p(140), p(250)];
    const fit1 = circleFrom3Points(a, b, c);
    const fit2 = circleFrom3Points(c, a, b);
    assert.ok(Math.abs(fit1.r - fit2.r) < 1e-9);
    assert.ok(Math.abs(fit1.center.x - fit2.center.x) < 1e-9);
  });

  test('returns null for collinear points (no finite circle fits a line)', () => {
    const fit = circleFrom3Points({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 });
    assert.equal(fit, null);
  });
});

describe('computePortGeometryFromOutline', () => {
  // Builds the 4 corners of a true annular sector (matching drawPortFaceDiagramInner's own
  // port shape: an arc at rInner, an arc at rOuter, both spanning the same half-angle) so
  // the exact expected r.port/d.port/w.port can be hand-computed independently.
  function sectorCorners(center, rInner, rOuter, halfAngle, centerAngle) {
    const pt = (r, a) => ({ x: center.x + r * Math.cos(centerAngle + a), y: center.y + r * Math.sin(centerAngle + a) });
    return [pt(rInner, -halfAngle), pt(rInner, halfAngle), pt(rOuter, halfAngle), pt(rOuter, -halfAngle)];
  }

  test('matches the exact sector geometry for a simple radial port (4 corners)', () => {
    const center = { x: 0, y: 0 };
    const mmPerPx = 0.5;
    const rInner = 40,
      rOuter = 100,
      halfAngle = 0.2;
    const corners = sectorCorners(center, rInner, rOuter, halfAngle, -Math.PI / 2);
    const result = computePortGeometryFromOutline(center, mmPerPx, corners);
    assert.ok(Math.abs(result.rPort - rInner * mmPerPx) < 1e-6);
    assert.ok(Math.abs(result.dPort - (rOuter - rInner) * mmPerPx) < 1e-6);
    assert.ok(Math.abs(result.wPort - 2 * halfAngle * rOuter * mmPerPx) < 1e-6);
  });

  test('gives the same result regardless of a port straddling the +-pi angle seam', () => {
    const center = { x: 0, y: 0 };
    const mmPerPx = 1;
    const rInner = 40,
      rOuter = 100,
      halfAngle = 0.2;
    const atZero = sectorCorners(center, rInner, rOuter, halfAngle, 0);
    const atSeam = sectorCorners(center, rInner, rOuter, halfAngle, Math.PI); // wraps across +-pi
    const r1 = computePortGeometryFromOutline(center, mmPerPx, atZero);
    const r2 = computePortGeometryFromOutline(center, mmPerPx, atSeam);
    assert.ok(Math.abs(r1.wPort - r2.wPort) < 1e-6);
    assert.ok(Math.abs(r1.rPort - r2.rPort) < 1e-6);
    assert.ok(Math.abs(r1.dPort - r2.dPort) < 1e-6);
  });

  test('handles a rounded (many-point, near-circular arc) port outline sensibly', () => {
    const center = { x: 0, y: 0 };
    const mmPerPx = 1;
    const rInner = 50,
      rOuter = 80,
      halfAngle = 0.3;
    // Trace both the inner and outer arcs with several points each, approximating a
    // rounded port rather than just its 4 sharp corners.
    const points = [];
    for (let t = -1; t <= 1; t += 0.5) {
      points.push({
        x: rInner * Math.cos(-Math.PI / 2 + t * halfAngle),
        y: rInner * Math.sin(-Math.PI / 2 + t * halfAngle),
      });
      points.push({
        x: rOuter * Math.cos(-Math.PI / 2 + t * halfAngle),
        y: rOuter * Math.sin(-Math.PI / 2 + t * halfAngle),
      });
    }
    const result = computePortGeometryFromOutline(center, mmPerPx, points);
    assert.ok(Math.abs(result.rPort - rInner) < 1e-6);
    assert.ok(Math.abs(result.dPort - (rOuter - rInner)) < 1e-6);
    assert.ok(Math.abs(result.wPort - 2 * halfAngle * rOuter) < 1e-6);
  });

  test('returns null with fewer than 3 points', () => {
    assert.equal(
      computePortGeometryFromOutline({ x: 0, y: 0 }, 1, [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
      null,
    );
  });
});

describe('findStrongestEdgeNear', () => {
  // Builds a flat-shaded ImageData-shaped region split by a vertical edge at x=edgeX:
  // columns left of it are `darkGray`, columns at/right of it are `lightGray`.
  function verticalEdgeImage(width, height, edgeX, darkGray, lightGray) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = x < edgeX ? darkGray : lightGray;
        const i = (y * width + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { data, width, height };
  }

  test('snaps to a strong vertical edge near the click', () => {
    const img = verticalEdgeImage(30, 30, 15, 20, 220);
    const found = findStrongestEdgeNear(img, 12, 15, 8, 100);
    assert.ok(found, 'expected an edge to be found');
    assert.ok(Math.abs(found.x - 15) <= 1, `expected snap x near 15, got ${found.x}`);
  });

  test('returns null in a flat region with no real edge', () => {
    const img = verticalEdgeImage(30, 30, 15, 128, 128); // no edge at all - uniform gray
    const found = findStrongestEdgeNear(img, 12, 15, 8, 100);
    assert.equal(found, null);
  });

  test('returns null when the only edge is outside the search radius', () => {
    const img = verticalEdgeImage(30, 30, 15, 20, 220);
    // click far from the edge with a small radius that doesn't reach it
    const found = findStrongestEdgeNear(img, 2, 15, 3, 100);
    assert.equal(found, null);
  });
});
