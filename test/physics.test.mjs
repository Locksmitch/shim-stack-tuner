import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpArr,
  stackGapAt,
  stackSupportedAt,
  buildStack,
  flowArea,
  valveArea,
  pressurizedArea,
  solveForceAtVelocity,
} from '../js/physics.js';

describe('interpArr', () => {
  test('interpolates linearly between two points', () => {
    assert.equal(interpArr([0, 10], [0, 100], 5), 50);
  });

  test('clamps to the first y below the range', () => {
    assert.equal(interpArr([0, 10], [0, 100], -5), 0);
  });

  test('clamps to the last y above the range', () => {
    assert.equal(interpArr([0, 10], [0, 100], 15), 100);
  });

  test('returns the exact value at a knot point', () => {
    assert.equal(interpArr([0, 5, 10], [0, 50, 100], 5), 50);
  });

  test('interpolates within the correct segment of a multi-point table', () => {
    assert.equal(interpArr([0, 5, 10], [0, 50, 200], 7.5), 125);
  });
});

describe('stackGapAt', () => {
  test('row 0 has no gap from rows below (there are none)', () => {
    const rows = [{ count: 1, diam: 20, thickness: 1, float: 0 }];
    assert.equal(stackGapAt(rows, 0, 5), 0);
  });

  test("an explicit Float adds directly to the row's own gap", () => {
    const rows = [{ count: 1, diam: 20, thickness: 1, float: 2 }];
    assert.equal(stackGapAt(rows, 0, 5), 2);
  });

  test('a narrower row below adds a structural gap once radius exceeds its reach', () => {
    const rows = [
      { count: 1, diam: 20, thickness: 1, float: 0 },
      { count: 1, diam: 10, thickness: 0.5, float: 0 },
    ];
    assert.equal(stackGapAt(rows, 1, 5), 0); // still within row 0's reach (r=5 <= 10)
    assert.equal(stackGapAt(rows, 1, 15), 1); // beyond row 0's reach — its thickness becomes a gap
  });
});

describe('stackSupportedAt', () => {
  test('row 0 is always supported (loaded directly by fluid pressure)', () => {
    const rows = [{ count: 1, diam: 20, thickness: 1, float: 0 }];
    assert.equal(stackSupportedAt(rows, 0, 999), true);
  });

  test('a later row is supported where an earlier row still reaches', () => {
    const rows = [
      { count: 1, diam: 20, thickness: 1, float: 0 },
      { count: 1, diam: 10, thickness: 0.5, float: 0 },
    ];
    assert.equal(stackSupportedAt(rows, 1, 5), true);
  });

  test("a later row is unsupported beyond every earlier row's reach", () => {
    const rows = [
      { count: 1, diam: 20, thickness: 1, float: 0 },
      { count: 1, diam: 10, thickness: 0.5, float: 0 },
    ];
    assert.equal(stackSupportedAt(rows, 1, 15), false);
  });
});

describe('flowArea', () => {
  const geom = { nPort: 4, wPort: 3, dPort: 2, dThrt: 0, nThrt: 0 };

  test('computes port-perimeter flow area for a given lift', () => {
    assert.equal(flowArea(1, geom), 20); // 4 * (3+2) * 1
  });

  test('clamps negative lift to zero', () => {
    assert.equal(flowArea(-1, geom), 0);
  });

  test('caps flow area at the throttle bore when one is present', () => {
    const throttled = { ...geom, dThrt: 2, nThrt: 1 };
    const athrt = (Math.PI / 4) * 2 * 2;
    assert.ok(Math.abs(flowArea(1, throttled) - athrt) < 1e-9);
  });
});

describe('valveArea', () => {
  const geom = { dRod: 8, dValve: 18 };
  const rodArea = (Math.PI / 4) * 8 * 8;
  const boreArea = (Math.PI / 4) * 18 * 18;

  test('base valve uses the rod area', () => {
    assert.ok(Math.abs(valveArea(geom, 'base') - rodArea) < 1e-9);
  });

  test('main rebound uses bore area minus rod area (annulus)', () => {
    assert.ok(Math.abs(valveArea(geom, 'mainRebound') - (boreArea - rodArea)) < 1e-9);
  });

  test('main compression uses the full bore area', () => {
    assert.ok(Math.abs(valveArea(geom, 'mainComp') - boreArea) < 1e-9);
  });
});

test('pressurizedArea multiplies port count, width, and depth', () => {
  assert.equal(pressurizedArea({ nPort: 4, wPort: 3, dPort: 2 }), 24);
});

