# Shim Stack Tuner

Shim Stack Tuner is a standalone browser-based tool for exploring shim-stack stiffness and damping-force behavior for suspension valving.

## What it does

- Models a shim stack with engagement and float behavior
- Estimates damping force over a velocity range
- Supports target curves and optimizer-style suggestions
- Runs entirely in the browser with no install required

## Run locally

Start a simple local server from the project folder and open the app in a browser:

- Run: `npm start`
- Open: http://127.0.0.1:8000/

The app now loads from [index.html](index.html), with styles in [styles.css](styles.css) and logic in [app.js](app.js).

## Notes

This is an independent engineering tool intended for comparison and exploration, not a replacement for calibrated dyno or manufacturer data.
