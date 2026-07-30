/* =========================================================
   PRODUCT PROFILE LIBRARY  (Phase 1)
   A product = a shock/fork. Each valve inside it carries a fixed shim ID, OD bounds,
   a soft stack-height tolerance, editable+saved port geometry, and named stock tunes.
   Tune rows are [count, OD_in, thickness_in], valve-face first, matching each FOX
   assembly drawing's order. The catalog data itself (extracted from FOX Factory
   valve-stack assembly drawings; every kit's shim count cross-checked against the
   drawing's "VALVE STACK HEIGHT" dimension) lives in data/catalog.json, not here -
   this module just knows how to fetch it and derive the parts bin from it, so the
   data can later be swapped for a server/database-backed source without any change
   to the code that consumes PRODUCTS/PARTS_BIN.
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

// Populated by loadCatalog() below; empty until then. `let` (not `const`) so the
// reassignment inside loadCatalog is visible to every module that imported these
// live bindings, without needing to re-import after the fetch resolves.
export let PRODUCTS = {};
export let PARTS_BIN = [];

/* ---- global parts bin: every real (ID,OD,thickness,type) shim across all products ----
   Row format is [count, od_in, thk_in, type?] where type is 'round' (default) or 'deltaT'
   (a triangle/delta shim - same OD reach, far less rim stiffness; see shimScaleAt in
   physics.js). canonThk's .0031/.0032 merge only makes sense for FOX's own inch-rounded
   drawings - a metric-sourced product (units:'mm') has its thicknesses converted exactly
   from mm, so snapping them to FOX's inch buckets would silently corrupt them instead. */
export function buildPartsBin() {
  const seen = new Map();
  for (const pk in PRODUCTS) {
    const prod = PRODUCTS[pk];
    const snap = (prod.units || 'in') !== 'mm';
    for (const vk in prod.valves) {
      const v = prod.valves[vk];
      for (const tk in v.tunes) {
        for (const r of v.tunes[tk].rows) {
          const od = r[1],
            thk = snap ? canonThk(r[2]) : r[2],
            type = r[3] || 'round';
          const key = v.shimID + '|' + od + '|' + thk + '|' + type;
          if (!seen.has(key)) seen.set(key, { id: v.shimID, od, thk, type });
        }
      }
    }
  }
  return [...seen.values()];
}
export function usableShims(v) {
  return PARTS_BIN.filter(
    (s) => Math.abs(s.id - v.shimID) < 1e-6 && s.od >= v.odMin - 1e-9 && s.od <= v.odMax + 1e-9,
  ).sort((a, b) => a.od - b.od || a.thk - b.thk || (a.type || 'round').localeCompare(b.type || 'round'));
}

// Fetches the product/valve/tune catalog from its standalone JSON data store and
// populates PRODUCTS/PARTS_BIN from it. Kept separate from the data itself so the
// fetch URL is the only thing that would need to change to point at a real backend
// (e.g. an API route) instead of a static file, once one exists.
export async function loadCatalog(url = './data/catalog.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load catalog (${res.status} ${res.statusText})`);
  PRODUCTS = await res.json();
  PARTS_BIN = buildPartsBin();
  return PRODUCTS;
}
