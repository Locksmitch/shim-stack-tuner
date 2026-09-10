import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toGrayLuma,
  otsuThreshold,
  connectedComponents,
  componentBoundary,
  fitCircleKasa,
  fitCircleRANSAC,
  fitOuterCircle,
  groupPorts,
  inferPortCount,
  analysePhoto,
} from '../js/image-analysis.js';

// ---- synthetic valve/piston image generator ----------------------------------
// Bright metal disc on a dark surround, a dark center bore, and one or more rings of
// dark annular-sector "ports" (through-holes read dark in a real face photo). Matches
// the app's own port model (drawPortFaceDiagramInner: inner arc, outer arc, straight
// sides) so the exact expected r/d/w.port can be hand-computed.
function makePiston({
  W = 420,
  H = 420,
  cx = 210,
  cy = 210,
  R = 180,
  bg = 35,
  metal = 205,
  hole = 12,
  boreR = 30,
  rings = [{ count: 6, halfAngle: 0.16, rInner: 96, rOuter: 150 }],
} = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const rr = Math.hypot(dx, dy);
      let v = bg;
      if (rr <= R) v = metal;
      if (rr <= boreR) v = hole;
      const ang = Math.atan2(dy, dx);
      for (const ring of rings) {
        for (let k = 0; k < ring.count; k++) {
          const a0 = (k * 2 * Math.PI) / ring.count - Math.PI / 2;
          let da = ang - a0;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          if (Math.abs(da) <= ring.halfAngle && rr >= ring.rInner && rr <= ring.rOuter) v = hole;
        }
      }
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

describe('toGrayLuma', () => {
  test('converts RGBA to a luma buffer of the right length', () => {
    const img = { data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), width: 2, height: 1 };
    const g = toGrayLuma(img);
    assert.equal(g.length, 2);
    assert.ok(Math.abs(g[0] - 255) < 1e-6);
    assert.equal(g[1], 0);
  });
});

describe('otsuThreshold', () => {
  test('lands between two well-separated peaks', () => {
    const g = new Float32Array(2000);
    for (let i = 0; i < 1000; i++) g[i] = 30;
    for (let i = 1000; i < 2000; i++) g[i] = 210;
    // Otsu returns t such that class 0 = [0..t]; for exact peaks at 30 and 210 that is 30
    // (callers binarise as gray > t). What matters is that it separates the two peaks.
    const t = otsuThreshold(g);
    assert.ok(t >= 30 && t < 210, `expected a separating threshold, got ${t}`);
  });
});

describe('connectedComponents', () => {
  test('separates two disjoint blobs and measures area', () => {
    const w = 10;
    const h = 10;
    const bin = new Uint8Array(w * h);
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [1, 2],
    ])
      bin[y * w + x] = 1;
    bin[7 * w + 7] = 1;
    const { comps } = connectedComponents(bin, w, h);
    assert.equal(comps.length, 2);
    const areas = comps.map((c) => c.area).sort((a, b) => a - b);
    assert.deepEqual(areas, [1, 3]);
  });
});

describe('fitCircleKasa', () => {
  test('recovers a circle from clean boundary points', () => {
    const cx = 120;
    const cy = 80;
    const r = 55;
    const pts = [];
    for (let d = 0; d < 360; d += 7) {
      pts.push({ x: cx + r * Math.cos((d * Math.PI) / 180), y: cy + r * Math.sin((d * Math.PI) / 180) });
    }
    const fit = fitCircleKasa(pts);
    assert.ok(Math.abs(fit.cx - cx) < 1e-6);
    assert.ok(Math.abs(fit.cy - cy) < 1e-6);
    assert.ok(Math.abs(fit.r - r) < 1e-6);
  });
});

describe('fitCircleRANSAC', () => {
  test('ignores gross outliers a plain fit would be dragged off by', () => {
    const cx = 200;
    const cy = 150;
    const r = 90;
    const pts = [];
    for (let d = 0; d < 360; d += 4) {
      pts.push({ x: cx + r * Math.cos((d * Math.PI) / 180), y: cy + r * Math.sin((d * Math.PI) / 180) });
    }
    for (let i = 0; i < 25; i++) pts.push({ x: cx + (i - 12) * 2, y: cy }); // a bogus line of points through the middle
    const fit = fitCircleRANSAC(pts, { threshold: 2 });
    assert.ok(Math.abs(fit.cx - cx) < 2, `cx off: ${fit.cx}`);
    assert.ok(Math.abs(fit.cy - cy) < 2, `cy off: ${fit.cy}`);
    assert.ok(Math.abs(fit.r - r) < 2, `r off: ${fit.r}`);
    assert.ok(fit.residual < 0.02);
  });
});

