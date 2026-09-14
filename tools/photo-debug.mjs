/* Run a REAL photo through the real detector and make its mistakes visible.
 *
 *   npm run photo:debug -- scratch/valve-front.jpg 46
 *                          ^ the photo                ^ D.valve in mm
 *
 * Node has no image decoder, so the photo is decoded in a headless browser (Playwright is
 * already a devDependency) and handed to js/image-analysis.js exactly as app.js hands it
 * over: capped to a 2400px reference space, same options. What comes back is therefore the
 * same answer the page would give, not a reimplementation of it.
 *
 * Writes into scratch/debug/ (gitignored, like everything in scratch/):
 *   report.txt   every number the analysis produced, per hole, plus a sensitivity sweep
 *   overlay.png  the whole face with its outlines and hole numbers
 *   mask.png     what the detector classified as sheet / valve / hole
 *   hole-NN.png  each hole cropped and blown up 4x with its traced outline on top - the
 *                one that actually answers "is this outline on the metal edge or not",
 *                which a full-frame view is far too small to show.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8000;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.join(ROOT, 'scratch', 'debug');

const [imgArg, dValveArg] = process.argv.slice(2);
if (!imgArg || !dValveArg) {
  console.error(
    'usage: npm run photo:debug -- <image> <D.valve mm>\n' + '   eg: npm run photo:debug -- scratch/valve-front.jpg 46',
  );
  process.exit(1);
}
const imgPath = path.resolve(ROOT, imgArg);
if (!existsSync(imgPath)) {
  console.error(`No such file: ${imgPath}`);
  process.exit(1);
}
const dValve = Number(dValveArg);
if (!(dValve > 0)) {
  console.error(`D.valve must be a positive number, got "${dValveArg}"`);
  process.exit(1);
}

const ext = path.extname(imgPath).toLowerCase();
const mime =
  { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[
    ext
  ] || 'image/jpeg';
const dataUrl = `data:${mime};base64,${readFileSync(imgPath).toString('base64')}`;

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

const fmt = (x, n = 3) => (typeof x === 'number' && isFinite(x) ? x.toFixed(n) : String(x));
const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);

mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT });
let browser;
const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

try {
  await waitForServer(BASE, 10000);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => say(`PAGE ERROR: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && say(`CONSOLE ERROR: ${m.text()}`));
  await page.goto(BASE + 'shim-stack-tuner.html', { waitUntil: 'networkidle' });

  // Decode + analyse in the page, through the same path app.js uses.
  const run = async (sensitivity) =>
    page.evaluate(
      async ({ dataUrl, dValve, sensitivity }) => {
        const mod = await import('/js/image-analysis.js');
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = () => rej(new Error('the browser could not decode that image'));
          img.src = dataUrl;
        });
        // same 2400px reference space makePhotoEntry() builds in app.js
        const cap = 2400;
        const scl = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight));
        const refW = Math.max(1, Math.round(img.naturalWidth * scl));
        const refH = Math.max(1, Math.round(img.naturalHeight * scl));
        const cv = document.createElement('canvas');
        cv.width = refW;
        cv.height = refH;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, refW, refH);
        const t0 = performance.now();
        const res = mod.analyseValvePhoto(ctx.getImageData(0, 0, refW, refH), dValve, { sensitivity });
        const ms = performance.now() - t0;
        window.__dbg = { res, refW, refH, dataUrl };
        return {
          ms,
          natural: { w: img.naturalWidth, h: img.naturalHeight },
          ref: { w: refW, h: refH },
          ok: res.ok,
          warnings: res.warnings,
          circle: res.circle,
          ellipse: res.ellipse,
          mmPerPx: res.mmPerPx,
          rimResidual: res.rimResidual,
          coverage: res.coverage,
          paper: res.paper,
          dRodMM: res.dRodMM,
          shaft: res.shaft
            ? { areaMM: res.shaft.areaMM, roundness: res.shaft.roundness, equivDiaMM: res.shaft.equivDiaMM }
            : null,
          groups: res.groups,
          holes: res.holes.map((h, i) => ({
            n: i + 1,
            id: h.id,
            rPort: h.rPort,
            rOuterMM: h.rOuterMM,
            dPort: h.dPort,
            wPort: h.wPort,
            areaMM: h.areaMM,
            roundness: h.roundness,
            sectorFill: h.sectorFill,
            widthInner: h.widthInner,
            widthMax: h.widthMax,
            widthOuter: h.widthOuter,
            angularSpan: h.angularSpan,
            pixels: h.pixels,
            circleFit: h.circleFit || null,
            completedFrom: h.completedFrom || null,
          })),
        };
      },
      { dataUrl, dValve, sensitivity },
    );

  const a = await run(1);

  say(`photo        ${path.basename(imgPath)}  ${a.natural.w}x${a.natural.h}px`);
  say(`analysed at  ${a.ref.w}x${a.ref.h}px (app caps the reference space at 2400px)`);
  say(`D.valve      ${dValve} mm   (analysis took ${Math.round(a.ms)} ms)`);
  say('');
  if (!a.ok) {
    say('ANALYSIS FAILED:');
    a.warnings.forEach((w) => say('  - ' + w));
  } else {
    say(`rim          centre ${fmt(a.circle.cx, 1)},${fmt(a.circle.cy, 1)}  r ${fmt(a.circle.r, 1)}px`);
    say(`scale        ${fmt(a.mmPerPx, 5)} mm/px   rim fit residual ${fmt(a.rimResidual, 4)}`);
    say(
      `shape        axis ratio ${fmt(a.ellipse.axisRatio, 4)}  tilt ${fmt(a.ellipse.tiltDeg, 1)}deg  ` +
        `de-skew ${a.ellipse.corrected ? 'APPLIED' : 'not applied'}`,
    );
    say(`face         ${fmt(a.coverage * 100, 1)}% of the rim circle detected as valve`);
    say(
      `sheet        value ${fmt(a.paper.v, 1)}  sat ${fmt(a.paper.s, 3)}  paper threshold ${fmt(a.paper.threshold, 1)}`,
    );
    say(
      `shaft        ${a.dRodMM ? `D.rod ${fmt(a.dRodMM)} mm (roundness ${fmt(a.shaft.roundness, 3)})` : 'NOT FOUND'}`,
    );
    say('');
    say(`${a.holes.length} holes, ${a.groups.length} ring(s)`);
    for (const g of a.groups) {
      const mine = a.holes.filter((h) => g.holeIds.includes(h.id));
      const areas = mine.map((h) => h.areaMM);
      const mean = areas.reduce((s, x) => s + x, 0) / (areas.length || 1);
      const sd = Math.sqrt(areas.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (areas.length || 1));
      say(
        `  ${g.id}: ${g.holeIds.length} holes, suggested ${g.suggestedRole}, inferred count ${g.count}, ` +
          `mean r ${fmt(g.meanRadiusMM, 2)}mm, area spread ${fmt(mean ? (sd / mean) * 100 : 0, 1)}%` +
          (mean && sd / mean > 0.18 ? '   <-- ports on one ring should be IDENTICAL' : ''),
      );
    }
    say('');
    say(
      pad('#', 4) +
        pad('r.in', 8) +
        pad('r.out', 8) +
        pad('d.port', 8) +
        pad('w.port', 8) +
        pad('area', 9) +
        pad('round', 7) +
        pad('sector', 7) +
        pad('w.in/max/out', 20) +
        pad('px', 7),
    );
    for (const h of a.holes) {
      say(
        pad('#' + h.n, 4) +
          pad(fmt(h.rPort, 2), 8) +
          pad(fmt(h.rOuterMM, 2), 8) +
          pad(fmt(h.dPort, 2), 8) +
          pad(fmt(h.wPort, 2), 8) +
          pad(fmt(h.areaMM, 2), 9) +
          pad(fmt(h.roundness, 3), 7) +
          pad(fmt(h.sectorFill, 3), 7) +
          pad(`${fmt(h.widthInner, 2)}/${fmt(h.widthMax, 2)}/${fmt(h.widthOuter, 2)}`, 20) +
          pad(h.pixels, 7),
      );
    }
    say('');
    say('');
    say('circle completion (the "a fifth of a circle tells you the rest" rule):');
    for (const h of a.holes) {
      const c = h.circleFit;
      if (!c) {
        say('  #' + h.n + ' not attempted');
        continue;
      }
      say(
        '  #' +
          pad(h.n, 3) +
          (c.ok ? 'COMPLETED' : 'rejected ') +
          '  inliers ' +
          fmt(c.inlierFrac, 2) +
          '  arc ' +
          fmt(c.arc, 2) +
          '  resid ' +
          fmt(c.residual, 3) +
          '  ' +
          (c.why || ''),
      );
    }
    say('');
    a.warnings.forEach((w) => say('warning: ' + w));
  }

  // How much does the answer depend on where the threshold happens to fall? If these move a
  // lot, the outlines are threshold-bound and no amount of averaging will settle them.
  say('');
  say('sensitivity sweep (white-tolerance slider):');
  say(
    pad('slider', 9) +
      pad('holes', 7) +
      pad('rim r px', 10) +
      pad('mean w.port', 13) +
      pad('mean area', 11) +
      'coverage',
  );
  for (const s of [0.6, 0.8, 1.0, 1.2, 1.5]) {
    const r = s === 1 ? a : await run(s);
    if (!r.ok) {
      say(pad(fmt(s, 2), 9) + 'FAILED: ' + r.warnings[0]);
      continue;
    }
    const n = r.holes.length || 1;
    say(
      pad(fmt(s, 2), 9) +
        pad(r.holes.length, 7) +
        pad(fmt(r.circle.r, 1), 10) +
        pad(fmt(r.holes.reduce((x, h) => x + h.wPort, 0) / n, 3), 13) +
        pad(fmt(r.holes.reduce((x, h) => x + h.areaMM, 0) / n, 2), 11) +
        fmt(r.coverage * 100, 1) +
        '%',
    );
  }
  await run(1); // leave window.__dbg holding the default-sensitivity result for the renders

  // ---- pictures ----
  if (a.ok) {
    const shots = await page.evaluate(async () => {
      const { res, refW, refH, dataUrl } = window.__dbg;
      const img = new Image();
      await new Promise((r) => {
        img.onload = r;
        img.src = dataUrl;
      });
      const out = {};
      const strokePoly = (ctx, pts, color, width) => {
        if (!pts.length) return;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      };

      // whole face
      {
        const c = document.createElement('canvas');
        c.width = refW;
        c.height = refH;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0, refW, refH);
        x.setLineDash([10, 7]);
        x.strokeStyle = '#eab308';
        x.lineWidth = 3;
        x.beginPath();
        x.arc(res.circle.cx, res.circle.cy, res.circle.r, 0, 7);
        x.stroke();
        x.setLineDash([]);
        if (res.shaft) strokePoly(x, res.shaft.contour, '#5b6472', 3);
        res.holes.forEach((h, i) => {
          strokePoly(x, h.contour, '#2f6fed', 3);
          if (h.recoveredContour) {
            x.setLineDash([12, 8]);
            strokePoly(x, h.recoveredContour, '#ff3b30', 4);
            x.setLineDash([]);
          }
          x.font = 'bold 34px system-ui, sans-serif';
          x.textAlign = 'center';
          x.textBaseline = 'middle';
          x.lineWidth = 6;
          x.strokeStyle = '#fff';
          x.strokeText(String(i + 1), h.centroidImg.x, h.centroidImg.y);
          x.fillStyle = '#0b0f14';
          x.fillText(String(i + 1), h.centroidImg.x, h.centroidImg.y);
        });
        out.overlay = c.toDataURL('image/png');
      }

      // classification mask
      {
        const { width, height, classes } = res.preview;
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const x = c.getContext('2d');
        const im = x.createImageData(width, height);
        for (let p = 0, i = 0; p < classes.length; p++, i += 4) {
          const v = classes[p];
          im.data[i] = v === 2 ? 234 : v === 1 ? 47 : 245;
          im.data[i + 1] = v === 2 ? 179 : v === 1 ? 111 : 245;
          im.data[i + 2] = v === 2 ? 8 : v === 1 ? 237 : 245;
          im.data[i + 3] = 255;
        }
        x.putImageData(im, 0, 0);
        out.mask = c.toDataURL('image/png');
      }

      // per-hole crops at 4x - the ones that show whether the outline is on the edge
      out.holes = res.holes.map((h) => {
        const all = h.recoveredContour ? h.contour.concat(h.recoveredContour) : h.contour;
        const xs = all.map((p) => p.x);
        const ys = all.map((p) => p.y);
        const padPx = 22;
        const x0 = Math.max(0, Math.floor(Math.min(...xs) - padPx));
        const y0 = Math.max(0, Math.floor(Math.min(...ys) - padPx));
        const x1 = Math.min(refW, Math.ceil(Math.max(...xs) + padPx));
        const y1 = Math.min(refH, Math.ceil(Math.max(...ys) + padPx));
        const z = 4;
        const c = document.createElement('canvas');
        c.width = (x1 - x0) * z;
        c.height = (y1 - y0) * z;
        const x = c.getContext('2d');
        x.imageSmoothingEnabled = false;
        x.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, -x0 * z, -y0 * z, refW * z, refH * z);
        strokePoly(
          x,
          h.contour.map((p) => ({ x: (p.x - x0) * z, y: (p.y - y0) * z })),
          'rgba(60,120,255,0.95)',
          2,
        );
        if (h.recoveredContour) {
          x.setLineDash([10, 7]);
          strokePoly(
            x,
            h.recoveredContour.map((p) => ({ x: (p.x - x0) * z, y: (p.y - y0) * z })),
            'rgba(255,60,60,0.95)',
            3,
          );
          x.setLineDash([]);
        }
        return c.toDataURL('image/png');
      });
      return out;
    });

    const save = (name, url) => writeFileSync(path.join(OUT, name), Buffer.from(url.split(',')[1], 'base64'));
    save('overlay.png', shots.overlay);
    save('mask.png', shots.mask);
    shots.holes.forEach((u, i) => save(`hole-${String(i + 1).padStart(2, '0')}.png`, u));
    say('');
    say(`wrote overlay.png, mask.png and ${shots.holes.length} hole crops to scratch/debug/`);
  }

  writeFileSync(path.join(OUT, 'report.txt'), lines.join('\n') + '\n');
  console.log(`\nreport -> ${path.join('scratch', 'debug', 'report.txt')}`);
} catch (err) {
  console.error('\nphoto-debug failed:', err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  await sleep(150);
}
