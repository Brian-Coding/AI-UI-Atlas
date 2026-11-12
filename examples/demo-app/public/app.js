// Shared helpers for Acme Notes pages.
window.acme = {
  async getJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return response.json();
  },
  escape(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  },
};
