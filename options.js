const el = document.getElementById('stackLinks');
chrome.storage.local.get({ stackLinks: true }, ({ stackLinks }) => {
  el.checked = stackLinks;
});
el.addEventListener('change', () => {
  chrome.storage.local.set({ stackLinks: el.checked });
});
