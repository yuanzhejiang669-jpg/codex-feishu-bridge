document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh').addEventListener('click', fetchCookies);
  fetchCookies();
});

async function fetchCookies() {
  const out = document.getElementById('out');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      out.textContent = 'No active tab';
      return;
    }
    const resp = await chrome.runtime.sendMessage({ cmd: 'cookies', url: tab.url });
    if (!resp?.ok) {
      out.textContent = 'Error: ' + (resp?.error || 'unknown');
      return;
    }
    if (!resp.data.length) {
      out.textContent = '(no cookies)';
      return;
    }
    out.textContent = resp.data.map(c =>
      `${c.name}=${c.value}` + (c.httpOnly ? ' [H]' : '') + (c.secure ? ' [S]' : '') + (c.partitionKey ? ' [P]' : '')
    ).join('\n');
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}
