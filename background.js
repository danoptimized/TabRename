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
// If the tab has no rule of its own, adopt any unattached rule for the same
// URL — one left over from before a browser restart whose tab hasn't asked
// yet (e.g. a lazily restored tab whose URL wasn't known at startup).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "tabrename:getTabRule" || !sender.tab) return false;
  resolveTabRule(sender.tab).then((rule) => {
    sendResponse(rule && rule.enabled !== false ? { title: rule.title, url: rule.url } : null);
  });
  return true; // respond asynchronously
});

async function resolveTabRule(tab) {
  const { [TAB_RULES_KEY]: tabRules = {} } = await chrome.storage.local.get(TAB_RULES_KEY);
  const own = tabRules[tab.id];
  if (own) return own;
  if (!tab.url) return null;
  // An unattached rule points at a tab ID that no longer answers for itself;
  // only adopt it if that tab isn't live under its old ID.
  let orphan = null;
  for (const [id, rule] of Object.entries(tabRules)) {
    if (rule.url !== tab.url) continue;
    if (await tabExists(Number(id))) continue;
    orphan = [id, rule];
    break;
  }
  if (!orphan) return null;
  const [oldId, rule] = orphan;
  const next = { ...tabRules, [tab.id]: rule };
  delete next[oldId];
  await chrome.storage.local.set({ [TAB_RULES_KEY]: next });
  return rule;
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// Tab-specific renames survive browser restarts: rules are stored in
// chrome.storage.local, and at startup each rule re-attaches to every
// restored tab sitting on the URL it was renamed on. Rules whose tab is gone
// stay unattached for now — a tab that lands on that URL later (e.g. a
// restored tab that had no URL at startup) adopts it via resolveTabRule, and
// anything still unattached is re-evaluated at the next startup.
chrome.runtime.onStartup.addListener(async () => {
  const { [TAB_RULES_KEY]: tabRules = {} } = await chrome.storage.local.get(TAB_RULES_KEY);
  const tabs = await chrome.tabs.query({});
  const byUrl = new Map();
  for (const tab of tabs) {
    if (tab.url) {
      const ids = byUrl.get(tab.url) ?? [];
      ids.push(tab.id);
      byUrl.set(tab.url, ids);
    }
  }
  const next = {};
  for (const [oldId, rule] of Object.entries(tabRules)) {
    const matches = byUrl.get(rule.url);
    if (matches) {
      for (const id of matches) next[id] = { ...rule };
    } else {
      // No tab is on this URL (yet): keep the rule unattached so a tab that
      // lands on it later can adopt it.
      next[oldId] = rule;
    }
  }
  await chrome.storage.local.set({ [TAB_RULES_KEY]: next });
  // Tabs restored and already loaded may have asked before the re-attach;
  // nudge them to re-read their rule.
  for (const id of Object.keys(next)) {
    chrome.tabs.sendMessage(Number(id), { type: "tabrename:refresh" }).catch(() => {});
  }
});

// A tab-specific rename dies with its tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(TAB_RULES_KEY).then(({ [TAB_RULES_KEY]: tabRules = {} }) => {
    if (!(tabId in tabRules)) return;
    delete tabRules[tabId];
    chrome.storage.local.set({ [TAB_RULES_KEY]: tabRules });
  });
});

// Discarded/prerendered tabs can swap IDs; move the rename with the tab.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  chrome.storage.local.get(TAB_RULES_KEY).then(({ [TAB_RULES_KEY]: tabRules = {} }) => {
    if (!(removedTabId in tabRules)) return;
    tabRules[addedTabId] = tabRules[removedTabId];
    delete tabRules[removedTabId];
    chrome.storage.local.set({ [TAB_RULES_KEY]: tabRules });
  });
});
