import { convLen, convForce, convVel, convMod, fmtLen, fmtForce, fmtVel } from './js/units.js';
import { interpArr, buildStack, solveForceAtVelocity, waltherViscAt } from './js/physics.js';
import { lsGet, lsSet } from './js/storage.js';
import { IN, canonThk, PRODUCTS, usableShims, loadCatalog } from './js/catalog-data.js';
import { OILS, loadOils } from './js/oil-data.js';
import { viscAtRef, cstToSus, viscosityIndex } from './js/oil-viscosity-calc.js';
import { buildBandsAtForce, computeStackYMaxMM, drawStackCanvas } from './js/stack-visual.js';
import { drawForceCurve as drawForceCurveVisual } from './js/force-curve-visual.js';
import { drawOilChart as drawOilChartVisual, OIL_MIN_TEMP, OIL_MAX_TEMP } from './js/oil-chart-visual.js';
import { setupCanvas } from './js/canvas-utils.js';
import { circleFrom3Points, computePortGeometryFromOutline, findStrongestEdgeNear } from './js/photo-measure.js';
import { analysePhoto } from './js/image-analysis.js';
import { broadcastLiveVisuals } from './js/live-sync.js';

let resultUnit = 'mm'; // display unit for force/velocity/outputs

// ---- per-field length unit handling ----
function onFieldUnitChange(sel) {
  const id = sel.dataset.for;
  const input = document.getElementById(id);
  const oldU = sel.dataset.unit,
    newU = sel.value;
  const v = parseFloat(input.value);
  if (!isNaN(v)) input.value = fmtLen(convLen(v, oldU, newU), newU);
  sel.dataset.unit = newU;
  input.step = newU === 'mm' ? '0.1' : '0.005';
  if (id === 'stackID' || id === 'clampDia') drawShimRefDiagram();
  if (['rPort', 'dPort', 'wPort', 'dValve', 'dRod'].includes(id)) drawPortFaceDiagram();
}
function getFieldMM(id) {
  const input = document.getElementById(id);
  const sel = document.querySelector(`.fieldUnit[data-for="${id}"]`);
  const unit = sel ? sel.dataset.unit : 'mm';
  return convLen(parseFloat(input.value) || 0, unit, 'mm');
}
function onRowUnitChange(sel) {
  const tr = sel.closest('tr');
  const dEl = tr.querySelector('.cDiam'),
    tEl = tr.querySelector('.cThick'),
    fEl = tr.querySelector('.cFloat');
  const oldU = sel.dataset.unit,
    newU = sel.value;
  const dv = parseFloat(dEl.value),
    tv = parseFloat(tEl.value),
    fv = parseFloat(fEl.value);
  if (!isNaN(dv)) dEl.value = fmtLen(convLen(dv, oldU, newU), newU);
  if (!isNaN(tv)) tEl.value = fmtLen(convLen(tv, oldU, newU), newU);
  if (!isNaN(fv)) fEl.value = fmtLen(convLen(fv, oldU, newU), newU);
  sel.dataset.unit = newU;
  // Steps follow real shim catalogs: metric 1mm OD / 0.05mm thickness increments
  // (RockShox tune shims: ODs 10,11,13,16–20,24mm; thicknesses 0.10/0.15/0.20/0.25/0.30),
  // imperial 0.025in OD / 0.0005in thickness increments (FOX-style).
  dEl.step = newU === 'mm' ? '1' : '0.025';
  tEl.step = newU === 'mm' ? '0.05' : '0.0005';
  fEl.step = newU === 'mm' ? '0.05' : '0.0005';
  drawShimRefDiagram();
}
function setAllFieldUnits(newU) {
  if (!newU) return;
  document.querySelectorAll('.fieldUnit').forEach((sel) => {
    sel.value = newU;
    onFieldUnitChange(sel);
  });
  document.querySelectorAll('.rowUnit').forEach((sel) => {
    sel.value = newU;
    onRowUnitChange(sel);
  });
}
function onModUnitChange(sel) {
  const input = document.getElementById('eMod');
  const oldU = sel.dataset.unit,
    newU = sel.value;
  const v = parseFloat(input.value);
  if (!isNaN(v)) input.value = Math.round(convMod(v, oldU, newU));
  sel.dataset.unit = newU;
}
function getModMPa() {
  const sel = document.querySelector('.modUnit[data-for="eMod"]');
  const unit = sel ? sel.dataset.unit : 'MPa';
  return convMod(parseFloat(document.getElementById('eMod').value) || 0, unit, 'MPa');
}

// ---- result unit (force/velocity/outputs) ----
function switchResultUnit(newU) {
  const oldU = resultUnit;
  if (newU === oldU) return;
  const fEl = document.getElementById('fMax');
  fEl.value = fmtForce(convForce(parseFloat(fEl.value), oldU, newU), newU);
  const uEl = document.getElementById('uMax');
  uEl.value = fmtVel(convVel(parseFloat(uEl.value), oldU, newU), newU);
  const axEl = document.getElementById('axisMaxF');
  if (axEl && axEl.value) axEl.value = fmtForce(convForce(parseFloat(axEl.value), oldU, newU), newU);
  const axMinEl = document.getElementById('axisMinF');
  if (axMinEl && axMinEl.value) axMinEl.value = fmtForce(convForce(parseFloat(axMinEl.value), oldU, newU), newU);
  const axUEl = document.getElementById('axisMaxU');
  if (axUEl && axUEl.value) axUEl.value = fmtVel(convVel(parseFloat(axUEl.value), oldU, newU), newU);
  const slider = document.getElementById('forceSlider');
  slider.max = convForce(parseFloat(slider.max), oldU, newU);
  slider.value = convForce(parseFloat(slider.value), oldU, newU);
  resultUnit = newU;
  document.querySelectorAll('.uforce').forEach((el) => (el.textContent = newU === 'mm' ? 'N' : 'lbf'));
  document.querySelectorAll('.uvel').forEach((el) => (el.textContent = newU === 'mm' ? 'mm/s' : 'in/s'));
  document.querySelectorAll('.ulen').forEach((el) => (el.textContent = newU === 'mm' ? 'mm' : 'in'));
  document.getElementById('sliderVal').textContent = fmtForce(parseFloat(slider.value), newU);
  if (currentStack) {
    drawStackAtSlider();
  }
  if (currentResults.length) {
    drawForceCurve();
    fillTable();
  }
  drawShimRefDiagram();
}

/* =========================================================
   OIL VISCOSITY COMPARISON PANEL
   Two oil cards (each a name + two arbitrary calibration points, same math as the
   former standalone Oil Viscosity Comparison page) plotted on one chart. Exactly one
   card is checked "active" at a time (see onOilActiveChange) - that's the fluid
   readFluid() hands to the shim-stack damping solver.
   ========================================================= */

// D.clamp uses this identical "auto-fills, sticks once you type into it directly"
// pattern (see clampDiaUserSet) - reused here for Oil temperature (°C), which resets
// to 21°C whenever the active oil changes, unless the user has directly edited it.
let oilTempUserSet = false;
let settingOilTempAuto = false;

function readOil(suffix) {
  return {
    t1: parseFloat(document.getElementById('temp1_m' + suffix).value),
    v1: parseFloat(document.getElementById('visc1_m' + suffix).value),
    t2: parseFloat(document.getElementById('temp2_m' + suffix).value),
    v2: parseFloat(document.getElementById('visc2_m' + suffix).value),
  };
}
function viscAt(oil, tempC) {
  return waltherViscAt(oil.t1, oil.v1, oil.t2, oil.v2, tempC);
}
// '' for Oil 1, '_2' for Oil 2 - whichever card's "Use for shim-stack calc" box is
// checked. Exactly one always is (see onOilActiveChange).
function activeOilSuffix() {
  return document.getElementById('oilActive2').checked ? '_2' : '';
}

function updateOilProbe(suffix) {
  const oil = readOil(suffix);
  const tempx = parseFloat(document.getElementById('tempx_m' + suffix).value);
  const v = viscAt(oil, tempx);
  document.getElementById('viscx_m' + suffix).textContent = v.toFixed(2);
  document.getElementById('viscx_i' + suffix).textContent = cstToSus(v).toFixed(2);
  const v40 = viscAtRef(40, oil.t1, oil.v1, oil.t2, oil.v2);
  const v100 = viscAtRef(100, oil.t1, oil.v1, oil.t2, oil.v2);
  const { vi, procedure } = viscosityIndex(v40, v100);
  const idx = suffix === '_2' ? '2' : '1';
  document.getElementById('vi_' + idx).textContent = isFinite(vi) ? vi : '—';
  document.getElementById('procedure_' + idx).textContent = procedure;
}

function recalcOilCompare() {
  document.getElementById('leg1name').textContent = document.getElementById('oil1_name').value || 'Oil 1';
  document.getElementById('leg2name').textContent = document.getElementById('oil2_name').value || 'Oil 2';
  updateOilProbe('');
  updateOilProbe('_2');
  drawOilChart();
}

// Checking one card's box unchecks the other - exactly one is always active, so the
// physics calc always has a defined fluid (can't uncheck down to zero-selected).
function onOilActiveChange(e) {
  const el = e.target;
  const other = document.getElementById(el.id === 'oilActive1' ? 'oilActive2' : 'oilActive1');
  if (el.checked) {
    other.checked = false;
  } else {
    el.checked = true;
    return;
  }
  if (!oilTempUserSet) {
    settingOilTempAuto = true;
    document.getElementById('oilTemp').value = 21;
    settingOilTempAuto = false;
  }
}

let oilPlotState = null; // cached scales from the last draw, used by hover/click
// Reads both oil cards + their probe-temp fields and delegates to the shared,
// state-driven js/oil-chart-visual.js.
function drawOilChart() {
  const probe1 = parseFloat(document.getElementById('tempx_m').value);
  const probe2 = parseFloat(document.getElementById('tempx_m_2').value);
  const oil1 = readOil(''),
    oil2 = readOil('_2');
  oilPlotState = drawOilChartVisual(document.getElementById('oilChart'), oil1, oil2, probe1, probe2);
  broadcastLiveVisuals({ oil: { oil1, oil2, probe1, probe2 } });
}

function updateOilHoverReadout(tempC) {
  const oil1 = readOil(''),
    oil2 = readOil('_2');
  const v1 = viscAt(oil1, tempC),
    v2 = viscAt(oil2, tempC);
  const name1 = document.getElementById('oil1_name').value || 'Oil 1';
  const name2 = document.getElementById('oil2_name').value || 'Oil 2';
  document.getElementById('hoverReadout').textContent =
    `${tempC.toFixed(1)}°C — ${name1}: ${v1.toFixed(2)} cSt (${cstToSus(v1).toFixed(1)} SUS)  ·  ${name2}: ${v2.toFixed(2)} cSt (${cstToSus(v2).toFixed(1)} SUS)`;
}
function setOilProbeTemp(tempC) {
  tempC = Math.max(OIL_MIN_TEMP, Math.min(OIL_MAX_TEMP, tempC));
  document.getElementById('tempx_m').value = tempC.toFixed(1);
  document.getElementById('tempx_m_2').value = tempC.toFixed(1);
  updateOilHoverReadout(tempC);
  recalcOilCompare();
}

/* =========================================================
   UI STATE + TABLE HANDLING
   ========================================================= */
let currentStack = null;
let currentGeom = null;
let currentRows = null;
let currentResults = []; // {u, F, Re} always stored in BASE units (mm/s, N)
// D.clamp auto-detection (see detectClampShimDiam()/runCalc()): once the user types directly
// into #clampDia, their value sticks and auto-detection stops touching it until a fresh
// example/config/setup is loaded. settingClampDiaAuto guards the field's own 'input' listener
// so the auto-set itself doesn't get mistaken for a manual edit.
let clampDiaUserSet = false;
let settingClampDiaAuto = false;
// The live stack preview's locked Y-axis scale (mm, canonical) - recomputed once per calc in
// runCalc() from the worst-case (max configured force) state, then reused for every slider
// position by drawStackAtSlider(). See computeStackYMaxMM()/drawStackCanvas() for why this
// needs to stay fixed across a single calc rather than tracking the current slider force.
let stackYMaxLockedMM = 1;
// Snapshot of the last successfully-computed stack, written on every calc so other pages
// (e.g. the Wheel Force Curve tool) can live-sync a compression valve config from this tab
// without an explicit export/import step. Same shape as gatherConfig() below.
const LIVE_CONFIG_KEY = 'sst_live_config_v1';

// Brief visual cue so a row you just added, duplicated, or reordered is easy to spot -
// see the .row-moved rule in styles.css for the actual background fade.
function flashRow(tr) {
  tr.classList.remove('row-moved');
  void tr.offsetWidth; // restart the transition if this row is already flashing
  tr.classList.add('row-moved');
  setTimeout(() => tr.classList.remove('row-moved'), 500);
}
// Reordering rows happens instantly (insertBefore), so without help a moved row just
// teleports to its new slot. This is a quick FLIP: the caller passes how far the row's
// top moved (old top minus new top); we start it visually offset by that same amount and
// let the CSS transition (see #shimBody tr in styles.css) ease it back to 0, so it visibly
// slides from its old position to its new one - showing which direction it moved.
function animateRowMove(tr, deltaY) {
  flashRow(tr);
  if (!deltaY) return;
  tr.style.transition = 'none';
  tr.style.transform = `translateY(${deltaY}px)`;
  void tr.offsetHeight; // force layout so the offset above applies before we clear it
  requestAnimationFrame(() => {
    tr.style.transition = '';
    tr.style.transform = '';
  });
}

function addShimRow(count, diam, thickness, unit, isSpecial, float, shimType) {
  const tbody = document.getElementById('shimBody');
  // Called with no arguments (the "+ Add shim row" button): clone the LAST row's unit
  // and dimensions so the new shim fits the stack being edited — an inch preset gets a
  // matching inch row, not a 30mm metric default that would dwarf the stack and (being
  // appended at the clamp end, wider than everything) leave the solver with no bonded
  // shim spanning the outer radii.
  if (count === undefined) {
    const last = tbody.lastElementChild;
    if (last) {
      unit = last.querySelector('.rowUnit').dataset.unit;
      diam = last.querySelector('.cDiam').value;
      thickness = last.querySelector('.cThick').value;
      count = 1;
      float = 0;
      isSpecial = null;
      shimType = last.querySelector('.rowType')?.value || 'round';
    }
  }
  const tr = document.createElement('tr');
  if (isSpecial) tr.className = isSpecial;
  const u = unit || 'mm';
  const type = shimType || 'round';
  const lenStep = u === 'mm' ? '1' : '0.025';
  const thickStep = u === 'mm' ? '0.05' : '0.0005';
  tr.innerHTML = `
    <td><input type="number" value="${count ?? 1}" step="1" class="cCount"></td>
    <td><input type="number" value="${diam ?? 30}" step="${lenStep}" class="cDiam"></td>
    <td><input type="number" value="${thickness ?? 0.25}" step="${thickStep}" class="cThick"></td>
    <td><input type="number" value="${float ?? 0}" step="${thickStep}" class="cFloat" title="0 = always engaged. Positive = gap that must close before this shim contributes."></td>
    <td class="col-type"><select class="rowType"><option value="round"${type === 'round' ? ' selected' : ''}>Round</option><option value="deltaT"${type === 'deltaT' ? ' selected' : ''}>Delta T</option></select></td>
    <td class="col-unit"><select class="rowUnit" data-unit="${u}"><option value="mm"${u === 'mm' ? ' selected' : ''}>mm</option><option value="in"${u === 'in' ? ' selected' : ''}>in</option></select></td>
    <td class="col-remove">
      <button class="small rowbtn" title="Move up (toward valve face)" data-action="up">↑</button><button class="small rowbtn" title="Move down (toward clamp)" data-action="down">↓</button><button class="small rowbtn" title="Duplicate this row below" data-action="dup">⧉</button><button class="small danger rowbtn" title="Remove row" data-action="remove">✕</button>
    </td>`;
  tbody.appendChild(tr);
  flashRow(tr);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}

function removeShimRow(btn) {
  btn.closest('tr').remove();
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}
function moveShimRow(btn, dir) {
  const tr = btn.closest('tr');
  const beforeTop = tr.getBoundingClientRect().top;
  if (dir < 0 && tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling);
  else if (dir > 0 && tr.nextElementSibling) tr.parentNode.insertBefore(tr.nextElementSibling, tr);
  animateRowMove(tr, beforeTop - tr.getBoundingClientRect().top);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}
