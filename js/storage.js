/* =========================================================
   PERSISTENCE (browser localStorage) — valve setups, panel collapse, tile layout.
   All guarded: if storage is unavailable (some browsers restrict it for file:// pages),
   every feature degrades gracefully to "works for this session only".
   ========================================================= */
export function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : JSON.parse(v);
  } catch (e) {
    return null;
  }
}
export function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
    return true;
  } catch (e) {
    return false;
  }
}
