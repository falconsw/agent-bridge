// Agent Bridge service worker: connects to the local bridge (ws://127.0.0.1:port)
// and carries out agent commands via chrome.debugger.
// SECURITY: the agent only ever sees and uses tabs IT opened (plus popups those tabs open);
// it cannot see or touch the user's own tabs. Sensitive fields (passwords, OTP, card numbers)
// never appear in snapshots. Blocked URL patterns are enforced on navigation and actions.
// When the work is done (done tool / 10 minutes without a command) the agent tabs close.
// TOKEN BUDGET: replies are compact text; actions wait for the page to settle and report
// only what changed (new elements, URL change), so agents rarely need a separate read.
import { t, setLang } from "./i18n.js";
import { installAgentLib } from "./page.js";

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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
const setBadge = (text = "", color = "#1a7f37") => {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
};
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
async function cleanup(reason) {
  clearTimeout(idleTimer);
  const list = myTabs;
  myTabs = [];
  await saveMyTabs();
  for (const id of list) {
    await chrome.debugger.detach({ tabId: id }).catch(() => {});
    await chrome.tabs.remove(id).catch(() => {});
    attached.delete(id);
    buffers.delete(id);
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

// Popups opened by an agent tab (target=_blank, window.open) belong to the agent too.
chrome.tabs.onCreated.addListener(async (tab) => {
  await loadMyTabs();
  if (tab.openerTabId === undefined || !myTabs.includes(tab.openerTabId)) return;
  myTabs.push(tab.id);
  await saveMyTabs();
  bufferOf(tab.openerTabId).notes.push(`new tab opened: [${tab.id}] (now the default tab)`);
  attachDebugger(tab.id).catch(() => {});
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadMyTabs();
  attached.delete(tabId);
  buffers.delete(tabId);
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
    // After a service worker restart the debugger may still be attached: reuse it.
    if (!/already attached/i.test(String(e.message))) throw e;
  }
  attached.add(tabId);
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(tabId, method).catch(() => {});
  await send(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: MARK_SCRIPT }).catch(() => {});
  await send(tabId, "Runtime.evaluate", { expression: MARK_SCRIPT }).catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  attached.delete(tabId);
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
  }
});

// --- page scripts ---
const LIB = `(${installAgentLib.toString()})();`;
const NAV_ERROR = /context was destroyed|Cannot find context|navigated or closed|Inspected target|No frame|not attached/i;

/** Runs `body` (an expression; window.__ab is available) in the page and returns its value. */
async function runInPage(tabId, body, { lib = true } = {}) {
  await attachDebugger(tabId);
  let reply;
  try {
    reply = await send(tabId, "Runtime.evaluate", {
      expression: lib ? `${LIB}\n${body}` : body,
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
  await assertAllowed((await chrome.tabs.get(tabId)).url ?? "");
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

async function mouseClick(tabId, { x, y }, { button = "left", clickCount = 1 } = {}) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let n = 1; n <= clickCount; n++) {
    await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: n });
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: n });
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

async function screenshot(tabId) {
  await attachDebugger(tabId);
  const { cssVisualViewport: vp } = await send(tabId, "Page.getLayoutMetrics");
  // CSS-pixel JPEG capped at 1280px wide: a fraction of a retina PNG's size and image tokens.
  const scale = Math.min(1, 1280 / vp.clientWidth);
  const reply = await send(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 70,
    clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale },
  });
  return { data: reply.data, mimeType: "image/jpeg" };
}

