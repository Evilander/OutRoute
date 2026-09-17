// Loaded in <head> so a saved theme applies before first paint.
(function () {
  try {
    const saved = localStorage.getItem('prism-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {
    // Storage can be blocked; the OS preference still applies through the stylesheet.
  }
})();
