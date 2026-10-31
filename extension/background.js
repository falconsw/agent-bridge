// Agent Bridge service worker: connects to the local bridge (ws://127.0.0.1:port)
// and carries out agent commands via chrome.debugger.
// SECURITY: the agent only ever sees and uses tabs IT opened; it cannot see or touch
// the user's own tabs. When the work is done (done tool / 10 minutes without a command)
// the agent tabs are closed, the debugger detaches and the bridge goes back to idle.

const DEFAULT_PORT = 8791;
const IDLE_TIMEOUT = 10 * 60 * 1000; // close agent tabs after 10 min without a command
let ws = null;
let token = "";
let port = DEFAULT_PORT;
let attached = new Set(); // tabs with an active debugger session
let myTabs = []; // tabs the agent opened (ordered: newest last)
let myTabsLoaded = false;
let retries = 0;
let activity = []; // recent actions (shown in the popup)
let idleTimer = null;

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
const refreshBadge = () => setBadge(ws?.readyState === 1 ? (myTabs.length ? "ON" : "") : "…", "#1a7f37");

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
  logAction("bekleme modu / idle", `${reason} · ${list.length} sekme kapandı / tabs closed`);
  refreshBadge();
}
const armIdleTimer = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => cleanup("10 dk işlem olmadı / no command for 10 min"), IDLE_TIMEOUT);
};

// --- target tab: only agent-owned ones ---
async function resolveTab(args) {
  await loadMyTabs();
  if (args.tabId !== undefined) {
    if (!myTabs.includes(args.tabId)) throw new Error("bu sekme agent'e ait değil / tab does not belong to the agent (it only works in tabs it opened)");
    return args.tabId;
  }
  if (!myTabs.length) throw new Error("açık agent sekmesi yok / no open agent tab — önce navigate ile bir sekme aç / open one with navigate first");
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
  logAction("debugger ayrıldı / detached", tabId ? `tab ${tabId}` : "");
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
        .map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    case "eval": {
      const tabId = await resolveTab(args);
      await attachDebugger(tabId);
      const reply = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || "page script failed / sayfa betiği hata verdi");
      return reply.result?.value ?? null;
    }
    case "navigate": {
      if (args.tabId !== undefined && !myTabs.includes(args.tabId)) throw new Error("bu sekme agent'e ait değil / tab does not belong to the agent");
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
      await cleanup("agent işi bitirdi / agent finished the task");
      return { closed: true, mode: "idle" };
    case "ping":
      return { pong: true };
    default:
      throw new Error(`bilinmeyen komut / unknown command: ${cmd}`);
  }
}

function connect() {
  chrome.storage.local.get(["token", "port"], ({ token: t, port: p }) => {
    token = t || "";
    port = p || DEFAULT_PORT;
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
        logAction("bağlandı / connected", `port ${port}${myTabs.length ? ` · ${myTabs.length} agent sekmesi` : " · boşta / idle"}`);
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
  if (area === "local" && (changes.token || changes.port)) {
    ws?.close();
    retries = 0;
    connect();
  }
});

// Status query from the popup
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "status") {
    reply({ open: ws?.readyState === 1, activity, hasToken: !!token, port, myTabs: myTabs.length });
  }
  if (msg.type === "reconnect") connect();
  return false;
});

connect();