function duplicateShimRow(btn) {
  const tr = btn.closest('tr');
  addShimRow(
    tr.querySelector('.cCount').value,
    tr.querySelector('.cDiam').value,
    tr.querySelector('.cThick').value,
    tr.querySelector('.rowUnit').dataset.unit,
    tr.className || null,
    tr.querySelector('.cFloat').value,
  );
  const newTr = tr.parentNode.lastElementChild;
  tr.parentNode.insertBefore(newTr, tr.nextSibling);
  flashRow(newTr);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}

// The stack preview and the deflection animation are one canvas now (stackCanvas, in the
// Shim stack configuration tile). This delegate keeps all the existing "something about
// the table changed, refresh the preview" call sites working: it redraws the animation
// from the last successful solve; the debounced live recalculation that follows the same
// edit then brings it fully up to date.
function drawShimRefDiagram() {
  try {
    if (currentStack && currentRows) drawStackAtSlider();
  } catch (e) {
    console.error('Stack preview draw failed (non-fatal):', e);
  }
}
/* ---- Live valve port face diagram (drawn to scale from the geometry inputs) ---- */
function drawPortFaceDiagram() {
  try {
    drawPortFaceDiagramInner();
  } catch (e) {
    console.error('Port face draw failed (non-fatal):', e);
  }
}
function drawPortFaceDiagramInner() {
  const cv = document.getElementById('portFaceCanvas');
  if (!cv) return;
  // Labels live in the HTML legend beside the canvas (see #portFaceCount/#portFaceNote in
  // shim-stack-tuner.html), not drawn into the canvas - canvas text is a fixed px size that
  // doesn't track the page's own font sizing, so it read inconsistently against real HTML text.
  const countEl = document.getElementById('portFaceCount');
  const noteEl = document.getElementById('portFaceNote');
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const rPort = getFieldMM('rPort'),
    dPort = getFieldMM('dPort'),
    wPort = getFieldMM('wPort');
  const nPort = Math.max(0, Math.round(parseFloat(document.getElementById('nPort').value) || 0));
  const dValve = getFieldMM('dValve'),
    dRod = getFieldMM('dRod');
  if (rPort <= 0 || dPort <= 0 || wPort <= 0 || nPort < 1 || dValve <= 0) {
    if (countEl) countEl.textContent = '';
    if (noteEl) {
      noteEl.textContent = 'Enter r.port, d.port, w.port, N.port and D.valve to draw the port face.';
      noteEl.classList.remove('legend-note');
      noteEl.style.display = '';
    }
    return;
  }
  if (noteEl) noteEl.classList.add('legend-note');
  const rOut = rPort + dPort;
  const rBody = Math.max(dValve / 2, rOut * 1.06);
  const cx = w / 2,
    cy = h / 2;
  const k = (Math.min(w, h) / 2 - 10) / rBody; // mm -> px

  // body + shaft
  ctx.beginPath();
  ctx.arc(cx, cy, rBody * k, 0, 2 * Math.PI);
  ctx.fillStyle = '#fbfcfe';
  ctx.fill();
  ctx.strokeStyle = '#1c2430';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (dRod > 0 && dRod / 2 < rBody) {
    ctx.beginPath();
    ctx.arc(cx, cy, (dRod / 2) * k, 0, 2 * Math.PI);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#5b6472';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  // ports: angular width taken at the OUTER edge (w.port is the width there)
  const halfAng = Math.min(wPort / 2 / rOut, (Math.PI / nPort) * 0.98);
  const overlap = (wPort / rOut) * nPort > 2 * Math.PI * 0.98;
  for (let i = 0; i < nPort; i++) {
    const aC = (i * 2 * Math.PI) / nPort - Math.PI / 2 + (nPort === 1 ? Math.PI / 2 : 0);
    ctx.beginPath();
    ctx.arc(cx, cy, rOut * k, aC - halfAng, aC + halfAng);
    ctx.arc(cx, cy, rPort * k, aC + halfAng, aC - halfAng, true);
    ctx.closePath();
    const primary = i === 0;
    ctx.fillStyle = primary ? '#c7d6fb' : '#dbe6ff';
    ctx.fill();
    ctx.strokeStyle = primary ? '#2f6fed' : '#8fa8e0';
    ctx.lineWidth = primary ? 1.5 : 1;
    ctx.stroke();
  }

  // dimension callouts on the first (top) port - colors match the legend swatches
  const aC = -Math.PI / 2 + (nPort === 1 ? Math.PI / 2 : 0);
  const dirX = Math.cos(aC),
    dirY = Math.sin(aC);
  // r.port: center -> inner edge
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + dirX * rPort * k, cy + dirY * rPort * k);
  ctx.stroke();
  // d.port: inner edge -> outer edge
  ctx.strokeStyle = '#0f9d58';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx + dirX * rPort * k, cy + dirY * rPort * k);
  ctx.lineTo(cx + dirX * rOut * k, cy + dirY * rOut * k);
  ctx.stroke();
  // w.port: chord across the outer edge of the first port
  const px1 = cx + Math.cos(aC - halfAng) * rOut * k,
    py1 = cy + Math.sin(aC - halfAng) * rOut * k;
  const px2 = cx + Math.cos(aC + halfAng) * rOut * k,
    py2 = cy + Math.sin(aC + halfAng) * rOut * k;
  ctx.strokeStyle = '#2f6fed';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px1, py1);
  ctx.lineTo(px2, py2);
  ctx.stroke();

  if (countEl) countEl.textContent = `N.port = ${nPort}`;
  if (noteEl) {
    if (rOut > dValve / 2 + 1e-9) {
      noteEl.textContent = 'Note: r.port + d.port exceeds the valve radius.';
      noteEl.style.display = '';
    } else if (overlap) {
      noteEl.textContent = 'Note: ports this wide would overlap each other.';
      noteEl.style.display = '';
    } else {
      noteEl.textContent = '';
      noteEl.style.display = 'none';
    }
  }
}

/* =========================================================
   PHOTO-ASSISTED PORT MEASUREMENT
   Enter one real dimension - D.valve, the piston outer diameter - then upload a straight-on
   photo of one or both piston faces. js/image-analysis.js finds the outer edge (pixel->mm
   scale + centre), the rod bore (D.rod) and the through-hole ports, clustered into radial
   groups. You label each group compression / rebound / throat / ignore; the tool keeps a
   compression set and a rebound set (each averaged across both photos' same-labelled groups)
   and "Apply [set]" writes r/d/w.port + N.port + D.rod + d.thrt/N.thrt + valve type into the
   geometry fields. "Manual trace mode" keeps the older 3-clicks-on-the-edge then
   trace-each-port flow (see computePortGeometryFromOutline / findStrongestEdgeNear in
   photo-measure.js) as a fallback for photos auto-detection can't handle. Points are stored
   in the PHOTO'S OWN natural pixel space (not canvas px) so the overlay and edge-snap stay
   anchored if the canvas resizes - photoImageToCanvasPt re-projects at draw time.
   ========================================================= */
const PHOTO_LABELS = ['compression', 'rebound', 'throat', 'ignore'];
const PHOTO_COLORS = { compression: '#2f6fed', rebound: '#0f9d58', throat: '#eab308', ignore: '#9aa4b2' };

let photos = []; // one entry per uploaded face; photos[0] = front, photos[1] = back
let photoActive = 0; // which entry the canvas shows
let photoMode = 'auto'; // 'auto' | 'manual'
let photoSnapEnabled = true; // manual-mode edge snap
let photoApplySet = 'compression'; // which stored set "Apply" writes
let photoDrawRect = null; // {x,y,w,h} in canvas CSS px - where the active image is drawn
let photoAdjusting = false; // dragging the outer-circle handles (auto mode)

function photoEntry() {
  return photos[photoActive] || null;
}
function makePhotoEntry(slot, name, img) {
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.drawImage(img, 0, 0);
  return {
    slot,
    name,
    img,
    offscreenCtx: octx, // full-res, for manual-mode edge snapping
    analysis: null,
    labels: {}, // groupId -> one of PHOTO_LABELS
    handles: null, // 3 points on the outer circle, for "Adjust circle"
    manual: {
      step: 'calibrate',
      calibPts: [],
      center: null,
      radiusPx: null,
      mmPerPx: null,
      currentTrace: [],
      ports: [],
    },
  };
}
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function photoCanvasToImagePt(x, y) {
  const e = photoEntry();
  return {
    x: ((x - photoDrawRect.x) * e.img.naturalWidth) / photoDrawRect.w,
    y: ((y - photoDrawRect.y) * e.img.naturalHeight) / photoDrawRect.h,
  };
}
function photoImageToCanvasPt(pt) {
  const e = photoEntry();
  return {
    x: photoDrawRect.x + (pt.x * photoDrawRect.w) / e.img.naturalWidth,
    y: photoDrawRect.y + (pt.y * photoDrawRect.h) / e.img.naturalHeight,
  };
}

// Reads a small full-resolution region around (imgX, imgY) and snaps to the strongest
// nearby edge (manual mode only), in the photo's natural pixel space.
function photoSnapPoint(imgX, imgY) {
  const e = photoEntry();
  if (!photoSnapEnabled || !e || !e.offscreenCtx) return { x: imgX, y: imgY };
  const radius = 12,
    pad = 2;
  const x0 = Math.max(0, Math.floor(imgX - radius - pad));
  const y0 = Math.max(0, Math.floor(imgY - radius - pad));
  const x1 = Math.min(e.img.naturalWidth, Math.ceil(imgX + radius + pad));
  const y1 = Math.min(e.img.naturalHeight, Math.ceil(imgY + radius + pad));
  const w = x1 - x0,
    h = y1 - y0;
  if (w <= 2 || h <= 2) return { x: imgX, y: imgY };
  const region = e.offscreenCtx.getImageData(x0, y0, w, h);
  const found = findStrongestEdgeNear(region, imgX - x0, imgY - y0, radius, 150);
  return found ? { x: x0 + found.x, y: y0 + found.y } : { x: imgX, y: imgY };
}

// Runs the CV pipeline on one photo. Analysis is done on a size-capped copy for speed;
// analysePhoto maps its results back to the photo's natural pixel space via srcToNatural,
// so they share the manual flow's coordinate model.
function runPhotoAnalysis(entry) {
  const dValveMM = getFieldMM('dValve');
  const iw = entry.img.naturalWidth,
    ih = entry.img.naturalHeight;
  const s = Math.min(1, 1400 / Math.max(iw, ih));
  const cw = Math.max(1, Math.round(iw * s)),
    ch = Math.max(1, Math.round(ih * s));
  const tmp = document.createElement('canvas');
  tmp.width = cw;
  tmp.height = ch;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(entry.img, 0, 0, cw, ch);
  entry.analysis = analysePhoto(tctx.getImageData(0, 0, cw, ch), dValveMM, 1 / s);
  entry.labels = {};
  entry.handles = null;
  const a = entry.analysis;
  if (!a.ok) return;
  const c = a.circle;
  entry.handles = [0, 2.0944, 4.1888].map((ang) => ({ x: c.cx + c.r * Math.cos(ang), y: c.cy + c.r * Math.sin(ang) }));
  const portGroups = a.groups.filter((g) => g.kind !== 'throat').sort((x, y) => x.meanRadiusMM - y.meanRadiusMM);
  a.groups.forEach((g) => {
    if (g.kind === 'throat') entry.labels[g.id] = 'throat';
    else if (portGroups.length === 2 && g.id === portGroups[0].id) entry.labels[g.id] = 'rebound';
    else entry.labels[g.id] = 'compression';
  });
}

// Re-fit the outer circle from the 3 dragged handles and recompute every port's geometry
// and the bore against the new scale (Adjust circle, auto mode).
function photoRefitFromHandles(entry) {
  const fit = circleFrom3Points(entry.handles[0], entry.handles[1], entry.handles[2]);
  const dValveMM = getFieldMM('dValve');
  const a = entry.analysis;
  if (!fit || !(dValveMM > 0) || !a || !a.ok) return;
  const circle = { cx: fit.center.x, cy: fit.center.y, r: fit.r };
  const mmPerPx = dValveMM / (2 * fit.r);
  a.circle = circle;
  a.mmPerPx = mmPerPx;
  const center = { x: circle.cx, y: circle.cy };
  a.groups.forEach((g) => {
    g.ports.forEach((p) => (p.geom = computePortGeometryFromOutline(center, mmPerPx, p.boundary)));
    g.meanRadiusMM =
      (g.ports.reduce((s, p) => s + Math.hypot(p.centroid.x - circle.cx, p.centroid.y - circle.cy), 0) /
        g.ports.length) *
      mmPerPx;
  });
  if (a.bore) a.dRodMM = 2 * a.bore.r * mmPerPx;
}

// Merges every group carrying each label, across both photos, into the final port sets
// plus a throat spec and a D.rod reading.
function resolvePhotoSets() {
  const buckets = { compression: [], rebound: [], throat: [] };
  const dRods = [];
  for (const entry of photos) {
    if (!entry) continue;
    const auto = photoMode === 'auto' && entry.analysis && entry.analysis.ok;
    if (auto) {
      if (entry.analysis.dRodMM) dRods.push(entry.analysis.dRodMM);
      for (const g of entry.analysis.groups) {
        const label = entry.labels[g.id] || 'ignore';
        if (label === 'ignore') continue;
        const live = g.ports.filter((p) => !p.excluded && p.geom);
        if (!live.length) continue;
        const avg = (f) => live.reduce((s, p) => s + f(p.geom), 0) / live.length;
        buckets[label].push({
          rPort: avg((x) => x.rPort),
          dPort: avg((x) => x.dPort),
          wPort: avg((x) => x.wPort),
          count: Math.max(live.length, g.suggestedCount || live.length),
        });
      }
    } else {
      const m = entry.manual;
      if (m && m.ports.length && m.mmPerPx) {
        const label = photoApplySet === 'rebound' ? 'rebound' : 'compression';
        m.ports.forEach((p) =>
          buckets[label].push({
            rPort: p.result.rPort,
            dPort: p.result.dPort,
            wPort: p.result.wPort,
            count: m.ports.length,
          }),
        );
      }
    }
  }
  const mergePorts = (arr) => {
    if (!arr.length) return null;
    const a = (f) => arr.reduce((s, x) => s + f(x), 0) / arr.length;
    return {
      rPort: a((x) => x.rPort),
      dPort: a((x) => x.dPort),
      wPort: a((x) => x.wPort),
      nPort: Math.max(...arr.map((x) => x.count)),
    };
  };
  const throat = buckets.throat.length
    ? {
        dThrt: buckets.throat.reduce((s, x) => s + (x.dPort + x.wPort) / 2, 0) / buckets.throat.length,
        nThrt: Math.max(...buckets.throat.map((x) => x.count)),
      }
    : null;
  return {
    compression: mergePorts(buckets.compression),
    rebound: mergePorts(buckets.rebound),
    throat,
    dRodMM: dRods.length ? dRods.reduce((s, x) => s + x, 0) / dRods.length : null,
  };
}
function photoCanApply() {
  const s = resolvePhotoSets();
  return !!(s.compression || s.rebound);
}

function photoManualInstruction(m) {
  if (m.step === 'calibrate') {
    const n = m.calibPts.length;
    return n === 0
      ? "Click 3 points anywhere along the valve's outer edge."
      : `${3 - n} more edge point${3 - n === 1 ? '' : 's'} (${n}/3).`;
  }
  const n = m.currentTrace.length;
  return n === 0
    ? 'Click points around one port (3+), then "Finish this port".'
    : `${n} point${n === 1 ? '' : 's'} - keep clicking, or press "Finish this port".`;
}

// (Re)builds the per-group label rows for the active photo (auto mode only).
function renderPhotoGroups() {
  const host = document.getElementById('photoGroups');
  if (!host) return;
  host.innerHTML = '';
  const e = photoEntry();
  if (photoMode !== 'auto' || !e || !e.analysis || !e.analysis.ok) return;
  e.analysis.groups.forEach((g) => {
    const label = e.labels[g.id] || 'ignore';
    const live = g.ports.filter((p) => !p.excluded).length;
    const row = document.createElement('div');
    row.className = 'photo-group-row';
    const dot = document.createElement('span');
    dot.className = 'photo-group-dot';
    dot.style.background = PHOTO_COLORS[label];
    const txt = document.createElement('span');
    txt.className = 'photo-group-text';
    txt.textContent = `${live} port${live === 1 ? '' : 's'} · r≈${fmtLen(g.meanRadiusMM, 'mm')}mm · ${
      g.kind === 'throat' ? 'small/round' : 'kidney'
    }`;
    const sel = document.createElement('select');
    sel.className = 'small';
    PHOTO_LABELS.forEach((L) => {
      const o = document.createElement('option');
      o.value = L;
      o.textContent = L[0].toUpperCase() + L.slice(1);
      o.selected = L === label;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      e.labels[g.id] = sel.value;
      updatePhotoUI();
      drawPhotoCanvas();
    });
    row.append(dot, txt, sel);
    host.appendChild(row);
  });
}

