// Runs the real service worker (extension/background.js) against a stubbed chrome.* API:
// checks that the URL policy and the eval gate hold on every path, without Chrome.
import assert from "node:assert/strict";

const local = { enabled: true, token: "TEST-TOKEN", lang: "en", cursor: false, evalMode: "on" };
const session = {};
const tabs = new Map(); // id → { id, url, status }
const closed = [];
const listeners = {};
const event = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
const storage = (bag) => ({
  get(keys, done) {
    const names = typeof keys === "string" ? [keys] : keys;
    const out = Object.fromEntries(names.filter((k) => k in bag).map((k) => [k, bag[k]]));
    return done ? done(out) : Promise.resolve(out);
  },
  set: async (values) => void Object.assign(bag, values),
});
let nextTab = 1;
let pageNeeds = null; // what the page-side detector reports for the next action ({ kind, label } or null)
let onAsk = null; // plays the user when an approval window opens: (approvalId, windowId) => …
const asked = [];
const EXT = { id: "ext-id" };
const evaluations = [];
let isolatedWorldAvailable = true;
let viewport = { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0, offsetX: 0, offsetY: 0 };
let childFrames = []; // frame ids under the main frame, as Page.getFrameTree lists them
const frameBoxes = {}; // frame id → content quad of its iframe element (none: the iframe is hidden)
const pageRects = {}; // "ox,oy" → what __ab.redactRects reports for the frame at that offset
const painted = []; // fillRect calls of the screenshot paint-over

// The worker's canvas, enough of it to see where the paint-over lands.
globalThis.createImageBitmap = async () => ({ width: viewport.clientWidth, height: viewport.clientHeight });
globalThis.OffscreenCanvas = class {
  getContext = () => ({ drawImage() {}, fillRect: (...box) => painted.push(box) });
  convertToBlob = async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
};

globalThis.chrome = {
  storage: { local: storage(local), session: storage(session), onChanged: event("storageChanged") },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  alarms: { create() {}, onAlarm: event("alarm") },
  runtime: { onMessage: event("message"), id: EXT.id, getURL: (path) => `chrome-extension://${EXT.id}/${path}` },
  windows: {
    create: async ({ url }) => {
      const win = { id: 900 + asked.length };
      asked.push(url);
      setTimeout(() => onAsk?.(new URL(url).searchParams.get("id"), win.id), 5);
      return win;
    },
    remove: async () => {},
    update: async () => {},
    onRemoved: event("windowRemoved"),
  },
  tabGroups: { query: async () => [], update: async () => {} },
  tabs: {
    get: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      return { ...tabs.get(id) };
    },
    create: async ({ url }) => {
      const tab = { id: nextTab++, url, status: "complete", groupId: -1, windowId: 1 };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    update: async (id, { url }) => void (tabs.get(id).url = url),
    remove: async (id) => {
      tabs.delete(id);
      closed.push(id);
    },
    group: async () => 1,
    onCreated: event("tabCreated"),
    onUpdated: event("tabUpdated"),
    onRemoved: event("tabRemoved"),
  },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    // Whatever runs in the page answers with the URL it ran on: a leak shows up in the reply.
    sendCommand: async ({ tabId }, _method, params) => {
      if (_method === "Page.getFrameTree") return { frameTree: { frame: { id: `frame-${tabId}` }, childFrames: childFrames.map((id) => ({ frame: { id } })) } };
      if (_method === "Page.getLayoutMetrics") return { cssVisualViewport: viewport };
      if (_method === "DOM.getFrameOwner") return { backendNodeId: params.frameId };
      if (_method === "DOM.getBoxModel") {
        if (!frameBoxes[params.backendNodeId]) throw new Error("Could not compute box model.");
        return { model: { content: frameBoxes[params.backendNodeId] } };
      }
      if (_method === "Page.captureScreenshot") return { data: "data:image/jpeg;base64,AAAA" };
      if (_method === "Page.createIsolatedWorld") {
        assert.equal(params.worldName, "agent-bridge-private");
        assert.equal(params.grantUniveralAccess, undefined);
        return isolatedWorldAvailable ? { executionContextId: 42 } : {};
      }
      if (_method === "Runtime.evaluate") evaluations.push(params);
      const body = params?.expression ?? "";
      if (body.includes("__ab.")) assert.equal(params.contextId, 42, "helpers must never run in the page world");
      if (/__ab\.(approval|pageApproval)\(/.test(body)) return { result: { value: pageNeeds } };
      if (body.includes("__ab.fieldInfo(")) return { result: { value: { kind: "toggle", checked: false, x: 1, y: 1 } } };
      const rectCall = body.match(/__ab\.redactRects\(([\d.]+), ([\d.]+)\)/);
      if (rectCall) return { result: { value: { rects: pageRects[`${rectCall[1]},${rectCall[2]}`] ?? [] } } };
      if (body.includes("__ab.secrets()")) return { result: { value: ["secret123", "user@example.test"] } };
      return { result: { value: `ran on ${tabs.get(tabId).url}` } };
    },
    onDetach: event("detach"),
    onEvent: event("debuggerEvent"),
  },
};

