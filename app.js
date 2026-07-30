import { convLen, convForce, convVel, convMod, fmtLen, fmtForce, fmtVel } from './js/units.js';
import { interpArr, stackGapAt, stackSupportedAt, buildStack, solveForceAtVelocity } from './js/physics.js';
import { lsGet, lsSet } from './js/storage.js';
import { IN, canonThk, PRODUCTS, usableShims, loadCatalog } from './js/catalog-data.js';
import { setupCanvas, drawAxes, defaultTickFmt, themeColor, isDarkTheme } from './js/canvas-utils.js';
import { circleFrom3Points, computePortGeometryFromOutline, findStrongestEdgeNear } from './js/photo-measure.js';

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
   VISCOSITY: ISO VG / SAE approx / Walther temperature correction
   ========================================================= */
const ISO_VG_TABLE = [
  [2, 1.3],
  [3, 1.6],
  [5, 2.0],
  [7, 2.4],
  [10, 2.9],
  [15, 3.6],
  [22, 4.4],
  [32, 5.4],
  [46, 6.8],
  [68, 8.7],
  [100, 11.4],
  [150, 14.8],
  [220, 19.4],
  [320, 24.7],
  [460, 31.4],
  [680, 41.0],
  [1000, 52.0],
];
function isoVGtoCst100(vg) {
  const xs = ISO_VG_TABLE.map((p) => Math.log(p[0])),
    ys = ISO_VG_TABLE.map((p) => Math.log(p[1]));
  const lx = Math.log(vg);
  if (lx <= xs[0]) return Math.exp(ys[0]);
  if (lx >= xs[xs.length - 1]) return Math.exp(ys[ys.length - 1]);
  for (let i = 0; i < xs.length - 1; i++) {
    if (lx >= xs[i] && lx <= xs[i + 1]) {
      const f = (lx - xs[i]) / (xs[i + 1] - xs[i]);
      return Math.exp(ys[i] + f * (ys[i + 1] - ys[i]));
    }
  }
}
function saeToCst(sae) {
  return { cSt40: Math.max(15 + 3.14 * (sae - 2.5), 1), cSt100: Math.max(3 + 0.629 * (sae - 2.5), 1) };
}
function onViscModeChange() {
  const mode = document.getElementById('viscMode').value;
  document.getElementById('viscDirectFields').style.display = mode === 'direct' ? '' : 'none';
  document.getElementById('viscIsoFields').style.display = mode === 'iso' ? '' : 'none';
  document.getElementById('viscSaeFields').style.display = mode === 'sae' ? '' : 'none';
  let hint = '';
  if (mode === 'iso') {
    const vg = parseFloat(document.getElementById('isoVG').value) || 32;
    const c100 = isoVGtoCst100(vg);
    document.getElementById('cst40').value = vg.toFixed(1);
    document.getElementById('cst100').value = c100.toFixed(2);
    hint = `≈ ${vg.toFixed(1)} cSt @40°C / ${c100.toFixed(2)} cSt @100°C (typical VI≈100 mineral oil)`;
  } else if (mode === 'sae') {
    const sae = parseFloat(document.getElementById('saeWt').value) || 5;
    const r = saeToCst(sae);
    document.getElementById('cst40').value = r.cSt40.toFixed(1);
    document.getElementById('cst100').value = r.cSt100.toFixed(2);
    hint = `≈ ${r.cSt40.toFixed(1)} cSt @40°C / ${r.cSt100.toFixed(2)} cSt @100°C (rough average — real oils vary a lot at a given "weight")`;
  }
  document.getElementById('viscResultHint').textContent = hint;
}
function onDirectCstChange() {
  document.getElementById('viscResultHint').textContent = '';
}

/* =========================================================
   UI STATE + TABLE HANDLING
   ========================================================= */
let currentStack = null;
let currentGeom = null;
let currentRows = null;
let currentResults = []; // {u, F, Re} always stored in BASE units (mm/s, N)
// The live stack preview's locked Y-axis scale (mm, canonical) - recomputed once per calc in
// runCalc() from the worst-case (max configured force) state, then reused for every slider
// position by drawStackAtSlider(). See computeStackYMaxMM()/drawStackCanvas() for why this
// needs to stay fixed across a single calc rather than tracking the current slider force.
let stackYMaxLockedMM = 1;
// Snapshot of the last successfully-computed stack, written on every calc so other pages
// (e.g. the Wheel Force Curve tool) can live-sync a compression valve config from this tab
// without an explicit export/import step. Same shape as gatherConfig() below.
const LIVE_CONFIG_KEY = 'sst_live_config_v1';
const SHIM_PALETTE = [
  { fill: '#c7d6fb', stroke: '#2f6fed' },
  { fill: '#c8ecd9', stroke: '#0f9d58' },
  { fill: '#e6d3f5', stroke: '#8e44ad' },
  { fill: '#ffe3b3', stroke: '#e08e0b' },
  { fill: '#bdeef0', stroke: '#16a3b0' },
  { fill: '#f6c9d0', stroke: '#d1495b' },
  { fill: '#dbe6ff', stroke: '#8fa8e0' },
];
const CLAMP_COLOR = { fill: '#f4d9a0', stroke: '#b8860b' };

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
   Lets the user trace 3 points on the valve's outer edge (to set scale from D.valve), then
   a freeform outline (3+ points, any shape - sharp sector, rounded, kidney, D-shaped)
   around one or more ports directly on an uploaded photo. Each click snaps to the nearest
   real edge in the photo (a local Sobel gradient search - see findStrongestEdgeNear in
   photo-measure.js) so clicks don't need to be pixel-perfect. r.port/d.port/w.port are
   computed per traced port (matching the model drawn above: an annular sector from r.port
   to r.port+d.port, w.port as an outer-edge arc width - see computePortGeometryFromOutline)
   then averaged across however many ports were traced. Click points are stored in the
   PHOTO'S OWN natural pixel space (not canvas/CSS pixels) so the overlay and the edge-snap
   search both stay correctly anchored to the image if the canvas is later resized -
   photoImageToCanvasPt re-projects them at draw time.
   ========================================================= */
