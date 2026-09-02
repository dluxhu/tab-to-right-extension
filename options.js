const DEFAULTS = { stackLinks: true, groupPlacement: 'end' };

const stackLinks = document.getElementById('stackLinks');
const placement = [...document.querySelectorAll('[name="groupPlacement"]')];

chrome.storage.local.get(DEFAULTS, saved => {
  stackLinks.checked = saved.stackLinks;
  for (const r of placement) r.checked = r.value === saved.groupPlacement;
});

stackLinks.addEventListener('change', () => {
  chrome.storage.local.set({ stackLinks: stackLinks.checked });
});
for (const r of placement) {
  r.addEventListener('change', () => {
    if (r.checked) chrome.storage.local.set({ groupPlacement: r.value });
  });
}
