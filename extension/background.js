// Agent Bridge service worker: connects to the local bridge (ws://127.0.0.1:port)
// and carries out agent commands via chrome.debugger.
// SECURITY: the agent only ever sees and uses tabs IT opened; it cannot see or touch
// the user's own tabs. Sensitive fields (passwords, OTP, card numbers) never appear in
// snapshots. Blocked URL patterns are enforced on navigation. When the work is done
// (done tool / 10 minutes without a command) the agent tabs close and the bridge idles.
import { t, setLang } from "./i18n.js";

const DEFAULT_PORT = 8791;
const IDLE_TIMEOUT = 10 * 60 * 1000;
let ws = null;
let token = "";
let port = DEFAULT_PORT;
let lang = "tr";
let enabled = false;
let attached = new Set();
let myTabs = []; // tabs the agent opened (ordered: newest last)
let myTabsLoaded = false;
let retries = 0;
let activity = [];
let idleTimer = null;

const T = (key, vars) => t(key, vars);

function makeToken() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const chunk = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join("");
  return `${chunk(4)}-${chunk(4)}`;
}

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

// --- blocked URL patterns (enterprise-style policy; comma-separated globs in storage) ---
function matchesBlocked(url, patterns) {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    return false;
  }
  const target = host + path;
  return patterns.some((pattern) => {
    const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`(^|//|\\.)${escaped.replace(/^\^/, "")}`, "i").test(target) || new RegExp(`^${escaped}$`, "i").test(target);
  });
}

async function assertAllowed(url) {
  const { blockPatterns } = await chrome.storage.local.get("blockPatterns");
  const patterns = blockPatterns ?? [];
  if (matchesBlocked(url, patterns)) throw new Error(T("blockedUrl", { url }));
}

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

// Claude-style visible marker: golden frame on the page + 🤖 prefix in the tab title.
const MARK_SCRIPT = `(() => {
  if (window.__agentBridge) return;
  window.__agentBridge = 1;
  const add = () => {
    if (document.getElementById("__agent-bridge-frame")) return;
    const frame = document.createElement("div");
    frame.id = "__agent-bridge-frame";
    frame.style.cssText = "position:fixed;inset:0;pointer-events:none;border:3px solid #ffc23a;z-index:2147483647;box-sizing:border-box";
    (document.body || document.documentElement).appendChild(frame);
    if (!/^🤖/.test(document.title)) document.title = "🤖 " + document.title;
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
})()`;

async function attachDebugger(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: MARK_SCRIPT }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: MARK_SCRIPT }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => {});
  attached.add(tabId);
}

/** Runs a page script and returns its value; resolves to a navigation notice if the page changed underneath. */
async function evaluate(tabId, expression, fallback) {
  await attachDebugger(tabId);
  try {
    const reply = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || T("pageScriptFailed"));
    return reply.result?.value ?? null;
  } catch (e) {
    return fallback ?? { ok: true, note: "sayfa değişti / page navigated" };
  }
}

// --- accessibility snapshot: semantic roles + stable refs (#rN), privacy-filtered ---
// Refs live in the page (window.__abRefs) and survive across commands until navigation.
const ROLE_MAP = `{a:"link",button:"button",input:"textbox",select:"combobox",textarea:"textbox",h1:"heading",h2:"heading",h3:"heading",h4:"heading",h5:"heading",h6:"heading",img:"image",nav:"navigation",main:"main",header:"banner",footer:"contentinfo",section:"region",article:"article",aside:"complementary",form:"form",table:"table",ul:"list",ol:"list",li:"listitem",label:"label",summary:"button",details:"group"}`;
const SENSITIVE_CHECK = `(el) => {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  return /cc-|csc|exp|one-time-code|current-password|new-password/.test((el.getAttribute("autocomplete") || "").toLowerCase());
}`;
const TREE_FN = `(root) => {
  window.__abRefs || (window.__abRefs = { map: new Map(), rev: new WeakMap(), n: 0 });
  const refs = window.__abRefs;
  const refFor = (el) => { let r = refs.rev.get(el); if (r === undefined) { r = ++refs.n; refs.rev.set(el, r); refs.map.set(r, el); } return r; };
  const roleOf = (el) => { const explicit = el.getAttribute("role"); if (explicit) return explicit; const map = ${ROLE_MAP}; const byTag = map[el.tagName.toLowerCase()]; if (byTag === "textbox" && ${SENSITIVE_CHECK}(el)) return null; return byTag || null; };
  const labelOf = (el) => (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 90);
  const lines = [];
  const started = Date.now();
  const walk = (el, depth) => {
    if (lines.length > 350 || Date.now() - started > 1200 || depth > 18) return;
    for (const child of el.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg" || tag === "head" || tag === "template") continue;
      const role = roleOf(child);
      if (role) lines.push(role + ' "' + labelOf(child) + '" #r' + refFor(child));
      else if (child.children.length) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines;
}`;