let photoImg = null;
let photoOffscreenCtx = null; // full-resolution copy of photoImg, read for edge-snapping
let photoDrawRect = null; // {x,y,w,h} in canvas CSS px - where the image is CURRENTLY drawn
let photoStep = 'calibrate'; // 'calibrate' | 'trace'
let photoCalibPts = []; // clicked points, in image-natural-pixel space
let photoCenter = null; // image-natural-pixel space
let photoRadiusImgPx = null;
let photoMmPerPx = null;
let photoCurrentTrace = []; // points of the port currently being traced (image space)
let photoCompletedPorts = []; // [{points, result:{rPort,dPort,wPort}}] - one per traced port
let photoOtherPortsCount = 0; // extra ports seen but not traced, for the N.port suggestion
let photoSnapEnabled = true;

function photoCanvasToImagePt(x, y) {
  return {
    x: ((x - photoDrawRect.x) * photoImg.naturalWidth) / photoDrawRect.w,
    y: ((y - photoDrawRect.y) * photoImg.naturalHeight) / photoDrawRect.h,
  };
}
function photoImageToCanvasPt(pt) {
  return {
    x: photoDrawRect.x + (pt.x * photoDrawRect.w) / photoImg.naturalWidth,
    y: photoDrawRect.y + (pt.y * photoDrawRect.h) / photoImg.naturalHeight,
  };
}

// Reads a small region of the FULL-RESOLUTION image (not the possibly-downscaled on-screen
// canvas, so a display that's shrunk to fit still snaps against real detail) around
// (imgX, imgY) and snaps to the strongest nearby edge, in image-natural-pixel space.
function photoSnapPoint(imgX, imgY) {
  if (!photoSnapEnabled || !photoOffscreenCtx) return { x: imgX, y: imgY };
  const radius = 12,
    pad = 2;
  const x0 = Math.max(0, Math.floor(imgX - radius - pad));
  const y0 = Math.max(0, Math.floor(imgY - radius - pad));
  const x1 = Math.min(photoImg.naturalWidth, Math.ceil(imgX + radius + pad));
  const y1 = Math.min(photoImg.naturalHeight, Math.ceil(imgY + radius + pad));
  const w = x1 - x0,
    h = y1 - y0;
  if (w <= 2 || h <= 2) return { x: imgX, y: imgY };
  const region = photoOffscreenCtx.getImageData(x0, y0, w, h);
  const found = findStrongestEdgeNear(region, imgX - x0, imgY - y0, radius, 150);
  return found ? { x: x0 + found.x, y: y0 + found.y } : { x: imgX, y: imgY };
}

function photoAveraged() {
  if (photoCompletedPorts.length === 0) return null;
  const sum = photoCompletedPorts.reduce(
    (acc, p) => ({
      rPort: acc.rPort + p.result.rPort,
      dPort: acc.dPort + p.result.dPort,
      wPort: acc.wPort + p.result.wPort,
    }),
    { rPort: 0, dPort: 0, wPort: 0 },
  );
  const n = photoCompletedPorts.length;
  return { rPort: sum.rPort / n, dPort: sum.dPort / n, wPort: sum.wPort / n };
}

function photoCurrentInstruction() {
  if (!photoImg) return 'Choose a photo to begin.';
  if (photoStep === 'calibrate') {
    const n = photoCalibPts.length;
    return n === 0
      ? "Click 3 points anywhere along the valve's outer edge."
      : `${3 - n} more point${3 - n === 1 ? '' : 's'} needed on the outer edge (${n}/3 placed).`;
  }
  const n = photoCurrentTrace.length;
  return n === 0
    ? 'Click points around this port\'s boundary (at least 3), then press "Finish this port".'
    : `${n} point${n === 1 ? '' : 's'} placed - click more, or press "Finish this port" when the outline looks right.`;
}

function updatePhotoUI() {
  document.getElementById('photoStepHint').textContent = photoCurrentInstruction();
  const portsHint = document.getElementById('photoPortsHint');
  if (photoCompletedPorts.length > 0) {
    const avg = photoAveraged();
    const n = photoCompletedPorts.length;
    const suggestedN = n + photoOtherPortsCount;
    portsHint.textContent =
      `${n} port${n === 1 ? '' : 's'} traced — average r.port ≈ ${fmtLen(avg.rPort, 'mm')}mm, ` +
      `d.port ≈ ${fmtLen(avg.dPort, 'mm')}mm, w.port ≈ ${fmtLen(avg.wPort, 'mm')}mm — suggested N.port = ${suggestedN}.`;
  } else {
    portsHint.textContent = '';
  }
  document.getElementById('photoFinishPortBtn').disabled = photoStep !== 'trace' || photoCurrentTrace.length < 3;
  document.getElementById('photoApplyBtn').disabled = photoCompletedPorts.length === 0;
  document.getElementById('photoUndoBtn').disabled =
    !photoImg || (photoStep === 'calibrate' && photoCalibPts.length === 0);
  document.getElementById('photoResetBtn').disabled = !photoImg;
}