describe('fitOuterCircle', () => {
  test('locks onto the piston rim, not the ports', () => {
    const img = makePiston({ R: 180, cx: 210, cy: 205 });
    const fit = fitOuterCircle(toGrayLuma(img), img.width, img.height);
    assert.ok(fit, 'expected a circle');
    assert.ok(Math.abs(fit.cx - 210) < 4, `cx off: ${fit.cx}`);
    assert.ok(Math.abs(fit.cy - 205) < 4, `cy off: ${fit.cy}`);
    assert.ok(Math.abs(fit.r - 180) < 5, `r off: ${fit.r}`);
    assert.ok(fit.aspect > 0.95);
  });
});

describe('groupPorts', () => {
  test('splits two concentric rings into two groups', () => {
    const circle = { cx: 0, cy: 0, r: 200 };
    const mk = (radius, n) =>
      Array.from({ length: n }, (_, k) => ({
        meanRadius: radius,
        area: 100,
        roundness: 0.5,
        centroid: { x: radius * Math.cos((k / n) * 2 * Math.PI), y: radius * Math.sin((k / n) * 2 * Math.PI) },
      }));
    const groups = groupPorts([...mk(70, 6), ...mk(140, 6)], circle);
    assert.equal(groups.length, 2);
    assert.ok(groups[0].meanRadius < groups[1].meanRadius);
  });
});

describe('inferPortCount', () => {
  test('suggests the full count when one port of a ring is missing', () => {
    const circle = { cx: 0, cy: 0, r: 100 };
    const ports = [];
    for (let k = 0; k < 6; k++) {
      if (k === 3) continue; // drop one
      ports.push({ centroid: { x: 60 * Math.cos((k / 6) * 2 * Math.PI), y: 60 * Math.sin((k / 6) * 2 * Math.PI) } });
    }
    assert.equal(inferPortCount(ports, circle), 6);
  });
});

describe('analysePhoto', () => {
  const DVALVE = 50;

  test('scales from D.valve and measures a single ring of ports', () => {
    const R = 180;
    const ring = { count: 6, halfAngle: 0.16, rInner: 96, rOuter: 150 };
    const img = makePiston({ R, boreR: 30, rings: [ring] });
    const res = analysePhoto(img, DVALVE);
    assert.ok(res.ok, res.warnings.join('; '));
    assert.ok(Math.abs(res.circle.r - R) < 5);

    const mmPerPx = DVALVE / (2 * res.circle.r);
    assert.ok(Math.abs(res.dRodMM - 2 * 30 * mmPerPx) < 1.5, `D.rod off: ${res.dRodMM}`);

    assert.equal(res.groups.length, 1);
    const g = res.groups[0];
    assert.equal(g.ports.length, 6);
    assert.equal(g.suggestedCount, 6);

    const avg = (f) => g.ports.reduce((s, p) => s + f(p.geom), 0) / g.ports.length;
    // tolerances ~1mm: threshold + centroid discretisation on a 420px synthetic image
    assert.ok(Math.abs(avg((x) => x.rPort) - ring.rInner * mmPerPx) < 1.2, `r.port ${avg((x) => x.rPort)}`);
    assert.ok(
      Math.abs(avg((x) => x.dPort) - (ring.rOuter - ring.rInner) * mmPerPx) < 1.2,
      `d.port ${avg((x) => x.dPort)}`,
    );
    assert.ok(
      Math.abs(avg((x) => x.wPort) - 2 * ring.halfAngle * ring.rOuter * mmPerPx) < 1.5,
      `w.port ${avg((x) => x.wPort)}`,
    );
  });

  test('separates a compression ring and a rebound ring', () => {
    const img = makePiston({
      R: 190,
      boreR: 28,
      rings: [
        { count: 4, halfAngle: 0.18, rInner: 55, rOuter: 95 },
        { count: 6, halfAngle: 0.14, rInner: 120, rOuter: 165 },
      ],
    });
    const res = analysePhoto(img, DVALVE);
    assert.ok(res.ok);
    assert.equal(res.groups.length, 2);
    assert.ok(res.groups[0].meanRadiusMM < res.groups[1].meanRadiusMM);
    assert.equal(res.groups[0].ports.length, 4);
    assert.equal(res.groups[1].ports.length, 6);
  });

  test('flags a ring of small round holes as throat-like', () => {
    const img = makePiston({
      R: 190,
      boreR: 26,
      rings: [
        { count: 8, halfAngle: 0.05, rInner: 60, rOuter: 74 }, // small, near-round
        { count: 6, halfAngle: 0.16, rInner: 120, rOuter: 165 }, // real kidney ports
      ],
    });
    const res = analysePhoto(img, DVALVE);
    assert.ok(res.ok);
    const throaty = res.groups.find((g) => g.kind === 'throat');
    assert.ok(throaty, 'expected one group classified throat');
    assert.ok(throaty.meanRadiusMM < res.groups.find((g) => g.kind === 'port').meanRadiusMM);
  });

  test('fails cleanly with no D.valve', () => {
    const res = analysePhoto(makePiston(), 0);
    assert.equal(res.ok, false);
    assert.ok(res.warnings.length);
  });
});
