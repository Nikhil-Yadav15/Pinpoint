/**
 * ChatGPT Text Bookmarker — Manifest V3 Background Service Worker
 * Relays toolbar extension icon clicks to the active ChatGPT tab to toggle the bookmark sidebar.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith('https://chatgpt.com/')) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'CGPT_BM_TOGGLE_SIDEBAR' });
  } catch {
    // Content script may still be initializing on a freshly opened tab
  }
});
