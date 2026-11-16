// Service worker: registers the right-click menu and hands the current page
// off to the editor tab. No state is kept in globals.

const MENU_ID = 'print-shipping-label';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Print Shipping Label',
      contexts: ['page', 'frame', 'image', 'link'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  startJob(tab, {
    srcUrl: info.mediaType === 'image' ? info.srcUrl : undefined,
    linkUrl: info.linkUrl,
    frameUrl: info.frameUrl,
  });
});

chrome.action.onClicked.addListener((tab) => {
  startJob(tab, {});
});

async function startJob(tab, hints) {
  const id = `job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const job = {
    tabId: tab?.id,
    tabUrl: tab?.url,
    title: tab?.title,
    srcUrl: hints.srcUrl,
    linkUrl: hints.linkUrl,
    frameUrl: hints.frameUrl,
  };

  // Grab a screenshot now, while the source tab is still visible. It is only
  // used as a last resort if the label can't be fetched as a PDF or image.
  let screenshot;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    console.warn('Screenshot unavailable:', err);
  }

  try {
    await chrome.storage.session.set({ [id]: { ...job, screenshot } });
  } catch (err) {
    // Most likely the screenshot blew the session-storage quota; go without it.
    console.warn('Storing job with screenshot failed:', err);
    await chrome.storage.session.set({ [id]: job });
  }

  const createProps = { url: chrome.runtime.getURL(`editor.html?job=${id}`) };
  if (tab?.id !== undefined && tab.index !== undefined) {
    createProps.index = tab.index + 1;
    createProps.openerTabId = tab.id;
    createProps.windowId = tab.windowId;
  }
  try {
    await chrome.tabs.create(createProps);
  } catch (err) {
    console.error('Could not open the label editor:', err);
  }
}