function photoSetSummaryText(sets) {
  const line = (name, s) =>
    s
      ? `${name}: r.port ${fmtLen(s.rPort, 'mm')} · d.port ${fmtLen(s.dPort, 'mm')} · w.port ${fmtLen(s.wPort, 'mm')} mm · N ${Math.round(s.nPort)}`
      : `${name}: —`;
  const out = [line('Compression', sets.compression), line('Rebound', sets.rebound)];
  if (sets.throat)
    out.push(`Throat: d.thrt ${fmtLen(sets.throat.dThrt, 'mm')} mm · N ${Math.round(sets.throat.nThrt)}`);
  if (sets.dRodMM) out.push(`D.rod ≈ ${fmtLen(sets.dRodMM, 'mm')} mm`);
  return out.join('\n');
}

function updatePhotoUI() {
  const e = photoEntry();
  const loaded = photos.filter(Boolean).length;
  const manual = photoMode === 'manual';

  const tabs = document.getElementById('photoTabs');
  if (tabs) {
    tabs.style.display = loaded > 1 ? '' : 'none';
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.idx) === photoActive));
  }
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  };
  show('photoModeRow', !!e);
  const snapLabel = document.getElementById('photoSnapToggle').closest('label');
  if (snapLabel) snapLabel.style.display = manual ? '' : 'none';
  show('photoUndoBtn', manual);
  show('photoFinishPortBtn', manual);
  show('photoAdjustBtn', !!e && !manual);
  show('photoApplyRow', !!e);

  const hint = document.getElementById('photoStepHint');
  if (!e) hint.textContent = 'Enter D.valve above, then choose a front photo.';
  else if (manual) hint.textContent = photoManualInstruction(e.manual);
  else if (!e.analysis) hint.textContent = 'Analysing…';
  else if (!e.analysis.ok)
    hint.textContent = e.analysis.warnings[0] || 'Auto-detection failed — try Manual trace mode.';
  else
    hint.textContent =
      'Set each group to compression / rebound / throat / ignore. Click a port on the image to drop it.';

  const warnEl = document.getElementById('photoWarnings');
  const warns = !manual && e && e.analysis && e.analysis.warnings ? e.analysis.warnings : [];
  warnEl.textContent = warns.join(' ');
  warnEl.style.display = warnEl.textContent ? '' : 'none';

  if (photoAdjusting) document.getElementById('photoAdjustBtn').classList.add('active');
  else document.getElementById('photoAdjustBtn').classList.remove('active');

  renderPhotoGroups();

  const sets = resolvePhotoSets();
  const sum = document.getElementById('photoSummary');
  sum.textContent = photoCanApply() ? photoSetSummaryText(sets) : '';
  sum.style.display = sum.textContent ? '' : 'none';

  document.getElementById('photoApplyBtn').disabled = !photoCanApply();
  document.getElementById('photoResetBtn').disabled = !e;
  document.getElementById('photoUndoBtn').disabled =
    !manual || !e || (e.manual.step === 'calibrate' && !e.manual.calibPts.length && !e.manual.ports.length);
  document.getElementById('photoFinishPortBtn').disabled = !manual || !e || e.manual.currentTrace.length < 3;
  const applySel = document.getElementById('photoApplySetSel');
  if (applySel && applySel.value !== photoApplySet) applySel.value = photoApplySet;
}

