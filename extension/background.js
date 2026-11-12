// Agent Bridge service worker: connects to the local bridge (ws://127.0.0.1:port)
// and carries out agent commands via chrome.debugger.
// SECURITY: the agent only ever sees and uses tabs IT opened (plus popups those tabs open) — and
// only its own: tabs of another agent on the same bridge are invisible and off limits, as are the
// user's own tabs. Sensitive fields (passwords, OTP, card numbers) never appear in snapshots, and
// a value the agent did not type into an identity or sign-in field (autofill, remembered account,
// a user draft in a contenteditable) is not shown to it either. Screenshots get a second layer
// outside the page: every such value's rectangle is painted over after the capture, in every
// frame of the tab's process plus the closed shadow roots the main-world watcher reports —
// so a page cannot unmask its own values while the picture is taken. Console and network output
// is scrubbed of those values. Clicking a javascript: link is refused outright. Signing in is
// left to the user, ticking a consent box (a real checkbox or an ARIA checkbox/switch/radio the
// click lands inside) waits for their approval. The URL policy (blocked patterns from the popup +
// the run's allowed domains from --allow) is enforced on every command and on every URL an agent
// tab lands on; a tab that leaves it is parked on about:blank. eval is opt-in (off by default,
// per-tab run limits still apply).
// When the work is done (done tool / 10 minutes without a command) the agent tabs close.
// TOKEN BUDGET: replies are compact text; actions wait for the page to settle and report
// only what changed (new elements, URL change), so agents rarely need a separate read.
import { t, setLang } from "./i18n.js";
import { installAgentLib, installShadowWatch } from "./page.js";
import { denyReason } from "./policy.js";

const DEFAULT_PORT = 8791;
const IDLE_TIMEOUT = 10 * 60 * 1000;
const APPROVAL_TIMEOUT = 60 * 1000; // how long a "may the agent do this?" window waits for the user
const APPROVAL_MEMORY = 2 * 60 * 1000; // a repeated action on the same consent box does not ask again
let ws = null;
let token = "";
let port = DEFAULT_PORT;
let lang = "tr";
let enabled = false;
let attached = new Set();
const mainContexts = new Map(); // tabId → Map(frameId → main-world executionContextId, from Runtime events)
let myTabs = []; // tabs the agent opened (ordered: newest last)
let myTabsLoaded = false;
// One command runs at a time: its policy lives in module state (runAllow, currentAgent…). An
// agent's own commands keep their order, approval waits included; while one of them waits for
// the user's answer, the turn goes to the other agents (see waitOffTurn).
const agentQueues = new Map(); // agent id → tail of that agent's commands
let turnQueue = Promise.resolve();
let endTurn = () => {}; // releases the turn of the command that is running
async function takeTurn() {
  const before = turnQueue;
  let release;
  turnQueue = new Promise((done) => (release = done));
  await before;
  endTurn = release;
}
let tabAllow = {}; // immutable creation policy, also used by navigation events
let tabOwner = {}; // tabId → agent id: one agent's tabs are off limits to every other agent
let runAllow = []; // allowed domains of the run that sent the latest command (--allow); empty = no limit
let retries = 0;
let rejected = false; // the bridge refused our token (it is paired with another one): the popup asks for the bridge's
let activity = [];
let idleTimer = null;
let lastOnline = 0; // last time the bridge socket was up; short reconnects are not logged

const T = (key, vars) => t(key, vars);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function makeToken() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const chunk = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join("");
  return `${chunk(4)}-${chunk(4)}`;
}

// Activity entries are stored as translation keys so the popup can render them in the current language.
// Internal / read-only commands are not shown; repeats of the same action are collapsed into a counter.
const QUIET = new Set(["ping", "tabs", "read", "find", "wait", "console", "network", "cleanup"]);
const logAction = (key, vars = {}, agent = "") => {
  const last = activity[0];
  if (last && last.key === key && last.agent === agent && JSON.stringify(last.vars) === JSON.stringify(vars) && Date.now() - last.ts < 60_000) {
    last.count = (last.count || 1) + 1;
    last.ts = Date.now();
  } else activity = [{ ts: Date.now(), key, vars, agent }, ...activity].slice(0, 20);
  chrome.storage.local.set({ activity });
};
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const seenAgents = new Set(); // agent session ids already announced in the log
function logCommand(cmd, args, agent) {
  const name = agent?.name || "";
  if (agent?.id && !seenAgents.has(agent.id)) {
    seenAgents.add(agent.id);
    logAction("act_agentJoined", {}, name);
  }
  if (QUIET.has(cmd)) return;
  logAction(`act_${cmd}`, cmd === "navigate" && args.url ? { host: hostOf(args.url) } : {}, name);
}

// --- agent tab ledger (kept in session storage; survives service worker restarts) ---
async function loadMyTabs() {
  if (myTabsLoaded) return;
  const { agentTabs, runAllow: savedAllow, tabAllow: savedTabAllow, tabOwner: savedOwner } =
    await chrome.storage.session.get(["agentTabs", "runAllow", "tabAllow", "tabOwner"]);
  myTabs = agentTabs ?? [];
  runAllow = savedAllow ?? [];
  tabAllow = savedTabAllow ?? Object.fromEntries(myTabs.map((id) => [id, [...runAllow]]));
  tabOwner = savedOwner ?? {};
  myTabsLoaded = true;
}
const saveMyTabs = () => chrome.storage.session.set({ agentTabs: myTabs, tabAllow, tabOwner });
// Ownership is per agent (the bridge sends the agent's id with every command): one agent's tabs
// are invisible and closed-off to the others.
const ownTab = (id) => myTabs.includes(id) && (tabOwner[id] ?? "") === currentAgentId;
// The list travels with every command (set on the bridge's command line, never by a tool call).
// Agents sharing the browser may differ: each command is checked against its own run's list.
async function setRunAllow(list) {
  await loadMyTabs();
  const next = Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : [];
  if (JSON.stringify(next) === JSON.stringify(runAllow)) return;
  runAllow = next;
  await chrome.storage.session.set({ runAllow });
}
const setBadge = (text = "", color = "#1a7f37") => {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
};
const refreshBadge = () => setBadge(ws?.readyState === 1 ? (myTabs.length ? T("badgeOn") : "") : "…", "#1a7f37");

