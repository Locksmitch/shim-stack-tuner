// Automated smoke test: starts the local server, loads the app in a
// headless browser, and fails if the page errors or the JS doesn't run.
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 8000;
const URL = `http://127.0.0.1:${PORT}/`;
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

async function run() {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT });
  let serverOutput = '';
  server.stdout.on('data', (d) => (serverOutput += d));
  server.stderr.on('data', (d) => (serverOutput += d));

  let browser;
  try {
    await waitForServer(URL, 10000);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

    await page.goto(URL, { waitUntil: 'networkidle' });
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

    if (errors.length > 0) {
      throw new Error('Console/page errors detected:\n' + errors.join('\n'));
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
