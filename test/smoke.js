// Automated smoke test: starts the local server, loads each page in a
// headless browser, and fails if a page errors or its JS doesn't run.
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

// Geometry shared between the synthetic photo generator and the test's click sequence:
// a filled circle of radius 200px centered at (250,250) - the valve's outer edge - and one
// true annular-sector "port" (rInner=80, rOuter=150, half-angle=0.15rad, pointing straight
// up), drawn the same way the app's own drawPortFaceDiagramInner draws a port (two arcs
// joined by straight sides), so it's representative of a real port shape/rendering rather
// than an arbitrary rectangle.
const PORT_GEOM = { cx: 250, cy: 250, rInner: 80, rOuter: 150, halfAngle: 0.15, centerAngle: -Math.PI / 2 };

// Generates the synthetic "valve photo" PNG (500x500) described above via an in-browser
// canvas. Used to exercise the photo-measurement feature's actual click + edge-snap math
// end-to-end, not just check the page loads.
async function generateSyntheticValvePhoto(browser) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate((g) => {
    const c = document.createElement('canvas');
    c.width = 500;
    c.height = 500;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 500, 500);
    ctx.fillStyle = '#888888';
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, 200, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = '#181818';
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.rOuter, g.centerAngle - g.halfAngle, g.centerAngle + g.halfAngle);
    ctx.arc(g.cx, g.cy, g.rInner, g.centerAngle + g.halfAngle, g.centerAngle - g.halfAngle, true);
    ctx.closePath();
    ctx.fill();
    return c.toDataURL('image/png');
  }, PORT_GEOM);
  await page.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// The 4 sharp corners of PORT_GEOM's sector, in image-pixel space - used as click targets.
