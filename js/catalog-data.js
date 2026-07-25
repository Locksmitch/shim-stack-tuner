/* =========================================================
   FOX 2025 GRIP X2 PRESET STACK LIBRARY
   Extracted from FOX Factory valve-stack assembly drawings. All shims 0.252in ID.
   rows are [count, OD_in, thickness_in], listed from the valve face (pressure side)
   outward toward the clamp, matching each drawing's assembly order. Every kit's shim
   count was cross-checked against the drawing's "VALVE STACK HEIGHT" dimension.
   ========================================================= */
/* =========================================================
   PRODUCT PROFILE LIBRARY  (Phase 1)
   A product = a shock/fork. Each valve inside it carries a fixed shim ID, OD bounds,
   a soft stack-height tolerance, editable+saved port geometry, and named stock tunes.
   Tune rows are [count, OD_in, thickness_in], valve-face first. FOX's 0.0031/0.0032
   rounding is collapsed to a single canonical 0.0031 part everywhere.
   ========================================================= */
export const IN = 25.4;
export const CANON_THK = [0.0031, 0.0045, 0.006, 0.01]; // real FOX catalog thicknesses (in)
export function canonThk(t) {
  let best = t,
    bd = 1e9;
  for (const c of CANON_THK) {
    const d = Math.abs(c - t);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return bd <= 0.0006 ? best : t; // snap only near-duplicates (merges .0031/.0032)
}

export const PRODUCTS = {
  fox38x2: {
    label: '2025 FOX 38 Factory — Grip X2',
    valves: {
      rebound: {
        label: 'Rebound',
        valveType: 'mainRebound',
        shimID: 0.252,
        odMin: 0.35,
        odMax: 0.65,
        faceOD: 0.65,
        heightTolIn: 0.05 / IN,
        geom: {
          stackID_in: 0.252,
          clampDia_in: 0.252,
          dRod: 8,
          dValve: 18,
          rPort: 4,
          dPort: 3,
          wPort: 3.5,
          nPort: 4,
          dThrt: 0,
          nThrt: 0,
        },
        tunes: {
          xlight: {
            kit: '820-03-766-KIT',
            label: 'X-Light',
            heightIn: 0.023,
            rows: [
              [2, 0.65, 0.0031],
              [2, 0.55, 0.0031],
              [2, 0.4, 0.0031],
              [1, 0.35, 0.0045],
            ],
          },
          light: {
            kit: '820-03-743-KIT',
            label: 'Light',
            heightIn: 0.029,
            rows: [
              [3, 0.65, 0.0032],
              [3, 0.55, 0.0032],
              [2, 0.45, 0.0032],
              [1, 0.35, 0.0045],
            ],
          },
          medplus: {
            kit: '820-03-778-KIT',
            label: 'Medium+',
            heightIn: 0.027,
            rows: [
              [2, 0.65, 0.0045],
              [2, 0.55, 0.0045],
              [1, 0.5, 0.0045],
              [1, 0.45, 0.0045],
            ],
          },
          firm: {
            kit: '820-03-779-KIT',
            label: 'Firm',
            heightIn: 0.036,
            rows: [
              [2, 0.65, 0.0045],
              [2, 0.55, 0.0045],
              [1, 0.5, 0.0045],
              [3, 0.45, 0.0045],
            ],
          },
        },
      },
      mid: {
        label: 'Mid valve (compression)',
        valveType: 'mainComp',
        shimID: 0.252,
        odMin: 0.325,
        odMax: 0.65,
        faceOD: 0.65,
        heightTolIn: 0.05 / IN,
        geom: {
          stackID_in: 0.252,
          clampDia_in: 0.252,
          dRod: 8,
          dValve: 18,
          rPort: 4,
          dPort: 3,
          wPort: 3.5,
          nPort: 4,
          dThrt: 0,
          nThrt: 0,
        },
        tunes: {
          light: {
            kit: '820-03-765-KIT',
            label: 'Light (CL)',
            floatIn: '.006–.010',
            rows: [
              [1, 0.65, 0.0031],
              [1, 0.4, 0.0031],
              [1, 0.35, 0.0031],
              [1, 0.55, 0.0031],
              [2, 0.45, 0.0031],
            ],
          },
          medium: {
            kit: '820-03-702-KIT',
            label: 'Medium (CM)',
            floatIn: '.006–.010',
            rows: [
              [1, 0.65, 0.0031],
              [1, 0.4, 0.0031],
              [1, 0.55, 0.0031],
              [2, 0.45, 0.0031],
              [1, 0.4, 0.0031],
            ],
          },
        },
      },
      base: {
        label: 'Base valve (compression)',
        valveType: 'base',
        shimID: 0.252,
        odMin: 0.4,
        odMax: 0.8,
        faceOD: 0.8,
        heightTolIn: 0.05 / IN,
        geom: {
          stackID_in: 0.252,
          clampDia_in: 0.252,
          dRod: 8,
          dValve: 22,
          rPort: 5,
          dPort: 4,
          wPort: 5,
          nPort: 6,
          dThrt: 0,
          nThrt: 0,
        },
        tunes: {
          light: {
            kit: '820-03-764-KIT',
            label: 'Light (CL)',
            heightIn: 0.14,
            rows: [
              [5, 0.8, 0.0031],
              [1, 0.4, 0.0031],
              [6, 0.8, 0.0045],
              [3, 0.7, 0.006],
              [3, 0.6, 0.006],
              [3, 0.5, 0.006],
              [1, 0.45, 0.01],
              [3, 0.4, 0.01],
            ],
          },
          firm: {
            kit: '820-03-703-KIT',
            label: 'Firm (CF)',
            heightIn: 0.137,
            rows: [
              [5, 0.8, 0.0031],
              [1, 0.5, 0.0031],
              [3, 0.8, 0.006],
              [3, 0.7, 0.006],
              [3, 0.6, 0.006],
              [4, 0.5, 0.006],
              [1, 0.45, 0.01],
              [3, 0.4, 0.01],
            ],
          },
        },
      },
    },
  },
};

/* ---- global parts bin: every real (ID,OD,thickness) shim across all products ---- */
export function buildPartsBin() {
  const seen = new Map();
  for (const pk in PRODUCTS) {
    const prod = PRODUCTS[pk];
    for (const vk in prod.valves) {
      const v = prod.valves[vk];
      for (const tk in v.tunes) {
        for (const r of v.tunes[tk].rows) {
          const od = r[1],
            thk = canonThk(r[2]);
          const key = v.shimID + '|' + od + '|' + thk;
          if (!seen.has(key)) seen.set(key, { id: v.shimID, od, thk });
        }
      }
    }
  }
  return [...seen.values()];
}
export const PARTS_BIN = buildPartsBin();
export function usableShims(v) {
  return PARTS_BIN.filter(
    (s) => Math.abs(s.id - v.shimID) < 1e-6 && s.od >= v.odMin - 1e-9 && s.od <= v.odMax + 1e-9,
  ).sort((a, b) => a.od - b.od || a.thk - b.thk);
}
