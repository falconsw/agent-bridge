// Agent Bridge service worker: connects to the local bridge (ws://127.0.0.1:port)
// and carries out agent commands via chrome.debugger.
// SECURITY: the agent only ever sees and uses tabs IT opened; it cannot see or touch
// the user's own tabs. When the work is done (done tool / 10 minutes without a command)
// the agent tabs are closed, the debugger detaches and the bridge goes back to idle.
import { t, setLang } from "./i18n.js";

const DEFAULT_PORT = 8791;
const IDLE_TIMEOUT = 10 * 60 * 1000; // close agent tabs after 10 min without a command
let ws = null;
let token = "";
let port = DEFAULT_PORT;
let lang = "tr";
let attached = new Set(); // tabs with an active debugger session
let myTabs = []; // tabs the agent opened (ordered: newest last)
let myTabsLoaded = false;
let retries = 0;
let activity = []; // recent actions (shown in the popup)
let idleTimer = null;

const T = (key, vars) => t(lang, key, vars);

const setBadge = (text, color = "#1a7f37") => {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
};

const logAction = (cmd, target = "") => {
  activity = [{ time: new Date().toLocaleTimeString("tr-TR"), cmd, target: target.slice(0, 60) }, ...activity].slice(0, 8);
  chrome.storage.local.set({ activity });
};

// --- agent tab ledger (kept in session storage; survives service worker restarts) ---
async function loadMyTabs() {
  if (myTabsLoaded) return;
  const { agentTabs } = await chrome.storage.session.get("agentTabs");
  myTabs = agentTabs ?? [];
  myTabsLoaded = true;
}
const saveMyTabs = () => chrome.storage.session.set({ agentTabs: myTabs });
const refreshBadge = () => setBadge(ws?.readyState === 1 ? (myTabs.length ? T("badgeOn") : "") : "…", "#1a7f37");

// --- idle mode: close tabs, detach debugger ---
async function cleanup(reason) {
  clearTimeout(idleTimer);
  const list = myTabs;
  myTabs = [];
  await saveMyTabs();
  for (const id of list) {
    await chrome.debugger.detach({ tabId: id }).catch(() => {});
    await chrome.tabs.remove(id).catch(() => {});
  }
  logAction(T("idleMode"), `${reason} · ${T("tabsClosed", { n: list.length })}`);
  refreshBadge();
}
const armIdleTimer = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => cleanup(T("noCommand10")), IDLE_TIMEOUT);
};

// --- target tab: only agent-owned ones ---
async function resolveTab(args) {
  await loadMyTabs();
  if (args.tabId !== undefined) {
    if (!myTabs.includes(args.tabId)) throw new Error(T("tabNotOwned"));
    return args.tabId;
  }
  if (!myTabs.length) throw new Error(T("noAgentTab"));
  return myTabs[myTabs.length - 1];
}

async function attachDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => {});
  attached.add(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  logAction(T("debuggerDetached"), tabId ? T("tabLabel", { id: tabId }) : "");
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  await loadMyTabs();
  if (myTabs.includes(tabId)) {
    myTabs = myTabs.filter((id) => id !== tabId);
    await saveMyTabs();
    refreshBadge();
  }
});

async function handleCommand(cmd, args = {}) {
  await loadMyTabs();
  switch (cmd) {
    case "tabs":
      return (
        await Promise.all(myTabs.map((id) => chrome.tabs.get(id).catch(() => null)))
      )
        .filter(Boolean)
        .map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active }));
    case "eval": {
      const tabId = await resolveTab(args);
      await attachDebugger(tabId);
      const reply = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || T("pageScriptFailed"));
      return reply.result?.value ?? null;
    }
    case "navigate": {
      if (args.tabId !== undefined && !myTabs.includes(args.tabId)) throw new Error(T("tabNotOwned"));
      let tab;
      if (args.tabId !== undefined) tab = await chrome.tabs.update(args.tabId, { url: args.url });
      else if (myTabs.length && args.newTab !== true) tab = await chrome.tabs.update(myTabs[myTabs.length - 1], { url: args.url });
      else {
        tab = await chrome.tabs.create({ url: args.url });
        myTabs.push(tab.id);
        await saveMyTabs();
      }
      refreshBadge();
      return { tabId: tab.id, url: args.url };
    }
    case "screenshot": {
      const tabId = await resolveTab(args);
      await attachDebugger(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
      const reply = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png" });
      return { data: reply.data };
    }
    case "cleanup":
      await cleanup(T("workDone"));
      return { closed: true, mode: "idle" };
    case "ping":
      return { pong: true };
    default:
      throw new Error(T("unknownCommand", { cmd }));
  }
}

function connect() {
  chrome.storage.local.get(["token", "port", "lang"], ({ token: savedToken, port: savedPort, lang: savedLang }) => {
    token = savedToken || "";
    port = savedPort || DEFAULT_PORT;
    lang = savedLang || "tr";
    setLang(lang);
    if (!token) {
      setBadge("?", "#9a6700");
      return;
    }
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
    };
    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        refreshBadge();
        logAction(T("connectedLog"), `port ${port}${myTabs.length ? ` · ${T("agentTabsCount", { n: myTabs.length })}` : ` · ${T("idleShort")}`}`);
        return;
      }
      if (!msg.id) return; // heartbeat etc.
      try {
        logAction(msg.cmd, JSON.stringify(briefArgs(msg.args ?? {})));
        const data = await handleCommand(msg.cmd, msg.args ?? {});
        armIdleTimer();
        ws.send(JSON.stringify({ id: msg.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e) }));
      }
    };
    ws.onclose = reconnect;
    ws.onerror = () => ws?.close();
  });
}

const briefArgs = (args) => {
  const { expression, path, ...rest } = args;
  return rest;
};

function reconnect() {
  setBadge("…", "#9a6700");
  const wait = Math.min(3000, 500 * ++retries);
  clearTimeout(connect.timer);
  connect.timer = setTimeout(connect, wait);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.port || changes.lang)) {
    ws?.close();
    retries = 0;
    connect();
  }
});

// Status query from the popup
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "status") {
    reply({ open: ws?.readyState === 1, activity, hasToken: !!token, port, myTabs: myTabs.length, lang });
  }
  if (msg.type === "reconnect") connect();
  return false;
});

connect();