// --- URL policy: blocked patterns (popup) + the run's allowed domains (see policy.js) ---
async function deniedBy(url, allow = runAllow) {
  await loadMyTabs();
  const { blockPatterns } = await chrome.storage.local.get("blockPatterns");
  return denyReason(url, { blockPatterns: blockPatterns ?? [], allow });
}
const denyText = (reason, url, allow = runAllow) =>
  reason === "blocked" ? T("blockedUrl", { url }) : T("notAllowedUrl", { host: hostOf(url) || url.slice(0, 60), allow: allow.join(", ") });

async function assertAllowed(url) {
  const reason = await deniedBy(url);
  if (reason) throw new Error(denyText(reason, url));
}

/** Takes an agent tab off a page outside the policy, so nothing can be read or done there. */
async function parkTab(tabId, url) {
  await chrome.tabs.update(tabId, { url: "about:blank" }).catch(() => {});
  logAction("act_parked", { host: hostOf(url) });
}

/** Every command passes here: an agent tab sitting outside the policy is parked and the command refused. */
async function guardTab(tabId) {
  const { url = "" } = await chrome.tabs.get(tabId);
  await loadMyTabs();
  const { blockPatterns = [] } = await chrome.storage.local.get("blockPatterns");
  const commandReason = denyReason(url, { blockPatterns, allow: runAllow });
  const policy = commandReason ? runAllow : (tabAllow[tabId] ?? []);
  const reason = commandReason || denyReason(url, { blockPatterns, allow: policy });
  if (!reason) return;
  await parkTab(tabId, url);
  throw new Error(`${denyText(reason, url, policy)} ${T("tabParked")}`);
}

// --- per-tab buffers: console, network, events to report with the next reply ---
const buffers = new Map(); // tabId → { console: [], net: [], reqs: Map, notes: [] }
const bufferOf = (tabId) => {
  if (!buffers.has(tabId)) buffers.set(tabId, { console: [], net: [], reqs: new Map(), notes: [] });
  return buffers.get(tabId);
};
const pushCapped = (list, item, cap = 200) => {
  list.push(item);
  if (list.length > cap) list.shift();
};
const drainNotes = (tabId) => {
  const b = bufferOf(tabId);
  const notes = b.notes;
  b.notes = [];
  return notes;
};

// --- idle mode: close tabs, detach debugger ---
// "workDone" (the agent's done tool) closes that agent's tabs only; the user's toggle-off and the
// global idle timeout close everything.
async function cleanup(reason) {
  clearTimeout(idleTimer);
  const list = reason === "workDone" ? myTabs.filter((id) => ownTab(id)) : myTabs;
  myTabs = myTabs.filter((id) => !list.includes(id));
  for (const id of list) {
    delete tabAllow[id];
    delete tabOwner[id];
  }
  await saveMyTabs();
  for (const id of list) {
    await chrome.debugger.detach({ tabId: id }).catch(() => {});
    await chrome.tabs.remove(id).catch(() => {});
    attached.delete(id);
    buffers.delete(id);
  }
  if (list.length) logAction("act_closed", { reason, n: list.length });
  refreshBadge();
}
const armIdleTimer = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => cleanup("noCommand10"), IDLE_TIMEOUT);
};

// --- target tab: only tabs this agent opened ---
async function resolveTab(args) {
  await loadMyTabs();
  let tabId;
  if (args.tabId !== undefined) {
    if (!ownTab(args.tabId)) throw new Error(T("tabNotOwned"));
    tabId = args.tabId;
  } else {
    tabId = [...myTabs].reverse().find((id) => ownTab(id));
    if (tabId === undefined) throw new Error(T("noAgentTab"));
  }
  await guardTab(tabId);
  return tabId;
}

// Claude-style tab strip marker: agent tabs live in one yellow "Agent" tab group per window,
// so Chrome outlines them in the tab bar. Purely cosmetic: failures never block the command.
const GROUP_TITLE = "Agent";
async function groupAgentTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== -1 && tab.groupId !== undefined) return;
    const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
    if (group) return void (await chrome.tabs.group({ tabIds: tabId, groupId: group.id }));
    const groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "yellow", collapsed: false });
  } catch {}
}

// Popups opened by an agent tab (target=_blank, window.open) belong to the agent too.
// Chrome often creates them without a URL yet: until one shows a page inside the policy it is
// remembered here, so a popup that turns out to point outside is closed instead of parked.
const newPopups = new Map(); // tabId → opener tabId
const closePopup = async (tabId, openerTabId, reason, url) => {
  newPopups.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  bufferOf(openerTabId).notes.push(`new tab closed: ${denyText(reason, url, tabAllow[openerTabId] ?? [])}`);
  logAction("act_parked", { host: hostOf(url) });
};
chrome.tabs.onCreated.addListener(async (tab) => {
  await loadMyTabs();
  if (tab.openerTabId === undefined || !myTabs.includes(tab.openerTabId)) return;
  const url = tab.pendingUrl || tab.url || "";
  const reason = await deniedBy(url, tabAllow[tab.openerTabId] ?? []);
  if (reason) return closePopup(tab.id, tab.openerTabId, reason, url);
  newPopups.set(tab.id, tab.openerTabId);
  myTabs.push(tab.id);
  tabAllow[tab.id] = [...(tabAllow[tab.openerTabId] ?? [])];
  tabOwner[tab.id] = tabOwner[tab.openerTabId] ?? "";
  await saveMyTabs();
  bufferOf(tab.openerTabId).notes.push(`new tab opened: [${tab.id}] (now the default tab)`);
  attachDebugger(tab.id).catch(() => {});
  groupAgentTab(tab.id);
});
// Redirects, links and page scripts can move an agent tab anywhere: check every URL it lands on.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url) return;
  await loadMyTabs();
  if (!myTabs.includes(tabId)) return;
  const reason = await deniedBy(change.url, tabAllow[tabId] ?? []);
  const openerTabId = newPopups.get(tabId);
  if (!reason) {
    if (change.url !== "about:blank") newPopups.delete(tabId);
    return;
  }
  if (openerTabId !== undefined) return closePopup(tabId, openerTabId, reason, change.url);
  await parkTab(tabId, change.url);
  bufferOf(tabId).notes.push(`${denyText(reason, change.url, tabAllow[tabId] ?? [])} ${T("tabParked")}`);
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadMyTabs();
  attached.delete(tabId);
  delete tabAllow[tabId];
  delete tabOwner[tabId];
  buffers.delete(tabId);
  newPopups.delete(tabId);
  if (!myTabs.includes(tabId)) return;
  myTabs = myTabs.filter((id) => id !== tabId);
  await saveMyTabs();
  refreshBadge();
});