describe('buildStack', () => {
  const geom = { clampDia: 10, stackID: 10, rPort: 4, dPort: 3 };
  const mech = { E: 200000, nu: 0.3 };

  test('yAtLoad(0) is always zero', () => {
    const rows = [{ count: 1, diam: 20, thickness: 0.5, float: 0 }];
    const stack = buildStack(rows, geom, mech, { Fmax: 100, nSteps: 40, nSeg: 40 });
    assert.equal(stack.yAtLoad(0), 0);
  });

  test('deflection increases monotonically with force', () => {
    const rows = [{ count: 1, diam: 20, thickness: 0.5, float: 0 }];
    const stack = buildStack(rows, geom, mech, { Fmax: 100, nSteps: 40, nSeg: 40 });
    const y1 = stack.yAtLoad(20);
    const y2 = stack.yAtLoad(50);
    const y3 = stack.yAtLoad(90);
    assert.ok(y1 < y2 && y2 < y3);
  });

  test('a thicker single shim is stiffer (deflects less) than a thinner one at the same force', () => {
    const thin = buildStack([{ count: 1, diam: 20, thickness: 0.25, float: 0 }], geom, mech, {
      Fmax: 100,
      nSteps: 40,
      nSeg: 40,
    });
    const thick = buildStack([{ count: 1, diam: 20, thickness: 0.5, float: 0 }], geom, mech, {
      Fmax: 100,
      nSteps: 40,
      nSeg: 40,
    });
    assert.ok(thin.yAtLoad(50) > thick.yAtLoad(50));
  });

  test('two identical shims (count 2) are stiffer than a single one of the same thickness', () => {
    const one = buildStack([{ count: 1, diam: 20, thickness: 0.3, float: 0 }], geom, mech, {
      Fmax: 100,
      nSteps: 40,
      nSeg: 40,
    });
    const two = buildStack([{ count: 2, diam: 20, thickness: 0.3, float: 0 }], geom, mech, {
      Fmax: 100,
      nSteps: 40,
      nSeg: 40,
    });
    assert.ok(two.yAtLoad(50) < one.yAtLoad(50));
  });

  test('a floating (Float > 0) row starts disengaged, then locks in and shows up in engageLog', () => {
    const rows = [
      { count: 1, diam: 20, thickness: 0.5, float: 0 },
      { count: 1, diam: 15, thickness: 0.5, float: 0.001 }, // tiny gap: engages almost immediately
    ];
    const stack = buildStack(rows, geom, mech, { Fmax: 100, nSteps: 100, nSeg: 100 });
    assert.equal(stack.engageF[0], -Infinity); // row 0 has no gap — engaged from the start
    assert.ok(stack.engageF[1] > 0 && stack.engageF[1] < 100); // row 1 engages partway through
    assert.equal(stack.engageLog.length, 1);
    assert.equal(stack.engageLog[0].rowIndex, 1);
  });

  test('throws when no always-engaged shim bridges the clamp to the load (every row floats)', () => {
    const rows = [{ count: 1, diam: 20, thickness: 0.5, float: 5 }];
    assert.throws(
      () => buildStack(rows, geom, mech, { Fmax: 100, nSteps: 40, nSeg: 40 }),
      /No always-engaged shim spans radius/,
    );
  });

  test('throws when the clamp diameter is not smaller than the largest shim OD', () => {
    const rows = [{ count: 1, diam: 20, thickness: 0.5, float: 0 }];
    const badGeom = { clampDia: 20, stackID: 20, rPort: 4, dPort: 3 };
    assert.throws(() => buildStack(rows, badGeom, mech, {}), /Clamp diameter must be smaller than the largest shim OD/);
  });
});

describe('solveForceAtVelocity', () => {
  const geom = {
    clampDia: 10,
    stackID: 10,
    rPort: 4,
    dRod: 8,
    dValve: 18,
    nPort: 4,
    wPort: 3.5,
    dPort: 3,
    dThrt: 0,
    nThrt: 0,
  };
  const mech = { E: 200000, nu: 0.3 };
  const fluid = { cSt40: 30, cSt100: 6, tempC: 40, rho: 850, Cd: 0.65, Re0: 10 };

  test('zero or negative velocity produces zero force with no solve', () => {
    const rows = [{ count: 1, diam: 20, thickness: 0.5, float: 0 }];
    const stack = buildStack(rows, geom, mech, { Fmax: 400, nSteps: 60, nSeg: 60 });
    assert.deepEqual(solveForceAtVelocity(0, stack, geom, fluid, 'mainComp', 400), { F: 0, Re: 0 });
    assert.deepEqual(solveForceAtVelocity(-100, stack, geom, fluid, 'mainComp', 400), { F: 0, Re: 0 });
  });

  test('higher shaft velocity produces higher damping force', () => {
    const rows = [{ count: 1, diam: 20, thickness: 0.5, float: 0 }];
    const stack = buildStack(rows, geom, mech, { Fmax: 400, nSteps: 60, nSeg: 60 });
    const slow = solveForceAtVelocity(1000, stack, geom, fluid, 'mainComp', 400);
    const fast = solveForceAtVelocity(5000, stack, geom, fluid, 'mainComp', 400);
    assert.ok(slow.F > 0);
    assert.ok(fast.F > slow.F);
  });
});