function drawCircleImg(ctx, c, stroke, dash) {
  const p = photoImageToCanvasPt({ x: c.cx, y: c.cy });
  const rPx = c.r * (photoDrawRect.w / photoEntry().img.naturalWidth);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dash || []);
  ctx.beginPath();
  ctx.arc(p.x, p.y, rPx, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawPolyImg(ctx, imgPts, fill, stroke) {
  if (imgPts.length < 2) return;
  const pts = imgPts.map(photoImageToCanvasPt);
  ctx.beginPath();
  pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  if (fill) {
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawPhotoCanvas() {
  const e = photoEntry();
  if (!e) return;
  const cv = document.getElementById('photoCanvas');
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w / e.img.naturalWidth, h / e.img.naturalHeight);
  const dw = e.img.naturalWidth * scale,
    dh = e.img.naturalHeight * scale;
  photoDrawRect = { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
  ctx.drawImage(e.img, photoDrawRect.x, photoDrawRect.y, dw, dh);

  if (photoMode === 'auto' && e.analysis && e.analysis.ok) {
    const a = e.analysis;
    drawCircleImg(ctx, a.circle, '#eab308', [6, 4]);
    if (a.bore) drawCircleImg(ctx, a.bore, '#5b6472', []);
    a.groups.forEach((g) => {
      const col = PHOTO_COLORS[e.labels[g.id] || 'ignore'];
      g.ports.forEach((p) =>
        drawPolyImg(
          ctx,
          p.contour,
          p.excluded ? 'rgba(154,164,178,0.12)' : hexToRgba(col, 0.28),
          p.excluded ? '#9aa4b2' : col,
        ),
      );
    });
    if (photoAdjusting && e.handles) {
      e.handles.forEach((hp) => {
        const q = photoImageToCanvasPt(hp);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = '#eab308';
        ctx.fill();
        ctx.strokeStyle = '#1c2430';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
    return;
  }

  // manual mode overlay
  const m = e.manual;
  m.calibPts.forEach((pt) => {
    const p = photoImageToCanvasPt(pt);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#eab308';
    ctx.fill();
  });
  if (m.center && m.radiusPx) drawCircleImg(ctx, { cx: m.center.x, cy: m.center.y, r: m.radiusPx }, '#eab308', [5, 4]);
  m.ports.forEach(({ points }) => drawPolyImg(ctx, points, 'rgba(143,168,224,0.2)', '#8fa8e0'));
  if (m.currentTrace.length) {
    const cvPts = m.currentTrace.map(photoImageToCanvasPt);
    ctx.strokeStyle = '#2f6fed';
    ctx.lineWidth = 2;
    ctx.beginPath();
    cvPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.fillStyle = '#2f6fed';
    cvPts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
      ctx.fill();
    });
  }
}

function photoPointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function photoCanvasClick(ev) {
  const entry = photoEntry();
  if (!entry || !photoDrawRect) return;
  const rect = document.getElementById('photoCanvas').getBoundingClientRect();
  const cx = ev.clientX - rect.left,
    cy = ev.clientY - rect.top;
  if (
    cx < photoDrawRect.x ||
    cx > photoDrawRect.x + photoDrawRect.w ||
    cy < photoDrawRect.y ||
    cy > photoDrawRect.y + photoDrawRect.h
  )
    return;
  const img = photoCanvasToImagePt(cx, cy);

  if (photoMode === 'auto') {
    const a = entry.analysis;
    if (!a || !a.ok) return;
    if (photoAdjusting && entry.handles) {
      let bi = 0,
        bd = Infinity;
      entry.handles.forEach((hp, i) => {
        const d = Math.hypot(hp.x - img.x, hp.y - img.y);
        if (d < bd) ((bd = d), (bi = i));
      });
      entry.handles[bi] = photoSnapPoint(img.x, img.y);
      photoRefitFromHandles(entry);
    } else {
      for (const g of a.groups) {
        for (const p of g.ports) {
          if (photoPointInPoly(img, p.contour)) {
            p.excluded = !p.excluded;
            updatePhotoUI();
            drawPhotoCanvas();
            return;
          }
        }
      }
      return;
    }
  } else {
    const m = entry.manual;
    const pt = photoSnapPoint(img.x, img.y);
    if (m.step === 'calibrate') {
      m.calibPts.push(pt);
      if (m.calibPts.length === 3) {
        const fit = circleFrom3Points(m.calibPts[0], m.calibPts[1], m.calibPts[2]);
        const dValveMM = getFieldMM('dValve');
        if (!fit) {
          m.calibPts.pop();
          document.getElementById('photoStepHint').textContent =
            'Those 3 points are nearly in a line - click further around the edge.';
          drawPhotoCanvas();
          return;
        }
        if (!(dValveMM > 0)) {
          m.calibPts = [];
          document.getElementById('photoStepHint').textContent = 'Enter D.valve (above) first.';
          drawPhotoCanvas();
          return;
        }
        m.center = fit.center;
        m.radiusPx = fit.r;
        m.mmPerPx = dValveMM / (2 * fit.r);
        m.step = 'trace';
      }
    } else {
      m.currentTrace.push(pt);
    }
  }
  updatePhotoUI();
  drawPhotoCanvas();
}

function photoFinishPort() {
  const e = photoEntry();
  if (!e || photoMode !== 'manual') return;
  const m = e.manual;
  if (m.currentTrace.length < 3) return;
  m.ports.push({
    points: m.currentTrace.slice(),
    result: computePortGeometryFromOutline(m.center, m.mmPerPx, m.currentTrace),
  });
  m.currentTrace = [];
  updatePhotoUI();
  drawPhotoCanvas();
}

function photoUndo() {
  const e = photoEntry();
  if (!e || photoMode !== 'manual') return;
  const m = e.manual;
  if (m.step === 'calibrate') m.calibPts.pop();
  else if (m.currentTrace.length) m.currentTrace.pop();
  else if (m.ports.length) m.ports.pop();
  else {
    m.step = 'calibrate';
    m.center = m.radiusPx = m.mmPerPx = null;
    m.calibPts = [];
  }
  updatePhotoUI();
  drawPhotoCanvas();
}

function setPhotoMode(mode) {
  photoMode = mode === 'manual' ? 'manual' : 'auto';
  photoAdjusting = false;
  const e = photoEntry();
  if (e && photoMode === 'auto' && !e.analysis) runPhotoAnalysis(e);
  updatePhotoUI();
  drawPhotoCanvas();
}

function photoReset() {
  photos = [];
  photoActive = 0;
  photoAdjusting = false;
  photoApplySet = 'compression';
  ['photoFileFront', 'photoFileBack'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('photoCanvas').style.display = 'none';
  updatePhotoUI();
}

function applyPhotoResult() {
  const sets = resolvePhotoSets();
  const chosen = sets[photoApplySet];
  if (!chosen) return;
  const changed = [];
  const setMM = (id, mm) => {
    setFieldValueAndUnit(id, fmtLen(mm, 'mm'), 'mm');
    changed.push(id);
  };
  setMM('rPort', chosen.rPort);
  setMM('dPort', chosen.dPort);
  setMM('wPort', chosen.wPort);
  document.getElementById('nPort').value = Math.max(1, Math.round(chosen.nPort));
  changed.push('nPort');
  if (sets.throat) {
    setMM('dThrt', sets.throat.dThrt);
    document.getElementById('nThrt').value = Math.max(1, Math.round(sets.throat.nThrt));
    changed.push('nThrt');
  }
  if (sets.dRodMM) setMM('dRod', sets.dRodMM);
  const vt = document.getElementById('valveType');
  if (vt.value !== 'base') {
    vt.value = photoApplySet === 'rebound' ? 'mainRebound' : 'mainComp';
    changed.push('valveType');
  }
  changed.forEach((id) => document.getElementById(id).dispatchEvent(new Event('input', { bubbles: true })));
}

function loadPhotoFile(evt) {
  const file = evt.target.files[0];
  const slot = Number(evt.target.dataset.slot || 0);
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const entry = makePhotoEntry(slot, file.name, img);
    photos[slot] = entry;
    photoActive = slot;
    if (photoMode === 'auto') runPhotoAnalysis(entry);
    document.getElementById('photoCanvas').style.display = 'block';
    updatePhotoUI();
    drawPhotoCanvas();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    document.getElementById('photoStepHint').textContent = 'Could not load that image file.';
  };
  img.src = url;
  evt.target.value = '';
}

function clearPresetSelection() {
  const sel = document.getElementById('tuneSel');
  if (sel) {
    const opt = sel.querySelector('option[value="__custom"]');
    if (opt) opt.remove();
    sel.value = '';
  }
  const note = document.getElementById('presetNote');
  if (note) note.textContent = '';
  stockRowsSig = null;
  stockTuneInfo = null; // stop custom-tracking (no named stock baseline)
}

function loadExample() {
  clearPresetSelection();
  clampDiaUserSet = false;
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', 12, 'mm');
  setFieldValueAndUnit('clampDia', 12, 'mm');
  // clamp washer (20mm) is smaller than the last taper shim (22mm) — a conventional
  // fully-bonded stack with no crossover, so the default example has no engagement knee.
  const rowsMM = [
    [1, 38, 0.25],
    [1, 34, 0.25],
    [1, 30, 0.25],
    [1, 26, 0.25],
    [1, 22, 0.25],
    [1, 20, 3.0],
    [1, 16, 3.0],
  ];
  rowsMM.forEach((r, i) => {
    addShimRow(
      r[0],
      r[1],
      r[2],
      'mm',
      i >= rowsMM.length - 2 ? (i === rowsMM.length - 2 ? 'clamp-row' : 'nut-row') : null,
      0,
    );
  });
  showWarn(null);
  scheduleLiveCalc();
}

// Fresh sessions (no saved sst_live_config_v1 yet) default to a real catalog tune - RockShox
// Vivid Coil Rebound R01 - instead of the hand-built demo stack, so a first-time user sees
// realistic geometry and force numbers rather than loadExample()'s placeholder sizes. Uses
// the same product/valve/tune selection path as picking it from the dropdowns by hand.
function loadDefaultTune() {
  if (!PRODUCTS['rsVividCoil2025']) {
    loadExample(); // catalog didn't load - fall back to the hand-built demo stack
    return;
  }
  curProduct = 'rsVividCoil2025';
  curValveKey = 'rebound';
  populateProductSel();
  populateValveSel();
  applyValveContext();
  const tuneSel = document.getElementById('tuneSel');
  tuneSel.value = 'r01';
  onTuneChange();
}

/* ---- product/valve/tune selection ---- */
let curProduct = 'fox38x2',
  curValveKey = 'rebound';
function currentValve() {
  return PRODUCTS[curProduct] && PRODUCTS[curProduct].valves[curValveKey];
}
// Every product stores its shim/geometry dimensions canonically in inches (see
// catalog.json), same as FOX's own drawings. A metric-sourced product (e.g. RockShox,
// units:'mm') just carries a display hint so the catalog/tune UI shows native mm instead
// of showing a metric shim as an odd inch decimal - the underlying physics is unaffected.
function prodDispUnit() {
  return PRODUCTS[curProduct] && PRODUCTS[curProduct].units === 'mm' ? 'mm' : 'in';
}
// FOX's own catalog rounds .0031in/.0032in drawing noise to a single canonical value
// (see canonThk) - that snap is meaningless, and lightly lossy, for a metric-sourced
// catalog whose inch values are already exact conversions from mm.
function catalogSnapsThk() {
  return prodDispUnit() !== 'mm';
}
function toDispLen(valIn, unit) {
  return unit === 'mm' ? convLen(valIn, 'in', 'mm') : valIn;
}

function populateProductSel() {
  const sel = document.getElementById('prodSel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const pk in PRODUCTS) {
    const o = document.createElement('option');
    o.value = pk;
    o.textContent = PRODUCTS[pk].label;
    sel.appendChild(o);
  }
  sel.value = curProduct;
}
function populateValveSel() {
  const sel = document.getElementById('valveSel');
  if (!sel) return;
  sel.innerHTML = '';
  if (!PRODUCTS[curProduct]) return; // catalog failed to load - leave the select empty
  const valves = PRODUCTS[curProduct].valves;
  for (const vk in valves) {
    const o = document.createElement('option');
    o.value = vk;
    o.textContent = valves[vk].label;
    sel.appendChild(o);
  }
  if (!valves[curValveKey]) curValveKey = Object.keys(valves)[0];
  sel.value = curValveKey;
}
function populateTuneSel() {
  const sel = document.getElementById('tuneSel');
  if (!sel) return;
  sel.innerHTML = '<option value="" selected disabled>choose stock tune…</option>';
  const tunes = currentValve().tunes;
  for (const tk in tunes) {
    const t = tunes[tk];
    const o = document.createElement('option');
    o.value = tk;
    o.textContent = `${t.label} — ${t.kit}`;
    sel.appendChild(o);
  }
}
function onProductChange() {
  curProduct = document.getElementById('prodSel').value;
  if (!PRODUCTS[curProduct]) return;
  curValveKey = Object.keys(PRODUCTS[curProduct].valves)[0];
  populateValveSel();
  applyValveContext();
}
function onValveChange() {
  curValveKey = document.getElementById('valveSel').value;
  applyValveContext();
}
function applyValveContext() {
  const v = currentValve();
  if (!v) return;
  document.getElementById('valveType').value = v.valveType;
  loadValveGeom(v);
  populateTuneSel();
  renderCatalog();
}
function renderCatalog() {
  const v = currentValve();
  if (!v) return;
  const list = usableShims(v);
  const cc = document.getElementById('catalogCount');
  if (cc) cc.textContent = `${list.length} parts`;
  const note = document.getElementById('catalogNote');
  const du = prodDispUnit();
  if (note)
    note.innerHTML = `ID ${fmtLen(toDispLen(v.shimID, du), du)}${du} · OD ${fmtLen(toDispLen(v.odMin, du), du)}–${fmtLen(toDispLen(v.odMax, du), du)}${du} · height target ±${(v.heightTolIn * IN).toFixed(2)}mm. Click a shim to add it to the stack:`;
  const chips = document.getElementById('catalogChips');
  if (chips) {
    chips.innerHTML = list
      .map((s) => {
        const odD = fmtLen(toDispLen(s.od, du), du);
        const thkD = fmtLen(toDispLen(s.thk, du), du);
        const isDelta = s.type === 'deltaT';
        return `<button class="small catchip" data-od="${s.od}" data-thk="${s.thk}" data-type="${s.type || 'round'}" title="Add one ${odD}${du} OD${isDelta ? ' (delta/triangle)' : ''} × ${thkD}${du} shim">${odD}${isDelta ? '<b>T</b>' : ''}<span style="opacity:.6">×</span>${thkD}</button>`;
      })
      .join('');
  }
}
// Add a catalog shim to the current stack, inserted in descending-OD order so the widest
// shim always sits at the valve face (keeps the stack solver-valid — a floating widest
// shim has nothing bonded spanning the outer radii). Reorder afterward with the row ↑↓.
// od/thk arrive in canonical inches; displayed in the current product's native unit.
function addCatalogShim(od, thk, type) {
  const tbody = document.getElementById('shimBody');
  const du = prodDispUnit();
  addShimRow(1, fmtLen(toDispLen(od, du), du), fmtLen(toDispLen(thk, du), du), du, null, 0, type || 'round');
  const newTr = tbody.lastElementChild;
  const odMM = od * IN;
  let ref = null;
  for (const tr of tbody.querySelectorAll('tr')) {
    if (tr === newTr) continue;
    const u = tr.querySelector('.rowUnit').dataset.unit;
    const trOD = convLen(parseFloat(tr.querySelector('.cDiam').value) || 0, u, 'mm');
    if (trOD < odMM - 1e-9) {
      ref = tr;
      break;
    }
  }
  if (ref) tbody.insertBefore(newTr, ref);
  drawShimRefDiagram();
  scheduleLiveCalc();
  refreshCustomState();
}

// track whether the loaded stack still matches its stock tune (for the "custom" label)
let stockRowsSig = null; // signature of the loaded stock tune's rows (null = not tracking)
let stockTuneInfo = null; // {kit,label,note}
let loadingStock = false; // guard so building the stock stack doesn't flag itself custom
function rowsSig(rows) {
  return rows
    .map(
      (r) =>
        `${r.count}:${r.diam.toFixed(3)}:${r.thickness.toFixed(4)}:${(r.float || 0).toFixed(3)}:${r.type || 'round'}`,
    )
    .join('|');
}
function setTuneSelCustom(isCustom) {
  const sel = document.getElementById('tuneSel');
  if (!sel) return;
  let opt = sel.querySelector('option[value="__custom"]');
  if (isCustom) {
    if (!opt) {
      opt = document.createElement('option');
      opt.value = '__custom';
      opt.textContent = '✏️ Custom (modified)';
      sel.appendChild(opt);
    }
    sel.value = '__custom';
  } else if (opt) {
    opt.remove();
  }
}
function refreshCustomState() {
  updateStackHeightDisplay();
  if (loadingStock || stockRowsSig === null) return;
  const isCustom = rowsSig(readRows()) !== stockRowsSig;
  setTuneSelCustom(isCustom);
  const note = document.getElementById('presetNote');
  if (!note) return;
  if (isCustom) {
    note.innerHTML = `<b>✏️ Custom</b> — modified from ${stockTuneInfo.kit} “${stockTuneInfo.label}”. Re-select that tune to restore stock.`;
  } else if (stockTuneInfo) {
    if (stockTuneInfo.key) document.getElementById('tuneSel').value = stockTuneInfo.key; // reselect the stock tune
    note.innerHTML = stockTuneInfo.note;
  }
}

// FOX publishes a dimensioned assembly drawing (PDF) for every Float X / DHX service kit.
// The kits split across two help-page asset dirs by model year; only the six 2022 kits use
// the older one. Returns null for any kit number that isn't a Float X / DHX valve-stack kit
// (e.g. the 820-xx FOX 38 kits, or RockShox's R01/C03 codes) so those stay plain text.
const FOX_FLOATX_2022_KITS = new Set([
  '805-05-215-KIT',
  '805-05-509-KIT',
  '805-05-510-KIT',
  '805-05-511-KIT',
  '805-05-512-KIT',
  '805-05-545-KIT',
]);
function foxDrawingUrl(kit) {
  if (!/^805-05-\d{3}-KIT$/.test(kit)) return null;
  const dir = FOX_FLOATX_2022_KITS.has(kit) ? 'page2871-EGZW' : 'page2958-IVPT';
  return `https://tech.ridefox.com/img/help/${dir}/${kit}.pdf`;
}

function onTuneChange() {
  const tk = document.getElementById('tuneSel').value;
  const v = currentValve();
  if (!v) return;
  const t = v.tunes[tk];
  if (!t) return;
  loadingStock = true;
  setTuneSelCustom(false);
  const du = prodDispUnit();
  const snap = catalogSnapsThk();
  const thkIn = (r) => (snap ? canonThk(r[2]) : r[2]);
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', fmtLen(toDispLen(v.shimID, du), du), du);
  t.rows.forEach((r) =>
    addShimRow(
      r[0],
      fmtLen(toDispLen(r[1], du), du),
      fmtLen(toDispLen(thkIn(r), du), du),
      du,
      null,
      0,
      r[3] || 'round',
    ),
  );
  document.getElementById('valveType').value = v.valveType;
  const total = t.rows.reduce((s, r) => s + r[0] * thkIn(r), 0);
  const heightBit =
    t.heightIn != null
      ? `drawing stack height ${t.heightIn.toFixed(3)}in (tune-shim total ${total.toFixed(4)}in)`
      : t.floatIn
        ? `float window ${t.floatIn}in (drawing stack height incl. spacer/spring hardware, not modeled)`
        : `tune-shim total ${total.toFixed(4)}in`;
  const dwgUrl = foxDrawingUrl(t.kit);
  const kitLabel = dwgUrl ? `<a href="${dwgUrl}" target="_blank" rel="noopener noreferrer">${t.kit}</a>` : t.kit;
  const noteHtml = `<b>${kitLabel}</b> — "${PRODUCTS[curProduct].label}, ${v.label}, ${t.label}". ${heightBit}.`;
  document.getElementById('presetNote').innerHTML = noteHtml;
  showWarn(null);
  pendingStockCapture = true; // capture this stock tune's curve as the target reference
  stockHeightMM = total * IN; // reference height for optimizer
  // baseline for "custom" detection
  stockTuneInfo = { kit: t.kit, label: `${v.label} ${t.label}`, note: noteHtml, key: tk };
  stockRowsSig = rowsSig(readRows());
  loadingStock = false;
  updateStackHeightDisplay();
  scheduleLiveCalc();
}

/* ---- per product+valve geometry persistence ---- */
const GEOM_KEY = 'sst_prodGeom_v1';
function geomKeyFor() {
  return curProduct + '/' + curValveKey;
}
function loadValveGeom(v) {
  clampDiaUserSet = false;
  const saved = (lsGet(GEOM_KEY) || {})[geomKeyFor()];
  const g = saved || v.geom;
  const du = prodDispUnit();
  const stackIDIn = g.stackID_in != null ? g.stackID_in : v.shimID;
  const clampDiaIn = g.clampDia_in != null ? g.clampDia_in : stackIDIn;
  setFieldValueAndUnit('stackID', fmtLen(toDispLen(stackIDIn, du), du), du);
  setFieldValueAndUnit('clampDia', fmtLen(toDispLen(clampDiaIn, du), du), du);
  ['dRod', 'dValve', 'rPort', 'dPort', 'wPort', 'dThrt'].forEach((id) =>
    setFieldValueAndUnit(id, fmtLen(g[id], 'mm'), 'mm'),
  );
  document.getElementById('nPort').value = g.nPort;
  document.getElementById('nThrt').value = g.nThrt;
  const hint = document.getElementById('geomSaveHint');
  if (hint) {
    hint.textContent = saved
      ? 'using your saved geometry'
      : v.geomNote
        ? `using approximate defaults — ${v.geomNote}`
        : 'using approximate defaults';
  }
  drawPortFaceDiagram();
}
function saveValveGeom() {
  const all = lsGet(GEOM_KEY) || {};
  all[geomKeyFor()] = {
    stackID_in: getFieldMM('stackID') / IN,
    clampDia_in: getFieldMM('clampDia') / IN,
    dRod: getFieldMM('dRod'),
    dValve: getFieldMM('dValve'),
    rPort: getFieldMM('rPort'),
    dPort: getFieldMM('dPort'),
    wPort: getFieldMM('wPort'),
    dThrt: getFieldMM('dThrt'),
    nPort: parseFloat(document.getElementById('nPort').value) || 0,
    nThrt: parseFloat(document.getElementById('nThrt').value) || 0,
  };
  const ok = lsSet(GEOM_KEY, all);
  const hint = document.getElementById('geomSaveHint');
  if (hint)
    hint.textContent = ok
      ? `saved geometry for ${PRODUCTS[curProduct].label} · ${currentValve().label}`
      : 'saved for this session (browser is blocking storage for local files)';
}
function initProductUX() {
  populateProductSel();
  populateValveSel();
  applyValveContext();
}

// label of the currently-selected stock tune (for pin auto-naming)
function currentTuneLabel() {
  const v = currentValve();
  const tk = document.getElementById('tuneSel') ? document.getElementById('tuneSel').value : '';
  if (v && v.tunes[tk]) return `${v.label} ${v.tunes[tk].label}`;
  if (tk === '__custom') return stockTuneInfo ? `${stockTuneInfo.label} (custom)` : 'Custom';
  return '';
}

// demonstrates the Float mechanism: a soft base stack plus a backup shim that only
// engages once the stack has already deflected a fair amount, producing a visible knee.
// Note: the backup shim's OD must not exceed the largest always-engaged shim's OD, or
// there'd be a real physical gap at the outer edge before it engages (see About panel —
// the model needs continuous material from the clamp ID out to the loaded radius).
function loadCrossoverExample() {
  clearPresetSelection();
  clampDiaUserSet = false;
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', 12, 'mm');
  setFieldValueAndUnit('clampDia', 12, 'mm');
  const rowsMM = [
    [1, 32, 0.2],
    [1, 28, 0.2],
    [1, 24, 0.2],
  ];
  rowsMM.forEach((r) => addShimRow(r[0], r[1], r[2], 'mm', null, 0));
  // backup shim: bonded like a normal row (Count/Diam/Thick) but with Float>0 so it only
  // starts contributing once the bending stack beneath closes the gap under it. Note the
  // total gap at its outer edge is the 0.05 Float PLUS the thickness of the narrower
  // 24/28mm shims it overhangs (structural crossover, detected automatically) — with the
  // default 400N range it engages around a sixth of the way up the curve.
  // OD (30mm) stays within the primary stack's reach (32mm) so it never leaves the
  // solver without bridging material.
  addShimRow(1, 30, 0.3, 'mm', null, 0.05);
  document.getElementById('fMax').value = fmtForce(convForce(400, 'mm', resultUnit), resultUnit);
  showWarn(null);
  scheduleLiveCalc();
}

function setFieldValueAndUnit(id, value, unit) {
  document.getElementById(id).value = value;
  const sel = document.querySelector(`.fieldUnit[data-for="${id}"], .modUnit[data-for="${id}"]`);
  if (sel) {
    sel.value = unit;
    sel.dataset.unit = unit;
  }
}

function readRows() {
  const rows = [];
  document.querySelectorAll('#shimBody tr').forEach((tr) => {
    const count = parseFloat(tr.querySelector('.cCount').value) || 0;
    const unit = tr.querySelector('.rowUnit').dataset.unit;
    const diam = convLen(parseFloat(tr.querySelector('.cDiam').value) || 0, unit, 'mm');
    const thickness = convLen(parseFloat(tr.querySelector('.cThick').value) || 0, unit, 'mm');
    const floatEl = tr.querySelector('.cFloat');
    const float = Math.max(0, convLen(parseFloat(floatEl ? floatEl.value : 0) || 0, unit, 'mm'));
    const typeEl = tr.querySelector('.rowType');
    const type = typeEl ? typeEl.value : 'round';
    const special = tr.className || null;
    if (count > 0 && diam > 0 && thickness > 0) rows.push({ count, diam, thickness, float, special, type });
  });
  return rows;
}

// A separate clamp washer and/or nut is normally modeled as ordinary rows at the clamp end
// of the table (per the D.clamp hint's own advice) — several shims sharing one OD, stacked
// last. When that pattern shows up, D.clamp should just match it automatically instead of
// needing to be kept in sync by hand. Returns the shared OD in mm, or null if the last row
// isn't part of a same-OD run of at least 2.
function detectClampShimDiam(rows) {
  if (rows.length < 2) return null;
  const od = rows[rows.length - 1].diam;
  let n = 0;
  for (let i = rows.length - 1; i >= 0 && Math.abs(rows[i].diam - od) < 1e-6; i--) n++;
  return n >= 2 ? od : null;
}

function readGeom() {
  return {
    dRod: getFieldMM('dRod'),
    dValve: getFieldMM('dValve'),
    rPort: getFieldMM('rPort'),
    dPort: getFieldMM('dPort'),
    wPort: getFieldMM('wPort'),
    nPort: parseFloat(document.getElementById('nPort').value),
    dThrt: getFieldMM('dThrt'),
    nThrt: parseFloat(document.getElementById('nThrt').value),
    stackID: getFieldMM('stackID'),
    clampDia: getFieldMM('clampDia'),
  };
}
function readMech() {
  return { E: getModMPa(), nu: parseFloat(document.getElementById('nu').value) };
}
// Pulls calibration points straight from whichever oil card is checked "active" (see
// activeOilSuffix()/onOilActiveChange) - the shim-stack calc always uses exactly the
// same fluid the comparison chart is plotting for that card.
function readFluid() {
  const oil = readOil(activeOilSuffix());
  return {
    rho: parseFloat(document.getElementById('rho').value),
    Cd: parseFloat(document.getElementById('cd').value),
    t1: oil.t1,
    v1: oil.v1,
    t2: oil.t2,
    v2: oil.v2,
    tempC: parseFloat(document.getElementById('oilTemp').value),
    Re0: parseFloat(document.getElementById('re0').value) || 10,
  };
}
function readValveType() {
  return document.getElementById('valveType').value;
}

function showWarn(msg) {
  const box = document.getElementById('warnBox');
  if (!msg) {
    box.style.display = 'none';
    box.textContent = '';
    return;
  }
  box.style.display = 'block';
  box.textContent = msg;
}

/* =========================================================
   RUN
   ========================================================= */
// runCalc({live}) — when live=true, this was triggered automatically by an edit rather
// than the Run button, so we (a) keep the force slider where the user left it instead of
// snapping it back to max, and (b) route problems to a quiet inline status line rather
// than the big red warning box, since half-finished input is expected mid-typing.
function runCalc(opts) {
  const live = !!(opts && opts.live);
  if (!live) showWarn(null);
  const rows = readRows();
  if (!clampDiaUserSet) {
    const autoOD = detectClampShimDiam(rows);
    if (autoOD != null && Math.abs(getFieldMM('clampDia') - autoOD) > 1e-6) {
      const u = document.querySelector('.fieldUnit[data-for="clampDia"]').dataset.unit || 'mm';
      settingClampDiaAuto = true;
      setFieldValueAndUnit('clampDia', fmtLen(convLen(autoOD, 'mm', u), u), u);
      settingClampDiaAuto = false;
    }
    const note = document.getElementById('clampDiaAutoNote');
    if (note) note.textContent = autoOD != null ? '(auto-matched to the shims at the clamp end)' : '';
  }
  if (rows.length < 2) {
    if (live) {
      liveStatus('err', 'waiting for at least 2 shim rows…');
    } else {
      showWarn('Add at least a couple of shim rows.');
    }
    return;
  }
  const geom = readGeom();
  const mech = readMech();
  const fluid = readFluid();
  const valveType = readValveType();
  const fMaxRaw = parseFloat(document.getElementById('fMax').value);
  const uMaxRaw = parseFloat(document.getElementById('uMax').value);
  const Fmax = convForce(fMaxRaw, resultUnit, 'mm');
  const uMax = convVel(uMaxRaw, resultUnit, 'mm');
  const nPts = Math.max(6, parseInt(document.getElementById('nPts').value) || 26);

  let stack;
  try {
    stack = buildStack(rows, geom, mech, { Fmax, nSteps: 150, nSeg: 350 });
  } catch (e) {
    if (live) {
      liveStatus('err', e.message);
    } else {
      showWarn(e.message);
    }
    return;
  }
  currentStack = stack;
  currentGeom = geom;
  currentRows = rows;
  broadcastLiveVisuals({ shims: { rows, unit: resultUnit } });
  // Lock the stack preview's Y-axis to this calc's worst case now, once - see
  // stackYMaxLockedMM's declaration and drawStackCanvas() for why.
  stackYMaxLockedMM = computeStackYMaxMM(Fmax, stack, geom, rows);
  lsSet(LIVE_CONFIG_KEY, { geom, mech, fluid, valveType, fMax: Fmax, uMax, nPts: String(nPts), rows });
  // The native 'storage' event only fires in *other* tabs/windows, never for changes made on
  // this same page - dispatch a matching custom event so same-page listeners (the merged Wheel
  // Force Curve panel, pop-out windows in the future) can react to a fresh calc too.
  document.dispatchEvent(new CustomEvent('sst-live-config-changed'));

  const results = [];
  for (let i = 0; i < nPts; i++) {
    const frac = i / (nPts - 1);
    const u = uMax * Math.pow(frac, 1.8);
    const r = solveForceAtVelocity(Math.max(u, 0.01), stack, geom, fluid, valveType, Fmax);
    results.push({ u, F: r.F, Re: r.Re });
  }
  results[0].u = 0;
  results[0].F = 0;
  results[0].Re = 0;
  currentResults = results;

  const slider = document.getElementById('forceSlider');
  const newMax = parseFloat(fmtForce(fMaxRaw, resultUnit));
  if (live) {
    // preserve the fraction of travel the user was viewing
    const oldMax = parseFloat(slider.max) || newMax;
    const frac = oldMax > 0 ? Math.min(1, (parseFloat(slider.value) || 0) / oldMax) : 1;
    slider.max = newMax;
    slider.value = fmtForce(newMax * frac, resultUnit);
  } else {
    slider.max = newMax;
    slider.value = fmtForce(fMaxRaw, resultUnit);
  }
  document.getElementById('sliderVal').textContent = fmtForce(parseFloat(slider.value), resultUnit);

  // snapshot the stock reference curve when a stock tune was just loaded
  if (pendingStockCapture) {
    stockCurve = currentResults.map((p) => ({ u: p.u, F: p.F }));
    pendingStockCapture = false;
  }

  drawStackAtSlider();
  drawForceCurve();
  fillTable();
  updateTargetReadout();

  const engaged =
    stack.engageLog && stack.engageLog.length
      ? stack.engageLog.map((e) => {
          const Fd = fmtForce(convForce(e.F, 'mm', resultUnit), resultUnit);
          return `row ${e.rowIndex + 1} engages at ≈${Fd} ${resultUnit === 'mm' ? 'N' : 'lbf'}`;
        })
      : [];

  if (live) {
    const pkF = fmtForce(convForce(results[results.length - 1].F, 'mm', resultUnit), resultUnit);
    let msg = `updated — peak damping ≈ ${pkF} ${resultUnit === 'mm' ? 'N' : 'lbf'}`;
    if (engaged.length) msg += ` · ${engaged.join('; ')}`;
    liveStatus('ok', msg);
  } else if (engaged.length) {
    showWarn(
      'Shim engagement during this run (Float gap and/or a structural crossover closing) — ' +
        engaged.join('; ') +
        '. (This is informational, not an error.)',
    );
  }
}

/* ---- Live (auto) recalculation ---------------------------------------------
   Debounced so a burst of keystrokes only triggers one solve. The physics build
   is ~10ms so this stays snappy, but debouncing avoids running it on every digit. */
let liveTimer = null;
function liveStatus(kind, msg) {
  const el = document.getElementById('liveStatus');
  if (!el) return;
  el.className = 'live-status ' + (kind || '');
  el.textContent = msg || '';
}
function scheduleLiveCalc() {
  const box = document.getElementById('liveMode');
  if (!box || !box.checked) return;
  liveStatus('calc', 'calculating…');
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    runCalc({ live: true });
  }, 260);
}
function onLiveModeChange() {
  const box = document.getElementById('liveMode');
  const btn = document.getElementById('recalcBtn');
  if (box && box.checked) {
    if (btn) btn.style.display = 'none';
    runCalc({ live: true });
  } else {
    if (btn) btn.style.display = '';
    liveStatus('', 'live update off — press Recalculate to refresh');
  }
}

// Reads the current slider force and current stack/geom/rows, then delegates to the
// shared, state-driven drawing functions in js/stack-visual.js (used identically by any
// pop-out window synced to the same state).
function drawStackAtSlider() {
  if (!currentStack || !currentRows) return;
  const Fdisp = parseFloat(document.getElementById('forceSlider').value) || 0;
  document.getElementById('sliderVal').textContent = fmtForce(Fdisp, resultUnit);
  const Fbase = convForce(Fdisp, resultUnit, 'mm');
  const { bands, rLoadDisp, clampDisp, shaftDisp } = buildBandsAtForce(
    Fbase,
    resultUnit,
    currentStack,
    currentGeom,
    currentRows,
  );
  const yMaxLocked = convLen(stackYMaxLockedMM, 'mm', resultUnit);
  drawStackCanvas(
    document.getElementById('stackCanvas'),
    bands,
    rLoadDisp,
    clampDisp,
    shaftDisp,
    yMaxLocked,
    resultUnit,
  );
  broadcastLiveVisuals({
    stack: { bands, rLoad: rLoadDisp, clampR: clampDisp, shaftR: shaftDisp, yMaxLocked, resultUnit },
  });
}

/* ---- pinned comparison curves + force-axis control ---- */
let pinnedCurves = []; // {name, color, results:[{u,F}]} — always base units (mm/s, N)
const PIN_COLORS = ['#8e44ad', '#e08e0b', '#d1495b', '#16a3b0', '#8a6d1a', '#33415c', '#c2185b', '#455a64'];
const PINS_KEY = 'sst_pins_v1',
  AXIS_KEY = 'sst_axis_v1';

function pinCurrentCurve() {
  if (!currentResults.length) {
    liveStatus('err', 'nothing to pin yet — make an edit so a curve is computed');
    return;
  }
  const nameEl = document.getElementById('pinName');
  let name = (nameEl.value || '').trim();
  if (!name) {
    name = currentTuneLabel() || 'Stack ' + (pinnedCurves.length + 1);
  }
  const color = PIN_COLORS[pinnedCurves.length % PIN_COLORS.length];
  pinnedCurves.push({ name, color, results: currentResults.map((p) => ({ u: p.u, F: p.F })) });
  if (pinnedCurves.length > 8) pinnedCurves.shift(); // keep the chart readable
  nameEl.value = '';
  lsSet(PINS_KEY, pinnedCurves);
  renderPinList();
  drawForceCurve();
}
function removePin(i) {
  pinnedCurves.splice(i, 1);
  lsSet(PINS_KEY, pinnedCurves);
  renderPinList();
  drawForceCurve();
}
function clearPins() {
  pinnedCurves = [];
  lsSet(PINS_KEY, pinnedCurves);
  renderPinList();
  drawForceCurve();
}
function renderPinList() {
  const el = document.getElementById('pinList');
  if (!el) return;
  el.innerHTML = '';
  pinnedCurves.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'pin-chip';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = p.color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(p.name));
    const btn = document.createElement('button');
    btn.title = 'remove';
    btn.textContent = '✕';
    btn.addEventListener('click', () => removePin(i));
    chip.appendChild(btn);
    el.appendChild(chip);
  });
}
function onAxisSettingChange() {
  const mode = document.getElementById('axisMode').value;
  document.getElementById('axisMaxWrap').style.display = mode === 'fixed' ? '' : 'none';
  const fEl = document.getElementById('axisMaxF');
  if (mode === 'fixed' && !(parseFloat(fEl.value) > 0)) {
    // prefill with the current chart maximum rounded up to a round number
    const maxN = Math.max(
      100,
      ...currentResults.map((p) => p.F),
      ...pinnedCurves.flatMap((c) => c.results.map((p) => p.F)),
    );
    const disp = convForce(maxN, 'mm', resultUnit);
    const mag = Math.pow(10, Math.floor(Math.log10(disp)));
    fEl.value = Math.ceil(disp / mag) * mag;
  }
  const fminEl = document.getElementById('axisMinF');
  // X (shaft velocity) axis
  const xMode = document.getElementById('xAxisMode').value;
  document.getElementById('xAxisMaxWrap').style.display = xMode === 'fixed' ? '' : 'none';
  const xEl = document.getElementById('axisMaxU');
  if (xMode === 'fixed' && !(parseFloat(xEl.value) > 0)) {
    const maxU = Math.max(
      100,
      ...currentResults.map((p) => p.u),
      ...pinnedCurves.flatMap((c) => c.results.map((p) => p.u)),
    );
    const disp = convVel(maxU, 'mm', resultUnit);
    const mag = Math.pow(10, Math.floor(Math.log10(disp)));
    xEl.value = Math.ceil(disp / mag) * mag;
  }
  lsSet(AXIS_KEY, {
    mode,
    maxN: convForce(parseFloat(fEl.value) || 0, resultUnit, 'mm'),
    minN: convForce(parseFloat(fminEl.value) || 0, resultUnit, 'mm'),
    xMode,
    maxU: convVel(parseFloat(xEl.value) || 0, resultUnit, 'mm'),
  });
  drawForceCurve();
}
function restoreAxisPrefs() {
  const a = lsGet(AXIS_KEY);
  if (!a) return;
  document.getElementById('axisMode').value = a.mode || 'auto';
  if (a.maxN > 0) document.getElementById('axisMaxF').value = fmtForce(convForce(a.maxN, 'mm', resultUnit), resultUnit);
  if (a.minN > 0) document.getElementById('axisMinF').value = fmtForce(convForce(a.minN, 'mm', resultUnit), resultUnit);
  document.getElementById('axisMaxWrap').style.display = a.mode === 'fixed' ? '' : 'none';
  document.getElementById('xAxisMode').value = a.xMode || 'auto';
  if (a.maxU > 0) document.getElementById('axisMaxU').value = fmtVel(convVel(a.maxU, 'mm', resultUnit), resultUnit);
  document.getElementById('xAxisMaxWrap').style.display = a.xMode === 'fixed' ? '' : 'none';
}