function drawPhotoCanvas() {
  if (!photoImg) return;
  const cv = document.getElementById('photoCanvas');
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);

  // "contain" fit: scale the image into w x h, preserving aspect ratio, centered.
  const scale = Math.min(w / photoImg.naturalWidth, h / photoImg.naturalHeight);
  const dw = photoImg.naturalWidth * scale,
    dh = photoImg.naturalHeight * scale;
  photoDrawRect = { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
  ctx.drawImage(photoImg, photoDrawRect.x, photoDrawRect.y, dw, dh);

  // calibration points + the fitted outer-edge circle
  photoCalibPts.forEach((pt) => {
    const p = photoImageToCanvasPt(pt);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
    ctx.fillStyle = '#eab308';
    ctx.fill();
  });
  if (photoCenter && photoRadiusImgPx) {
    const c = photoImageToCanvasPt(photoCenter);
    const rPx = photoRadiusImgPx * (photoDrawRect.w / photoImg.naturalWidth);
    ctx.strokeStyle = '#eab308';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, rPx, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, 3, 0, 2 * Math.PI);
    ctx.fillStyle = '#eab308';
    ctx.fill();
  }

  // completed ports: muted closed outlines, so you can see what's already been captured
  photoCompletedPorts.forEach(({ points }) => {
    const cvPts = points.map(photoImageToCanvasPt);
    ctx.beginPath();
    cvPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(143,168,224,0.2)';
    ctx.fill();
    ctx.strokeStyle = '#8fa8e0';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // the port currently being traced: an open polyline (not yet closed) with its own points
  if (photoCurrentTrace.length > 0) {
    const cvPts = photoCurrentTrace.map(photoImageToCanvasPt);
    ctx.strokeStyle = '#2f6fed';
    ctx.lineWidth = 2;
    ctx.beginPath();
    cvPts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    ctx.fillStyle = '#2f6fed';
    cvPts.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
      ctx.fill();
    });
  }
}

function photoCanvasClick(e) {
  if (!photoImg || !photoDrawRect) return;
  const cv = document.getElementById('photoCanvas');
  const rect = cv.getBoundingClientRect();
  const cx = e.clientX - rect.left,
    cy = e.clientY - rect.top;
  // ignore clicks outside the drawn image (the letterboxed margin, if any)
  if (
    cx < photoDrawRect.x ||
    cx > photoDrawRect.x + photoDrawRect.w ||
    cy < photoDrawRect.y ||
    cy > photoDrawRect.y + photoDrawRect.h
  ) {
    return;
  }
  const raw = photoCanvasToImagePt(cx, cy);
  const pt = photoSnapPoint(raw.x, raw.y);

  if (photoStep === 'calibrate') {
    photoCalibPts.push(pt);
    if (photoCalibPts.length === 3) {
      const fit = circleFrom3Points(photoCalibPts[0], photoCalibPts[1], photoCalibPts[2]);
      if (!fit) {
        photoCalibPts.pop();
        updatePhotoUI();
        document.getElementById('photoStepHint').textContent =
          'Those 3 points are too close to a straight line to fit a circle - click a point further around the edge.';
        drawPhotoCanvas();
        return;
      }
      const dValveMM = getFieldMM('dValve');
      if (!(dValveMM > 0)) {
        photoCalibPts = [];
        updatePhotoUI();
        document.getElementById('photoStepHint').textContent = 'Enter D.valve (above) before calibrating.';
        drawPhotoCanvas();
        return;
      }
      photoCenter = fit.center;
      photoRadiusImgPx = fit.r;
      photoMmPerPx = dValveMM / (2 * fit.r);
      photoStep = 'trace';
    }
  } else if (photoStep === 'trace') {
    photoCurrentTrace.push(pt);
  }
  updatePhotoUI();
  drawPhotoCanvas();
}

function photoFinishPort() {
  if (photoCurrentTrace.length < 3) return;
  const result = computePortGeometryFromOutline(photoCenter, photoMmPerPx, photoCurrentTrace);
  photoCompletedPorts.push({ points: photoCurrentTrace.slice(), result });
  photoCurrentTrace = [];
  updatePhotoUI();
  drawPhotoCanvas();
}

function photoUndo() {
  if (photoStep === 'calibrate') {
    photoCalibPts.pop();
  } else if (photoStep === 'trace') {
    if (photoCurrentTrace.length > 0) {
      photoCurrentTrace.pop();
    } else if (photoCompletedPorts.length > 0) {
      photoCompletedPorts.pop();
    } else {
      photoStep = 'calibrate';
      photoCenter = null;
      photoRadiusImgPx = null;
      photoMmPerPx = null;
      photoCalibPts.pop();
    }
  }
  updatePhotoUI();
  drawPhotoCanvas();
}

