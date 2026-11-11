// TabRename content script: applies custom titles to this page from the two
// rule kinds — tab-specific rules (resolved through the background worker)
// and URL rules (chrome.storage.sync) — and keeps them applied against sites
// that rewrite their own titles.

(() => {
  const APPLY_DEBOUNCE_MS = 50;
  const URL_POLL_MS = 1000;

  let urlRules = [];
  let tabRule = null; // { title, url } bound to this exact tab, or null
  let originalTitle = null;
  let applied = null; // { source, title } for the rule currently in effect
  let lastHref = location.href;
  let applyScheduled = false;

  function globToRegex(pattern) {
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[\\s\\S]*");
    return new RegExp(`^${source}$`);
  }

  function matchRule(url) {
    for (const rule of urlRules) {
      if (rule.enabled === false) continue;
      try {
        if (globToRegex(rule.pattern).test(url)) return rule;
      } catch {
        // Invalid pattern; skip it.
      }
    }
    return null;
  }

  function applyTitle() {
    // A tab-specific rename wins over URL rules, and only applies while this
    // tab is still on the URL it was renamed on.
    let rule = null;
    if (tabRule && tabRule.url === location.href) {
      rule = { source: "tab", title: tabRule.title };
    } else {
      const urlRule = matchRule(location.href);
      if (urlRule) rule = { source: "url", title: urlRule.title };
    }

    if (rule) {
      if (!applied && document.title && document.title !== rule.title) {
        originalTitle = document.title;
      }
      applied = rule;
      if (document.title !== rule.title) document.title = rule.title;
    } else if (applied) {
      // Rules were removed, disabled, or no longer match: restore the original.
      applied = null;
      if (originalTitle) document.title = originalTitle;
    }
  }

  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    setTimeout(() => {
      applyScheduled = false;
      applyTitle();
    }, APPLY_DEBOUNCE_MS);
  }

  async function loadUrlRules() {
    const stored = await chrome.storage.sync.get("rules");
    urlRules = Array.isArray(stored.rules) ? stored.rules : [];
    applyTitle();
  }

  async function loadTabRule() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "tabrename:getTabRule" });
      tabRule = res && res.title ? { title: res.title, url: res.url } : null;
    } catch {
      tabRule = null; // background unreachable (e.g. mid-reload of the extension)
    }
    applyTitle();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" || area === "local") && changes.rules) loadUrlRules();
  });

  // The popup nudges this tab right after saving or deleting a tab rule.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "tabrename:refresh") loadTabRule();
  });

  // Sites change their title through the DOM (document.title writes, new
  // <title> nodes, text updates). Watch for any of those and re-apply.
  const observer = new MutationObserver(scheduleApply);
  observer.observe(document, { childList: true, subtree: true, characterData: true });

  document.addEventListener("DOMContentLoaded", applyTitle);
  window.addEventListener("load", applyTitle);

  // SPAs change the URL without a load event; re-match on navigation.
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      applyTitle();
    }
  }, URL_POLL_MS);

  loadUrlRules();
  loadTabRule();
})();
