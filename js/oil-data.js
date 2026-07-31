/* =========================================================
   OIL LIBRARY
   Known suspension-fluid viscosity presets (cSt @40°C/@100°C, taken directly from
   manufacturer datasheets) for the oil pickers in the Shim Stack Tuner and the Oil
   Viscosity Comparison page. The data itself lives in data/oils.json, not here - same
   reasoning as catalog-data.js/data/catalog.json: keeps the fetch URL as the only thing
   that would need to change to point at a real backend later.
   ========================================================= */
export let OILS = [];

export async function loadOils(url = './data/oils.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load oil library (${res.status} ${res.statusText})`);
  OILS = await res.json();
  return OILS;
}
