import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  toGrayLuma,
  downscaleRGBA,
  samplePaperReference,
  classifyPaper,
  floodOutside,
  connectedComponents,
  traceContour,
  fitCircleKasa,
  ellipseFromRegion,
  makeFaceSpace,
  refineOuterRadius,
  measureHole,
  groupHolesByRadius,
  inferRingCount,
  otsuTwoThresholds,
  dropSpecks,
  areaDispersion,
  analyseValvePhoto,
} from '../js/image-analysis.js';

/* ---- synthetic valve photo ----------------------------------------------------
   The shot the tool actually asks for: a dark valve lying on a white sheet, so the
   through-holes show the SHEET through them (they are bright, not dark). `squashY`
   foreshortens the disc the way an off-square camera angle would, for the de-skew
   tests. Ports are exact annular sectors so r/d/w.port can be hand-computed. */
function makeValvePhoto({
  W = 480,
  H = 480,
  cx = 240,
  cy = 240,
  R = 190,
  paper = 238,
  body = 70,
  holeShade = null, // defaults to the paper seen through the hole
  squashY = 1,
  boreR = 26,
  rings = [{ count: 6, halfAngle: 0.18, rInner: 100, rOuter: 155 }],
  blobs = [], // extra free-form holes: {cx, cy, r} circles in valve-frame coords
} = {}) {
  const hv = holeShade == null ? paper : holeShade;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = (y - cy) / squashY; // into the valve's own un-foreshortened frame
      const rr = Math.hypot(dx, dy);
      let v = paper;
      if (rr <= R) {
        v = body;
        if (rr <= boreR) v = hv;
        const ang = Math.atan2(dy, dx);
        for (const ring of rings) {
          for (let k = 0; k < ring.count; k++) {
            const a0 = (k * 2 * Math.PI) / ring.count - Math.PI / 2;
            let da = ang - a0;
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da < -Math.PI) da += 2 * Math.PI;
            if (Math.abs(da) <= ring.halfAngle && rr >= ring.rInner && rr <= ring.rOuter) v = hv;
          }
        }
        for (const b of blobs) {
          if (Math.hypot(dx - b.cx, dy - b.cy) <= b.r) v = hv;
        }
      }
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

const DVALVE = 50;

describe('downscaleRGBA', () => {
  test('box-averages down to the requested cap and reports the scale', () => {
    const img = makeValvePhoto({ W: 400, H: 200 });
    const ds = downscaleRGBA(img, 100);
    assert.equal(ds.width, 100);
    assert.equal(ds.height, 50);
    assert.ok(Math.abs(ds.scale - 0.25) < 1e-9);
  });

  test('leaves an already-small image untouched', () => {
    const img = makeValvePhoto({ W: 80, H: 80 });
    const ds = downscaleRGBA(img, 1000);
    assert.equal(ds.scale, 1);
    assert.equal(ds.data, img.data);
  });
});

describe('samplePaperReference', () => {
  test('reads the sheet from the frame border, not the valve', () => {
    const ref = samplePaperReference(makeValvePhoto({ paper: 231, body: 60 }));
    assert.ok(Math.abs(ref.v - 231) < 3, `paper value ${ref.v}`);
    assert.ok(ref.s < 0.05, `grey paper should be unsaturated, got ${ref.s}`);
  });

  test('is not dragged off by a valve that runs into the border band', () => {
    // R large enough that the disc reaches the frame on all four sides
    const ref = samplePaperReference(makeValvePhoto({ R: 235, paper: 231, body: 60 }));
    assert.ok(ref.v > 150, `expected the sheet to still win the median, got ${ref.v}`);
  });
});

describe('classifyPaper + floodOutside', () => {
  test('separates sheet, valve and landlocked holes by topology', () => {
    const img = makeValvePhoto({ rings: [{ count: 4, halfAngle: 0.2, rInner: 100, rOuter: 150 }] });
    const ref = samplePaperReference(img);
    const { mask } = classifyPaper(img, ref);
    const outside = floodOutside(mask, img.width, img.height);

    const enclosed = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) enclosed[i] = mask[i] && !outside[i] ? 1 : 0;
    const { comps } = connectedComponents(enclosed, img.width, img.height);
    const real = comps.filter((c) => c.area > 50);
    // 4 ports + the centre bore
    assert.equal(real.length, 5, `expected 5 landlocked holes, got ${real.length}`);

    // a pixel well outside the valve is background, one in the body is not paper at all
    const at = (x, y) => y * img.width + x;
    assert.equal(outside[at(5, 5)], 1);
    assert.equal(mask[at(240, 240 - 180)], 0, 'a point in the valve body should not read as paper');
  });
});

