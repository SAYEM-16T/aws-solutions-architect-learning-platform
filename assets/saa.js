/* Shared helpers for every SAA-SECTIONS page.
   Loaded in <head> without defer so the saved theme is applied before first paint. */
(function () {
  "use strict";
  const THEME_KEY = "saa-theme";
  const THEMES = ["auto", "light", "dark", "dracula"];

  // localStorage can be missing or throw (private window, blocked site data).
  function readLocal(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeLocal(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* not saved, page still works */ }
  }

  function applyTheme(theme) {
    if (THEMES.includes(theme) && theme !== "auto") document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(readLocal(THEME_KEY));

  function bindThemeButton() {
    const btn = document.querySelector("[data-theme-toggle]");
    if (!btn) return;
    const show = () => { btn.textContent = "Theme: " + (readLocal(THEME_KEY) || "auto"); };
    show();
    btn.addEventListener("click", () => {
      const now = readLocal(THEME_KEY) || "auto";
      const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
      writeLocal(THEME_KEY, next);
      applyTheme(next);
      show();
    });
  }

  // True when the page comes from the tracker server, so its /api/* routes exist.
  const served = location.protocol === "http:" || location.protocol === "https:";

  // Tracker data (read only). Resolves to null when opened as a plain file.
  function trackerState() {
    if (!served) return Promise.resolve(null);
    return fetch("/api/state", { cache: "no-store" })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  // Text boxes keep the height they were dragged to (this browser). Boxes with the same data-size
  // (e.g. every question note) share one height; others are kept by id.
  const OLD_SIZE = { secnote: "saa-note-height" };  // key used before by the summary page's note box
  function sizeKey(ta) { return ta.dataset.size || ta.id || ""; }
  function trackSize(ta) {
    const key = sizeKey(ta);
    if (!key || ta.dataset.sized) return;
    ta.dataset.sized = "1";
    const saved = parseInt(readLocal("saa-size-" + key) || readLocal(OLD_SIZE[key] || ""), 10);
    if (saved > 40) ta.style.height = saved + "px";
    let timer = null, last = ta.offsetHeight;
    new ResizeObserver(() => {
      const h = ta.offsetHeight;
      if (h <= 40 || h === last) return;  // hidden, or not changed
      last = h;
      clearTimeout(timer);
      timer = setTimeout(() => {
        writeLocal("saa-size-" + key, String(h));
        document.querySelectorAll("textarea").forEach(o => { if (o !== ta && sizeKey(o) === key) o.style.height = h + "px"; });
      }, 300);
    }).observe(ta);
  }
  function bindSizes() {
    document.querySelectorAll("textarea").forEach(trackSize);
    new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.matches("textarea")) trackSize(n);
      n.querySelectorAll && n.querySelectorAll("textarea").forEach(trackSize);
    }))).observe(document.body, { childList: true, subtree: true });
  }

  window.SAA = { readLocal, writeLocal, served, trackerState };
  document.addEventListener("DOMContentLoaded", bindThemeButton);
  document.addEventListener("DOMContentLoaded", bindSizes);
})();