let forceChartMap = null; // {pad,w,h,xMax,yMax,yMin} in display units — for hit-testing
let hiddenCurves = new Set(); // labels of curves toggled off via the legend
let legendHits = []; // clickable legend rects {label,x0,y0,x1,y1}
// Gathers current state + axis-preference DOM values and delegates to the shared,
// state-driven js/force-curve-visual.js - forceChartMap/legendHits are this page's own
// pointer-interaction state (target-handle dragging, legend-click hide/show), fed back
// from the pure function's return value.
function drawForceCurve() {
  const xModeEl = document.getElementById('xAxisMode');
  const xMaxEl = document.getElementById('axisMaxU');
  const modeEl = document.getElementById('axisMode');
  const fEl = document.getElementById('axisMaxF'),
    fminEl = document.getElementById('axisMinF');
  const forceOpts = {
    resultUnit,
    pinnedCurves,
    currentResults,
    optCandidates,
    targetOn,
    stockCurve,
    targetHandles,
    hiddenCurves,
    dragHandle,
    xMode: xModeEl ? xModeEl.value : 'auto',
    xFixed: xMaxEl ? parseFloat(xMaxEl.value) || 0 : 0,
    mode: modeEl ? modeEl.value : 'auto',
    fixedMax: fEl ? parseFloat(fEl.value) || 0 : 0,
    fixedMin: fminEl ? parseFloat(fminEl.value) || 0 : 0,
  };
  const { forceChartMap: fcm, legendHits: lh } = drawForceCurveVisual(
    document.getElementById('forceCanvas'),
    forceOpts,
  );
  forceChartMap = fcm;
  legendHits = lh;
  // dragHandle is main-page-only interaction state (which target handle is mid-drag) - the
  // pop-out is a read-only mirror, so it's dropped rather than broadcast. hiddenCurves is a
  // Set, which doesn't survive the JSON round-trip through localStorage (see live-sync.js) -
  // sent as a plain array instead; the pop-out rebuilds the Set before drawing.
  const forceForBroadcast = { ...forceOpts };
  delete forceForBroadcast.dragHandle;
  forceForBroadcast.hiddenCurves = [...hiddenCurves];
  broadcastLiveVisuals({ force: forceForBroadcast });
}

/* =========================================================
   TARGET CURVE (Phase 2) — draggable desired-force line over the chart.
   Handles hold {u, F} in base units (mm/s, N). u is fixed per handle; you drag F.
   The stock reference is snapshotted whenever a stock tune loads.
   ========================================================= */
let targetOn = false,
  targetHandles = [],
  stockCurve = null,
  dragHandle = -1,
  pendingStockCapture = false;
const TARGET_KEY = 'sst_target_v2'; // v2: denser handle set + origin-anchored line

function saveTarget() {
  lsSet(TARGET_KEY, { on: targetOn, handles: targetHandles });
}
function restoreTarget() {
  const t = lsGet(TARGET_KEY);
  if (!t) return;
  targetOn = !!t.on;
  targetHandles = t.handles || [];
  const box = document.getElementById('targetOn');
  if (box) box.checked = targetOn;
}
// Handle spacing is denser at low shaft speed, where a small force change is a big feel
// change, and sparser up top. The origin (0,0) is always part of the target line but is
// not a draggable handle — at zero shaft speed there's no damping force, by definition.
const TARGET_FRACS = [0.03, 0.07, 0.12, 0.18, 0.26, 0.35, 0.45, 0.56, 0.68, 0.8, 0.9, 1.0];
function resetTargetToCurrent() {
  if (!currentResults.length) return;
  const uMaxB = currentResults[currentResults.length - 1].u;
  const us = currentResults.map((p) => p.u),
    fs = currentResults.map((p) => p.F);
  targetHandles = TARGET_FRACS.map((f) => {
    const u = uMaxB * f;
    return { u, F: interpArr(us, fs, u) };
  });
  saveTarget();
  drawForceCurve();
  updateTargetReadout();
}
function clearTarget() {
  targetHandles = [];
  targetOn = false;
  const box = document.getElementById('targetOn');
  if (box) box.checked = false;
  const cv = document.getElementById('forceCanvas');
  if (cv) cv.style.touchAction = '';
  saveTarget();
  drawForceCurve();
  updateTargetReadout();
}
function onTargetToggle() {
  targetOn = document.getElementById('targetOn').checked;
  const cv = document.getElementById('forceCanvas');
  if (cv) cv.style.touchAction = targetOn ? 'none' : ''; // let the handle drag win over page scroll on touch
  if (targetOn && !targetHandles.length) resetTargetToCurrent();
  saveTarget();
  drawForceCurve();
  updateTargetReadout();
}
function updateTargetReadout() {
  const el = document.getElementById('targetReadout');
  if (!el) return;
  if (!targetOn || !targetHandles.length || !currentResults.length) {
    el.textContent = '';
    return;
  }
  const us = currentResults.map((p) => p.u),
    fs = currentResults.map((p) => p.F);
  let se = 0,
    worst = 0;
  targetHandles.forEach((hn) => {
    const cur = interpArr(us, fs, hn.u);
    const d = hn.F - cur;
    const pct = cur > 1e-6 ? (100 * d) / cur : 0;
    se += d * d;
    if (Math.abs(pct) > Math.abs(worst)) worst = pct;
  });
  const rms = Math.sqrt(se / targetHandles.length);
  const uf = resultUnit === 'mm' ? 'N' : 'lbf';
  el.textContent = `current vs target — RMS ${fmtForce(convForce(rms, 'mm', resultUnit), resultUnit)} ${uf}, worst ${worst > 0 ? '+' : ''}${worst.toFixed(0)}%`;
}
// pointer on the force chart (mouse + touch via pointer events): legend clicks toggle a
// line's visibility (works any time); dragging a target handle edits the target (target mode).
function forceCanvasPointer(e, phase) {
  if (!forceChartMap) return;
  const cv = document.getElementById('forceCanvas');
  const rect = cv.getBoundingClientRect();
  const px = e.clientX - rect.left,
    py = e.clientY - rect.top;
  const { pad, w, h, xMax, yMax, yMin } = forceChartMap;
  const Xh = (u) => pad.l + (w - pad.l - pad.r) * (u / xMax);
  const Yh = (F) => h - pad.b - (h - pad.t - pad.b) * ((F - yMin) / (yMax - yMin));
  if (phase === 'down') {
    // legend hit? toggle that curve's visibility
    for (const lh of legendHits) {
      if (px >= lh.x0 && px <= lh.x1 && py >= lh.y0 && py <= lh.y1) {
        if (hiddenCurves.has(lh.label)) hiddenCurves.delete(lh.label);
        else hiddenCurves.add(lh.label);
        e.preventDefault();
        drawForceCurve();
        return;
      }
    }
    if (!targetOn) return;
    let best = -1,
      bd = 14;
    targetHandles.forEach((hn, i) => {
      const dx = px - Xh(convVel(hn.u, 'mm', resultUnit)),
        dy = py - Yh(convForce(hn.F, 'mm', resultUnit));
      const dist = Math.hypot(dx, dy);
      if (dist < bd) {
        bd = dist;
        best = i;
      }
    });
    dragHandle = best;
    if (best >= 0) {
      e.preventDefault();
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
    }
  } else if (phase === 'move') {
    if (dragHandle < 0) return;
    e.preventDefault();
    const FD = yMin + ((yMax - yMin) * (h - pad.b - py)) / (h - pad.t - pad.b);
    targetHandles[dragHandle].F = Math.max(0, convForce(FD, resultUnit, 'mm'));
    drawForceCurve();
    updateTargetReadout();
  } else {
    // up
    if (dragHandle >= 0) {
      dragHandle = -1;
      saveTarget();
    }
  }
}

