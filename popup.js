const form = document.getElementById("rule-form");
const patternInput = document.getElementById("pattern");
const titleInput = document.getElementById("title");
const saveButton = document.getElementById("save");
const cancelButton = document.getElementById("cancel");
const statusEl = document.getElementById("status");
const rulesList = document.getElementById("rules");
const emptyEl = document.getElementById("empty");
const scopeInputs = document.querySelectorAll('input[name="scope"]');

let urlRules = []; // chrome.storage.sync rules, keyed by rule id
let tabRules = {}; // chrome.storage.local rules, keyed by tab id
let activeTab = null;
let editing = null; // { kind: "tab", tabId, title, url } or { kind: "url", id, pattern, title, enabled }
let statusTimer = null;

function globToRegex(pattern) {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${source}$`);
}

function setStatus(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ""), 2500);
}

function currentScope() {
  return document.querySelector('input[name="scope"]:checked').value;
}

function setScope(value) {
  for (const input of scopeInputs) input.checked = input.value === value;
}

function resetForm() {
  editing = null;
  patternInput.value = "";
  titleInput.value = "";
  patternInput.disabled = false;
  for (const input of scopeInputs) input.disabled = false;
  saveButton.textContent = "Rename tab";
  cancelButton.hidden = true;
}

function startEdit(entry) {
  editing = entry;
  titleInput.value = entry.title;
  patternInput.value = entry.pattern || entry.url;
  patternInput.disabled = entry.kind === "tab";
  setScope(entry.kind);
  // Switching scope mid-edit would turn one rule kind into the other;
  // keep the scope fixed and let the user delete + re-add instead.
  for (const input of scopeInputs) input.disabled = true;
  saveButton.textContent = "Save changes";
  cancelButton.hidden = false;
  titleInput.focus();
}

async function nudgeTab(tabId) {
  // Tell the tab's content script to re-read its tab rule right away.
  try {
    await chrome.tabs.sendMessage(tabId, { type: "tabrename:refresh" });
  } catch {
    // Tab has no content script (e.g. a chrome:// page); nothing to do.
  }
}

function renderRules() {
  rulesList.textContent = "";
  const tabEntries = Object.entries(tabRules);
  emptyEl.hidden = urlRules.length + tabEntries.length > 0;

  for (const [tabId, rule] of tabEntries) {
    addRuleRow({ kind: "tab", tabId: Number(tabId), ...rule });
  }
  for (const rule of urlRules) {
    addRuleRow({ kind: "url", ...rule });
  }
}

function addRuleRow(entry) {
  const li = document.createElement("li");
  li.className = entry.enabled === false ? "rule disabled" : "rule";

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = entry.enabled !== false;
  enabled.title = "Enable or disable this rule";
  enabled.addEventListener("change", async () => {
    entry.enabled = enabled.checked;
    if (entry.kind === "tab") {
      tabRules[entry.tabId] = { title: entry.title, url: entry.url, enabled: entry.enabled };
      await chrome.storage.local.set({ tabRules });
      await nudgeTab(entry.tabId);
    } else {
      const rule = urlRules.find((r) => r.id === entry.id);
      if (rule) rule.enabled = enabled.checked;
      await chrome.storage.sync.set({ rules: urlRules });
    }
    setStatus(enabled.checked ? "Rule enabled" : "Rule disabled");
  });

  const texts = document.createElement("div");
  texts.className = "texts";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = entry.title;
  const pattern = document.createElement("div");
  pattern.className = "pattern";
  pattern.textContent = entry.pattern || entry.url;
  texts.append(name, pattern);

  const editButton = document.createElement("button");
  editButton.className = "icon";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => startEdit(entry));

  const deleteButton = document.createElement("button");
  deleteButton.className = "icon";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    if (entry.kind === "tab") {
      delete tabRules[entry.tabId];
      await chrome.storage.local.set({ tabRules });
      await nudgeTab(entry.tabId);
    } else {
      urlRules = urlRules.filter((r) => r.id !== entry.id);
      await chrome.storage.sync.set({ rules: urlRules });
    }
    const editingThis =
      editing &&
      editing.kind === entry.kind &&
      (entry.kind === "url" ? editing.id === entry.id : editing.tabId === entry.tabId);
    if (editingThis) resetForm();
    renderRules();
    setStatus("Rule deleted");
  });

  li.append(enabled, texts, editButton, deleteButton);
  if (entry.kind === "tab") {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "this tab";
    li.append(badge);
  }
  rulesList.append(li);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = titleInput.value.trim();
  if (!title) {
    setStatus("A title is required.");
    return;
  }

  if (editing) {
    if (editing.kind === "tab") {
      tabRules[editing.tabId] = { ...tabRules[editing.tabId], title };
      await chrome.storage.local.set({ tabRules });
      await nudgeTab(editing.tabId);
      setStatus("Tab renamed");
    } else {
      const rule = urlRules.find((r) => r.id === editing.id);
      if (rule) {
        rule.pattern = patternInput.value.trim();
        rule.title = title;
      }
      await chrome.storage.sync.set({ rules: urlRules });
      setStatus("Rule updated");
    }
  } else if (currentScope() === "tab") {
    if (!activeTab?.url) {
      setStatus("No active page to rename.");
      return;
    }
    tabRules[activeTab.id] = { title, url: activeTab.url, enabled: true };
    await chrome.storage.local.set({ tabRules });
    await nudgeTab(activeTab.id);
    setStatus("Tab renamed (this tab only)");
  } else {
    const pattern = patternInput.value.trim();
    if (!pattern) {
      setStatus("A URL pattern is required.");
      return;
    }
    urlRules.push({ id: crypto.randomUUID(), pattern, title, enabled: true });
    await chrome.storage.sync.set({ rules: urlRules });
    setStatus("Rule added");
  }

  // Renaming is about the tab in front of you: reload it so the new title
  // takes effect in a clean load, whatever the page does with its own title.
  if (activeTab?.id != null) {
    try {
      await chrome.tabs.reload(activeTab.id);
    } catch {
      // Tab may have closed mid-save; the rule still applies next load.
    }
  }

  renderRules();
  resetForm();
});

cancelButton.addEventListener("click", resetForm);

for (const input of scopeInputs) {
  input.addEventListener("change", () => {
    // Tab-specific renames are pinned to the current URL, so the pattern
    // field doesn't apply.
    patternInput.disabled = currentScope() === "tab";
  });
}

async function getTargetTab() {
  // A right-click "Rename this tab…" points us at the exact tab that was
  // clicked, even if it wasn't the active tab.
  const { pendingTabId } = await chrome.storage.session.get("pendingTabId");
  if (pendingTabId != null) {
    await chrome.storage.session.remove("pendingTabId");
    const tab = await chrome.tabs.get(pendingTabId).catch(() => null);
    if (tab) return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function init() {
  const [{ rules }, local, tab] = await Promise.all([
    chrome.storage.sync.get("rules"),
    chrome.storage.local.get("tabRules"),
    getTargetTab(),
  ]);
  urlRules = Array.isArray(rules) ? rules : [];
  tabRules = local.tabRules ?? {};
  activeTab = tab;
  renderRules();

  if (!activeTab?.url) return;

  // Open the form on the rule that governs this page, if any. A tab-specific
  // rule takes precedence since that's what the tab currently shows.
  if (tabRules[activeTab.id]) {
    startEdit({ kind: "tab", tabId: activeTab.id, ...tabRules[activeTab.id] });
  } else {
    const matching = urlRules.find((rule) => {
      try {
        return globToRegex(rule.pattern).test(activeTab.url);
      } catch {
        return false;
      }
    });
    if (matching) {
      startEdit({ kind: "url", ...matching });
    } else {
      patternInput.value = activeTab.url;
      titleInput.value = activeTab.title || "";
    }
  }
}

init();