function portCorners() {
  const { cx, cy, rInner, rOuter, halfAngle, centerAngle } = PORT_GEOM;
  const pt = (r, a) => ({ x: cx + r * Math.cos(centerAngle + a), y: cy + r * Math.sin(centerAngle + a) });
  return [pt(rOuter, -halfAngle), pt(rOuter, halfAngle), pt(rInner, halfAngle), pt(rInner, -halfAngle)];
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
        'spring-calculator.html',
        'shim-delta.html',
        'oil-viscosity.html',
        'spring-damper-curve.html',
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

      if (errors.length > 0) throw new Error('Shim Stack Tuner console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Shim Stack Tuner: photo-assisted port measurement, exercised end-to-end with a
    // synthetic image whose exact pixel geometry is known (PORT_GEOM), so the computed
    // r.port/d.port/w.port can be checked against hand-calculated expected values (not just
    // "no errors"). Also exercises: edge-snapping (clicks are deliberately offset from the
    // true corners - a pass requires the snap to have corrected them), tracing + averaging
    // multiple ports, the "other ports" counter, and the N.port suggestion. ----
    {
      const pngBuffer = await generateSyntheticValvePhoto(browser);
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });

      // The photo-measure section starts collapsed - open it.
      await page.evaluate(() => {
        document.querySelectorAll('details.diagram-box').forEach((d) => {
          if (d.querySelector('#photoFile')) d.open = true;
        });
      });
      await page.waitForSelector('#photoFile', { state: 'attached', timeout: 5000 });

      await page.fill('#dValve', '50');
      await page.dispatchEvent('#dValve', 'input');
      await page.setInputFiles('#photoFile', { name: 'test-valve.png', mimeType: 'image/png', buffer: pngBuffer });
      await page.waitForTimeout(300);
      await page.locator('#photoCanvas').scrollIntoViewIfNeeded();

      const box = await page.locator('#photoCanvas').boundingBox();
      const imgW = 500,
        imgH = 500;
      const scale = Math.min(box.width / imgW, box.height / imgH);
      const dw = imgW * scale,
        dh = imgH * scale;
      const offX = box.x + (box.width - dw) / 2;
      const offY = box.y + (box.height - dh) / 2;
      const toPage = (ix, iy) => ({ x: offX + ix * scale, y: offY + iy * scale });

      // Calibration: 3 points on the outer circle (radius 200, center 250,250).
      for (const deg of [0, 130, 260]) {
        const rad = (deg * Math.PI) / 180;
        const p = toPage(250 + 200 * Math.cos(rad), 250 + 200 * Math.sin(rad));
        await page.mouse.click(p.x, p.y);
      }

      // Trace the port's 4 sharp corners, but click a few pixels off from each true corner
      // (radially, toward/away from center) - within the edge-snap search radius, so a
      // passing result requires snapping to have corrected the imprecision, not just luck.
      const corners = portCorners();
      const cx = PORT_GEOM.cx,
        cy = PORT_GEOM.cy;
      const offsetRadially = (pt, delta) => {
        const d = Math.hypot(pt.x - cx, pt.y - cy);
        const ux = (pt.x - cx) / d,
          uy = (pt.y - cy) / d;
        return { x: pt.x + ux * delta, y: pt.y + uy * delta };
      };
      const traceOnePort = async (deltas) => {
        for (let i = 0; i < corners.length; i++) {
          const offPt = offsetRadially(corners[i], deltas[i]);
          const p = toPage(offPt.x, offPt.y);
          await page.mouse.click(p.x, p.y);
        }
        await page.click('#photoFinishPortBtn');
      };
      await traceOnePort([5, -5, 5, -5]);
      await page.waitForTimeout(100);

      let portsHint = await page.textContent('#photoPortsHint');
      if (!portsHint || !portsHint.includes('1 port traced')) {
        throw new Error(`Photo measurement: expected "1 port traced" after finishing one port, got: "${portsHint}"`);
      }

      // Expected (mmPerPx = 50/(2*200) = 0.125): r.port=80*0.125=10, d.port=70*0.125=8.75, w.port=(2*0.15*150)*0.125=5.625
      const close = (a, b, tol) => Math.abs(a - b) < tol;
      function parsePortsHint(text) {
        const m = text.match(/r\.port ≈ ([\d.]+)mm, d\.port ≈ ([\d.]+)mm, w\.port ≈ ([\d.]+)mm/);
        if (!m) throw new Error(`Photo measurement: could not parse ports hint: "${text}"`);
        return { rPort: parseFloat(m[1]), dPort: parseFloat(m[2]), wPort: parseFloat(m[3]) };
      }
      let avg = parsePortsHint(portsHint);
      if (!close(avg.rPort, 10, 0.5) || !close(avg.dPort, 8.75, 0.5) || !close(avg.wPort, 5.625, 0.5)) {
        throw new Error(
          `Photo measurement (1 port, with edge-snap correcting offset clicks): expected r.port~10, d.port~8.75, w.port~5.625, got ${JSON.stringify(avg)}`,
        );
      }

      // Trace a second port (same true shape, different offsets) and confirm averaging.
      await traceOnePort([-4, 4, -4, 4]);
      await page.waitForTimeout(100);
      portsHint = await page.textContent('#photoPortsHint');
      if (!portsHint || !portsHint.includes('2 ports traced')) {
        throw new Error(`Photo measurement: expected "2 ports traced" after a second port, got: "${portsHint}"`);
      }
      avg = parsePortsHint(portsHint);
      if (!close(avg.rPort, 10, 0.5) || !close(avg.dPort, 8.75, 0.5) || !close(avg.wPort, 5.625, 0.5)) {
        throw new Error(`Photo measurement: 2-port average drifted too far from expected, got ${JSON.stringify(avg)}`);
      }

      // 2 more ports visible but not traced -> suggested N.port should be 2 traced + 2 = 4.
      await page.fill('#photoOtherPorts', '2');
      await page.dispatchEvent('#photoOtherPorts', 'input');
      await page.waitForTimeout(100);
      portsHint = await page.textContent('#photoPortsHint');
      if (!portsHint.includes('suggested N.port = 4')) {
        throw new Error(`Photo measurement: expected suggested N.port = 4, got: "${portsHint}"`);
      }

      await page.click('#photoApplyBtn');
      await page.waitForTimeout(100);
      const rPortVal = parseFloat(await page.$eval('#rPort', (el) => el.value));
      const dPortVal = parseFloat(await page.$eval('#dPort', (el) => el.value));
      const wPortVal = parseFloat(await page.$eval('#wPort', (el) => el.value));
      const nPortVal = parseInt(await page.$eval('#nPort', (el) => el.value), 10);
      if (!close(rPortVal, 10, 0.5) || !close(dPortVal, 8.75, 0.5) || !close(wPortVal, 5.625, 0.5) || nPortVal !== 4) {
        throw new Error(
          `Photo measurement: expected applied r.port~10, d.port~8.75, w.port~5.625, N.port=4, got r.port=${rPortVal}, d.port=${dPortVal}, w.port=${wPortVal}, N.port=${nPortVal}`,
        );
      }

      if (errors.length > 0) throw new Error('Photo measurement console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Spring Curve Calculator: loads clean, chart renders, popout opens ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'spring-calculator.html');
      await page.waitForSelector('#chart', { timeout: 5000 });
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

    // ---- Shim Delta Tool: loads clean, delta renders for the default pair ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-delta.html');
      await page.waitForSelector('#output .summary-grid', { timeout: 5000 });
      if (errors.length > 0) throw new Error('Shim delta tool console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Oil Viscosity Comparison: loads clean, probe values compute, chart renders ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'oil-viscosity.html');
      await page.waitForSelector('#chart', { timeout: 5000 });
      const cst = await page.textContent('#viscx_m');
      if (!cst || cst === '—') {
        throw new Error(`Oil viscosity: expected #viscx_m to show a computed value, got: "${cst}"`);
      }
      // Click on the chart and confirm the probe temp field followed the click.
      const box = await page.locator('#chart').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(100);
      const probeAfterClick = await page.$eval('#tempx_m', (el) => el.value);
      if (!probeAfterClick) throw new Error('Oil viscosity: probe temp did not update after clicking the chart');
      if (errors.length > 0) throw new Error('Oil viscosity console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Wheel Force Curve: no-config state in a fresh context ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'spring-damper-curve.html');
      await page.waitForSelector('#chart', { timeout: 5000 });
      const syncText = await page.textContent('#syncStatus');
      if (!syncText || !syncText.includes('No valve config found')) {
        throw new Error(`Wheel force: expected "no config" sync status, got: "${syncText}"`);
      }
      const disabled = await page.$eval('#velocity', (el) => el.disabled);
      if (!disabled) throw new Error('Wheel force: expected velocity slider disabled with no synced config');
      if (errors.length > 0) throw new Error('Wheel force (no config) console/page errors:\n' + errors.join('\n'));
      await page.close();
    }

    // ---- Wheel Force Curve: synced-from-tuner state (same page/context, so localStorage
    // written by the tuner is visible - browser.newPage() would start a fresh, empty one) ----
    {
      const { page, errors } = await loadAndCollectErrors(browser, 'shim-stack-tuner.html');
      await page.waitForSelector('h1', { timeout: 5000 });
      await page.waitForTimeout(300); // let the initial synchronous runCalc({live:true}) persist
      const hasConfig = await page.evaluate(() => localStorage.getItem('sst_live_config_v1') !== null);
      if (!hasConfig) throw new Error('Tuner did not persist sst_live_config_v1 after initial load');

      errors.length = 0; // remaining checks are scoped to the new page, not the tuner
      await page.goto(BASE + 'spring-damper-curve.html', { waitUntil: 'networkidle' });
      await page.waitForSelector('#chart', { timeout: 5000 });

      const syncText = await page.textContent('#syncStatus');
      if (!syncText || syncText.includes('No valve config found')) {
        throw new Error(`Wheel force: expected a synced status, got: "${syncText}"`);
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

      if (errors.length > 0) throw new Error('Wheel force (synced) console/page errors:\n' + errors.join('\n'));
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
