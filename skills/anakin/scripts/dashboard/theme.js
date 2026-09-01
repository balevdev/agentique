// Blocking head script: the theme must be decided before first paint,
// or a stored light theme flashes dark (and vice versa) on every load.
(() => {
  let saved = null;
  try { saved = localStorage.getItem("anakin-theme"); } catch { /* storage may be blocked */ }
  document.documentElement.dataset.theme =
    saved === "light" || saved === "dark" ? saved
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
})();