let socket;
globalThis.WebSocket = class {
  readyState = 1;
  sent = [];
  constructor() {
    socket = this;
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {}
};

await import("../extension/background.js");
socket.onopen();
await socket.onmessage({ data: JSON.stringify({ type: "ready" }) });

let seq = 0;
/** Sends one command as the bridge would; resolves to { ok, data | error }. `who` overrides agent fields. */
async function run(cmd, args = {}, allow, who) {
  const id = `c${++seq}`;
  await socket.onmessage({ data: JSON.stringify({ id, cmd, args, agent: { id: "a1", name: "test", ...(allow ? { allow } : {}), ...who } }) });
  return socket.sent.find((m) => m.id === id);
}
const allow = ["example.com"];
const refused = (reply, pattern) => {
  assert.equal(reply.ok, false, `expected a refusal, got: ${JSON.stringify(reply)}`);
  assert.match(reply.error, pattern);
};

// --- limited run ---
let r = await run("navigate", { url: "https://mail.test/inbox" }, allow);
refused(r, /outside this run's allowed domains/);
assert.equal(tabs.size, 0, "a refused navigate must not open a tab");

r = await run("navigate", { url: "https://example.com/" }, allow);
assert.equal(r.ok, true, r.error);
let tabId = [...tabs.keys()][0];

r = await run("eval", { expression: "1" }, allow);
assert.equal(r.data, "ran on https://example.com/");

// The page moves the tab itself (redirect, link, location=…): the listener parks it.
tabs.get(tabId).url = "https://mail.test/inbox";
await listeners.tabUpdated(tabId, { url: "https://mail.test/inbox" });
assert.equal(tabs.get(tabId).url, "about:blank", "tab must be parked when it leaves the allowed domains");
r = await run("read", {}, allow);
assert.match(r.data, /! mail\.test is outside this run's allowed domains/, "the agent must be told why the tab is blank");

// Even if the listener has not fired yet, no command reads or runs anything there.
for (const [cmd, args] of [["eval", { expression: "document.cookie" }], ["read", {}], ["find", { query: "x" }], ["click", { ref: 1 }], ["screenshot", {}], ["console", {}], ["network", {}], ["key", { keys: "Enter" }], ["upload", { ref: 1, paths: [] }]]) {
  tabs.get(tabId).url = "https://mail.test/inbox";
  r = await run(cmd, args, allow);
  refused(r, /outside this run's allowed domains.*about:blank/);
  assert.equal(tabs.get(tabId).url, "about:blank", `${cmd}: tab must be parked`);
}

// A redirect during navigate: the snapshot of the landing page is never returned.
tabs.get(tabId).url = "https://example.com/";
const realUpdate = chrome.tabs.update;
chrome.tabs.update = async (id, { url }) => void (tabs.get(id).url = url === "https://example.com/go" ? "https://mail.test/landed" : url);
r = await run("navigate", { url: "https://example.com/go" }, allow);
refused(r, /mail\.test is outside/);
assert.equal(tabs.get(tabId).url, "about:blank");
chrome.tabs.update = realUpdate;

// Popups opened by an agent tab: closed when they point outside, adopted otherwise.
tabs.set(50, { id: 50, url: "", pendingUrl: "https://mail.test/compose", openerTabId: tabId, status: "loading", groupId: -1, windowId: 1 });
await listeners.tabCreated({ ...tabs.get(50) });
assert.ok(closed.includes(50), "a popup outside the allowed domains must be closed");
r = await run("tabs", {}, allow);
assert.deepEqual(r.data.map((t) => t.id), [tabId]);
tabs.set(51, { id: 51, url: "", pendingUrl: "https://example.com/popup", openerTabId: tabId, status: "complete", groupId: -1, windowId: 1 });
await listeners.tabCreated({ ...tabs.get(51) });
r = await run("tabs", {}, allow);
assert.deepEqual(r.data.map((t) => t.id), [tabId, 51]);
await run("tabs", { close: 51 }, allow);
await listeners.tabRemoved(51);
// Real Chrome creates window.open tabs without a URL; the first one they commit decides.
tabs.set(52, { id: 52, url: "", openerTabId: tabId, status: "loading", groupId: -1, windowId: 1 });
await listeners.tabCreated({ ...tabs.get(52) });
tabs.get(52).url = "https://mail.test/compose";
await listeners.tabUpdated(52, { url: "https://mail.test/compose" });
assert.ok(closed.includes(52), "a popup that loads a page outside the allowed domains must be closed");
await listeners.tabRemoved(52);
r = await run("read", {}, allow);
assert.match(r.data, /! new tab closed: mail\.test is outside/);

// --- eval gate (popup setting): eval is opt-in, default off ---
tabs.get(tabId).url = "https://example.com/";
delete local.evalMode;
refused(await run("eval", { expression: "1" }, allow), /eval is off/);
local.evalMode = "off";
refused(await run("eval", { expression: "1" }, allow), /eval is off/);
local.evalMode = "allowlist";
assert.equal((await run("eval", { expression: "1" }, allow)).ok, true);
refused(await run("eval", { expression: "1" }), /only runs with an allowed-domain list/);
local.evalMode = "on";

// A different command cannot relax the policy of a tab or its future popups.
await run("tabs", {});
tabs.get(tabId).url = "https://mail.test/inbox";
await listeners.tabUpdated(tabId, { url: "https://mail.test/inbox" });
assert.equal(tabs.get(tabId).url, "about:blank");
refused(await run("navigate", { url: "https://mail.test/inbox", tabId }), /outside/);
assert.deepEqual(session.tabAllow[tabId], allow);
await run("cleanup");
await run("navigate", { url: "https://mail.test/inbox", newTab: true });
tabId = [...tabs.keys()][0];

// --- no --allow: today's behaviour, except that blocked patterns now hold everywhere ---
tabs.get(tabId).url = "https://mail.test/inbox";
r = await run("eval", { expression: "1" });
assert.equal(r.data, "ran on https://mail.test/inbox");
await listeners.tabUpdated(tabId, { url: "https://mail.test/inbox" });
assert.equal(tabs.get(tabId).url, "https://mail.test/inbox");
local.blockPatterns = ["mail.test/*"];
refused(await run("eval", { expression: "1" }), /blocked URL pattern/);
assert.equal(tabs.get(tabId).url, "about:blank");

// --- sign-in and consent steps wait for the user ---
delete local.blockPatterns;
tabs.get(tabId).url = "https://shop.test/login";
const answerWith = (allow, sender = EXT) => (id) => listeners.message({ type: "approvalAnswer", id, allow }, sender, () => {});
pageNeeds = { kind: "login", label: "Sign in" };

// Signing in is never the agent's step: no window, no way to say yes, the tab is shown to the user.
onAsk = () => assert.fail("a sign-in must not open an approval window");
const shown = [];
const plainUpdate = chrome.tabs.update;
chrome.tabs.update = async (id, props) => (props.active ? void shown.push(id) : plainUpdate(id, props));
for (const [cmd, args] of [["click", { ref: 1 }], ["key", { keys: "Enter" }], ["type", { ref: 2, text: "x", submit: true }], ["fill", { fields: [], submit: true }], ["eval", { expression: "document.forms[0].submit()" }]]) {
  refused(await run(cmd, args), /shop\.test asks to sign in: that step is left to the user/);
}
assert.equal(asked.length, 0);
assert.deepEqual(shown, Array(5).fill(tabId), "the agent tab must be brought to the user");
for (const keys of ["shift+Enter", "ctrl+Enter", "cmd+Enter", "alt+Enter"]) {
  refused(await run("key", { keys }), /asks to sign in/);
}
chrome.tabs.update = plainUpdate;

// Consent boxes: the user is asked.
pageNeeds = { kind: "consent", label: "I accept the terms" };
onAsk = answerWith(false);
refused(await run("click", { ref: 1 }), /did not approve this step \(ticking a consent box, shop\.test\)/);
assert.equal(asked.length, 1);
for (const keys of ["shift+Space", "ctrl+Space", "cmd+Space", "alt+Space"]) {
  refused(await run("key", { keys }), /did not approve/);
}

onAsk = (id, windowId) => listeners.windowRemoved(windowId); // the user just closes the window
refused(await run("key", { keys: "Space" }), /did not approve/);

onAsk = (id) => {
  answerWith(true, { id: "some-other-extension" })(id); // only our own pages may answer
  setTimeout(() => answerWith(false)(id), 20);
};
refused(await run("click", { ref: 1 }), /did not approve/);

let info;
onAsk = (id) => {
  listeners.message({ type: "approvalInfo", id }, EXT, (reply) => (info = reply));
  answerWith(true)(id);
};
assert.equal((await run("click", { ref: 1 })).ok, true);
assert.deepEqual(info, { kind: "consent", label: "I accept the terms", host: "shop.test", agent: "test" });

// The approval is remembered for that box only.
onAsk = () => assert.fail("must not ask twice for the same box");
assert.equal((await run("click", { ref: 1 })).ok, true);
onAsk = answerWith(false);
pageNeeds = { kind: "consent", label: "I accept the privacy policy" };
refused(await run("fill", { fields: [{ ref: 3, value: true }] }), /ticking a consent box/);
pageNeeds = { kind: "script", label: "I accept the privacy policy" };
refused(await run("eval", { expression: "box.click()" }), /eval on a page with a consent box/);

// Ordinary steps never open a window; with the switch off nothing does.
const before = asked.length;
pageNeeds = null;
assert.equal((await run("click", { ref: 1 })).ok, true);
pageNeeds = { kind: "login", label: "Sign in" };
local.confirmSensitive = false;
assert.equal((await run("click", { ref: 1 })).ok, true);
assert.equal(asked.length, before);

// A javascript: link is refused outright — even with the confirmation switch off: no window, no yes.
const askedBefore = asked.length;
pageNeeds = { kind: "jslink", label: "javascript:fetch('/x')" };
onAsk = () => assert.fail("a javascript: link must be refused without asking");
refused(await run("click", { ref: 1 }), /javascript: link would run a page script/);
assert.equal(asked.length, askedBefore);
pageNeeds = null;
onAsk = null;

// --- per-agent ownership: another agent's tabs are invisible and off limits ---
tabs.get(tabId).url = "https://example.com/";
const other = { id: "a2", name: "other" };
refused(await run("tabs", { close: tabId }, allow, other), /does not belong to the agent/);
refused(await run("navigate", { url: "https://example.com/other", tabId }, allow, other), /does not belong to the agent/);
refused(await run("read", { tabId }, allow, other), /does not belong to the agent/);
assert.deepEqual((await run("tabs", {}, allow, other)).data, [], "another agent must not list tabs it does not own");
assert.equal((await run("read", { tabId }, allow)).ok, true, "the owning agent still works");

// --- console output is scrubbed of the values the snapshot hides ---
await listeners.debuggerEvent({ tabId }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "token secret123 for user@example.test" }] });
r = await run("console", {}, allow);
assert.ok(!String(r.data).includes("secret123"), `console must be scrubbed, got: ${r.data}`);
assert.match(String(r.data), /•••/);

// --- screenshot: rects from every frame plus the closed-shadow watcher, then paint-over in the worker ---
await listeners.debuggerEvent({ tabId }, "Runtime.executionContextCreated", { context: { executionContextId: 77, auxData: { frameId: `frame-${tabId}`, type: "default" } } });
r = await run("screenshot", {}, allow);
assert.equal(r.ok, true, r.error);

assert.ok(evaluations.some((e) => String(e.expression).includes("__ab.redactRects(0, 0)")), "screenshot must collect redaction rects");
assert.ok(evaluations.some((e) => String(e.expression).includes("__abShadowWatch.rects()")), "screenshot must query the closed-shadow watcher");

// Two drivers send commands in the same turn: the unrestricted one must not
// overwrite the restricted command's policy while it awaits chrome.* calls.
delete local.confirmSensitive;
pageNeeds = null;
tabs.get(tabId).url = "https://private.test/inbox";
const [restricted] = await Promise.all([
  run("read", { tabId }, ["public.test"]),
  run("tabs", {}),
]);
refused(restricted, /outside/);
assert.equal(tabs.get(tabId).url, "about:blank");
assert.equal((await run("ping")).ok, true, "a rejected command must not poison the queue");

// --- screenshot paint-over: a scrolled page and a hidden iframe ahead of a visible one ---
tabs.get(tabId).url = "https://shop.test/";
viewport = { ...viewport, pageY: 500 }; // scrolled down: rects stay viewport-relative, so must the paint
childFrames = ["hidden-frame", "visible-frame"];
frameBoxes["visible-frame"] = [100, 200, 400, 200, 400, 500, 100, 500];
pageRects["0,0"] = [{ x: 50, y: 60, w: 100, h: 20 }];
pageRects["100,200"] = [{ x: 110, y: 230, w: 80, h: 20 }]; // the collector adds the frame offset itself
painted.length = 0;
evaluations.length = 0;
r = await run("screenshot", { tabId });
assert.equal(r.ok, true, r.error);
assert.deepEqual(painted, [[48, 58, 104, 24], [108, 228, 84, 24]], "paint must land on the fields, whatever the scroll position");
assert.equal(evaluations.filter((e) => String(e.expression).includes("__ab.redactRects(")).length, 2, "the hidden iframe is skipped, the visible one keeps its own offset");
assert.ok(!(await run("read", { tabId })).data.includes("DBG"), "no debug notes in replies");
viewport = { ...viewport, pageY: 0 };
childFrames = [];

// --- an approval wait holds up that agent only; it comes back as the same agent and run ---
tabs.get(tabId).url = "https://shop.test/terms";
pageNeeds = { kind: "consent", label: "I accept the cookie policy" };
onAsk = (id) => setTimeout(() => answerWith(true)(id), 80);
const waiting = run("click", { ref: 1, tabId }, ["shop.test"]);
await new Promise((done) => setTimeout(done, 20));
pageNeeds = null;
const meanwhile = await run("tabs", {}, ["other.test"], other);
assert.equal(meanwhile.ok, true, "another agent must not wait for this agent's approval window");
assert.ok(!socket.sent.some((m) => m.id === `c${seq - 1}`), "the click is still waiting for the user");
r = await waiting;
assert.equal(r.ok, true, `the click must go on under its own run's policy, got: ${r.error}`);
assert.equal(tabs.get(tabId).url, "https://shop.test/terms");
onAsk = null;

// Helper isolation is mandatory, while the explicit eval tool retains page globals.
tabs.get(tabId).url = "https://shop.test/";
assert.equal((await run("read", { tabId })).ok, true);
assert.equal((await run("eval", { expression: "window.appState", tabId })).ok, true);
assert.equal(evaluations.findLast((e) => e.expression === "window.appState").contextId, undefined);
isolatedWorldAvailable = false;
const count = evaluations.length;
refused(await run("read", { tabId }), /isolated helper context unavailable/);
assert.equal(evaluations.length, count, "context failure must never fall back to page evaluation");
console.log("[background] passed");
process.exit(0); // the worker keeps timers (heartbeat, idle) alive