async function handleCommand(cmd, args = {}) {
  await loadMyTabs();
  switch (cmd) {
    case "tabs":
      return (
        await Promise.all(myTabs.map((id) => chrome.tabs.get(id).catch(() => null)))
      )
        .filter(Boolean)
        .map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active }));
    case "read": {
      const tabId = await resolveTab(args);
      const { selector, maxText = 800 } = args;
      return await evaluate(
        tabId,
        `(() => {
          const ARGS = ${JSON.stringify({ selector, maxText })};
          const scope = ARGS.selector ? document.querySelector(ARGS.selector) : document.body;
          if (!scope) return { title: document.title, url: location.href, tree: ["(scope bulunamadı / scope not found)"], text: "" };
          return {
            title: document.title,
            url: location.href,
            tree: (${TREE_FN})(scope),
            text: (scope.innerText || "").slice(0, ARGS.maxText),
          };
        })()`,
      );
    }
    case "click": {
      const tabId = await resolveTab(args);
      await assertAllowed((await chrome.tabs.get(tabId)).url ?? "");
      const target = await evaluate(
        tabId,
        `(() => {
          const ARGS = ${JSON.stringify({ ref: args.ref, selector: args.selector, text: args.text, notFound: T("elementNotFound") })};
          let el = null;
          if (ARGS.ref !== undefined) el = window.__abRefs?.map.get(ARGS.ref);
          else if (ARGS.selector) el = document.querySelector(ARGS.selector);
          else if (ARGS.text) {
            const needle = ARGS.text.toLocaleLowerCase();
            el = [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[contenteditable=true]")].find(e => (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "").toLocaleLowerCase().includes(needle));
          }
          if (!el || !document.contains(el)) return { ok: false, error: ARGS.notFound + " (read'i tekrarla / re-run read)" };
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
      );
      if (!target?.ok) return target;
      // Real input via CDP: mouse move + press + release at the element's center.
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await chrome.debugger.sendCommand({ tabId }, `Input.${type}`, {
          type,
          x: target.x,
          y: target.y,
          button: "left",
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
      }
      await new Promise((y) => setTimeout(y, 800));
      return await evaluate(
        tabId,
        `(async () => {
          await new Promise((y) => setTimeout(y, 0));
          return { ok: true, clicked: true, title: document.title, url: location.href, elements: (${TREE_FN})(document.body).slice(0, 12) };
        })()`,
      );
    }
    case "type": {
      const tabId = await resolveTab(args);
      await assertAllowed((await chrome.tabs.get(tabId)).url ?? "");
      const prepared = await evaluate(
        tabId,
        `(() => {
          const ARGS = ${JSON.stringify({ ref: args.ref, selector: args.selector, clear: args.clear !== false, notFound: T("noFieldFound") })};
          let el = null;
          if (ARGS.ref !== undefined) el = window.__abRefs?.map.get(ARGS.ref);
          else if (ARGS.selector) el = document.querySelector(ARGS.selector);
          if (!el) { el = document.activeElement; }
          if (!el || !document.contains(el)) return { ok: false, error: ARGS.notFound + " (read'i tekrarla / re-run read)" };
          el.scrollIntoView({ block: "center" });
          el.focus();
          if (ARGS.clear) {
            if (el.isContentEditable) { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); }
            else {
              const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
              if (descriptor && descriptor.set) descriptor.set.call(el, "");
              else el.value = "";
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          const r = el.getBoundingClientRect();
          return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
      );
      if (!prepared?.ok) return prepared;
      // Real keyboard: CDP inserts text (works with React/IME-like handlers) + optional Enter.
      await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: args.text });
      if (args.pressEnter) {
        for (const type of ["keyDown", "keyUp"]) {
          await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          });
        }
      }
      await new Promise((y) => setTimeout(y, 800));
      return await evaluate(
        tabId,
        `(async () => { await new Promise((y) => setTimeout(y, 0)); return { ok: true, title: document.title, url: location.href, elements: (${TREE_FN})(document.body).slice(0, 12) }; })()`,
      );
    }
    case "navigate": {
      if (args.tabId !== undefined && !myTabs.includes(args.tabId)) throw new Error(T("tabNotOwned"));
      await assertAllowed(args.url);
      let tab;
      if (args.tabId !== undefined) tab = await chrome.tabs.update(args.tabId, { url: args.url });
      else if (myTabs.length && args.newTab !== true) tab = await chrome.tabs.update(myTabs[myTabs.length - 1], { url: args.url });
      else {
        tab = await chrome.tabs.create({ url: args.url });
        myTabs.push(tab.id);
        await saveMyTabs();
      }
      await attachDebugger(tab.id); // mark the agent tab right away (frame + 🤖 title)
      refreshBadge();
      return { tabId: tab.id, url: args.url };
    }
    case "screenshot": {
      const tabId = await resolveTab(args);
      await attachDebugger(tabId);
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
    ws.onclose = () => {
      clearInterval(connect.heartbeat);
      reconnect();
    };
    ws.onerror = () => ws?.close();
  });
}

const briefArgs = (args) => {
  const { expression, path, text, ...rest } = args;
  return rest;
};

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
  cleanup(T("toggleOff")).then(() => setBadge(""));
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

// Status query from the popup
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "status") {
    reply({ open: ws?.readyState === 1, activity, enabled, port, myTabs: myTabs.length, lang, token });
  }
  if (msg.type === "reconnect") connect();
  return false;
});

connect();
