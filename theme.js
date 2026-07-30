// Wires up the shared #themeToggle button. The theme itself is applied
// earlier by an inline snippet in <head> (before CSS renders, so there's
// no flash of the wrong theme) — this just keeps the button in sync and
// persists changes for next time.
function initThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  function render() {
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.textContent = dark ? '☀️ Light' : '🌙 Dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  render();
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sst_theme', next);
    render();
    // Canvas drawing can't use CSS variables directly, so any page with a theme-aware
    // chart (see themeColor() in canvas-utils.js) needs to know to redraw with the new
    // palette. Dispatched as a plain DOM event rather than calling into page-specific
    // code directly, since theme.js is shared by every tool page and has no business
    // knowing which (if any) of them have charts to redraw.
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  });
}
document.addEventListener('DOMContentLoaded', initThemeToggle);

// Shared "?" info-bubble behavior (see .hint-details/.hint-bubble/.hint-popover in
// theme.css). Each bubble is a plain <details>/<summary> - the browser already gives us
// open/close, keyboard access, and screen-reader semantics for free. This just adds two
// conveniences every popover-style control needs: opening one closes any other that was
// left open, and clicking anywhere outside all of them closes it too. The 'toggle' event
// doesn't bubble in every browser, so this listens on the capture phase instead, which
// still fires regardless of bubbling support.
document.addEventListener(
  'toggle',
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLDetailsElement) || !el.classList.contains('hint-details') || !el.open) return;
    document.querySelectorAll('details.hint-details[open]').forEach((other) => {
      if (other !== el) other.open = false;
    });
  },
  true,
);
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.hint-details[open]').forEach((el) => {
    if (!el.contains(e.target)) el.open = false;
  });
});