/* =========================================================
   OPTIMIZER (Phase 3) — search the valve's real-shim catalog for stacks whose damping
   curve best matches the target line. Local hill-climb from the current stack (so it
   stays close to what you loaded) with a few perturbed restarts for diversity. Every
   candidate is built ONLY from catalog parts, kept in descending-OD (widest-at-face)
   order so it's always solver-valid, and scored on curve fit plus a soft stack-height
   penalty that leans thick (never under the reference height).
   ========================================================= */
let optCandidates = []; // [{label,color,rows:[{count,od_in,thk_in}],err,hMM,flag,curve}]
let stockHeightMM = 0; // reference height (mm) from the last stock tune loaded
const OPT_COLORS = ['#2563eb', '#0891b2', '#7c3aed'];

function currentStackHeightMM() {
  return readRows().reduce((s, r) => s + r.count * r.thickness, 0);
}

// Live "how does this compare to what I loaded" readout shown just above the shim table.
// Always shows the current total stack thickness; once a stock tune is loaded (the same
// stockRowsSig/stockTuneInfo tracking refreshCustomState() uses for the "Custom (modified)"
// label), it also shows the live delta against that tune's original height, scored against
// the same soft height-tolerance band the optimizer uses (never under, small over allowance).
function updateStackHeightDisplay() {
  const valEl = document.getElementById('stackHeightVal');
  const deltaEl = document.getElementById('stackHeightDelta');
  if (!valEl || !deltaEl) return;
  const totalMM = currentStackHeightMM();
  valEl.textContent = `${totalMM.toFixed(3)}mm (${convLen(totalMM, 'mm', 'in').toFixed(4)}in)`;
  if (stockRowsSig === null || !stockTuneInfo) {
    deltaEl.textContent = '';
    return;
  }
  const v = currentValve();
  const tolOver = ((v && v.heightTolIn) || 0.05 / IN) * IN;
  const delta = totalMM - stockHeightMM;
  let flag, color;
  if (delta < -1e-4) {
    flag = '▼ under stock';
    color = 'var(--warn)';
  } else if (delta > tolOver + 1e-4) {
    flag = '▲ over tolerance';
    color = '#e08e0b';
  } else {
    flag = '✓ in-band';
    color = 'var(--accent2)';
  }
  const sign = delta >= 0 ? '+' : '−';
  deltaEl.innerHTML = ` — vs stock <b>${stockTuneInfo.label}</b> (${stockHeightMM.toFixed(3)}mm reference, allowed up to +${tolOver.toFixed(2)}mm, never under): <span style="color:${color}">${sign}${Math.abs(delta).toFixed(3)}mm</span> ${flag}`;
}

function optimizeToTarget() {
  const status = document.getElementById('optStatus');
  if (!targetOn || !targetHandles.length) {
    status.textContent = 'Turn on Target curve and shape it first.';
    return;
  }
  const v = currentValve();
  const catalog = usableShims(v);
  if (!catalog.length) {
    status.textContent = 'No catalog for this valve — pick a Product/Valve first.';
    return;
  }
  status.textContent = 'searching real shims…';
  document.getElementById('optBtn').disabled = true;
  // let the status paint before the (blocking) search
  setTimeout(() => {
    try {
      runOptimize(v, catalog);
    } finally {
      document.getElementById('optBtn').disabled = false;
    }
  }, 20);
}