// Claude-style visible marker: golden frame on the page + 🤖 prefix in the tab title.
const MARK_SCRIPT = `(() => {
  if (window.__agentBridge) return;
  window.__agentBridge = 1;
  const add = () => {
    if (document.getElementById("__agent-bridge-frame")) return;
    const frame = document.createElement("div");
    frame.id = "__agent-bridge-frame";
    frame.style.cssText = "position:fixed;inset:0;pointer-events:none;border:3px solid #ffc23a;z-index:2147483647;box-sizing:border-box";
    frame.setAttribute("aria-hidden", "true");
    (document.body || document.documentElement).appendChild(frame);
    if (!/^🤖/.test(document.title)) document.title = "🤖 " + document.title;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})()`;

const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

async function attachDebugger(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // Another extension's frame in the page (password managers on sign-in pages) blocks the debugger.
    if (/chrome-extension:\/\/ URL of different extension/i.test(String(e.message))) throw new Error(T("attachBlocked"));
    // After a service worker restart the debugger may still be attached: reuse it.
    if (!/already attached/i.test(String(e.message))) throw e;
  }
  attached.add(tabId);
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(tabId, method).catch(() => {});
  // The shadow watcher runs in the page's main world (every frame, before its scripts): it is how
  // closed shadow roots — invisible to the helper world — report their personal-field rectangles.
  await send(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: MARK_SCRIPT }).catch(() => {});
  await send(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: SHADOW_SCRIPT }).catch(() => {});
  await send(tabId, "Runtime.evaluate", { expression: MARK_SCRIPT }).catch(() => {});
  await send(tabId, "Runtime.evaluate", { expression: SHADOW_SCRIPT }).catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
  mainContexts.delete(tabId);
  if (reason === "canceled_by_user") bufferOf(tabId).notes.push("user detached the debugger (cancelled the debugging bar)");
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (!attached.has(tabId)) return;
  const b = bufferOf(tabId);
  switch (method) {
    case "Page.javascriptDialogOpening":
      // A blocking alert/confirm would freeze every page script; accept it and tell the agent.
      send(tabId, "Page.handleJavaScriptDialog", { accept: true, promptText: params.defaultPrompt || "" }).catch(() => {});
      b.notes.push(`${params.type} dialog auto-accepted: "${String(params.message).slice(0, 120)}"`);
      break;
    case "Runtime.consoleAPICalled": {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      pushCapped(b.console, { level: params.type, text: text.slice(0, 300) });
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails || {};
      pushCapped(b.console, { level: "exception", text: String(d.exception?.description || d.text).slice(0, 300) });
      break;
    }
    case "Network.requestWillBeSent":
      b.reqs.set(params.requestId, { method: params.request.method, url: params.request.url, type: params.type });
      if (b.reqs.size > 400) b.reqs.delete(b.reqs.keys().next().value);
      break;
    case "Network.responseReceived": {
      const req = b.reqs.get(params.requestId) || { method: "GET", url: params.response.url };
      pushCapped(b.net, { ...req, type: params.type, status: params.response.status });
      break;
    }
    case "Network.loadingFailed": {
      const req = b.reqs.get(params.requestId);
      if (req) pushCapped(b.net, { ...req, type: params.type, status: params.canceled ? "canceled" : `failed ${params.errorText}` });
      break;
    }
    case "Runtime.executionContextCreated": {
      // Main-world contexts per frame: the closed-shadow watcher lives in the page world and can
      // only be asked there (isolated worlds cannot see closed roots).
      const c = params.context ?? {};
      if (c.auxData?.frameId && c.auxData.type === "default") {
        if (!mainContexts.has(tabId)) mainContexts.set(tabId, new Map());
        mainContexts.get(tabId).set(c.auxData.frameId, c.executionContextId);
      }
      break;
    }
  }
});

// Same rule as maskUrl in page.js: an address that names the account (…?email=…) is not shown to the agent.
const maskUrl = (url) => String(url).replace(/[^\s\/?&=#:]+(@|%(25)*40)[^\s\/?&=#%]+\.[a-z]{2,}/gi, "•••");

// Console and network output can carry the same values the snapshot hides (a page logging the
// user's e-mail or an OTP): scrub them out before the agent sees them. Best effort — the page
// can still log a secret that never lived in a field; no filter can know that one.
async function redactSecrets(tabId, text) {
  let out = String(text);
  try {
    const vals = await runInPage(tabId, `__ab.secrets()`);
    if (Array.isArray(vals)) for (const v of vals) if (v && String(v).length > 3) out = out.split(String(v)).join("•••");
  } catch {}
  return maskUrl(out);
}

// --- page scripts ---
const LIB = `(${installAgentLib.toString()})();`;
const SHADOW_SCRIPT = `(${installShadowWatch.toString()})();`;
const NAV_ERROR = /context was destroyed|Cannot find context|navigated or closed|Inspected target|No frame|not attached/i;

// Re-resolve on every call: navigation destroys contexts. Never fall back to the page world.
async function helperContext(tabId) {
  const { frameTree } = await send(tabId, "Page.getFrameTree");
  const { executionContextId } = await send(tabId, "Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "agent-bridge-private",
  });
  if (!Number.isInteger(executionContextId)) throw new Error("isolated helper context unavailable");
  return executionContextId;
}

/** Runs `body` (an expression; window.__ab is available) in the page and returns its value. */
async function runInPage(tabId, body, { lib = true, mainWorld = false } = {}) {
  await guardTab(tabId); // the page may have moved since the command started (redirect, click, script)
  await attachDebugger(tabId);
  let reply;
  try {
    reply = await send(tabId, "Runtime.evaluate", {
      expression: lib ? `${LIB}\n${body}` : body,
      ...(mainWorld ? {} : { contextId: await helperContext(tabId) }),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
  } catch (e) {
    if (/not attached/i.test(String(e.message))) attached.delete(tabId);
    throw e;
  }
  if (reply.exceptionDetails) {
    const d = reply.exceptionDetails;
    throw new Error(String(d.exception?.description || d.text || T("pageScriptFailed")).split("\n    at ")[0]);
  }
  return reply.result?.value;
}

/** Waits until the tab finished loading; `expectStart` first waits briefly for a load to begin. */
async function waitLoad(tabId, { expectStart = false, timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  if (expectStart) {
    const startBy = Date.now() + 1500;
    while (Date.now() < startBy) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "loading") break;
      await sleep(50);
    }
  }
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && !(tab.url === "about:blank" && tab.pendingUrl)) return tab;
    await sleep(100);
  }
  return chrome.tabs.get(tabId);
}

