// TabRename background service worker. Tab-specific renames live here because
// only the background side knows tab IDs; content scripts ask for their own
// tab's rule. Also owns the tab context menu entry.

const TAB_RULES_KEY = "tabRules";
const MENU_RENAME_TAB = "tabrename-rename-tab";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create(
    {
      id: MENU_RENAME_TAB,
      title: "Rename this tab…",
      contexts: ["tab"],
    },
    () => void chrome.runtime.lastError // duplicates on re-install are fine
  );
});

// Right-clicking a tab opens the popup pointed at that exact tab — including
// background tabs, which the popup would otherwise not know about. The popup
// reads and clears pendingTabId when it opens.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_RENAME_TAB || !tab) return;
  await chrome.storage.session.set({ pendingTabId: tab.id });
  try {
    await chrome.action.openPopup({ windowId: tab.windowId });
  } catch {
    // openPopup needs a user gesture or is unavailable; clear the pointer so
    // the next normal popup open isn't hijacked.
    await chrome.storage.session.remove("pendingTabId");
  }
});

// Content scripts ask at load time (and after popup edits) whether their tab
// has a tab-specific rename. Tab IDs only exist on this side of the boundary.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "tabrename:getTabRule" || !sender.tab) return false;
  chrome.storage.session.get(TAB_RULES_KEY).then(({ [TAB_RULES_KEY]: tabRules }) => {
    const rule = tabRules?.[sender.tab.id];
    sendResponse(rule && rule.enabled !== false ? { title: rule.title, url: rule.url } : null);
  });
  return true; // respond asynchronously
});

// A tab-specific rename dies with its tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.get(TAB_RULES_KEY).then(({ [TAB_RULES_KEY]: tabRules = {} }) => {
    if (!(tabId in tabRules)) return;
    delete tabRules[tabId];
    chrome.storage.session.set({ [TAB_RULES_KEY]: tabRules });
  });
});

// Discarded/prerendered tabs can swap IDs; move the rename with the tab.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  chrome.storage.session.get(TAB_RULES_KEY).then(({ [TAB_RULES_KEY]: tabRules = {} }) => {
    if (!(removedTabId in tabRules)) return;
    tabRules[addedTabId] = tabRules[removedTabId];
    delete tabRules[removedTabId];
    chrome.storage.session.set({ [TAB_RULES_KEY]: tabRules });
  });
});
