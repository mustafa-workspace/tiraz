// popup.js — TIRAZ popup logic

document.addEventListener('DOMContentLoaded', () => {
  const badge = document.getElementById('status-badge');
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');

  // Check if we can communicate with the active tab's content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      // Extension pages not supported
      dot.classList.add('inactive');
      text.classList.add('inactive');
      text.textContent = 'Not available on this page';
      badge.style.cursor = 'default';
      return;
    }

    // Try to ping the content script
    chrome.tabs.sendMessage(tab.id, { type: 'TIRAZ-ping' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        dot.classList.add('inactive');
        text.classList.add('inactive');
        text.textContent = 'Reload page to activate';
      } else {
        dot.classList.remove('inactive');
        text.classList.remove('inactive');
        text.textContent = 'Active on this page';
      }
    });
  });

  // Click to trigger inspect mode from popup
  badge.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: 'TIRAZ-toggle-inspect' });
      window.close();
    });
  });
});