function runOptimize(v, catalog) {
  const geom = readGeom(),
    mech = readMech(),
    fluid = readFluid(),
    valveType = readValveType();
  const Fmax = convForce(parseFloat(document.getElementById('fMax').value), resultUnit, 'mm');
  const evalVels = targetHandles.map((hn) => hn.u).filter((u) => u > 0);
  const txU = [0, ...targetHandles.map((h) => h.u)],
    txF = [0, ...targetHandles.map((h) => h.F)];
  const tgtF = (u) => interpArr(txU, txF, u);
  const meanTgt = Math.max(1, txF.reduce((a, b) => a + b, 0) / txF.length);
  const Href = stockHeightMM > 0 ? stockHeightMM : currentStackHeightMM();
  const tolOver = (v.heightTolIn || 0.05 / IN) * IN; // mm the stack may exceed Href by
  const ODS = [...new Set(catalog.map((s) => s.od))].sort((a, b) => a - b);
  // Round and delta (triangle) shims at the same OD are different physical parts - see
  // shimScaleAt() in physics.js - so thickness lookups and part identity are keyed on
  // type too, not just OD, or the search would silently treat a 23mm delta as if it were
  // a full round disc.
  const thksFor = (od, type) =>
    catalog.filter((s) => Math.abs(s.od - od) < 1e-9 && (s.type || 'round') === (type || 'round')).map((s) => s.thk);
  const variantsAt = (od) => catalog.filter((s) => Math.abs(s.od - od) < 1e-9);
  const nearest = (arr, x) => arr.reduce((b, t) => (Math.abs(t - x) < Math.abs(b - x) ? t : b), arr[0]);
  // The face shim covers the valve ports, so the widest (face) OD is fixed for this valve
  // and must always be present. The optimizer may change the face shim's thickness/count
  // but never its OD, and can never leave the stack with no port-covering shim.
  const faceOD = v.faceOD || v.odMax;
  const faceCnt = (c) => c.reduce((s, x) => (Math.abs(x.od - faceOD) < 1e-9 ? s + x.count : s), 0);
  const isFace = (s) => Math.abs(s.od - faceOD) < 1e-9;

  const clone = (c) => c.map((x) => ({ ...x }));
  // ORDER-PRESERVING normalization: merge only CONSECUTIVE identical rows, keep sequence
  // intact (order is physical — a narrow "pivot" shim above a wider one makes a crossover).
  const norm = (c) => {
    const out = [];
    for (const s of c) {
      const last = out[out.length - 1];
      if (
        last &&
        Math.abs(last.od - s.od) < 1e-9 &&
        Math.abs(last.thk - s.thk) < 1e-9 &&
        (last.type || 'round') === (s.type || 'round')
      )
        last.count += s.count;
      else out.push({ count: s.count, od: s.od, thk: s.thk, type: s.type || 'round' });
    }
    return out;
  };
  // the piston-contacting shim (row 0) must be the port-covering face OD; keep it there
  const ensureFace = (c) => {
    let cc = clone(c);
    if (cc.length && isFace(cc[0])) return cc;
    const fi = cc.findIndex(isFace);
    if (fi > 0) {
      const [f] = cc.splice(fi, 1);
      cc.unshift(f);
    } else if (fi < 0) {
      const variants = variantsAt(faceOD);
      // Normally faceOD is itself a real catalog OD, so variants[0] is always defined.
      // Fall back to the catalog entry closest to faceOD on the rare chance a
      // product/valve is defined with a faceOD that doesn't match one of its tune rows.
      const fv =
        variants[0] ||
        catalog.reduce((best, s) => (Math.abs(s.od - faceOD) < Math.abs(best.od - faceOD) ? s : best), catalog[0]);
      cc.unshift({ count: 1, od: fv.od, thk: fv.thk, type: fv.type || 'round' });
    }
    return cc;
  };
  const prep = (c) => norm(ensureFace(c));
  const sig = (c) =>
    prep(c)
      .map((s) => `${s.count}x${s.od.toFixed(3)}${s.type === 'deltaT' ? 'T' : ''}x${s.thk.toFixed(4)}`)
      .join('>'); // order- and type-sensitive

  const cache = new Map();
  const BUDGET = 2400;
  function evalStack(c) {
    const cn = prep(c);
    if (faceCnt(cn) < 1 || !isFace(cn[0])) return null; // ports must be covered by the contacting shim
    const rows = cn.map((s) => ({
      count: s.count,
      diam: s.od * IN,
      thickness: s.thk * IN,
      float: 0,
      type: s.type || 'round',
    }));
    let stack;
    try {
      stack = buildStack(rows, geom, mech, { Fmax, nSteps: 55, nSeg: 110 });
    } catch {
      return null;
    }
    let se = 0;
    for (const u of evalVels) {
      const r = solveForceAtVelocity(Math.max(u, 0.01), stack, geom, fluid, valveType, Fmax);
      const d = r.F - tgtF(u);
      se += d * d;
    }
    const err = Math.sqrt(se / evalVels.length);
    const hMM = cn.reduce((s, x) => s + x.count * x.thk * IN, 0);
    return { err, hMM, rows: cn };
  }
  function ev(c) {
    const k = sig(c);
    if (cache.has(k)) return cache.get(k);
    const e = evalStack(c);
    cache.set(k, e);
    return e;
  }
  function score(e) {
    if (!e) return Infinity;
    let pen = 0;
    const under = Href - e.hMM;
    if (under > 1e-4)
      pen += 8 * under; // never go under the reference
    else {
      const overBand = e.hMM - (Href + tolOver);
      if (overBand > 0) pen += 3 * overBand;
    } // mild if too thick
    return e.err + pen * meanTgt; // scale mm penalty into force units
  }
  // Neighborhood now explores ORDER (crossover/pivot arrangements), not just a taper:
  // per-row thickness/OD/count edits, swap adjacent shims, and insert a catalog shim at
  // several positions behind the face. The face shim (row 0) keeps its port-covering OD.
  function neighbors(c) {
    const cc = prep(c);
    const out = [];
    cc.forEach((s, i) => {
      thksFor(s.od, s.type).forEach((t) => {
        if (Math.abs(t - s.thk) > 1e-9) {
          const n = clone(cc);
          n[i] = { ...s, thk: t };
          out.push(n);
        }
      });
      // round <-> delta swap at the same OD/thickness, when that exact part exists
      variantsAt(s.od).forEach((vv) => {
        if ((vv.type || 'round') !== (s.type || 'round') && Math.abs(vv.thk - s.thk) < 1e-9) {
          const n = clone(cc);
          n[i] = { ...s, type: vv.type || 'round' };
          out.push(n);
        }
      });
      // OD change: allowed on any non-face row (i>=1) — this is how a pivot/crossover forms
      if (i >= 1) {
        ODS.forEach((od) => {
          if (Math.abs(od - s.od) > 1e-9) {
            variantsAt(od).forEach((vv) => {
              const ths = thksFor(od, vv.type);
              if (!ths.length) return;
              const nt = ths.some((t) => Math.abs(t - s.thk) < 1e-9) ? s.thk : nearest(ths, s.thk);
              const n = clone(cc);
              n[i] = { ...s, od, thk: nt, type: vv.type || 'round' };
              out.push(n);
            });
          }
        });
      }
      if (s.count < 8) {
        const n = clone(cc);
        n[i] = { ...s, count: s.count + 1 };
        out.push(n);
      }
      if (s.count > 1) {
        const n = clone(cc);
        n[i] = { ...s, count: s.count - 1 };
        out.push(n);
      } else if (i >= 1) {
        out.push(clone(cc).filter((_, j) => j !== i));
      } // remove a non-face row
      if (i >= 1 && i < cc.length - 1) {
        const n = clone(cc);
        const t = n[i];
        n[i] = n[i + 1];
        n[i + 1] = t;
        out.push(n);
      } // swap order
    });
    // insert each catalog shim at a few positions behind the face (pivot-behind-face, mid, tail)
    const positions = [...new Set([1, Math.max(1, Math.floor(cc.length / 2)), cc.length])];
    catalog.forEach((s) => {
      positions.forEach((p) => {
        const n = clone(cc);
        n.splice(p, 0, { count: 1, od: s.od, thk: s.thk, type: s.type || 'round' });
        out.push(n);
      });
    });
    return out;
  }
  function climb(start) {
    let cur = prep(start),
      curS = score(ev(cur)),
      guard = 0;
    while (guard++ < 60) {
      let best = null,
        bestS = curS;
      for (const n of neighbors(cur)) {
        if (cache.size > BUDGET) break;
        const s = score(ev(n));
        if (s < bestS - 1e-9) {
          bestS = s;
          best = n;
        }
      }
      if (!best || cache.size > BUDGET) break;
      cur = prep(best);
      curS = bestS;
    }
    return cur;
  }

  const snapStart = catalogSnapsThk();
  const startCand0 = ensureFace(
    readRows()
      .map((r) => ({
        count: r.count,
        od: r.diam / IN,
        thk: snapStart ? canonThk(r.thickness / IN) : r.thickness / IN,
        type: r.type || 'round',
      }))
      .filter((s) => s.od >= v.odMin - 1e-9 && s.od <= v.odMax + 1e-9),
  );
  if (prep(startCand0).length < 2) {
    document.getElementById('optStatus').textContent = 'Load a stock tune for this valve first.';
    return;
  }

  climb(startCand0); // from the current stack, in its real order
  if (cache.size < BUDGET) climb(ensureFace([startCand0[0], ...startCand0.slice(1).sort((a, b) => b.od - a.od)])); // a plain-taper seed
  // structured seed: a small pivot behind the face — biases toward crossover-shaped optima
  if (cache.size < BUDGET) {
    const pv = variantsAt(ODS[0])[0];
    if (pv)
      climb(
        ensureFace([
          startCand0[0],
          { count: 1, od: pv.od, thk: pv.thk, type: pv.type || 'round' },
          ...startCand0.slice(1),
        ]),
      );
  }
  for (let r = 0; r < 4 && cache.size < BUDGET; r++) {
    // perturbed restarts for diversity
    const pert = clone(startCand0);
    for (let k = 0; k < 2; k++) {
      // perturb two rows for a bigger jump
      const j = 1 + Math.floor(Math.random() * Math.max(1, pert.length - 1));
      if (pert[j]) {
        const ths = thksFor(pert[j].od, pert[j].type);
        // A row whose OD isn't an exact catalog match (e.g. still holding a
        // generic/manually-entered dimension) has no catalog thicknesses to pick
        // from — leave its thickness alone rather than perturbing to undefined.
        if (ths.length) pert[j].thk = ths[Math.floor(Math.random() * ths.length)];
        pert[j].count = Math.max(1, pert[j].count + (Math.random() < 0.5 ? -1 : 1));
      }
    }
    climb(pert);
  }

  // rank all evaluated feasible stacks by the (coarse) search score, keep the distinct top set
  const ranked = [...cache.entries()]
    .filter(([, e]) => e)
    .map(([k, e]) => ({ sig: k, e, s: score(e) }))
    .sort((a, b) => a.s - b.s);
  const seen = new Set(),
    shortlist = [];
  for (const r of ranked) {
    if (seen.has(r.sig)) continue;
    seen.add(r.sig);
    shortlist.push(r);
    if (shortlist.length >= 18) break;
  }

  // re-evaluate the shortlist at FULL resolution so coarse search speed doesn't cost accuracy
  const nPts = Math.max(6, parseInt(document.getElementById('nPts').value) || 26);
  const uMax = convVel(parseFloat(document.getElementById('uMax').value), resultUnit, 'mm');
  const scored = shortlist
    .map((r) => {
      const rowsMM = r.e.rows.map((s) => ({
        count: s.count,
        diam: s.od * IN,
        thickness: s.thk * IN,
        float: 0,
        type: s.type || 'round',
      }));
      let stack;
      try {
        stack = buildStack(rowsMM, geom, mech, { Fmax, nSteps: 150, nSeg: 350 });
      } catch {
        return null;
      }
      let se = 0;
      for (const u of evalVels) {
        const res = solveForceAtVelocity(Math.max(u, 0.01), stack, geom, fluid, valveType, Fmax);
        const dd = res.F - tgtF(u);
        se += dd * dd;
      }
      const err = Math.sqrt(se / evalVels.length);
      const curve = [];
      for (let i = 0; i < nPts; i++) {
        const frac = i / (nPts - 1);
        const u = uMax * Math.pow(frac, 1.8);
        const res = solveForceAtVelocity(Math.max(u, 0.01), stack, geom, fluid, valveType, Fmax);
        curve.push({ u, F: res.F });
      }
      curve[0] = { u: 0, F: 0 };
      return {
        rows: r.e.rows,
        hMM: r.e.hMM,
        err,
        score:
          err +
          Math.max(0, Href - r.e.hMM > 1e-4 ? 8 * (Href - r.e.hMM) : Math.max(0, r.e.hMM - (Href + tolOver)) * 3) *
            meanTgt,
        curve,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  // DIVERSITY: don't show three near-identical stacks. Greedily pick the best, then the
  // next that differs by at least a few shims (count-vector L1 distance), etc.
  const stackDist = (a, b) => {
    const m = new Map();
    a.rows.forEach((s) => {
      const k = s.od.toFixed(3) + (s.type === 'deltaT' ? 'T' : '') + '|' + s.thk.toFixed(4);
      m.set(k, (m.get(k) || 0) + s.count);
    });
    b.rows.forEach((s) => {
      const k = s.od.toFixed(3) + (s.type === 'deltaT' ? 'T' : '') + '|' + s.thk.toFixed(4);
      m.set(k, (m.get(k) || 0) - s.count);
    });
    let d = 0;
    m.forEach((v) => (d += Math.abs(v)));
    return d;
  };
  const pickDiverse = (minD) => {
    const ch = [];
    for (const c of scored) {
      if (ch.every((x) => stackDist(x, c) >= minD)) {
        ch.push(c);
        if (ch.length >= 3) break;
      }
    }
    return ch;
  };
  let finals = pickDiverse(4);
  if (finals.length < 3) finals = pickDiverse(2);
  if (finals.length < 3) {
    const extra = scored.filter((c) => !finals.includes(c));
    finals = finals.concat(extra).slice(0, 3);
  }

  optCandidates = finals.map((r, idx) => {
    const flag = r.hMM < Href - 1e-4 ? 'under' : r.hMM > Href + tolOver + 1e-4 ? 'over' : 'in-band';
    return {
      label: `Opt ${idx + 1}`,
      color: OPT_COLORS[idx % OPT_COLORS.length],
      rows: r.rows,
      err: r.err,
      hMM: r.hMM,
      flag,
      curve: r.curve,
    };
  });

  renderOptResults(Href, tolOver);
  drawForceCurve();
  document.getElementById('optStatus').textContent =
    `searched ${cache.size} stacks · showing ${optCandidates.length} distinct options`;
}

function renderOptResults(Href, tolOver) {
  const box = document.getElementById('optResults');
  if (!box) return;
  if (!optCandidates.length) {
    box.innerHTML = '';
    return;
  }
  const uf = resultUnit === 'mm' ? 'N' : 'lbf';
  const du = prodDispUnit();
  const rowsTxt = (rows) =>
    rows
      .map((s) => {
        const od = fmtLen(toDispLen(s.od, du), du);
        const thk = fmtLen(toDispLen(s.thk, du), du);
        return `${s.count}×${od}${s.type === 'deltaT' ? 'T' : ''}/${thk}`;
      })
      .join('  ') + ` (${du})`;
  const flagChip = (f) =>
    f === 'in-band'
      ? `<span style="color:var(--accent2)">✓ in-band</span>`
      : f === 'under'
        ? `<span style="color:var(--warn)">▼ under height</span>`
        : `<span style="color:#e08e0b">▲ over height</span>`;
  box.innerHTML =
    `<p class="hint" style="margin:2px 0;">Reference height ${Href.toFixed(3)}mm (allowed up to +${tolOver.toFixed(2)}mm, never under). Suggestions use only real ${PRODUCTS[curProduct] ? PRODUCTS[curProduct].label : ''} parts for this valve:</p>` +
    optCandidates
      .map(
        (c, i) => `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; border:1px solid var(--line); border-radius:8px; padding:6px 8px; margin-bottom:5px;">
        <span class="sw" style="width:12px;height:12px;border-radius:2px;background:${c.color};flex:none;"></span>
        <b style="font-size:12.5px;">${c.label}</b>
        <span class="hint" style="margin:0;">fit ${fmtForce(convForce(c.err, 'mm', resultUnit), resultUnit)} ${uf} RMS · height ${c.hMM.toFixed(3)}mm ${flagChip(c.flag)}</span>
        <span style="flex:1"></span>
        <span class="hint" style="margin:0; font-family:ui-monospace,monospace;">${rowsTxt(c.rows)}</span>
        <button class="small applyCandidateBtn" data-idx="${i}">Apply to stack</button>
      </div>`,
      )
      .join('');
}

function applyCandidate(i) {
  const c = optCandidates[i];
  if (!c) return;
  loadingStock = true; // building the stack — don't let it flag itself
  const v = currentValve();
  const du = prodDispUnit();
  document.getElementById('shimBody').innerHTML = '';
  setFieldValueAndUnit('stackID', fmtLen(toDispLen(v.shimID, du), du), du);
  c.rows.forEach((s) =>
    addShimRow(
      s.count,
      fmtLen(toDispLen(s.od, du), du),
      fmtLen(toDispLen(s.thk, du), du),
      du,
      null,
      0,
      s.type || 'round',
    ),
  );
  loadingStock = false;
  // an applied optimizer suggestion isn't a named stock tune — mark the tune selector custom
  const stockNote = stockTuneInfo ? ` (from ${stockTuneInfo.label})` : '';
  stockRowsSig = null;
  setTuneSelCustom(true);
  document.getElementById('presetNote').innerHTML =
    `<b>✏️ Custom</b> — optimizer suggestion ${c.label}${stockNote} applied.`;
  document.getElementById('optStatus').textContent = `applied ${c.label} — edit freely or pin it to compare`;
  updateStackHeightDisplay();
  scheduleLiveCalc();
}

function clearSuggestions() {
  optCandidates = [];
  renderOptResults(0, 0);
  document.getElementById('optStatus').textContent = '';
  drawForceCurve();
}

function fillTable() {
  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';
  currentResults.forEach((p) => {
    // The two velocity columns always read m/s(2dp)/in/s(3dp), independent of resultUnit -
    // see the equivalent note on drawForceCurve()'s fmtForceChartTick. The damping coeff.
    // column stays tied to resultUnit as before (N·s/mm or lbf·s/in, per its header).
    const uDisp = convVel(p.u, 'mm', resultUnit);
    const FDisp = convForce(p.F, 'mm', resultUnit);
    const coeff = uDisp > 0 ? FDisp / uDisp : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${(p.u / 1000).toFixed(2)}</td><td>${convVel(p.u, 'mm', 'in').toFixed(3)}</td><td>${fmtForce(FDisp, resultUnit)}</td><td>${coeff.toFixed(4)}</td><td>${p.Re.toFixed(0)}</td>`;
    tbody.appendChild(tr);
  });
}

/* =========================================================
   SAVE / LOAD / EXPORT  (files always store canonical mm/N/MPa values)
   ========================================================= */
function gatherConfig() {
  return {
    geom: readGeom(),
    mech: readMech(),
    fluid: readFluid(),
    valveType: readValveType(),
    fMax: convForce(parseFloat(document.getElementById('fMax').value), resultUnit, 'mm'),
    uMax: convVel(parseFloat(document.getElementById('uMax').value), resultUnit, 'mm'),
    nPts: document.getElementById('nPts').value,
    rows: readRows(),
  };
}
function saveConfig() {
  const cfg = gatherConfig();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shim-stack-config.json';
  a.click();
}
// Applies a config object (canonical mm/N/MPa, same shape as gatherConfig()/LIVE_CONFIG_KEY)
// to every relevant field, the valve type, and the shim rows. Shared by the file-based
// load-config flow and restoring the last-used session on startup (see init()). Throws
// on malformed input (missing/non-object geom, fluid, etc.) — callers decide how to react.
function applyConfigToUI(cfg) {
  clampDiaUserSet = false;
  setFieldValueAndUnit('dRod', fmtLen(cfg.geom.dRod, 'mm'), 'mm');
  setFieldValueAndUnit('dValve', fmtLen(cfg.geom.dValve, 'mm'), 'mm');
  setFieldValueAndUnit('rPort', fmtLen(cfg.geom.rPort, 'mm'), 'mm');
  setFieldValueAndUnit('dPort', fmtLen(cfg.geom.dPort, 'mm'), 'mm');
  setFieldValueAndUnit('wPort', fmtLen(cfg.geom.wPort, 'mm'), 'mm');
  document.getElementById('nPort').value = cfg.geom.nPort;
  setFieldValueAndUnit('dThrt', fmtLen(cfg.geom.dThrt, 'mm'), 'mm');
  document.getElementById('nThrt').value = cfg.geom.nThrt;
  setFieldValueAndUnit('stackID', fmtLen(cfg.geom.stackID, 'mm'), 'mm');
  setFieldValueAndUnit(
    'clampDia',
    fmtLen(cfg.geom.clampDia != null ? cfg.geom.clampDia : cfg.geom.stackID, 'mm'),
    'mm',
  );
  setFieldValueAndUnit('eMod', Math.round(cfg.mech.E), 'MPa');
  document.getElementById('nu').value = cfg.mech.nu;
  document.getElementById('rho').value = cfg.fluid.rho;
  document.getElementById('cd').value = cfg.fluid.Cd;
  // Restores into Oil 1's card and makes it active - older saved configs/sessions
  // (before the fluid model generalized to arbitrary calibration points) stored
  // cSt40/cSt100 directly, so fall back to those if t1/v1/t2/v2 aren't present.
  document.getElementById('temp1_m').value = cfg.fluid.t1 != null ? cfg.fluid.t1 : 40;
  document.getElementById('visc1_m').value = cfg.fluid.v1 != null ? cfg.fluid.v1 : cfg.fluid.cSt40;
  document.getElementById('temp2_m').value = cfg.fluid.t2 != null ? cfg.fluid.t2 : 100;
  document.getElementById('visc2_m').value = cfg.fluid.v2 != null ? cfg.fluid.v2 : cfg.fluid.cSt100;
  document.getElementById('oilActive1').checked = true;
  document.getElementById('oilActive2').checked = false;
  oilTempUserSet = false;
  document.getElementById('oilTemp').value = cfg.fluid.tempC;
  document.getElementById('re0').value = cfg.fluid.Re0;
  recalcOilCompare();
  document.getElementById('valveType').value = cfg.valveType;
  resultUnit = 'mm';
  document.getElementById('resultUnit').value = 'mm';
  document.querySelectorAll('.uforce').forEach((el) => (el.textContent = 'N'));
  document.querySelectorAll('.uvel').forEach((el) => (el.textContent = 'mm/s'));
  document.querySelectorAll('.ulen').forEach((el) => (el.textContent = 'mm'));
  document.getElementById('fMax').value = fmtForce(cfg.fMax, 'mm');
  document.getElementById('uMax').value = fmtVel(cfg.uMax, 'mm');
  document.getElementById('nPts').value = cfg.nPts;
  clearPresetSelection();
  document.getElementById('shimBody').innerHTML = '';
  cfg.rows.forEach((r) =>
    addShimRow(
      r.count,
      fmtLen(r.diam, 'mm'),
      fmtLen(r.thickness, 'mm'),
      'mm',
      null,
      fmtLen(r.float || 0, 'mm'),
      r.type || 'round',
    ),
  );
  showWarn(null);
}
function loadConfig(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      applyConfigToUI(JSON.parse(e.target.result)); // canonical mm/N/MPa
      scheduleLiveCalc();
    } catch (err) {
      showWarn('Could not read that file: ' + err.message);
    }
  };
  reader.readAsText(file);
  evt.target.value = '';
}
function exportCSV() {
  if (!currentResults.length) {
    showWarn('Run a calculation first.');
    return;
  }
  const fLabel = resultUnit === 'mm' ? 'N' : 'lbf';
  // Velocity columns always export m/s + in/s, independent of resultUnit - see fillTable().
  let csv = `shaft_velocity_m_s,shaft_velocity_in_s,damping_force_${fLabel},damping_coeff_${fLabel}_s_per_${resultUnit === 'mm' ? 'mm' : 'in'},reynolds\n`;
  currentResults.forEach((p) => {
    const uDisp = convVel(p.u, 'mm', resultUnit);
    const FDisp = convForce(p.F, 'mm', resultUnit);
    const coeff = uDisp > 0 ? FDisp / uDisp : 0;
    csv += `${(p.u / 1000).toFixed(4)},${convVel(p.u, 'mm', 'in').toFixed(4)},${FDisp.toFixed(4)},${coeff.toFixed(5)},${p.Re.toFixed(1)}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'damping-force-curve.csv';
  a.click();
}

/* ---- named valve-dimension setups ---- */
const VS_KEY = 'sst_valveSetups_v1';
function refreshValveSetupList(selectName) {
  const sel = document.getElementById('valveSetups');
  const setups = lsGet(VS_KEY) || {};
  sel.innerHTML = '<option value="" selected disabled>saved valve setups…</option>';
  Object.keys(setups)
    .sort()
    .forEach((name) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
  if (selectName && setups[selectName]) sel.value = selectName;
}
function saveValveSetup() {
  const nameEl = document.getElementById('valveSetupName');
  const selEl = document.getElementById('valveSetups');
  const name = (nameEl.value || selEl.value || '').trim();
  if (!name) {
    document.getElementById('valveSetupHint').textContent =
      'Type a name first (or pick an existing setup to overwrite), then press Save setup.';
    return;
  }
  const setups = lsGet(VS_KEY) || {};
  // canonical mm values, same convention as saved config files
  setups[name] = {
    dRod: getFieldMM('dRod'),
    dValve: getFieldMM('dValve'),
    rPort: getFieldMM('rPort'),
    dPort: getFieldMM('dPort'),
    wPort: getFieldMM('wPort'),
    nPort: parseFloat(document.getElementById('nPort').value) || 0,
    dThrt: getFieldMM('dThrt'),
    nThrt: parseFloat(document.getElementById('nThrt').value) || 0,
    clampDia: getFieldMM('clampDia'),
    valveType: readValveType(),
  };
  const ok = lsSet(VS_KEY, setups);
  refreshValveSetupList(name);
  nameEl.value = '';
  document.getElementById('valveSetupHint').textContent = ok
    ? `Saved "${name}". It will be available next time you open this file in this browser.`
    : `Saved "${name}" for this session — but this browser is blocking storage for local files, so it won't survive closing the page.`;
}
function loadValveSetup(name) {
  const setups = lsGet(VS_KEY) || {};
  const s = setups[name];
  if (!s) return;
  clampDiaUserSet = false;
  setFieldValueAndUnit('dRod', fmtLen(s.dRod, 'mm'), 'mm');
  setFieldValueAndUnit('dValve', fmtLen(s.dValve, 'mm'), 'mm');
  setFieldValueAndUnit('rPort', fmtLen(s.rPort, 'mm'), 'mm');
  setFieldValueAndUnit('dPort', fmtLen(s.dPort, 'mm'), 'mm');
  setFieldValueAndUnit('wPort', fmtLen(s.wPort, 'mm'), 'mm');
  document.getElementById('nPort').value = s.nPort;
  setFieldValueAndUnit('dThrt', fmtLen(s.dThrt, 'mm'), 'mm');
  document.getElementById('nThrt').value = s.nThrt;
  if (s.clampDia != null) setFieldValueAndUnit('clampDia', fmtLen(s.clampDia, 'mm'), 'mm');
  document.getElementById('valveType').value = s.valveType;
  document.getElementById('valveSetupHint').textContent = `Loaded "${name}" (values shown in mm).`;
  drawPortFaceDiagram();
  scheduleLiveCalc();
}
function deleteValveSetup() {
  const sel = document.getElementById('valveSetups');
  const name = sel.value;
  if (!name) {
    document.getElementById('valveSetupHint').textContent = 'Pick a setup in the dropdown first, then press Delete.';
    return;
  }
  const setups = lsGet(VS_KEY) || {};
  delete setups[name];
  lsSet(VS_KEY, setups);
  refreshValveSetupList();
  document.getElementById('valveSetupHint').textContent = `Deleted "${name}".`;
}

/* ---- collapsible + draggable panels, saved layout ---- */
const LAYOUT_KEY = 'sst_layout_v1';
const COLLAPSE_KEY = 'sst_collapsed_v1';
const DEFAULT_LAYOUT = {
  colMain: ['p-workspace', 'p-oil', 'p-geom', 'p-advanced', 'p-spring-calc', 'p-shim-delta', 'p-wheel-force'],
};
// The oil/shim-material panel is advanced/rarely-touched, and Spring Calculator/Shim Delta/
// Wheel Force are secondary/independent tools - all start collapsed for a brand-new user
// (nothing in localStorage yet) and after "Reset layout".
const DEFAULT_COLLAPSED = ['p-advanced', 'p-spring-calc', 'p-shim-delta', 'p-wheel-force'];

function redrawAllVisuals() {
  drawShimRefDiagram();
  drawPortFaceDiagram();
  drawOilChart();
  if (currentStack) {
    drawStackAtSlider();
  }
  if (currentResults.length) {
    drawForceCurve();
  }
}
function togglePanel(panel) {
  panel.classList.toggle('collapsed');
  const collapsed = [...document.querySelectorAll('.panel.collapsed')].map((p) => p.id).filter(Boolean);
  lsSet(COLLAPSE_KEY, collapsed);
  if (!panel.classList.contains('collapsed')) redrawAllVisuals(); // canvases need a redraw after being display:none
}
function applyCollapsed() {
  const collapsed = lsGet(COLLAPSE_KEY) || DEFAULT_COLLAPSED;
  collapsed.forEach((id) => {
    const p = document.getElementById(id);
    if (p) p.classList.add('collapsed');
  });
}
function gatherLayout() {
  const ids = (col) => [...document.getElementById(col).children].map((p) => p.id).filter(Boolean);
  return { colMain: ids('colMain') };
}
function applyLayout(layout) {
  if (!layout) return;
  ['colMain'].forEach((colId) => {
    const col = document.getElementById(colId);
    (layout[colId] || []).forEach((pid) => {
      const p = document.getElementById(pid);
      if (p && col) col.appendChild(p);
    });
  });
}
// Swap a panel with its previous (dir<0) or next (dir>0) sibling — a no-op at
// either end of the list. This is the whole reorder UI: no drag-and-drop.
function movePanel(panel, dir) {
  const col = panel.parentElement;
  if (!col) return;
  if (dir < 0 && panel.previousElementSibling) col.insertBefore(panel, panel.previousElementSibling);
  else if (dir > 0 && panel.nextElementSibling) col.insertBefore(panel.nextElementSibling, panel);
  else return;
  saveLayout();
  redrawAllVisuals();
}
function saveLayout() {
  lsSet(LAYOUT_KEY, gatherLayout());
}
function resetLayout() {
  applyLayout(DEFAULT_LAYOUT);
  document.querySelectorAll('.panel.collapsed').forEach((p) => p.classList.remove('collapsed'));
  DEFAULT_COLLAPSED.forEach((id) => {
    const p = document.getElementById(id);
    if (p) p.classList.add('collapsed');
  });
  lsSet(LAYOUT_KEY, DEFAULT_LAYOUT);
  lsSet(COLLAPSE_KEY, DEFAULT_COLLAPSED);
  redrawAllVisuals();
}

function initPanelUX() {
  document.querySelectorAll('.panel[id^="p-"]').forEach((p) => {
    const h2 = p.querySelector('h2');
    if (!h2) return;
    // click header (not a move button) toggles collapse
    h2.addEventListener('click', (e) => {
      if (e.target.closest('.panel-move')) return;
      togglePanel(p);
    });
    h2.querySelectorAll('.panel-move').forEach((btn) => {
      btn.addEventListener('click', () => movePanel(p, btn.dataset.dir === 'up' ? -1 : 1));
    });
  });
}

/* ---- pop-out windows (live mirrors of a chart/table, see js/live-sync.js) ---- */
const popoutWindows = {};
function openPopout(key, url, w, h) {
  const existing = popoutWindows[key];
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }
  const left = window.screenX + 60,
    top = window.screenY + 60;
  popoutWindows[key] = window.open(url, 'sst-popout-' + key, `width=${w},height=${h},left=${left},top=${top}`);
}

function wireStaticControls() {
  document.querySelectorAll('.fieldUnit').forEach((sel) => {
    sel.addEventListener('change', () => onFieldUnitChange(sel));
  });
  document.querySelectorAll('.modUnit').forEach((sel) => {
    sel.addEventListener('change', () => onModUnitChange(sel));
  });

  const bindings = [
    ['bulkUnit', 'change', (e) => setAllFieldUnits(e.target.value)],
    ['resetLayoutBtn', 'click', () => resetLayout()],
    ['valveSetups', 'change', (e) => loadValveSetup(e.target.value)],
    ['saveValveSetupBtn', 'click', () => saveValveSetup()],
    ['deleteValveSetupBtn', 'click', () => deleteValveSetup()],
    ['forceSlider', 'input', () => drawStackAtSlider()],
    ['addShimRowBtn', 'click', () => addShimRow()],
    ['loadExampleBtn', 'click', () => loadExample()],
    ['loadCrossoverBtn', 'click', () => loadCrossoverExample()],
    ['prodSel', 'change', () => onProductChange()],
    ['valveSel', 'change', () => onValveChange()],
    ['tuneSel', 'change', () => onTuneChange()],
    ['saveValveGeomBtn', 'click', () => saveValveGeom()],
    ['resultUnit', 'change', (e) => switchResultUnit(e.target.value)],
    ['recalcBtn', 'click', () => runCalc()],
    ['saveConfigBtn', 'click', () => saveConfig()],
    ['loadConfigTriggerBtn', 'click', () => document.getElementById('loadFile').click()],
    ['loadFile', 'change', loadConfig],
    ['exportCSVBtn', 'click', () => exportCSV()],
    ['liveMode', 'change', () => onLiveModeChange()],
    ['axisMode', 'change', () => onAxisSettingChange()],
    ['axisMinF', 'input', () => onAxisSettingChange()],
    ['axisMaxF', 'input', () => onAxisSettingChange()],
    ['xAxisMode', 'change', () => onAxisSettingChange()],
    ['axisMaxU', 'input', () => onAxisSettingChange()],
    ['pinCurveBtn', 'click', () => pinCurrentCurve()],
    ['clearPinsBtn', 'click', () => clearPins()],
    ['targetOn', 'change', () => onTargetToggle()],
    ['resetTargetBtn', 'click', () => resetTargetToCurrent()],
    ['clearTargetBtn', 'click', () => clearTarget()],
    ['optBtn', 'click', () => optimizeToTarget()],
    ['clearSuggestionsBtn', 'click', () => clearSuggestions()],
    ['photoFileFront', 'change', loadPhotoFile],
    ['photoFileBack', 'change', loadPhotoFile],
    ['popoutStackBtn', 'click', () => openPopout('stack', 'popout-stack.html', 520, 480)],
    ['popoutForceBtn', 'click', () => openPopout('force', 'popout-force.html', 620, 480)],
    ['popoutOilBtn', 'click', () => openPopout('oil', 'popout-oil.html', 620, 480)],
    ['popoutShimsBtn', 'click', () => openPopout('shims', 'popout-shims.html', 480, 520)],
    ['photoUndoBtn', 'click', () => photoUndo()],
    ['photoFinishPortBtn', 'click', () => photoFinishPort()],
    ['photoResetBtn', 'click', () => photoReset()],
    ['photoApplyBtn', 'click', () => applyPhotoResult()],
    ['photoModeToggle', 'change', (e) => setPhotoMode(e.target.checked ? 'manual' : 'auto')],
    [
      'photoAdjustBtn',
      'click',
      () => {
        photoAdjusting = !photoAdjusting;
        updatePhotoUI();
        drawPhotoCanvas();
      },
    ],
    [
      'photoApplySetSel',
      'change',
      (e) => {
        photoApplySet = e.target.value;
        updatePhotoUI();
      },
    ],
    [
      'photoTabFront',
      'click',
      () => {
        photoActive = 0;
        updatePhotoUI();
        drawPhotoCanvas();
      },
    ],
    [
      'photoTabBack',
      'click',
      () => {
        photoActive = 1;
        updatePhotoUI();
        drawPhotoCanvas();
      },
    ],
    [
      'photoSnapToggle',
      'change',
      (e) => {
        photoSnapEnabled = e.target.checked;
      },
    ],
  ];
  bindings.forEach(([id, evt, fn]) => document.getElementById(id).addEventListener(evt, fn));
}

async function init() {
  try {
    await loadCatalog();
  } catch (err) {
    // A dedicated, persistent status line (not showWarn's #warnBox) — that banner is a
    // one-slot transient shared with live-calc validation messages and gets cleared by
    // loadExample()/runCalc() a moment later, which would wipe this before it's ever seen.
    const box = document.getElementById('catalogLoadWarn');
    box.textContent = `Couldn't load the shim/valve catalog (${err.message}). Stock-product presets and the catalog parts bin are unavailable this session — custom stacks still work.`;
    box.style.display = 'block';
  }
  try {
    await loadOils();
    // Picking a preset just fills in that card's calibration fields (always at 40/100,
    // since that's what data/oils.json's manufacturer-datasheet entries are keyed to);
    // the fields stay editable afterward like any other value.
    const optionsHtml =
      '<option value="">— custom —</option>' + OILS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
    document.querySelectorAll('.oilPresetSel').forEach((sel) => {
      sel.innerHTML = optionsHtml;
      sel.addEventListener('change', () => {
        const oil = OILS.find((o) => o.id === sel.value);
        if (!oil) return;
        const suffix = sel.dataset.suffix;
        document.getElementById(suffix ? 'oil2_name' : 'oil1_name').value = oil.label;
        document.getElementById('temp1_m' + suffix).value = 40;
        document.getElementById('visc1_m' + suffix).value = oil.cst40;
        document.getElementById('temp2_m' + suffix).value = 100;
        document.getElementById('visc2_m' + suffix).value = oil.cst100;
        recalcOilCompare();
      });
    });
  } catch (err) {
    console.warn('Could not load the oil library:', err.message); // preset pickers just stay empty; custom values still work
  }
  wireStaticControls();
  const shimBody = document.getElementById('shimBody');
  shimBody.addEventListener('input', () => {
    drawShimRefDiagram();
    refreshCustomState();
  });
  shimBody.addEventListener('change', (e) => {
    if (e.target.matches('.rowUnit')) onRowUnitChange(e.target);
    drawShimRefDiagram();
    refreshCustomState();
  });
  shimBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.rowbtn');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'up') moveShimRow(btn, -1);
    else if (action === 'down') moveShimRow(btn, 1);
    else if (action === 'dup') duplicateShimRow(btn);
    else if (action === 'remove') removeShimRow(btn);
  });
  document.getElementById('catalogChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.catchip');
    if (!btn) return;
    addCatalogShim(parseFloat(btn.dataset.od), parseFloat(btn.dataset.thk), btn.dataset.type);
  });
  document.getElementById('optResults').addEventListener('click', (e) => {
    const btn = e.target.closest('.applyCandidateBtn');
    if (!btn) return;
    applyCandidate(parseInt(btn.dataset.idx, 10));
  });
  document.getElementById('stackID').addEventListener('input', drawShimRefDiagram);
  document.getElementById('clampDia').addEventListener('input', () => {
    if (!settingClampDiaAuto) {
      clampDiaUserSet = true;
      const note = document.getElementById('clampDiaAutoNote');
      if (note) note.textContent = '';
    }
    drawShimRefDiagram();
  });
  ['rPort', 'dPort', 'wPort', 'nPort', 'dValve', 'dRod'].forEach((id) => {
    document.getElementById(id).addEventListener('input', drawPortFaceDiagram);
  });
  document.getElementById('oilActive1').addEventListener('change', onOilActiveChange);
  document.getElementById('oilActive2').addEventListener('change', onOilActiveChange);
  document.getElementById('oilTemp').addEventListener('input', () => {
    if (!settingOilTempAuto) oilTempUserSet = true;
  });
  [
    'oil1_name',
    'temp1_m',
    'visc1_m',
    'temp2_m',
    'visc2_m',
    'tempx_m',
    'oil2_name',
    'temp1_m_2',
    'visc1_m_2',
    'temp2_m_2',
    'visc2_m_2',
    'tempx_m_2',
  ].forEach((id) => document.getElementById(id).addEventListener('input', recalcOilCompare));
  document.getElementById('toggle_crosshair').addEventListener('change', drawOilChart);
  const oilChartCanvas = document.getElementById('oilChart');
  oilChartCanvas.addEventListener('mousemove', (e) => {
    if (!oilPlotState || !document.getElementById('toggle_crosshair').checked) return;
    const rect = oilChartCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = OIL_MIN_TEMP + ((x - oilPlotState.pad.l) / oilPlotState.pw) * (OIL_MAX_TEMP - OIL_MIN_TEMP);
    if (t < OIL_MIN_TEMP || t > OIL_MAX_TEMP) return;
    setOilProbeTemp(t);
  });
  oilChartCanvas.addEventListener('click', (e) => {
    if (!oilPlotState) return;
    const rect = oilChartCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = OIL_MIN_TEMP + ((x - oilPlotState.pad.l) / oilPlotState.pw) * (OIL_MAX_TEMP - OIL_MIN_TEMP);
    setOilProbeTemp(t);
  });
  new ResizeObserver(() => drawOilChart()).observe(oilChartCanvas.parentElement);
  document.getElementById('photoCanvas').addEventListener('click', photoCanvasClick);
  new ResizeObserver(() => {
    if (photoEntry()) drawPhotoCanvas();
  }).observe(document.getElementById('photoCanvas'));

  // Live recalculation: any edit to an input/select schedules a debounced solve.
  // Listens on document.body — NOT a specific container — so edits keep triggering
  // recalcs no matter which column/area a tile has been dragged into. Controls with
  // their own handlers (unit switchers, presets, axis, pins, live toggle, slider)
  // are excluded so they don't double-fire or recalc needlessly.
  (function wireLiveInputs() {
    const SKIP_IDS = [
      'liveMode',
      'loadFile',
      'forceSlider',
      'bulkUnit',
      'resultUnit',
      'prodSel',
      'valveSel',
      'tuneSel',
      'valveSetups',
      'valveSetupName',
      'pinName',
      'axisMode',
      'axisMaxF',
      'axisMinF',
      'xAxisMode',
      'axisMaxU',
    ];
    const isLiveTrigger = (t) => {
      if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'SELECT')) return false;
      if (SKIP_IDS.includes(t.id)) return false;
      return true;
    };
    ['input', 'change'].forEach((evt) => {
      document.body.addEventListener(evt, (e) => {
        if (isLiveTrigger(e.target)) scheduleLiveCalc();
      });
    });
  })();

  initPanelUX();
  document.querySelectorAll('details.diagram-box').forEach((det) => {
    det.addEventListener('toggle', () => {
      if (det.open) redrawAllVisuals();
    });
  });
  applyLayout(lsGet(LAYOUT_KEY));
  applyCollapsed();
  refreshValveSetupList();
  initProductUX();
  pinnedCurves = lsGet(PINS_KEY) || [];
  renderPinList();
  restoreAxisPrefs();
  restoreTarget();
  (function wireTargetDrag() {
    const cv = document.getElementById('forceCanvas');
    if (!cv) return;
    cv.addEventListener('pointerdown', (e) => forceCanvasPointer(e, 'down'));
    cv.addEventListener('pointermove', (e) => forceCanvasPointer(e, 'move'));
    window.addEventListener('pointerup', (e) => forceCanvasPointer(e, 'up'));
    if (targetOn) cv.style.touchAction = 'none';
  })();
  // Restore whatever stack was last successfully computed (LIVE_CONFIG_KEY is written on
  // every successful calc, live or explicit) so a reload picks up where you left off,
  // rather than always resetting to the built-in demo stack.
  let restored = false;
  const savedConfig = lsGet(LIVE_CONFIG_KEY);
  if (savedConfig) {
    try {
      applyConfigToUI(savedConfig);
      restored = true;
    } catch (err) {
      console.warn('Could not restore last-used config, falling back to the example stack:', err);
    }
  }
  if (!restored) loadDefaultTune();
  recalcOilCompare();
  drawPortFaceDiagram();
  runCalc({ live: true }); // populate outputs immediately on load
  window.addEventListener('resize', () => {
    if (currentStack) {
      drawStackAtSlider();
      drawForceCurve();
    }
    drawShimRefDiagram();
    drawPortFaceDiagram();
  });
  // Canvas colors are read from the theme at draw time (see themeColor() in
  // canvas-utils.js), so switching light/dark doesn't repaint on its own - redraw
  // everything once when theme.js announces a change.
  document.addEventListener('themechange', redrawAllVisuals);
}
init();
