// Automated smoke test: starts the local server, loads the hub page and the merged
// shim-stack-tuner.html (which now hosts every tool as its own panel) in a headless
// browser, and fails if a page errors or its JS doesn't run.
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 8000;
const BASE = `http://127.0.0.1:${PORT}/`;
const ROOT = path.join(__dirname, '..');

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url)
        .then(() => resolve())
        .catch((err) => {
          if (Date.now() > deadline) return reject(err);
          setTimeout(poll, 200);
        });
    })();
  });
}

// Loads a page and returns any console/page errors seen while it settles.
async function loadAndCollectErrors(browser, path) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  return { page, errors };
}

// Shared between the synthetic photo generator and the test's expectations: a bright metal
// disc (R=200px @ 250,250) on a dark surround, a dark center bore, and two concentric rings
// of dark annular-sector ports drawn the way drawPortFaceDiagramInner draws a port (two arcs
// joined by straight sides). From this the exact r/d/w.port and D.rod can be hand-computed
// against the D.valve = 50mm scale (mmPerPx = 50 / (2 * 200) = 0.125).
const VALVE_PHOTO = {
  cx: 250,
  cy: 250,
  R: 200,
  boreR: 26,
  rings: [
    { count: 4, halfAngle: 0.18, rInner: 55, rOuter: 95 }, // inner ring -> rebound
    { count: 6, halfAngle: 0.14, rInner: 120, rOuter: 165 }, // outer ring -> compression
  ],
};