describe('traceContour', () => {
  test('walks the whole boundary of a filled square', () => {
    const w = 20;
    const h = 20;
    const labels = new Int32Array(w * h).fill(-1);
    for (let y = 5; y <= 12; y++) for (let x = 4; x <= 11; x++) labels[y * w + x] = 0;
    const c = traceContour(labels, 0, w, h, 5 * w + 4);
    // an 8x8 square has 28 boundary pixels
    assert.equal(c.length, 28, `contour length ${c.length}`);
    assert.ok(c.every((p) => labels[p.y * w + p.x] === 0));
  });
});

describe('fitCircleKasa', () => {
  test('recovers a circle from clean points', () => {
    const pts = [];
    for (let d = 0; d < 360; d += 7) {
      pts.push({ x: 120 + 55 * Math.cos((d * Math.PI) / 180), y: 80 + 55 * Math.sin((d * Math.PI) / 180) });
    }
    const fit = fitCircleKasa(pts);
    assert.ok(Math.abs(fit.cx - 120) < 1e-6);
    assert.ok(Math.abs(fit.cy - 80) < 1e-6);
    assert.ok(Math.abs(fit.r - 55) < 1e-6);
  });
});

describe('ellipseFromRegion', () => {
  test('measures the foreshortening of a tilted disc', () => {
    const img = makeValvePhoto({ R: 170, squashY: 0.8, rings: [] });
    const ref = samplePaperReference(img);
    const { mask } = classifyPaper(img, ref);
    const outside = floodOutside(mask, img.width, img.height);
    const solid = new Uint8Array(mask.length);
    for (let i = 0; i < solid.length; i++) solid[i] = outside[i] ? 0 : 1;
    const { labels, comps } = connectedComponents(solid, img.width, img.height);
    const disc = comps.reduce((a, b) => (b.area > a.area ? b : a));
    const ell = ellipseFromRegion(labels, disc.id, img.width, img.height);
    assert.ok(Math.abs(ell.axisRatio - 0.8) < 0.02, `axis ratio ${ell.axisRatio}`);
    assert.ok(Math.abs(ell.a - 170) < 4, `semi-major ${ell.a}`);
    assert.ok(Math.abs(Math.sin(ell.phi)) < 0.05, `major axis should be horizontal, phi=${ell.phi}`);
  });
});

describe('refineOuterRadius', () => {
  test('lands on the rim to well under a pixel', () => {
    const R = 168;
    const img = makeValvePhoto({ R, rings: [] });
    const gray = toGrayLuma(img);
    const face = makeFaceSpace({ x: 240, y: 240 }, 0, 1);
    const res = refineOuterRadius(gray, img.width, img.height, face, R * 1.04);
    assert.ok(res, 'expected a refined rim');
    assert.ok(Math.abs(res.r - R) < 0.7, `radius ${res.r} vs ${R}`);
    assert.ok(res.residual < 0.01, `residual ${res.residual}`);
  });
});

