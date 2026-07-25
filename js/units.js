/* =========================================================
   UNITS — length fields are PER-FIELD; force/velocity/modulus use one "result unit"
   ========================================================= */
export const FACT_LEN = { mm: 1, in: 25.4 };
export const FACT_FORCE = { mm: 1, in: 4.4482216153 }; // result-unit key 'mm' means metric(N), 'in' means imperial(lbf)
export const FACT_VEL = { mm: 1, in: 25.4 };
export const FACT_MOD = { MPa: 1, psi: 0.00689476 };
const DEC_LEN = { mm: 3, in: 4 };
const DEC_FORCE = { mm: 1, in: 2 };
const DEC_VEL = { mm: 1, in: 3 };

export function convLen(v, fromU, toU) {
  if (isNaN(v) || fromU === toU) return v;
  return (v * FACT_LEN[fromU]) / FACT_LEN[toU];
}
export function convForce(v, fromU, toU) {
  if (isNaN(v) || fromU === toU) return v;
  return (v * FACT_FORCE[fromU]) / FACT_FORCE[toU];
}
export function convVel(v, fromU, toU) {
  if (isNaN(v) || fromU === toU) return v;
  return (v * FACT_VEL[fromU]) / FACT_VEL[toU];
}
export function convMod(v, fromU, toU) {
  if (isNaN(v) || fromU === toU) return v;
  return (v * FACT_MOD[fromU]) / FACT_MOD[toU];
}
export function fmtLen(v, u) {
  return v.toFixed(DEC_LEN[u]);
}
export function fmtForce(v, u) {
  return v.toFixed(DEC_FORCE[u]);
}
export function fmtVel(v, u) {
  return v.toFixed(DEC_VEL[u]);
}