function photoReset() {
  photoStep = 'calibrate';
  photoCalibPts = [];
  photoCenter = null;
  photoRadiusImgPx = null;
  photoMmPerPx = null;
  photoCurrentTrace = [];
  photoCompletedPorts = [];
  photoOtherPortsCount = 0;
  const otherEl = document.getElementById('photoOtherPorts');
  if (otherEl) otherEl.value = 0;
  updatePhotoUI();
  drawPhotoCanvas();
}

function applyPhotoResult() {
  const avg = photoAveraged();
  if (!avg) return;
  setFieldValueAndUnit('rPort', fmtLen(avg.rPort, 'mm'), 'mm');
  setFieldValueAndUnit('dPort', fmtLen(avg.dPort, 'mm'), 'mm');
  setFieldValueAndUnit('wPort', fmtLen(avg.wPort, 'mm'), 'mm');
  ['rPort', 'dPort', 'wPort'].forEach((id) => {
    document.getElementById(id).dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (document.getElementById('photoApplyNPort').checked) {
    document.getElementById('nPort').value = photoCompletedPorts.length + photoOtherPortsCount;
    document.getElementById('nPort').dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function loadPhotoFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    photoImg = img;
    // A separate, never-displayed canvas holding the image at FULL resolution, so edge
    // snapping always reads real detail even when the on-screen canvas has to shrink a
    // large photo to fit.
    const off = document.createElement('canvas');
    off.width = img.naturalWidth;
    off.height = img.naturalHeight;
    photoOffscreenCtx = off.getContext('2d', { willReadFrequently: true });
    photoOffscreenCtx.drawImage(img, 0, 0);
    photoReset();
    document.getElementById('photoCanvas').style.display = 'block';
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
  const noteHtml = `<b>${t.kit}</b> — "${PRODUCTS[curProduct].label}, ${v.label}, ${t.label}". ${heightBit}.`;
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
  if (hint) hint.textContent = saved ? 'using your saved geometry' : 'using approximate defaults';
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
function readFluid() {
  return {
    rho: parseFloat(document.getElementById('rho').value),
    Cd: parseFloat(document.getElementById('cd').value),
    cSt40: parseFloat(document.getElementById('cst40').value) || 30,
    cSt100: parseFloat(document.getElementById('cst100').value) || 6,
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
  // Lock the stack preview's Y-axis to this calc's worst case now, once - see
  // stackYMaxLockedMM's declaration and drawStackCanvas() for why.
  stackYMaxLockedMM = computeStackYMaxMM(Fmax);
  lsSet(LIVE_CONFIG_KEY, { geom, mech, fluid, valveType, fMax: Fmax, uMax, nPts: String(nPts), rows });

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

// Builds smooth, curved shim bands directly from the shim table rows.
//
// Layout: each row rests in table order at the cumulative thickness of the rows below it,
// plus the cumulative Float gaps below it. Structural cavities — where a wider shim
// overhangs a narrower one beneath it — appear automatically because each row is drawn in
// its own slot across its own reach.
//
// Motion: the solver gives one deflection curve y(r) for the engaged stack. At each
// radius, the gap beneath a row is its explicit Float PLUS the thickness of any narrower
// rows below that don't reach that radius (see stackGapAt). The row is only pushed where
// the supported stack beneath has crossed that gap: push(r) = y(r) − gap(r) where
// supported. The row's offset is the RUNNING MAX of push from the clamp outward — so a
// wide clamp plate over a small pivot shim visibly stays put while the shims below bend
// up around the pivot's edge, gets contacted, and only then starts to move: correct
// order, no overlap, no tearing at cavity edges. This mirrors the solver's own
// engagement rule, so what you see matches what's computed.
// Builds the shim-band geometry (one polygon per row) at a given force and display unit -
// shared by drawStackAtSlider() (the current slider force) and computeStackYMaxMM() (the
// calc's worst-case Fmax state, used to lock the preview's Y-axis scale - see runCalc()).
function buildBandsAtForce(Fbase, unit) {
  const profile = currentStack.profileAt(Fbase); // {rs, ys} in mm
  const aMM = (currentGeom.clampDia && currentGeom.clampDia > 0 ? currentGeom.clampDia : currentGeom.stackID) / 2;
  const shaftMM = (currentGeom.stackID || 0) / 2;
  const engageF = currentStack.engageF || [];
  function liftAt(r) {
    return interpArr(profile.rs, profile.ys, r);
  }

  let base = 0; // cumulative shim material below
  let cumFloat = 0; // cumulative explicit float gaps below (incl. this row's own gap)
  let clampMaterialH = 0; // thickness of rows that never reach past the clamp line at all —
  // real material, but with nothing to draw as its own band (see clampH below)
  const bands = [];
  currentRows.forEach((row, idx) => {
    cumFloat += Math.max(0, row.float || 0);
    const hRow = row.count * row.thickness;
    const yRest = base + cumFloat;
    base += hRow;
    const rOuter = row.diam / 2;
    if (rOuter <= aMM) {
      clampMaterialH += hRow;
      return;
    }
    const pal =
      row.special === 'clamp-row' || row.special === 'nut-row' ? CLAMP_COLOR : SHIM_PALETTE[idx % SHIM_PALETTE.length];
    const engagedNow = Fbase >= (engageF[idx] !== undefined ? engageF[idx] : -Infinity);
    const N = 50;
    const rs = [],
      yB = [],
      yT = [];
    // The material between the shaft and the clamp boundary is clamped rigid (it's what
    // the bending model treats as immovable) but it's still real shim material, so it's
    // drawn flat out to the clamp line rather than leaving a gap at the shaft.
    if (shaftMM < aMM) {
      rs.push(convLen(shaftMM, 'mm', unit));
      yB.push(convLen(yRest, 'mm', unit));
      yT.push(convLen(yRest + hRow, 'mm', unit));
    }
    let runMax = 0; // contact offset carried outward — a plate can't dip back down mid-span
    for (let s = 0; s <= N; s++) {
      const r = aMM + ((rOuter - aMM) * s) / N;
      if (stackSupportedAt(currentRows, idx, r)) {
        const push = liftAt(r) - stackGapAt(currentRows, idx, r);
        if (push > runMax) runMax = push;
      }
      rs.push(convLen(r, 'mm', unit));
      yB.push(convLen(yRest + runMax, 'mm', unit));
      yT.push(convLen(yRest + runMax + hRow, 'mm', unit));
    }
    bands.push({
      rs,
      yB,
      yT,
      fill: pal.fill,
      stroke: pal.stroke,
      dashed: row.float > 0 && !engagedNow,
      faded: row.float > 0 && !engagedNow,
      delta: row.type === 'deltaT',
    });
  });

  return {
    bands,
    rLoadDisp: convLen(currentStack.rLoad, 'mm', unit),
    clampDisp: convLen(aMM, 'mm', unit),
    // The shaft/post the shims are actually threaded onto is sized by the shim ID (the
    // hole in the shims themselves), not D.rod — a separate, unrelated dimension further
    // up the damper at the seal. stackID is meant to stay <= clampDia (per the geometry
    // panel's own hint text), so this normally doesn't overlap the clamp-diameter line.
    shaftDisp: convLen(shaftMM, 'mm', unit),
    clampMaterialDisp: convLen(clampMaterialH, 'mm', unit),
  };
}

// Derives the stack preview's locked Y-axis scale from the calc's worst case (its max
// configured force) so it can be computed once per calc (see runCalc()) and reused for
// every slider position, instead of being recomputed from whatever force the slider is
// currently at - see drawStackCanvas() for why that rescaling was the actual bug.
function computeStackYMaxMM(FmaxMM) {
  const { bands, rLoadDisp, clampMaterialDisp } = buildBandsAtForce(FmaxMM, 'mm');
  let yMax = 1e-6;
  bands.forEach((b) => {
    for (let i = 0; i < b.yT.length; i++) {
      if (b.rs[i] <= rLoadDisp) yMax = Math.max(yMax, b.yT[i]);
    }
  });
  const tallestShimH = bands.reduce((m, b) => Math.max(m, b.yT[0] - b.yB[0]), 1e-6);
  const clampH = clampMaterialDisp > 0 ? clampMaterialDisp : tallestShimH * 1.5;
  yMax = Math.max(yMax, yMax + clampH);
  return yMax * 1.18;
}

function drawStackAtSlider() {
  if (!currentStack || !currentRows) return;
  const Fdisp = parseFloat(document.getElementById('forceSlider').value) || 0;
  document.getElementById('sliderVal').textContent = fmtForce(Fdisp, resultUnit);
  const Fbase = convForce(Fdisp, resultUnit, 'mm');
  const { bands, rLoadDisp, clampDisp, shaftDisp, clampMaterialDisp } = buildBandsAtForce(Fbase, resultUnit);
  const yMaxLocked = convLen(stackYMaxLockedMM, 'mm', resultUnit);
  drawStackCanvas(bands, rLoadDisp, clampDisp, shaftDisp, clampMaterialDisp, yMaxLocked);
}

function drawStackCanvas(bands, rLoad, clampR, shaftR, clampMaterialH, yMaxLocked) {
  const cv = document.getElementById('stackCanvas');
  const { ctx, w, h } = setupCanvas(cv);
  // Extra left/top padding vs. the force chart's default (44px/14px) - the dual-unit tick
  // labels here ("2.50mm (0.098in)") are much longer than the shared default's bare numbers.
  const pad = { l: 88, r: 46, t: 20, b: 26 };
  let xMax = Math.max(rLoad, clampR || 0);
  bands.forEach((b) => {
    xMax = Math.max(xMax, b.rs[b.rs.length - 1]);
  });
  // Where THIS force's shim stack currently tops out — the clamp shim is drawn stacked
  // directly above this, like one more (thicker, black) shim on top of the sequence, not
  // off to the side. Grows with force, unlike yMax below - that's the whole fix: this
  // (positioning) stays dynamic, only the axis scale is locked.
  let stackTopY = 1e-6;
  bands.forEach((b) => {
    // Only the physically-loaded span (out to the port edge) counts. Beyond it, the model
    // has no applied moment, so it holds whatever rotation it had at the port and projects
    // a straight line outward — a small rotation carried over a long unsupported rim
    // amplifies into a tip height many times the real, loaded deflection. The tip still
    // draws, just clipped to the plot area below instead of pulling the clamp up with it.
    for (let i = 0; i < b.yT.length; i++) {
      if (b.rs[i] <= rLoad) stackTopY = Math.max(stackTopY, b.yT[i]);
    }
  });
  // Rows entirely inside the clamp radius (e.g. a clamp/nut row narrower than D.clamp)
  // never get their own band, but they're still real material - fold their thickness into
  // the clamp block's height instead of the generic fallback so the diagram doesn't lose it.
  const tallestShimH = bands.reduce((m, b) => Math.max(m, b.yT[0] - b.yB[0]), 1e-6);
  const clampH = clampMaterialH > 0 ? clampMaterialH : tallestShimH * 1.5;
  xMax *= 1.03;
  // Locked to the calc's worst-case (max configured force) state - computed once in
  // runCalc() via computeStackYMaxMM(), not recomputed here from the current bands. If it
  // rescaled with every slider move, the clamp block's fixed real thickness would map to
  // fewer and fewer pixels as force (and yMax) grew, making it visibly shrink even though
  // nothing about it actually changed - that illusion was the reported bug.
  const yMax = yMaxLocked;
  // Tick labels here always show both units - primary (whichever resultUnit currently is)
  // at a fixed 2dp(mm)/3dp(in), with the other unit's equivalent in brackets at its own
  // fixed decimal count - instead of the shared default rule (up to 4dp, no unit shown),
  // which was needlessly precise for these frequently-sub-1mm cross-section values.
  const fmtStackTick = (val) =>
    resultUnit === 'mm'
      ? `${val.toFixed(2)}mm (${convLen(val, 'mm', 'in').toFixed(3)}in)`
      : `${val.toFixed(3)}in (${convLen(val, 'in', 'mm').toFixed(2)}mm)`;
  drawAxes(
    ctx,
    w,
    h,
    pad,
    xMax,
    yMax,
    `radius (${resultUnit === 'mm' ? 'mm' : 'in'})`,
    `cross-section (${resultUnit === 'mm' ? 'mm' : 'in'})`,
    undefined,
    fmtStackTick,
    3, // fewer ticks than the default 5 - these dual-unit labels need more room each
    10, // slightly smaller than the default 11px tick font, same reason
  );
  const X = (r) => pad.l + (w - pad.l - pad.r) * (r / xMax);
  const Y = (y) => h - pad.b - (h - pad.t - pad.b) * (y / yMax);

  // the shaft the shims are threaded onto — always beside the stack, spanning its full
  // height, drawn first so the stack sits in front of it
  if (shaftR > 0) {
    ctx.fillStyle = '#cfd8e3';
    ctx.fillRect(X(0), pad.t, X(Math.min(shaftR, xMax)) - X(0), h - pad.t - pad.b);
    ctx.fillStyle = '#5b6472';
    ctx.font = '11px sans-serif';
    ctx.fillText('shaft', X(0) + 4, pad.t + 12);
  }

  // clamp diameter — a relatively normal (if thicker) shim that never moves, stacked
  // directly on top of the real shims rather than off to the side
  if (clampR > shaftR) {
    ctx.fillStyle = '#111318';
    ctx.fillRect(X(shaftR), Y(stackTopY + clampH), X(clampR) - X(shaftR), Y(stackTopY) - Y(stackTopY + clampH));
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.fillText('clamp', X(shaftR) + 4, Y(stackTopY + clampH / 2) + 4);
  }

  // Now that the axis no longer stretches to fit it, an unloaded overhang tip can run past
  // the top of the plot - clip to the plot rectangle so it crops there instead of drawing
  // over the axis title/labels above.
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  ctx.clip();
  bands.forEach((b) => {
    // one smooth closed polygon per shim: along the bottom edge, back along the top edge
    ctx.beginPath();
    b.rs.forEach((r, i) => {
      const x = X(r),
        y = Y(b.yB[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = b.rs.length - 1; i >= 0; i--) ctx.lineTo(X(b.rs[i]), Y(b.yT[i]));
    ctx.closePath();
    ctx.globalAlpha = b.faded ? 0.55 : 1;
    ctx.fillStyle = b.fill;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = b.stroke;
    ctx.lineWidth = 0.8;
    if (b.dashed) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    // delta/triangle shims: hatch the outer half, where only the three lobes carry load
    // (see shimScaleAt in physics.js) — the inner half is still a full disc, unmarked.
    if (b.delta) {
      const n = b.rs.length,
        half = Math.floor(n / 2);
      ctx.save();
      ctx.beginPath();
      for (let i = half; i < n; i++) {
        const x = X(b.rs[i]),
          y = Y(b.yB[i]);
        if (i === half) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= half; i--) ctx.lineTo(X(b.rs[i]), Y(b.yT[i]));
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = b.stroke;
      ctx.lineWidth = 0.7;
      ctx.globalAlpha = 0.75;
      const x0 = X(b.rs[half]),
        x1 = X(b.rs[n - 1]);
      for (let x = x0 - 12; x <= x1 + 12; x += 4) {
        ctx.beginPath();
        ctx.moveTo(x, Y(0));
        ctx.lineTo(x + 12, Y(0) - 14);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  });
  ctx.restore();

  if (clampR > 0) {
    // yellow, not black — a black line would vanish against the black clamp shim above
    ctx.strokeStyle = '#eab308';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(X(clampR), pad.t);
    ctx.lineTo(X(clampR), h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    // the label itself needs more contrast than the line — a darker gold reads fine on
    // the light theme's white canvas, but is nearly invisible on the dark theme's navy one
    ctx.fillStyle = isDarkTheme() ? '#eab308' : '#8a6d1a';
    ctx.font = '11px sans-serif';
    ctx.fillText('clamp dia', X(clampR) + 4, h - pad.b - 4);
  }

  const warnColor = themeColor('--warn', '#c0392b');
  ctx.strokeStyle = warnColor;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(X(rLoad), pad.t);
  ctx.lineTo(X(rLoad), h - pad.b);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = warnColor;
  ctx.font = '11px sans-serif';
  ctx.fillText('port edge', X(rLoad) + 4, pad.t + 12);
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
function drawForceCurve() {
  const cv = document.getElementById('forceCanvas');
  const { ctx, w, h } = setupCanvas(cv);
  const pad = { l: 52, r: 16, t: 14, b: 26 };

  const curves = [];
  pinnedCurves.forEach((p) => {
    curves.push({
      label: p.name,
      color: p.color,
      width: 1.6,
      dash: [5, 3],
      dots: false,
      pts: p.results.map((q) => ({ u: convVel(q.u, 'mm', resultUnit), F: convForce(q.F, 'mm', resultUnit) })),
    });
  });
  if (currentResults.length) {
    curves.push({
      label: 'current',
      color: '#0f9d58',
      width: 2.2,
      dash: [],
      dots: true,
      pts: currentResults.map((p) => ({ u: convVel(p.u, 'mm', resultUnit), F: convForce(p.F, 'mm', resultUnit) })),
    });
  }
  optCandidates.forEach((c) => {
    curves.push({
      label: c.label,
      color: c.color,
      width: 1.8,
      dash: [2, 3],
      dots: false,
      pts: c.curve.map((p) => ({ u: convVel(p.u, 'mm', resultUnit), F: convForce(p.F, 'mm', resultUnit) })),
    });
  });
  // stock reference + target contribute to scaling and are drawn separately
  const stockPts =
    targetOn && stockCurve
      ? stockCurve.map((p) => ({ u: convVel(p.u, 'mm', resultUnit), F: convForce(p.F, 'mm', resultUnit) }))
      : [];
  const tgtPts =
    targetOn && targetHandles.length
      ? targetHandles.map((hn) => ({ u: convVel(hn.u, 'mm', resultUnit), F: convForce(hn.F, 'mm', resultUnit) }))
      : [];
  if (!curves.length && !tgtPts.length) return;

  // a curve is drawn/scaled only if not hidden (click its legend entry to toggle)
  const vis = (c) => !hiddenCurves.has(c.label);
  const stockHidden = hiddenCurves.has('stock (reference)');
  const visCurves = curves.filter(vis);
  const scaleStock = stockPts.length && !stockHidden;
  const allX = [
    ...visCurves.flatMap((c) => c.pts.map((p) => p.u)),
    ...(scaleStock ? stockPts.map((p) => p.u) : []),
    ...tgtPts.map((p) => p.u),
  ];
  const allYForAuto = [
    ...visCurves.flatMap((c) => c.pts.map((p) => p.F)),
    ...(scaleStock ? stockPts.map((p) => p.F) : []),
    ...tgtPts.map((p) => p.F),
  ];
  const xModeEl = document.getElementById('xAxisMode');
  const xMode = xModeEl ? xModeEl.value : 'auto';
  const xMaxEl = document.getElementById('axisMaxU');
  const xFixed = xMaxEl ? parseFloat(xMaxEl.value) || 0 : 0;
  const xMax = xMode === 'fixed' && xFixed > 0 ? xFixed : Math.max(1, ...allX) * 1.05;
  const modeEl = document.getElementById('axisMode');
  const mode = modeEl ? modeEl.value : 'auto';
  const fEl = document.getElementById('axisMaxF'),
    fminEl = document.getElementById('axisMinF');
  const fixedMax = fEl ? parseFloat(fEl.value) || 0 : 0;
  const fixedMin = fminEl ? parseFloat(fminEl.value) || 0 : 0;
  let yMin, yMax;
  if (mode === 'fixed' && fixedMax > fixedMin) {
    yMin = fixedMin;
    yMax = fixedMax;
  } else {
    yMin = 0;
    yMax = Math.max(1, ...allYForAuto) * 1.15;
  }

  // Shaft velocity always reads in m/s (2dp) with in/s (3dp) in brackets on this chart,
  // independent of the Metric/Imperial resultUnit toggle (which still governs the Y axis -
  // force - and everything else). `val` arrives in whatever unit resultUnit currently is,
  // since that's still what the chart's own X-axis scale (xMax above) is plotted in.
  const fmtForceChartTick = (val, axis) => {
    if (axis !== 'x') return defaultTickFmt(val);
    const mm = convVel(val, resultUnit, 'mm');
    return `${(mm / 1000).toFixed(2)}m/s (${convVel(mm, 'mm', 'in').toFixed(3)}in/s)`;
  };
  drawAxes(
    ctx,
    w,
    h,
    pad,
    xMax,
    yMax,
    'shaft velocity',
    `damping force (${resultUnit === 'mm' ? 'N' : 'lbf'})`,
    yMin,
    fmtForceChartTick,
    3, // fewer ticks than the default 5 - the m/s(in/s) X labels need more room each
    10, // slightly smaller than the default 11px tick font, same reason
  );
  const X = (u) => pad.l + (w - pad.l - pad.r) * (u / xMax);
  const Y = (F) => h - pad.b - (h - pad.t - pad.b) * ((F - yMin) / (yMax - yMin));
  forceChartMap = { pad, w, h, xMax, yMax, yMin };

  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  ctx.clip();

  if (stockPts.length && !stockHidden) {
    ctx.strokeStyle = themeColor('--muted', '#9aa3b0');
    ctx.lineWidth = 1.4;
    ctx.setLineDash([]);
    ctx.beginPath();
    stockPts.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  visCurves.forEach((c) => {
    ctx.strokeStyle = c.color;
    ctx.lineWidth = c.width;
    ctx.setLineDash(c.dash);
    ctx.beginPath();
    c.pts.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    if (c.dots) {
      ctx.fillStyle = c.color;
      c.pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(X(p.u), Y(p.F), 2.2, 0, 7);
        ctx.fill();
      });
    }
  });

  if (tgtPts.length) {
    const lineP = [{ u: 0, F: 0 }, ...tgtPts];
    ctx.strokeStyle = '#c026d3';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    lineP.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
  ctx.setLineDash([]);

  if (tgtPts.length) {
    tgtPts.forEach((p, i) => {
      const x = X(p.u),
        y = Y(p.F);
      ctx.fillStyle = i === dragHandle ? '#a21caf' : '#c026d3';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(x - 4, y - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    });
  }

  // legend (top-left) — every entry is clickable to hide/show that line. Hidden ones are
  // greyed and struck through. Hit rectangles are saved for the pointer handler.
  ctx.font = '11px sans-serif';
  let ly = pad.t + 12;
  legendHits = [];
  const inkColor = themeColor('--ink', '#1c2430');
  const legend = curves.map((c) => ({ label: c.label, color: c.color, dash: c.dash }));
  if (stockPts.length) legend.unshift({ label: 'stock (reference)', color: themeColor('--muted', '#9aa3b0'), dash: [] });
  if (tgtPts.length) legend.push({ label: 'target', color: '#c026d3', dash: [6, 4], noHide: true });
  legend.forEach((c) => {
    const hidden = hiddenCurves.has(c.label);
    ctx.globalAlpha = hidden ? 0.4 : 1;
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(c.dash || []);
    ctx.beginPath();
    ctx.moveTo(pad.l + 8, ly - 3);
    ctx.lineTo(pad.l + 30, ly - 3);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = inkColor;
    const tw = ctx.measureText(c.label).width;
    ctx.fillText(c.label, pad.l + 36, ly);
    if (hidden) {
      ctx.strokeStyle = inkColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l + 36, ly - 3);
      ctx.lineTo(pad.l + 36 + tw, ly - 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (!c.noHide) legendHits.push({ label: c.label, x0: pad.l + 4, y0: ly - 12, x1: pad.l + 40 + tw, y1: ly + 4 });
    ly += 15;
  });
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
    } catch (e) {
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
    const fc = faceCnt(cc);
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
    .filter(([k, e]) => e)
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
      } catch (err) {
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
  document.getElementById('cst40').value = cfg.fluid.cSt40;
  document.getElementById('cst100').value = cfg.fluid.cSt100;
  document.getElementById('oilTemp').value = cfg.fluid.tempC;
  document.getElementById('re0').value = cfg.fluid.Re0;
  document.getElementById('viscMode').value = 'direct';
  onViscModeChange();
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
const DEFAULT_LAYOUT = { colMain: ['p-workspace', 'p-geom', 'p-advanced'] };
// The oil/shim-material panel is advanced/rarely-touched, so it starts collapsed —
// both for a brand-new user (nothing in localStorage yet) and after "Reset layout".
const DEFAULT_COLLAPSED = ['p-advanced'];

function redrawAllVisuals() {
  drawShimRefDiagram();
  drawPortFaceDiagram();
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
    ['viscMode', 'change', () => onViscModeChange()],
    ['cst40', 'input', () => onDirectCstChange()],
    ['cst100', 'input', () => onDirectCstChange()],
    ['isoVG', 'input', () => onViscModeChange()],
    ['saeWt', 'input', () => onViscModeChange()],
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
    ['photoFile', 'change', loadPhotoFile],
    ['photoUndoBtn', 'click', () => photoUndo()],
    ['photoFinishPortBtn', 'click', () => photoFinishPort()],
    ['photoResetBtn', 'click', () => photoReset()],
    ['photoApplyBtn', 'click', () => applyPhotoResult()],
    [
      'photoSnapToggle',
      'change',
      (e) => {
        photoSnapEnabled = e.target.checked;
      },
    ],
    [
      'photoOtherPorts',
      'input',
      (e) => {
        photoOtherPortsCount = Math.max(0, parseInt(e.target.value, 10) || 0);
        updatePhotoUI();
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
  document.getElementById('clampDia').addEventListener('input', drawShimRefDiagram);
  ['rPort', 'dPort', 'wPort', 'nPort', 'dValve', 'dRod'].forEach((id) => {
    document.getElementById(id).addEventListener('input', drawPortFaceDiagram);
  });
  document.getElementById('photoCanvas').addEventListener('click', photoCanvasClick);
  new ResizeObserver(() => {
    if (photoImg) drawPhotoCanvas();
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
  if (!restored) loadExample();
  onViscModeChange();
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