/** Full (capped) snapshot once the page has settled; retries across late navigations. */
async function snapshot(tabId, opts = {}) {
  const { confirmSensitive } = await chrome.storage.local.get("confirmSensitive");
  opts = { ...opts, signIn: confirmSensitive !== false };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runInPage(tabId, `__ab.quiet(250, 1500).then(() => __ab.render(${JSON.stringify(opts)}))`);
    } catch (e) {
      if (!NAV_ERROR.test(String(e.message))) throw e;
      await waitLoad(tabId);
    }
  }
  throw new Error("page kept navigating; try read again");
}

const withNotes = (tabId, text) => {
  const notes = drainNotes(tabId);
  return notes.length ? `${text}\n! ${notes.join("\n! ")}` : text;
};

/**
 * Runs an action and reports its effect compactly:
 * - same page → only the elements that appeared (and how many disappeared)
 * - new page / URL change → a capped snapshot of the new page.
 */
async function act(tabId, prepareBody, perform) {
  const prepared = await runInPage(tabId, `(() => { __ab.mark(); return ${prepareBody}; })()`);
  await perform(prepared);
  await sleep(120);
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "loading") await waitLoad(tabId);
  let diff;
  try {
    diff = await runInPage(tabId, `__ab.quiet(300, 2500).then(() => __ab.changes(40))`);
  } catch (e) {
    if (!NAV_ERROR.test(String(e.message))) throw e;
    await waitLoad(tabId);
    diff = { newDoc: true };
  }
  const warn = prepared?.warn ? `\n! ${prepared.warn}` : "";
  if (diff.newDoc || diff.urlChanged) {
    return withNotes(tabId, `ok → page changed${warn}\n${await snapshot(tabId, { max: 80 })}`);
  }
  const head = `ok · ${diff.title} · ${diff.url}${warn}`;
  if (!diff.addedTotal) {
    return withNotes(tabId, `${head}\nno new elements${diff.removed ? `, ${diff.removed} disappeared` : ""} (content may still have changed: find/read to check)`);
  }
  const more = diff.addedTotal > diff.added.length ? `\n(+${diff.addedTotal - diff.added.length} more new)` : "";
  return withNotes(tabId, `${head}\nnew (${diff.addedTotal})${diff.removed ? `, ${diff.removed} gone` : ""}:\n${diff.added.join("\n")}${more}`);
}

const target = (args) => JSON.stringify({ ref: args.ref, selector: args.selector, text: args.text });

// --- the user's steps: signing in is left to the user, ticking consent boxes needs their approval ---
// The question is asked in an extension window: neither the agent (it only reaches its own tabs)
// nor the page can press the buttons. No answer in time, or closing the window, means no.
const approvals = new Map(); // id → { info, finish, windowId }
const granted = new Map(); // "tab|host|kind|label" → valid until
let currentAgent = ""; // name of the agent whose command is running (shown in the approval window)
let currentAgentId = ""; // id of the agent whose command is running (tab ownership)

/** Waits for `pending` without holding the turn, then takes it back as the same agent and run. */
async function waitOffTurn(pending) {
  const mine = { allow: runAllow, agent: currentAgent, agentId: currentAgentId };
  endTurn();
  try {
    return await pending;
  } finally {
    await takeTurn();
    await setRunAllow(mine.allow);
    currentAgent = mine.agent;
    currentAgentId = mine.agentId;
  }
}

function askUser(info) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (allow) => {
      const entry = approvals.get(id);
      if (!entry) return;
      approvals.delete(id);
      clearTimeout(timer);
      if (entry.windowId !== undefined) chrome.windows.remove(entry.windowId).catch(() => {});
      resolve(allow);
    };
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT);
    approvals.set(id, { info, finish });
    chrome.windows
      .create({ url: chrome.runtime.getURL(`confirm.html?id=${id}`), type: "popup", width: 420, height: 330, focused: true })
      .then((win) => {
        if (approvals.has(id)) approvals.get(id).windowId = win.id;
        else chrome.windows.remove(win.id).catch(() => {});
      })
      .catch(() => finish(false));
  });
}
chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of approvals.values()) if (entry.windowId === windowId) entry.finish(false);
});

/**
 * `check` is a page expression (__ab.approval / __ab.pageApproval) that names the step, if it is one.
 * Sign-in: never done by the agent, not even with a yes; the tab is shown to the user instead.
 * Consent box: the user is asked. A javascript: link is refused outright, in every setting.
 */
async function requireApproval(tabId, check) {
  const { confirmSensitive } = await chrome.storage.local.get("confirmSensitive");
  const need = await runInPage(tabId, check);
  if (need?.kind === "jslink") {
    const tab = await chrome.tabs.get(tabId);
    logAction("act_jslink", { host: hostOf(tab.url ?? "") }, currentAgent);
    throw new Error(T("jslinkRefused", { host: hostOf(tab.url ?? "") || T("thisPage") }));
  }
  if (confirmSensitive === false || !need) return;
  const tab = await chrome.tabs.get(tabId);
  const host = hostOf(tab.url ?? "") || T("thisPage");
  if (need.kind === "login") {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    logAction("act_handoff", { host }, currentAgent);
    throw new Error(T("loginHandoff", { host }));
  }
  const key = [tabId, host, need.kind, need.label].join("|");
  if (granted.get(key) > Date.now()) return;
  const allow = await waitOffTurn(askUser({ kind: need.kind, label: String(need.label ?? "").slice(0, 160), host, agent: currentAgent }));
  logAction(allow ? "act_approved" : "act_denied", { host }, currentAgent);
  if (!allow) throw new Error(T("approvalDenied", { what: T(`approval_${need.kind}`), host }));
  granted.set(key, Date.now() + APPROVAL_MEMORY);
}