async function handleCommand(cmd, args = {}) {
  await loadMyTabs();
  switch (cmd) {
    case "tabs": {
      if (args.close !== undefined) {
        if (!myTabs.includes(args.close)) throw new Error(T("tabNotOwned"));
        await chrome.tabs.remove(args.close).catch(() => {});
      }
      if (args.switchTo !== undefined) {
        if (!myTabs.includes(args.switchTo)) throw new Error(T("tabNotOwned"));
        myTabs = [...myTabs.filter((id) => id !== args.switchTo), args.switchTo];
        await saveMyTabs();
      }
      const tabs = (await Promise.all(myTabs.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
      const current = myTabs[myTabs.length - 1];
      return tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.id === current }));
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
      return act(tabId, `__ab.point(__ab.resolve(${target(args)}))`, (p) =>
        mouseClick(tabId, p, { button: args.button ?? "left", clickCount: args.double ? 2 : 1 }),
      );
    }
    case "hover": {
      const tabId = await resolveTab(args);
      return act(tabId, `__ab.point(__ab.resolve(${target(args)}))`, (p) =>
        send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y }),
      );
    }
    case "type": {
      const tabId = await resolveTab(args);
      const hasTarget = args.ref !== undefined || args.selector;
      return act(tabId, `__ab.prepareType(${hasTarget ? target(args) : "null"}, ${args.clear !== false})`, async (p) => {
        if (!p.focused) await mouseClick(tabId, p); // custom widgets focus only on a real click
        if (args.text) await send(tabId, "Input.insertText", { text: args.text });
        else if (args.clear !== false) await pressKey(tabId, "Backspace");
        if (args.submit) await pressKey(tabId, "Enter");
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
          if (want !== info.checked) await mouseClick(tabId, info);
          lines.push(`${name} ${want ? "☑" : "☐"}`);
        } else if (info.kind === "select") {
          lines.push(`${name}="${await runInPage(tabId, `__ab.selectOption(${tgt}, ${JSON.stringify(String(value))})`)}"`);
        } else {
          const p = await runInPage(tabId, `__ab.prepareType(${tgt}, true)`);
          if (!p.focused) await mouseClick(tabId, p);
          if (String(value ?? "")) await send(tabId, "Input.insertText", { text: String(value) });
          lines.push(`${name} ✓`);
        }
      }
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
        for (let i = 0; i < (args.repeat ?? 1); i++) for (const combo of String(args.keys).split(/\s+/)) await pressKey(tabId, combo);
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
      await assertAllowed((await chrome.tabs.get(tabId)).url ?? "");
      await attachDebugger(tabId);
      const reply = await send(tabId, "Runtime.evaluate", { expression: `${LIB}\n__ab.resolve(${target(args)})` });
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
      if (args.tabId !== undefined && !myTabs.includes(args.tabId)) throw new Error(T("tabNotOwned"));
      let tabId;
      if (args.url === "back" || args.url === "forward" || args.url === "reload") {
        tabId = await resolveTab(args);
        if (args.url === "back") await chrome.tabs.goBack(tabId);
        else if (args.url === "forward") await chrome.tabs.goForward(tabId);
        else await chrome.tabs.reload(tabId);
      } else {
        await assertAllowed(args.url);
        if (args.tabId !== undefined) tabId = args.tabId;
        else if (myTabs.length && args.newTab !== true) tabId = myTabs[myTabs.length - 1];
        if (tabId !== undefined) {
          await attachDebugger(tabId).catch(() => {});
          await chrome.tabs.update(tabId, { url: args.url });
        } else {
          const tab = await chrome.tabs.create({ url: args.url });
          tabId = tab.id;
          myTabs.push(tabId);
          await saveMyTabs();
          await attachDebugger(tabId); // mark the agent tab right away (frame + 🤖 title)
        }
      }
      refreshBadge();
      await waitLoad(tabId, { expectStart: true });
      return withNotes(tabId, `[tab ${tabId}]\n${await snapshot(tabId, { max: args.max ?? 80 })}`);
    }
    case "screenshot":
      return screenshot(await resolveTab(args));
    case "eval": {
      const tabId = await resolveTab(args);
      const value = await runInPage(tabId, args.expression, { lib: false });
      return value === undefined ? "undefined" : value;
    }
    case "console": {
      const tabId = await resolveTab(args);
      const b = bufferOf(tabId);
      const pattern = args.pattern ? new RegExp(args.pattern, "i") : null;
      const rows = b.console.filter((m) => (!args.errorsOnly || /error|exception|assert/.test(m.level)) && (!pattern || pattern.test(m.text)));
      if (args.clear) b.console = [];
      const list = rows.slice(-(args.limit ?? 30)).map((m) => `[${m.level}] ${m.text}`);
      return list.length ? list.join("\n") : "(no console messages captured since the tab was attached)";
    }
    case "network": {
      const tabId = await resolveTab(args);
      const b = bufferOf(tabId);
      const pattern = args.pattern ? new RegExp(args.pattern, "i") : null;
      const rows = b.net.filter((r) => (!pattern || pattern.test(r.url)) && (!args.apiOnly || r.type === "XHR" || r.type === "Fetch"));
      if (args.clear) b.net = [];
      const list = rows.slice(-(args.limit ?? 30)).map((r) => `${r.status} ${r.method} ${r.type ?? ""} ${r.url.slice(0, 160)}`);
      return list.length ? list.join("\n") : "(no requests captured since the tab was attached)";
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
  const { expression, path, paths, text, fields, ...rest } = args;
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