describe('measureHole', () => {
  test('reports w.port as the radius-averaged arc width of a sector', () => {
    const ring = { count: 1, halfAngle: 0.25, rInner: 90, rOuter: 150 };
    const img = makeValvePhoto({ rings: [ring], boreR: 0 });
    const ref = samplePaperReference(img);
    const { mask } = classifyPaper(img, ref);
    const outside = floodOutside(mask, img.width, img.height);
    const enclosed = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) enclosed[i] = mask[i] && !outside[i] ? 1 : 0;
    const { labels, comps } = connectedComponents(enclosed, img.width, img.height);
    const hole = comps.reduce((a, b) => (b.area > a.area ? b : a));

    const mmPerPx = DVALVE / (2 * 190);
    const face = makeFaceSpace({ x: 240, y: 240 }, 0, 1);
    const m = measureHole(labels, hole.id, img.width, img.height, face, mmPerPx);

    assert.ok(Math.abs(m.rPort - ring.rInner * mmPerPx) < 0.3, `r.port ${m.rPort}`);
    assert.ok(Math.abs(m.dPort - (ring.rOuter - ring.rInner) * mmPerPx) < 0.3, `d.port ${m.dPort}`);
    // area of an annular sector = span * (ro^2 - ri^2)/2, so area/depth = span * rMid
    const expectedW = 2 * ring.halfAngle * ((ring.rInner + ring.rOuter) / 2) * mmPerPx;
    assert.ok(Math.abs(m.wPort - expectedW) < 0.3, `w.port ${m.wPort} vs ${expectedW}`);
    // and that average really does sit between the inner and outer arc widths
    assert.ok(m.widthInner < m.wPort && m.wPort < m.widthOuter, `${m.widthInner} < ${m.wPort} < ${m.widthOuter}`);
    assert.ok(m.sectorFill > 0.95, `a true sector should fill its bounding sector, got ${m.sectorFill}`);
  });

  test('averages a peanut port between its waist and its widest point', () => {
    // two overlapping circles = a port fat at both ends, pinched in the middle
    const img = makeValvePhoto({
      rings: [],
      boreR: 0,
      blobs: [
        { cx: 0, cy: -105, r: 26 },
        { cx: 0, cy: -150, r: 26 },
      ],
    });
    const ref = samplePaperReference(img);
    const { mask } = classifyPaper(img, ref);
    const outside = floodOutside(mask, img.width, img.height);
    const enclosed = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) enclosed[i] = mask[i] && !outside[i] ? 1 : 0;
    const { labels, comps } = connectedComponents(enclosed, img.width, img.height);
    const hole = comps.reduce((a, b) => (b.area > a.area ? b : a));
    const mmPerPx = DVALVE / (2 * 190);
    const m = measureHole(labels, hole.id, img.width, img.height, makeFaceSpace({ x: 240, y: 240 }, 0, 1), mmPerPx);

    assert.ok(m.wPort < m.widthMax, `the mean width must be under the widest band (${m.wPort} vs ${m.widthMax})`);
    assert.ok(m.wPort * m.dPort > 0, 'w*d must be positive');
    // w*d reproduces the measured open area exactly - that is the point of using area/depth
    assert.ok(Math.abs(m.wPort * m.dPort - m.areaMM) < 1e-6, 'w.port * d.port should equal the measured area');
    assert.ok(m.roundness < 0.95, `a peanut is not round, got ${m.roundness}`);
  });
});

describe('otsuTwoThresholds / dropSpecks / areaDispersion', () => {
  test('puts three well-separated populations in three classes', () => {
    const v = [];
    for (let i = 0; i < 500; i++) v.push(40);
    for (let i = 0; i < 500; i++) v.push(120);
    for (let i = 0; i < 200; i++) v.push(220);
    // classes are [0..t1], [t1+1..t2], >t2 - so a cut sits ON the top of its lower class
    const [t1, t2] = otsuTwoThresholds(Float32Array.from(v));
    assert.ok(t1 >= 40 && t1 < 120, `first cut ${t1}`);
    assert.ok(t2 >= 120 && t2 < 220, `second cut ${t2}`);
  });

  test('dropSpecks removes threshold slivers but keeps a ring of small bleed holes', () => {
    const mk = (areas) => areas.map((area, id) => ({ id, area }));
    const withSlivers = dropSpecks(mk([5000, 5000, 5000, 5000, 40, 30]));
    assert.equal(withSlivers.length, 4, 'slivers next to big ports should go');
    const bleeds = dropSpecks(mk([5000, 5000, 200, 200, 200, 200, 200, 200]));
    assert.equal(bleeds.length, 8, 'a genuine ring of small holes must survive');
  });

  test('areaDispersion is higher for a fragmented segmentation than a clean one', () => {
    const clean = [5000, 5000, 5000, 5000].map((area, id) => ({ id, area }));
    const shredded = [5000, 5000, 3000, 2000, 4200, 800].map((area, id) => ({ id, area }));
    assert.ok(areaDispersion(shredded) > areaDispersion(clean));
    assert.equal(areaDispersion(clean), 0);
  });
});