async function mouseClick(tabId, { x, y, label }, { button = "left", clickCount = 1 } = {}) {
  await showCursor(tabId, `__ab.cursor.move(${x}, ${y})`);
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let n = 1; n <= clickCount; n++) {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: n });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: n });
  }
  await showCursor(tabId, `__ab.cursor.click(${x}, ${y}, ${JSON.stringify(label ?? "")})`);
}

/** Draws the on-screen cursor. Purely cosmetic: never let it break the action. */
async function showCursor(tabId, body) {
  try {
    const { cursor } = await chrome.storage.local.get("cursor");
    if (cursor === false) return;
    await runInPage(tabId, body);
  } catch {
    // The page may have navigated or the overlay may be blocked — visuals are optional.
  }
}

// --- keyboard ---
const NAMED_KEYS = {
  enter: ["Enter", "Enter", 13, "\r"], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
  backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], space: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40], arrowleft: ["ArrowLeft", "ArrowLeft", 37],
  arrowright: ["ArrowRight", "ArrowRight", 39], up: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40],
  left: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
};
const MODIFIERS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
// macOS ignores editing shortcuts sent as raw keys; CDP needs the editor command explicitly.
const EDIT_COMMANDS = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };

async function pressKey(tabId, combo) {
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  const keyName = parts.pop() ?? "";
  let modifiers = 0;
  for (const p of parts) modifiers |= MODIFIERS[p.toLowerCase()] ?? 0;
  let key, code, keyCode, text;
  const named = NAMED_KEYS[keyName.toLowerCase()];
  if (named) [key, code, keyCode, text] = named;
  else if (keyName.length === 1) {
    key = keyName;
    const upper = keyName.toUpperCase();
    code = /[a-z]/i.test(keyName) ? `Key${upper}` : /\d/.test(keyName) ? `Digit${keyName}` : "";
    keyCode = upper.charCodeAt(0);
    text = keyName;
  } else throw new Error(`unknown key "${keyName}" (use Enter, Tab, Escape, ArrowDown, ctrl+a …)`);
  if (modifiers & (2 | 4)) text = undefined;
  const commands = modifiers & (2 | 4) && EDIT_COMMANDS[key.toLowerCase()] ? [EDIT_COMMANDS[key.toLowerCase()]] : undefined;
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await send(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text, unmodifiedText: text, commands });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/**
 * Every rectangle the snapshot hides, across the frames of this debugger session, in top-level
 * CSS pixels: each frame runs the same collector in its own isolated world (cross-origin frames
 * too), offset by its iframe's position. Closed shadow roots report through the main-world
 * watcher (SHADOW_SCRIPT). Not covered: an iframe Chrome runs in another process (a different
 * site) is not in this session's frame tree; the snapshot cannot read into it either.
 */