// Generates the synthetic valve-face PNG (500x500) via an in-browser canvas. Exercises the
// photo tool's real auto-detection + manual-trace math end-to-end, not just "page loads".
async function generateSyntheticValvePhoto(browser) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate((g) => {
    const c = document.createElement('canvas');
    c.width = 500;
    c.height = 500;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#282828';
    ctx.fillRect(0, 0, 500, 500);
    ctx.fillStyle = '#c8c8c8';
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.R, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.boreR, 0, 2 * Math.PI);
    ctx.fill();
    for (const ring of g.rings) {
      for (let k = 0; k < ring.count; k++) {
        const a0 = (k * 2 * Math.PI) / ring.count - Math.PI / 2;
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, ring.rOuter, a0 - ring.halfAngle, a0 + ring.halfAngle);
        ctx.arc(g.cx, g.cy, ring.rInner, a0 + ring.halfAngle, a0 - ring.halfAngle, true);
        ctx.closePath();
        ctx.fill();
      }
    }
    return c.toDataURL('image/png');
  }, VALVE_PHOTO);
  await page.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function run() {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT });
  let serverOutput = '';
  server.stdout.on('data', (d) => (serverOutput += d));
  server.stderr.on('data', (d) => (serverOutput += d));

  let browser;
  try {
    await waitForServer(BASE, 10000);
    browser = await chromium.launch();

    // ---- Hub page: loads clean, nav links to every tool, theme toggle works ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, '');
      await page.waitForSelector('h1', { timeout: 5000 });
      const title = await page.textContent('h1');
      if (!title || !title.includes('Valving Toolbox')) {
        throw new Error(`Hub page: expected h1 to contain "Valving Toolbox", got: "${title}"`);
      }
      const toolLinks = [
        'shim-stack-tuner.html',
        'shim-stack-tuner.html#p-spring-calc',
        'shim-stack-tuner.html#p-shim-delta',
        'shim-stack-tuner.html#p-wheel-force',
      ];
      for (const href of toolLinks) {
        const count = await page.locator(`a[href="${href}"]`).count();
        if (count < 1) throw new Error(`Hub page: expected a link to ${href}`);
      }
      const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
      await page.click('#themeToggle');
      const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
      if (themeAfter === themeBefore) {
        throw new Error(`Hub page: theme toggle did not change data-theme (stayed "${themeBefore}")`);
      }
      if (errors.length > 0) throw new Error('Hub page console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Shim Stack Tuner: the full interaction check ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });

      const title = await page.textContent('h1');
      if (!title || !title.includes('Shim Stack Tuner')) {
        throw new Error(`Expected h1 to contain "Shim Stack Tuner", got: "${title}"`);
      }

      // Exercise one representative interaction to prove the JS actually runs
      // (this is what caught the duplicate-inline-script bug last time).
      await page.selectOption('#bulkUnit', 'in');
      await page.waitForTimeout(200);
      const selected = await page.$eval('#bulkUnit', (el) => el.value);
      if (selected !== 'in') {
        throw new Error(`Expected #bulkUnit to be "in" after selecting it, got: "${selected}"`);
      }

      // The initial load already ran runCalc({live:true}) synchronously - confirm the
      // results table actually got populated (proves physics engine + rendering pipeline
      // are wired correctly end-to-end, not just "no console errors").
      const rowCountAfterLoad = await page.$$eval('#resultsTable tbody tr', (rows) => rows.length);
      if (rowCountAfterLoad < 2) {
        throw new Error(`Expected results table to have rows after initial load, got ${rowCountAfterLoad}`);
      }

      // Click "+ Add shim row" (exercises the delegated event wiring for that control)
      // and confirm the shim table actually grew by one row.
      const shimRowsBefore = await page.$$eval('#shimBody tr', (rows) => rows.length);
      await page.click('#addShimRowBtn');
      const shimRowsAfter = await page.$$eval('#shimBody tr', (rows) => rows.length);
      if (shimRowsAfter !== shimRowsBefore + 1) {
        throw new Error(`Expected #shimBody to grow by 1 row, went from ${shimRowsBefore} to ${shimRowsAfter}`);
      }

      // Turn on the target curve and run the optimizer on the default, out-of-the-box
      // stack (no product/valve/tune selection needed). This previously crashed on first
      // use for any user - see the ensureFace()/thksFor() fix in runOptimize.
      await page.locator('#targetOn').check();
      await page.click('#optBtn');
      await page.waitForTimeout(1500);

      // Oil viscosity comparison panel (merged from the former standalone page): loads
      // clean, probe values compute, chart renders, click-to-probe works.
      const cst = await page.textContent('#viscx_m');
      if (!cst || cst === '—') {
        throw new Error(`Oil viscosity panel: expected #viscx_m to show a computed value, got: "${cst}"`);
      }
      await page.locator('#oilChart').scrollIntoViewIfNeeded();
      const oilBox = await page.locator('#oilChart').boundingBox();
      await page.mouse.click(oilBox.x + oilBox.width / 2, oilBox.y + oilBox.height / 2);
      await page.waitForTimeout(100);
      const probeAfterClick = await page.$eval('#tempx_m', (el) => el.value);
      if (!probeAfterClick) throw new Error('Oil viscosity panel: probe temp did not update after clicking the chart');

      // Switching the active oil should reset Oil temperature to 21°C by default.
      await page.check('#oilActive2');
      await page.waitForTimeout(100);
      const oilTempAfterSwitch = await page.$eval('#oilTemp', (el) => el.value);
      if (oilTempAfterSwitch !== '21') {
        throw new Error(
          `Oil viscosity panel: expected #oilTemp to reset to 21 after switching oils, got: "${oilTempAfterSwitch}"`,
        );
      }
      const active1Checked = await page.$eval('#oilActive1', (el) => el.checked);
      if (active1Checked)
        throw new Error('Oil viscosity panel: expected #oilActive1 to be unchecked after checking #oilActive2');

      if (errors.length > 0) throw new Error('Shim Stack Tuner console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Shim Stack Tuner: photo port measurement. AUTO mode: upload the synthetic valve
    // photo (two known port rings + a bore), confirm the tool auto-finds the groups and
    // "Apply" writes r/d/w.port + N.port + D.rod + valve type, scaled from D.valve only.
    // Then the MANUAL trace fallback. Expected values use mmPerPx = 50 / (2 * 200) = 0.125. ----
    {
      const close = (a, b, tol) => Math.abs(a - b) < tol;
      const pngBuffer = await generateSyntheticValvePhoto(browser);
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });

      await page.evaluate(() => {
        document.querySelectorAll('details.diagram-box').forEach((d) => {
          if (d.querySelector('#photoFileFront')) d.open = true;
        });
      });
      await page.waitForSelector('#photoFileFront', { state: 'attached', timeout: 5000 });

      await page.fill('#dValve', '50');
      await page.dispatchEvent('#dValve', 'input');
      await page.setInputFiles('#photoFileFront', { name: 'front.png', mimeType: 'image/png', buffer: pngBuffer });
      await page.waitForFunction(() => document.querySelectorAll('#photoGroups .photo-group-row').length >= 2, null, {
        timeout: 5000,
      });

      // group rows come back inner-ring-first; label inner rebound, outer compression.
      const selects = page.locator('#photoGroups .photo-group-row select');
      await selects.nth(0).selectOption('rebound');
      await selects.nth(1).selectOption('compression');
      await page.waitForTimeout(50);

      const summary = await page.textContent('#photoSummary');
      if (!/Compression: r\.port/.test(summary) || !/Rebound: r\.port/.test(summary)) {
        throw new Error(`Photo auto-detect: expected a per-set summary, got: "${summary}"`);
      }

      await page.selectOption('#photoApplySetSel', 'compression');
      await page.click('#photoApplyBtn');
      await page.waitForTimeout(100);
      const val = async (id) => parseFloat(await page.$eval(id, (el) => el.value));
      const rP = await val('#rPort');
      const dP = await val('#dPort');
      const wP = await val('#wPort');
      const nP = parseInt(await page.$eval('#nPort', (el) => el.value), 10);
      const dRodV = await val('#dRod');
      const vt = await page.$eval('#valveType', (el) => el.value);
      // outer ring: rInner 120, rOuter 165, halfAngle 0.14 -> r~15, d~5.6, w~5.8, N=6
      if (!close(rP, 15, 1.5) || !close(dP, 5.625, 1.5) || !close(wP, 5.78, 1.8) || nP !== 6) {
        throw new Error(`Photo auto-detect apply: expected r~15 d~5.6 w~5.8 N=6, got r=${rP} d=${dP} w=${wP} N=${nP}`);
      }
      if (!close(dRodV, 2 * 26 * 0.125, 1.5)) throw new Error(`Photo auto-detect: D.rod expected ~6.5, got ${dRodV}`);
      if (vt !== 'mainComp') throw new Error(`Photo auto-detect: expected valve type mainComp, got "${vt}"`);

      // ---- Manual trace fallback: 3 edge clicks + trace the outer ring's top port ----
      await page.locator('#photoModeToggle').check();
      await page.waitForTimeout(50);
      await page.locator('#photoSnapToggle').uncheck(); // click exact synthetic coords, no snap drift
      // Centre the canvas in the viewport so no click lands under the sticky top nav.
      await page.evaluate(() => document.getElementById('photoCanvas').scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(50);
      const box = await page.locator('#photoCanvas').boundingBox();
      const s = Math.min(box.width / 500, box.height / 500);
      const offX = box.x + (box.width - 500 * s) / 2;
      const offY = box.y + (box.height - 500 * s) / 2;
      const toPage = (ix, iy) => ({ x: offX + ix * s, y: offY + iy * s });
      for (const deg of [20, 150, 280]) {
        const r = (deg * Math.PI) / 180;
        const p = toPage(250 + 200 * Math.cos(r), 250 + 200 * Math.sin(r));
        await page.mouse.click(p.x, p.y);
      }
      const ring = VALVE_PHOTO.rings[1];
      const a0 = -Math.PI / 2;
      const seq = [
        [ring.rOuter, -ring.halfAngle],
        [ring.rOuter, ring.halfAngle],
        [ring.rInner, ring.halfAngle],
        [ring.rInner, -ring.halfAngle],
      ];
      for (const [rr, da] of seq) {
        const p = toPage(250 + rr * Math.cos(a0 + da), 250 + rr * Math.sin(a0 + da));
        await page.mouse.click(p.x, p.y);
      }
      await page.click('#photoFinishPortBtn');
      await page.waitForTimeout(50);
      await page.selectOption('#photoApplySetSel', 'rebound');
      await page.click('#photoApplyBtn');
      await page.waitForTimeout(100);
      const rReb = await val('#rPort');
      if (!close(rReb, 15, 2))
        throw new Error(`Photo manual trace: expected r.port ~15 for the traced port, got ${rReb}`);
      if ((await page.$eval('#valveType', (el) => el.value)) !== 'mainRebound') {
        throw new Error('Photo manual trace: expected valve type mainRebound after applying the rebound set');
      }

      if (errors.length > 0) throw new Error('Photo measurement console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Spring Curve Calculator panel (merged from the former spring-calculator.html):
    // expand it, chart renders, popout opens ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });
      await page.click('#p-spring-calc h2'); // expand (default-collapsed)
      await page.waitForTimeout(300);

      const rateText = await page.textContent('#a_ks');
      if (!rateText || rateText.includes('—')) {
        throw new Error(`Spring calculator: expected #a_ks to show a computed rate, got: "${rateText}"`);
      }
      await page.click('#btn-popout');
      await page.waitForTimeout(200);
      const overlayActive = await page.$eval('#popout-overlay', (el) => el.classList.contains('active'));
      if (!overlayActive) throw new Error('Spring calculator: popout overlay did not open');
      if (errors.length > 0) throw new Error('Spring calculator console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Shim Delta Tool panel (merged from the former shim-delta.html): expand it, delta
    // renders for the default pair ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });
      await page.click('#p-shim-delta h2'); // expand (default-collapsed)
      await page.waitForSelector('#output .summary-grid', { timeout: 5000 });
      if (errors.length > 0) throw new Error('Shim delta tool console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Wheel Force Curve panel (merged from the former spring-damper-curve.html): it
    // shares the same page load as the tuner, so by the time its own script runs, app.js's
    // initial runCalc({live:true}) has already written sst_live_config_v1 - it's synced from
    // the moment the panel is expanded, with no separate tab and no export/import step. ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });
      await page.click('#p-wheel-force h2'); // expand (default-collapsed)
      await page.waitForTimeout(300);

      const syncText = await page.textContent('#syncStatus');
      if (!syncText || syncText.includes('No valve config found')) {
        throw new Error(`Wheel force: expected a synced status on initial load, got: "${syncText}"`);
      }
      const enabled = await page.$eval('#velocity', (el) => !el.disabled);
      if (!enabled) throw new Error('Wheel force: expected velocity slider enabled once synced');

      // Drag the slider (range inputs need a dispatched event, not .fill()) and confirm the
      // damper-force readout actually changed - proves the sync + solve wiring runs end-to-end.
      const before = await page.textContent('#damperReadout');
      await page.evaluate(() => {
        const el = document.getElementById('velocity');
        el.value = '4000';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const after = await page.textContent('#damperReadout');
      if (after === before) {
        throw new Error('Wheel force: expected damper-force readout to change after moving the velocity slider');
      }

      // Editing a value in the workspace above should re-sync this panel on the spot, with no
      // "Refresh" click needed - proves the same-page sst-live-config-changed event works
      // (the native 'storage' event only fires in *other* tabs, never on this same page).
      const syncBefore = await page.textContent('#syncStatus');
      await page.fill('#clampDia', '15');
      await page.dispatchEvent('#clampDia', 'input');
      await page.waitForTimeout(300);
      const syncAfter = await page.textContent('#syncStatus');
      if (syncAfter === syncBefore) {
        throw new Error('Wheel force: expected sync status to update after a live edit elsewhere on the page');
      }

      if (errors.length > 0) throw new Error('Wheel force console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Pop-out windows: each of the 4 buttons opens a real, separate browser window
    // (window.open(), not an in-page overlay) that paints immediately from the last-known
    // sst_live_visuals_v1 snapshot and then live-updates via BroadcastChannel when the main
    // page recomputes - no export/import step, no page reload. A canvas is checked by
    // sampling distinct pixel colors: a chart that only cleared to background paints exactly
    // 1 distinct color, which is exactly the failure mode this catches (the hiddenCurves Set
    // not surviving the JSON round-trip through localStorage silently blanked the force
    // pop-out's first paint - see broadcastLiveVisuals()/readLiveVisualsSnapshot() in
    // js/live-sync.js). ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });
      await page.waitForTimeout(300); // let the initial synchronous runCalc({live:true}) broadcast
      const context = page.context();

      async function openPopout(btnId) {
        const [popup] = await Promise.all([context.waitForEvent('page'), page.click(btnId)]);
        await popup.waitForLoadState('networkidle');
        await popup.waitForTimeout(300);
        return popup;
      }

      function distinctColorCount(popup, canvasId) {
        return popup.evaluate((id) => {
          const cv = document.getElementById(id);
          const ctx = cv.getContext('2d');
          const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
          const seen = new Set();
          for (let i = 0; i < data.length; i += 4 * 61) seen.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
          return seen.size;
        }, canvasId);
      }

      // Stack + Force + Oil: each paints more than the single background color on open.
      for (const [btnId, canvasId, label] of [
        ['#popoutStackBtn', 'stackCanvas', 'Shim stack'],
        ['#popoutForceBtn', 'forceCanvas', 'Force curve'],
        ['#popoutOilBtn', 'oilChart', 'Oil viscosity'],
      ]) {
        const popup = await openPopout(btnId);
        const n = await distinctColorCount(popup, canvasId);
        if (n < 2) throw new Error(`${label} pop-out: expected a real initial paint, got only ${n} distinct color(s)`);
        await popup.close();
      }

      // Shim table pop-out: row count matches the main table, and grows after a live edit.
      {
        const popup = await openPopout('#popoutShimsBtn');
        const rowCount = await popup.$$eval('#shimBody tr', (rows) => rows.length);
        if (rowCount < 2) throw new Error(`Shim table pop-out: expected populated rows, got ${rowCount}`);

        await page.click('#addShimRowBtn');
        await page.waitForTimeout(300);
        const rowCountAfter = await popup.$$eval('#shimBody tr', (rows) => rows.length);
        if (rowCountAfter !== rowCount + 1) {
          throw new Error(
            `Shim table pop-out: expected row count to grow by 1 after a live edit, went from ${rowCount} to ${rowCountAfter}`,
          );
        }
        await popup.close();
      }

      // Re-clicking the same button after its window closed should open a fresh one (proves
      // the tracked-reference/.focus() path doesn't wedge once the old window is gone).
      const reopened = await openPopout('#popoutStackBtn');
      await reopened.close();

      if (errors.length > 0) throw new Error('Pop-out windows console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    console.log('SMOKE TEST PASSED');
  } catch (err) {
    console.error('SMOKE TEST FAILED');
    console.error(err.message || err);
    if (serverOutput) console.error('--- server output ---\n' + serverOutput);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

run();
