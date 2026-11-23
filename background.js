// Clicking the toolbar icon opens the dashboard in its own window,
// or focuses it if it is already open.
const PAGE = chrome.runtime.getURL('dashboard.html');

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: PAGE });
  if (tabs.length) {
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    await chrome.tabs.update(tabs[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url: PAGE, type: 'popup', width: 1280, height: 900 });
});