async function personalRects(tabId) {
  const rects = [];
  const collect = async (frameId, ox, oy) => {
    const contextId = frameId === undefined ? await helperContext(tabId) : await frameWorld(tabId, frameId);
    const reply = await send(tabId, "Runtime.evaluate", { expression: `${LIB}\n__ab.redactRects(${ox}, ${oy})`, contextId, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(String(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text));
    return reply.result?.value ?? { rects: [] };
  };
  // The watcher runs in each frame's main world; ask it there (contextId from Runtime events).
  // A stored context can be stale (the document navigated since): for the main frame a
  // context-less evaluate — the main world of the current document — is the safe fallback.
  const watcherRects = async (frameId, ox, oy, isRoot) => {
    const evalWatch = async (contextId) => {
      const reply = await send(tabId, "Runtime.evaluate", { expression: `window.__abShadowWatch ? __abShadowWatch.rects() : []`, ...(contextId ? { contextId } : {}), returnByValue: true });
      return reply.result?.value;
    };
    let out;
    try { out = await evalWatch(mainContexts.get(tabId)?.get(frameId)); } catch {}
    if (!Array.isArray(out) && isRoot) { try { out = await evalWatch(undefined); } catch {} }
    if (Array.isArray(out)) for (const r of out) rects.push({ x: r.x + ox, y: r.y + oy, w: r.w, h: r.h });
  };
  // Where a child frame sits on screen: the content box of its owner element, which the debugger
  // reports in top-level CSS pixels. Asked per frame id, never matched by position in a list:
  // hidden iframes have no box and the frame tree is not in DOM order.
  const frameOrigin = async (frameId) => {
    const { backendNodeId } = await send(tabId, "DOM.getFrameOwner", { frameId });
    const [x, y] = (await send(tabId, "DOM.getBoxModel", { backendNodeId })).model.content;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("no box");
    return { x, y };
  };
  const { frameTree } = await send(tabId, "Page.getFrameTree");
  const walk = async (frame, ox, oy, isRoot = true) => {
    const own = await collect(frame.frame.id, ox, oy);
    rects.push(...(own.rects ?? []));
    await watcherRects(frame.frame.id, ox, oy, isRoot);
    for (const child of frame.childFrames ?? []) {
      // No box (a hidden iframe: nothing of it is on screen either) or an unreachable child
      // must not abort the rest of the walk.
      try {
        const origin = await frameOrigin(child.frame.id);
        await walk(child, origin.x, origin.y, false);
      } catch {}
    }
  };
  await walk(frameTree, 0, 0);
  return rects.slice(0, 300);
}

/** An isolated helper world for a specific frame (child frames are outside the main frame's world). */
async function frameWorld(tabId, frameId) {
  const world = await send(tabId, "Page.createIsolatedWorld", { frameId, worldName: "agent-bridge-private" });
  if (!Number.isInteger(world.executionContextId)) throw new Error("isolated helper context unavailable");
  return world.executionContextId;
}

/** Paints over the personal-value rectangles after the capture: page scripts cannot reach this. */
async function redactPixels(image, vp, rects) {
  // chrome.debugger hands us bare base64 (no data: prefix); fetch needs a URL.
  const blob = await (await fetch(image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`)).blob();
  const img = await createImageBitmap(blob);
  const scale = img.width / vp.clientWidth;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = "#111318";
  // Rects are relative to the layout viewport, the picture starts at the visual one: the two
  // differ by offsetX/Y (pinch zoom), not by the scroll position (pageX/Y).
  const dx = vp.offsetX ?? 0;
  const dy = vp.offsetY ?? 0;
  for (const r of rects) ctx.fillRect((r.x - dx) * scale - 2, (r.y - dy) * scale - 2, r.w * scale + 4, r.h * scale + 4);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin);
}

async function screenshot(tabId) {
  // Values the snapshot hides (autofilled e-mail etc.) are drawn as dots for the picture; no veil, no picture.
  if (await runInPage(tabId, `__ab.veil(true)`)) await sleep(60);
  try {
    const { cssVisualViewport: vp } = await send(tabId, "Page.getLayoutMetrics");
    // CSS-pixel JPEG capped at 1280px wide: a fraction of a retina PNG's size and image tokens.
    const scale = Math.min(1, 1280 / vp.clientWidth);
    const reply = await send(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale },
    });
    // Second layer, outside the page: paint over every personal value's rectangle. This survives
    // closed shadow roots and pages that strip the CSS veil afterwards.
    try {
      const data = await redactPixels(reply.data, vp, await personalRects(tabId));
      return { data, mimeType: "image/jpeg" };
    } catch (e) {
      bufferOf(tabId).notes.push(`pixel redaction unavailable (${String(e.message).slice(0, 80)}); the CSS veil was applied for this shot`);
      return { data: reply.data, mimeType: "image/jpeg" };
    }
  } finally {
    await runInPage(tabId, `__ab.veil(false)`).catch(() => {});
  }
}

async function handleCommand(cmd, args = {}) {
  await loadMyTabs();
  switch (cmd) {
    case "tabs": {
      if (args.close !== undefined) {
        if (!ownTab(args.close)) throw new Error(T("tabNotOwned"));
        await chrome.tabs.remove(args.close).catch(() => {});
      }
      if (args.switchTo !== undefined) {
        if (!ownTab(args.switchTo)) throw new Error(T("tabNotOwned"));
        myTabs = [...myTabs.filter((id) => id !== args.switchTo), args.switchTo];
        await saveMyTabs();
      }
      const mine = myTabs.filter((id) => ownTab(id));
      const tabs = (await Promise.all(mine.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
      const current = mine[mine.length - 1];
      const visible = [];
      for (const tab of tabs) {
        if (await deniedBy(tab.url) || await deniedBy(tab.url, tabAllow[tab.id] ?? [])) continue;
        visible.push({ id: tab.id, title: tab.title, url: maskUrl(tab.url), active: tab.id === current });
      }
      return visible;
    }
    case "read": {
      const tabId = await resolveTab(args);
      const { ref, selector, mode, viewport, max } = args;
      return withNotes(tabId, await snapshot(tabId, { ref, selector, mode, viewport, max: max ?? (mode === "all" ? 250 : 150) }));
    }
    case "find": {
      const tabId = await resolveTab(args);
      return withNotes(tabId, await runInPage(tabId, `__ab.find(${JSON.stringify(String(args.query))}, ${Number(args.max) || 20})`));
    }
    case "click": {
      const tabId = await resolveTab(args);
      await requireApproval(tabId, `__ab.approval(${target(args)})`);
      return act(tabId, `__ab.point(__ab.resolve(${target(args)}))`, (p) =>
        mouseClick(tabId, p, { button: args.button ?? "left", clickCount: args.double ? 2 : 1 }),
      );
    }
    case "hover": {
      const tabId = await resolveTab(args);
      return act(tabId, `__ab.point(__ab.resolve(${target(args)}))`, async (p) => {
        await showCursor(tabId, `__ab.cursor.move(${p.x}, ${p.y})`);
        await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      });
    }
    case "type": {
      const tabId = await resolveTab(args);
      const hasTarget = args.ref !== undefined || args.selector;
      return act(tabId, `__ab.prepareType(${hasTarget ? target(args) : "null"}, ${args.clear !== false}, ${JSON.stringify(String(args.text ?? ""))})`, async (p) => {
        if (!p.focused) await mouseClick(tabId, p); // custom widgets focus only on a real click
        if (args.text) {
          await send(tabId, "Input.insertText", { text: args.text });
          await showCursor(tabId, `__ab.cursor.typed(${JSON.stringify(args.text)}, ${p.x ?? "null"}, ${p.y ?? "null"})`);
        } else if (args.clear !== false) await pressKey(tabId, "Backspace");
        if (args.submit) {
          await requireApproval(tabId, `__ab.approval(null, "key")`);
          await pressKey(tabId, "Enter");
        }
      });
    }
    case "fill": {
      // A whole form in one call: text fields, checkboxes/radios (value true/false) and <select>s.
      const tabId = await resolveTab(args);
      const lines = [];
      for (const field of args.fields ?? []) {
        const tgt = JSON.stringify({ ref: field.ref, selector: field.selector, text: field.label });
        const name = field.ref !== undefined ? `r${field.ref}` : field.selector ?? field.label;
        const info = await runInPage(tabId, `__ab.fieldInfo(${tgt})`);
        const value = field.value;
        if (info.kind === "toggle") {
          const want = value === true || /^(true|on|yes|1|checked)$/i.test(String(value));
          if (want && !info.checked) await requireApproval(tabId, `__ab.approval(${tgt})`);
          if (want !== info.checked) await mouseClick(tabId, info);
          lines.push(`${name} ${want ? "☑" : "☐"}`);
        } else if (info.kind === "select") {
          lines.push(`${name}="${await runInPage(tabId, `__ab.selectOption(${tgt}, ${JSON.stringify(String(value))})`)}"`);
        } else {
          const p = await runInPage(tabId, `__ab.prepareType(${tgt}, true, ${JSON.stringify(String(value ?? ""))})`);
          if (!p.focused) await mouseClick(tabId, p);
          if (String(value ?? "")) {
            await send(tabId, "Input.insertText", { text: String(value) });
            await showCursor(tabId, `__ab.cursor.typed(${JSON.stringify(String(value))}, ${p.x ?? "null"}, ${p.y ?? "null"})`);
          } else await pressKey(tabId, "Backspace");
          lines.push(`${name} ✓`);
        }
      }
      if (args.submit) await requireApproval(tabId, `__ab.approval(null, "key")`);
      const summary = await act(tabId, "null", () => (args.submit ? pressKey(tabId, "Enter") : null));
      return `${lines.join(" · ")}\n${summary}`;
    }
    case "select": {
      const tabId = await resolveTab(args);
      let chosen = "";
      const reply = await act(tabId, `__ab.selectOption(${target(args)}, ${JSON.stringify(String(args.value))})`, (text) => {
        chosen = text;
      });
      return `selected "${chosen}"\n${reply}`;
    }
    case "key": {
      const tabId = await resolveTab(args);
      return act(tabId, "null", async () => {
        for (let i = 0; i < (args.repeat ?? 1); i++) {
          for (const combo of String(args.keys).split(/\s+/)) {
            // Enter submits the focused form, Space ticks the focused box: same question as a click.
            const key = combo.split("+").filter(Boolean).at(-1)?.toLowerCase();
            if (key === "enter" || key === "space") await requireApproval(tabId, `__ab.approval(null, ${key === "enter" ? '"key"' : '"click"'})`);
            await pressKey(tabId, combo);
          }
        }
      });
    }
    case "scroll": {
      const tabId = await resolveTab(args);
      const hasTarget = args.ref !== undefined || args.selector;
      const where = await runInPage(
        tabId,
        hasTarget ? `(() => { const p = __ab.point(__ab.resolve(${target(args)})); return { ...p, h: innerHeight }; })()` : `({ x: innerWidth / 2, y: innerHeight / 2, h: innerHeight })`,
      );
      const sign = args.direction === "up" ? -1 : 1;
      if (!hasTarget || args.amount) {
        await send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x: where.x, y: where.y, deltaX: 0, deltaY: sign * where.h * 0.8 * (args.amount ?? 1),
        });
      }
      await sleep(150);
      return withNotes(tabId, await snapshot(tabId, { viewport: true, max: args.max ?? 60 }));
    }
    case "upload": {
      const tabId = await resolveTab(args);
      await attachDebugger(tabId);
      const reply = await send(tabId, "Runtime.evaluate", { expression: `${LIB}\n__ab.resolve(${target(args)})`, contextId: await helperContext(tabId) });
      if (reply.exceptionDetails) throw new Error(String(reply.exceptionDetails.exception?.description || "element not found").split("\n")[0]);
      await send(tabId, "DOM.enable").catch(() => {});
      return act(tabId, "null", () => send(tabId, "DOM.setFileInputFiles", { files: args.paths, objectId: reply.result.objectId }));
    }
    case "wait": {
      const tabId = await resolveTab(args);
      const timeout = Math.min(args.timeout ?? 10_000, 60_000);
      if (!args.text && !args.selector) {
        await sleep(timeout);
        return withNotes(tabId, `waited ${timeout} ms`);
      }
      const check = `(() => {
        const A = ${JSON.stringify({ text: args.text, selector: args.selector })};
        const found = A.selector ? !!document.querySelector(A.selector) : (document.body?.innerText || "").toLocaleLowerCase().includes(A.text.toLocaleLowerCase());
        return found;
      })()`;
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const found = await runInPage(tabId, check, { lib: false }).catch(() => null);
        if (found === !args.gone) return withNotes(tabId, `ok after ${Date.now() - started} ms`);
        await sleep(250);
      }
      throw new Error(`still ${args.gone ? "present" : "missing"} after ${timeout} ms`);
    }
    case "navigate": {
      await loadMyTabs();
      if (args.tabId !== undefined && !ownTab(args.tabId)) throw new Error(T("tabNotOwned"));
      let tabId;
      if (args.url === "back" || args.url === "forward" || args.url === "reload") {
        tabId = await resolveTab(args);
        if (args.url === "back") await chrome.tabs.goBack(tabId);
        else if (args.url === "forward") await chrome.tabs.goForward(tabId);
        else await chrome.tabs.reload(tabId);
      } else {
        await assertAllowed(args.url);
        if (args.tabId !== undefined) tabId = args.tabId;
        else if (args.newTab !== true) tabId = [...myTabs].reverse().find((id) => ownTab(id));
        if (tabId !== undefined) {
          const reason = await deniedBy(args.url, tabAllow[tabId] ?? []);
          if (reason) throw new Error(denyText(reason, args.url, tabAllow[tabId] ?? []));
          await attachDebugger(tabId).catch(() => {});
          await chrome.tabs.update(tabId, { url: args.url });
        } else {
          const tab = await chrome.tabs.create({ url: "about:blank" });
          tabId = tab.id;
          myTabs.push(tabId);
          tabAllow[tabId] = [...runAllow];
          tabOwner[tabId] = currentAgentId;
          await saveMyTabs();
          // Register the mark and the closed-shadow watcher BEFORE the real document loads:
          // a page script that runs first can create closed shadow roots nobody will ever see.
          await attachDebugger(tabId); // mark the agent tab right away (frame + 🤖 title)
          await chrome.tabs.update(tabId, { url: args.url });
          groupAgentTab(tabId);
        }
      }
      refreshBadge();
      await waitLoad(tabId, { expectStart: true });
      return withNotes(tabId, `[tab ${tabId}]\n${await snapshot(tabId, { max: args.max ?? 80 })}`);
    }
    case "screenshot":
      return screenshot(await resolveTab(args));
    case "eval": {
      // eval can do whatever the tab's logged-in session can: opt-in only (popup, "Advanced"),
      // default off — an agent that was never granted it does not get it.
      const { evalMode } = await chrome.storage.local.get("evalMode");
      if (!evalMode || evalMode === "off") throw new Error(T("evalOff"));
      if (evalMode === "allowlist" && !runAllow.length) throw new Error(T("evalNeedsAllow"));
      const tabId = await resolveTab(args);
      await requireApproval(tabId, `__ab.pageApproval()`); // a script could sign in, tick the box or read a hidden value itself
      const value = await runInPage(tabId, args.expression, { lib: false, mainWorld: true });
      return value === undefined ? "undefined" : value;
    }
    case "console": {
      const tabId = await resolveTab(args);
      const b = bufferOf(tabId);
      const pattern = args.pattern ? new RegExp(args.pattern, "i") : null;
      const rows = b.console.filter((m) => (!args.errorsOnly || /error|exception|assert/.test(m.level)) && (!pattern || pattern.test(m.text)));
      if (args.clear) b.console = [];
      const list = rows.slice(-(args.limit ?? 30)).map((m) => `[${m.level}] ${m.text}`);
      return list.length ? await redactSecrets(tabId, list.join("\n")) : "(no console messages captured since the tab was attached)";
    }
    case "network": {
      const tabId = await resolveTab(args);
      const b = bufferOf(tabId);
      const pattern = args.pattern ? new RegExp(args.pattern, "i") : null;
      const rows = b.net.filter((r) => (!pattern || pattern.test(r.url)) && (!args.apiOnly || r.type === "XHR" || r.type === "Fetch"));
      if (args.clear) b.net = [];
      const list = rows.slice(-(args.limit ?? 30)).map((r) => `${r.status} ${r.method} ${r.type ?? ""} ${maskUrl(r.url).slice(0, 160)}`);
      return list.length ? await redactSecrets(tabId, list.join("\n")) : "(no requests captured since the tab was attached)";
    }
    case "cleanup":
      await cleanup("workDone");
      return { closed: true, mode: "idle" };
    case "ping":
      return { pong: true };
    default:
      throw new Error(T("unknownCommand", { cmd }));
  }
}


function connect() {
  chrome.storage.local.get(["enabled", "token", "port", "lang"], ({ enabled: isEnabled, token: savedToken, port: savedPort, lang: savedLang }) => {
    enabled = !!isEnabled;
    if (!enabled) {
      setBadge("");
      return;
    }
    token = savedToken || makeToken();
    if (token !== savedToken) chrome.storage.local.set({ token }); // first run: generate once, reuse forever
    port = savedPort || DEFAULT_PORT;
    lang = savedLang || "tr";
    setLang(lang);
    clearTimeout(connect.timer);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      reconnect();
      return;
    }
    ws.onopen = () => {
      retries = 0;
      ws.send(JSON.stringify({ type: "hello", token, chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] }));
      // Heartbeat: WS traffic keeps the service worker alive while connected; a silent
      // socket would let Chrome suspend the worker and drop the connection.
      clearInterval(connect.heartbeat);
      connect.heartbeat = setInterval(() => {
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
      }, 20_000);
    };
    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        rejected = false;
        refreshBadge();
        if (Date.now() - lastOnline > 120_000) logAction("act_connected");
        lastOnline = Date.now();
        return;
      }
      if (!msg.id) return; // heartbeat etc.
      const commandSocket = ws;
      const execute = async () => {
        await takeTurn();
        try {
          if (!enabled || ws !== commandSocket || commandSocket.readyState !== 1) return;
          await setRunAllow(msg.agent?.allow);
          currentAgent = msg.agent?.name || "";
          currentAgentId = String(msg.agent?.id ?? "");
          logCommand(msg.cmd, msg.args ?? {}, msg.agent);
          const data = await handleCommand(msg.cmd, msg.args ?? {});
          armIdleTimer();
          commandSocket.send(JSON.stringify({ id: msg.id, ok: true, data }));
        } catch (e) {
          // Chrome drops the debugger on pages it protects (another extension's frame in the page).
          const error = String(e.message || e);
          if (commandSocket.readyState === 1) commandSocket.send(JSON.stringify({ id: msg.id, ok: false, error: /Detached while handling command/i.test(error) ? T("attachBlocked") : error }));
        } finally {
          endTurn();
        }
      };
      const agentId = String(msg.agent?.id ?? "");
      const task = (agentQueues.get(agentId) ?? Promise.resolve()).then(execute);
      const tail = task.catch(() => {});
      agentQueues.set(agentId, tail);
      tail.then(() => agentQueues.get(agentId) === tail && agentQueues.delete(agentId));
      return task;
    };
    ws.onclose = (event) => {
      rejected = event?.code === 4001; // "invalid token" (src/bridge.mjs)
      if (lastOnline) lastOnline = Date.now();
      clearInterval(connect.heartbeat);
      reconnect();
    };
    ws.onerror = () => ws?.close();
  });
}

function reconnect() {
  setBadge("…", "#9a6700");
  const wait = Math.min(3000, 500 * ++retries);
  clearTimeout(connect.timer);
  connect.timer = setTimeout(connect, wait);
}

// Self-heal: if the service worker slept while the bridge was down, a 1-minute alarm
// wakes it so a freshly started bridge is picked up without any user interaction.
chrome.alarms.create("findBridge", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "findBridge" && ws?.readyState !== 1) {
    retries = 0;
    connect();
  }
});

// Turning the access toggle off: stop reconnecting, drop the socket, close agent tabs.
function disableAccess() {
  enabled = false;
  clearTimeout(connect.timer);
  clearInterval(connect.heartbeat);
  clearTimeout(idleTimer);
  if (ws) {
    const closing = ws;
    ws = null;
    closing.onclose = null;
    closing.onerror = null;
    closing.close();
  }
  cleanup("toggleOff").then(() => setBadge(""));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) {
    retries = 0;
    if (changes.enabled.newValue) connect();
    else disableAccess();
    return;
  }
  if ((changes.token && changes.token.newValue !== token) || changes.port || changes.lang) {
    ws?.close();
    retries = 0;
    connect();
  }
});

// Status query from the popup; questions and answers of the approval window
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.id !== undefined && !String(sender.url ?? "").startsWith(chrome.runtime.getURL(""))) return false;
  if (msg.type === "approvalInfo") reply(approvals.get(msg.id)?.info ?? null);
  if (msg.type === "approvalAnswer") approvals.get(msg.id)?.finish(msg.allow === true);
  if (msg.type === "status") {
    reply({ open: ws?.readyState === 1, rejected, activity, enabled, port, myTabs: myTabs.length, lang, token, allow: runAllow });
  }
  if (msg.type === "reconnect") connect();
  if (msg.type === "clearActivity") {
    activity = [];
    chrome.storage.local.set({ activity });
  }
  return false;
});

connect();
