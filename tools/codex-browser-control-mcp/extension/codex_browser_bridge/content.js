;(function () {
  if (/streamlit/i.test(document.title)) return;
  if (window.self !== window.top) return;

  const d = document.createElement('div');
  d.id = 'codex-browser-bridge-ind';
  d.innerText = 'codex_browser: connected';
  d.style.cssText = [
    'position:fixed',
    'bottom:8px',
    'right:8px',
    'background:#2f855a',
    'color:white',
    'padding:4px 7px',
    'border-radius:4px',
    'font-size:11px',
    'font-weight:bold',
    'z-index:2147483647',
    'box-shadow:0 2px 4px rgba(0,0,0,0.2)',
    'opacity:0.45',
    'pointer-events:none'
  ].join(';');
  (document.body || document.documentElement).appendChild(d);
})();