describe('groupHolesByRadius / inferRingCount', () => {
  test('splits two concentric rings', () => {
    const mk = (rMid, n) => Array.from({ length: n }, () => ({ rMidMM: rMid, areaMM: 10, roundness: 0.5, dPort: 2 }));
    const groups = groupHolesByRadius([...mk(8, 6), ...mk(18, 6)], 25);
    assert.equal(groups.length, 2);
    assert.ok(groups[0].meanRadiusMM < groups[1].meanRadiusMM);
  });

  test('infers the full count when one port of a ring was missed', () => {
    const holes = [];
    for (let k = 0; k < 6; k++) {
      if (k === 3) continue;
      holes.push({
        centroidFace: { x: 60 * Math.cos((k / 6) * 2 * Math.PI), y: 60 * Math.sin((k / 6) * 2 * Math.PI) },
      });
    }
    assert.equal(inferRingCount(holes), 6);
  });
});

describe('analyseValvePhoto', () => {
  test('scales from D.valve and measures one ring of ports', () => {
    const R = 190;
    const ring = { count: 6, halfAngle: 0.18, rInner: 100, rOuter: 155 };
    const img = makeValvePhoto({ R, boreR: 26, rings: [ring] });
    const res = analyseValvePhoto(img, DVALVE);
    assert.ok(res.ok, res.warnings.join('; '));

    const mmPerPx = DVALVE / (2 * R);
    assert.ok(Math.abs(res.circle.r - R) < 2, `rim radius ${res.circle.r}`);
    assert.ok(Math.abs(res.coverage - 1) < 0.05, `coverage ${res.coverage}`);

    assert.ok(res.shaft, 'expected the centre bore to be found');
    assert.ok(Math.abs(res.dRodMM - 2 * 26 * mmPerPx) < 0.5, `D.rod ${res.dRodMM}`);

    assert.equal(res.holes.length, 6);
    assert.equal(res.groups.length, 1);
    assert.equal(res.groups[0].count, 6);

    const avg = (f) => res.holes.reduce((s, h) => s + f(h), 0) / res.holes.length;
    assert.ok(Math.abs(avg((h) => h.rPort) - ring.rInner * mmPerPx) < 0.5, `r.port ${avg((h) => h.rPort)}`);
    assert.ok(
      Math.abs(avg((h) => h.dPort) - (ring.rOuter - ring.rInner) * mmPerPx) < 0.5,
      `d.port ${avg((h) => h.dPort)}`,
    );
    const expectedW = 2 * ring.halfAngle * ((ring.rInner + ring.rOuter) / 2) * mmPerPx;
    assert.ok(Math.abs(avg((h) => h.wPort) - expectedW) < 0.5, `w.port ${avg((h) => h.wPort)} vs ${expectedW}`);
  });

  test('separates a rebound ring from a compression ring and suggests which is which', () => {
    const img = makeValvePhoto({
      R: 195,
      boreR: 24,
      rings: [
        { count: 4, halfAngle: 0.2, rInner: 55, rOuter: 100 },
        { count: 6, halfAngle: 0.16, rInner: 125, rOuter: 172 },
      ],
    });
    const res = analyseValvePhoto(img, DVALVE);
    assert.ok(res.ok, res.warnings.join('; '));
    assert.equal(res.groups.length, 2);
    const [inner, outer] = [...res.groups].sort((a, b) => a.meanRadiusMM - b.meanRadiusMM);
    assert.equal(inner.suggestedRole, 'rebound');
    assert.equal(outer.suggestedRole, 'compression');
    assert.equal(inner.holeIds.length, 4);
    assert.equal(outer.holeIds.length, 6);
  });

  test('flags a ring of small round holes as throat/bleed', () => {
    const img = makeValvePhoto({
      R: 195,
      boreR: 24,
      rings: [
        { count: 8, halfAngle: 0.05, rInner: 62, rOuter: 76 }, // small + near round
        { count: 6, halfAngle: 0.18, rInner: 125, rOuter: 172 }, // real ports
      ],
    });
    const res = analyseValvePhoto(img, DVALVE);
    assert.ok(res.ok, res.warnings.join('; '));
    const throat = res.groups.find((g) => g.suggestedRole === 'throat');
    assert.ok(throat, `expected a throat ring, got ${res.groups.map((g) => g.suggestedRole).join('/')}`);
    assert.ok(throat.meanRadiusMM < res.groups.find((g) => g.suggestedRole === 'compression').meanRadiusMM);
  });

  test('de-skews a tilted photo instead of just measuring it wrong', () => {
    const R = 185;
    const ring = { count: 6, halfAngle: 0.18, rInner: 100, rOuter: 155 };
    const square = analyseValvePhoto(makeValvePhoto({ R, rings: [ring] }), DVALVE);
    const tilted = analyseValvePhoto(makeValvePhoto({ R, rings: [ring], squashY: 0.85 }), DVALVE);
    assert.ok(tilted.ok, tilted.warnings.join('; '));
    assert.ok(tilted.ellipse.corrected, 'expected the tilt to be corrected');
    assert.ok(Math.abs(tilted.ellipse.axisRatio - 0.85) < 0.03, `axis ratio ${tilted.ellipse.axisRatio}`);
    assert.equal(tilted.holes.length, 6);

    const mean = (r, f) => r.holes.reduce((s, h) => s + f(h), 0) / r.holes.length;
    for (const f of [(h) => h.rPort, (h) => h.dPort, (h) => h.wPort]) {
      const a = mean(square, f);
      const b = mean(tilted, f);
      assert.ok(Math.abs(a - b) < 0.45, `tilted reading drifted: ${b} vs ${a}`);
    }
  });

  test('still finds ports that photograph dim because the valve shades them', () => {
    const img = makeValvePhoto({ holeShade: 150, body: 60, paper: 240 });
    const res = analyseValvePhoto(img, DVALVE);
    assert.ok(res.ok, res.warnings.join('; '));
    assert.equal(res.holes.length, 6);
  });

  test('finds shaded ports on a glare-swept face, where one Otsu cut splits the body instead', () => {
    // The hard case: the body carries a bright specular sweep that is brighter than the
    // (shaded) ports, so a single threshold separates lit metal from dark metal and leaves
    // the ports attached to the lit half. Three-class Otsu + the landlocked rule recover it.
    const R = 190;
    const ring = { count: 6, halfAngle: 0.18, rInner: 100, rOuter: 155 };
    const W = 480;
    const H = 480;
    const img = makeValvePhoto({ R, rings: [ring], boreR: 26 });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - 240;
        const dy = y - 240;
        const rr = Math.hypot(dx, dy);
        if (rr > R) continue;
        const i = (y * W + x) * 4;
        const isHole = img.data[i] > 200; // the synthetic drew holes at the paper value
        // lit metal peaks at 125, shaded ports sit at 150: a real gap, but the body's own
        // 55..125 spread is far wider than it, which is what defeats a single Otsu cut
        const v = isHole ? 150 : 55 + 70 * (0.5 + 0.5 * Math.cos(Math.atan2(dy, dx) * 2 - 1.1));
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      }
    }
    const res = analyseValvePhoto(img, DVALVE);
    assert.ok(res.ok, res.warnings.join('; '));
    assert.equal(res.holes.length, 6, `expected 6 ports, got ${res.holes.length}`);
    const mmPerPx = DVALVE / (2 * R);
    const avg = (f) => res.holes.reduce((s, h) => s + f(h), 0) / res.holes.length;
    assert.ok(Math.abs(avg((h) => h.rPort) - ring.rInner * mmPerPx) < 0.6, `r.port ${avg((h) => h.rPort)}`);
  });

  test('fails cleanly without D.valve', () => {
    const res = analyseValvePhoto(makeValvePhoto(), 0);
    assert.equal(res.ok, false);
    assert.ok(res.warnings.length);
  });

  test('hands back a preview mask the UI can paint', () => {
    const res = analyseValvePhoto(makeValvePhoto(), DVALVE);
    assert.ok(res.preview && res.preview.classes.length === res.preview.width * res.preview.height);
    const seen = new Set(res.preview.classes);
    assert.ok(seen.has(0) && seen.has(1) && seen.has(2), 'expected sheet, body and hole classes in the preview');
  });
});
