# Valving Toolbox

[![CI](https://github.com/Locksmitch/shim-stack-tuner/actions/workflows/ci.yml/badge.svg)](https://github.com/Locksmitch/shim-stack-tuner/actions/workflows/ci.yml)

A small collection of independent, offline calculators for suspension valving and spring setup, served as a static multi-page site with a shared light/dark theme. Started as the standalone Shim Stack Tuner (the repo/package name), which is still the flagship tool.

## Tools

- **[Shim Stack Tuner](shim-stack-tuner.html)** — models a shim stack's engagement and float behavior, estimates damping force over a velocity range, and supports target curves and optimizer-style suggestions against a real shim catalog. Its port-geometry fields (r.port/d.port/w.port) can also be estimated from an uploaded photo: click 3 points on the valve's outer edge to set the scale, then trace freeform outlines (any shape — sharp, rounded, kidney) around one or more ports, averaging across however many you trace. Every click snaps to the nearest real edge in the photo automatically (a local Sobel gradient search), so clicks don't need to be pixel-perfect.
- **[Spring Curve Calculator](spring-calculator.html)** — compares dual springs-in-series against single springs: spring rate, coil-bind travel, sag/peak force, and a live force-vs-displacement chart with a pop-out view.
- **[Shim Delta Tool](shim-delta.html)** — pick two stock tunes and see exactly which shims to remove, keep, and add to go from one to the other.
- **[Oil Viscosity Comparison](oil-viscosity.html)** — plots two oils' viscosity across a temperature range from their cSt@40°C/@100°C ratings, computes Viscosity Index (ASTM D2270/ISO 2909), and lets you probe any temperature.
- **[Wheel Force Curve](spring-damper-curve.html)** — plots spring force across a chosen travel range, plus a second line showing spring force plus the additive damper force a compression valve tune generates at a chosen shaft velocity (0-8000 mm/s, via a slider). The valve tune is live-synced from whatever the Shim Stack Tuner tab currently has computed — no export/import step.

[index.html](index.html) is the hub page linking to all five. Every page runs entirely in the browser with no install, no accounts, and no network requests.

## Run locally

Start a simple local server from the project folder and open the app in a browser:

- Run: `npm start`
- Open: http://127.0.0.1:8000/

## Structure

- [theme.css](theme.css) / [theme.js](theme.js) — shared CSS variables (light + dark palettes), the top nav bar, and the theme-toggle button used by every page. Each tool's own stylesheet references these variables rather than hardcoding colors, so the toggle applies site-wide; state persists via `localStorage`.
- **Shim Stack Tuner**: markup in [shim-stack-tuner.html](shim-stack-tuner.html), styles in [styles.css](styles.css). Logic lives in [app.js](app.js) (event wiring, UI state, orchestration) plus a set of ES modules under [js/](js/): `units.js` (unit conversion), `physics.js` (the calculation engine), `storage.js` (localStorage helpers), `catalog-data.js` (loads the product/valve/tune catalog and derives the parts bin from it — see below), `canvas-utils.js` (shared canvas drawing helpers), and `photo-measure.js` (pure geometry + a small local edge-detection routine for the photo-assisted port measurement: fitting a circle through 3 clicked points, computing r.port/d.port/w.port from a freeform traced outline of any shape, and a Sobel-gradient edge-snap that corrects an imprecise click onto the nearest real boundary in the photo). Its own live-preview/results canvases intentionally keep a fixed light plotting surface in both themes, since their axis colors are drawn in JS assuming a light background. On every successful calculation, `runCalc()` also writes the full current stack (geometry, oil, valve type, shim rows) to the `sst_live_config_v1` localStorage key — a one-way snapshot that the Wheel Force Curve page reads, so it always reflects whatever the tuner last successfully computed without any explicit export/import step. The tuner itself also reads this same key on load (`applyConfigToUI()` in `init()`) and restores it instead of the built-in demo stack, so reopening the page picks up wherever you left off; the "Load example" button resets back to the demo stack on demand (and, since that's itself a successful calc, becomes the new "last used" state until you change something else).
- **Catalog data store**: the stock product/valve/tune library (currently FOX's 2025 38 Factory Grip X2 and RockShox's 2025 Vivid Coil) lives in [data/catalog.json](data/catalog.json), not in JS. A product's dimensions are always stored canonically in inches; a metric-sourced product (like the Vivid Coil) adds a `"units": "mm"` hint so the catalog/tune UI displays native mm instead of odd inch decimals, and so its thicknesses skip FOX's `.0031`/`.0032` rounding-noise snap (see `canonThk` in `catalog-data.js`), which would otherwise lightly corrupt an exact mm→in conversion. Tune rows also carry an optional 4th element, `"deltaT"`, marking a delta/triangle shim (see `deltaCoverage` in `physics.js`) — a part that reaches the quoted OD via three lobes rather than a full disc, so it's far softer at the rim; the optimizer treats round and delta shims at the same OD as distinct parts. `catalog-data.js`'s `loadCatalog()` fetches it on page load and populates `PRODUCTS`/`PARTS_BIN`; `app.js`'s `init()` awaits that before wiring up the product/valve/tune selects. If the fetch fails (e.g. the file is missing, or the page was opened as `file://` instead of through a server), a status line above the product select reports it and the stock-catalog features are unavailable for that session, but building a stack by hand still works normally. Keeping the data in its own JSON file rather than baked into a JS module means it can be edited (or generated) independently of the code, and is the natural seam for later swapping in a real backend — `loadCatalog(url)` takes the fetch URL as its only parameter, so pointing it at an API route instead of a static file wouldn't require any change to the code that consumes the catalog.
- **Spring Curve Calculator, Shim Delta Tool, Oil Viscosity Comparison**: each is a single self-contained HTML file (markup, styles, and logic together) — no build step, no shared JS module with the tuner.
- **Wheel Force Curve**: also self-contained, but its `<script type="module">` imports `buildStack`/`solveForceAtVelocity` directly from `js/physics.js` (and `lsGet` from `js/storage.js`) rather than reimplementing that math — it's the one non-tuner page that depends on the `js/` modules, since it needs the tuner's actual damping-force solver, not just its own arithmetic.

## Testing

`npm test` runs two suites:

- **Unit tests** ([test/physics.test.mjs](test/physics.test.mjs), [test/photo-measure.test.mjs](test/photo-measure.test.mjs)) — exercise `js/physics.js` (the calculation engine) and `js/photo-measure.js` (the photo-measurement geometry) directly with Node's built-in test runner, no browser needed. Run alone: `npm run test:unit`.
- **Smoke test** ([test/smoke.js](test/smoke.js)) — loads every page in a headless browser and checks each starts up without JS errors, plus one representative interaction per tool (the shim stack tuner's fuller interaction suite plus a full photo-measurement pass against a synthetically generated valve image with known geometry, the spring calculator's pop-out chart, the delta tool's default comparison, the oil viscosity chart's click-to-probe, the wheel force page's tuner-sync + velocity-slider check). Run alone: `npm run test:e2e`. One-time setup: `npm install` then `npx playwright install chromium`.

## Notes

These are independent engineering tools intended for comparison and exploration, not a replacement for calibrated dyno or manufacturer data.
