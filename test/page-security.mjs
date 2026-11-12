// Exercise the real privacy scanner with lightweight DOM fixtures, including
// fields that snapshot traversal skips (sensitive fields, shadow DOM, frames).
import assert from "node:assert/strict";
import vm from "node:vm";
import { installAgentLib } from "../extension/page.js";

function scope(children = []) {
  return {
    children,
    querySelectorAll(selector) {
      const all = children.flatMap((el) => [el, ...el.querySelectorAll("*")]);
      if (selector === 'input[type="password"]') return all.filter((el) => el.localName === "input" && el.type === "password");
      assert.equal(selector, "*");
      return all;
    },
  };
}

function element(tag, attrs = {}, value = "", children = []) {
  const properties = new Map();
  return {
    ...scope(children),
    localName: tag, value, type: attrs.type ?? "text",
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
    matches: () => false, // none of these fixtures are consent controls unless a test says so
    closest: () => null,
    querySelector: () => null,
    isConnected: true,
    isContentEditable: false,
    parentElement: null,
    getRootNode: () => doc,
    checkVisibility: () => true,
    innerText: value,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    style: {
      getPropertyValue: (name) => properties.get(name)?.value ?? "",
      getPropertyPriority: (name) => properties.get(name)?.priority ?? "",
      setProperty: (name, value, priority = "") => properties.set(name, { value, priority }),
    },
  };
}

const otp = element("input", { autocomplete: "one-time-code" }, "123456");
const card = element("input", { autocomplete: "cc-number" }, "4111111111111111");
const email = element("input", { type: "email" }, "user@example.test");
const hiddenOtp = element("input", { autocomplete: "one-time-code", "aria-hidden": "true" }, "654321");
const ordinary = element("input", {}, "search term");
const shadow = element("div");
shadow.shadowRoot = scope([card]);
const frame = element("iframe");
frame.contentDocument = scope([email]);
const doc = scope([element("button", {}, "", [otp]), shadow, frame, hiddenOtp, ordinary]);
for (const el of [otp, card, email, hiddenOtp, ordinary]) el.ownerDocument = doc;

// The page's forged helper must have no effect on the isolated helper world.
const pageWindow = { __ab: { v: 12, pageApproval: () => null, veil: () => 0 } };
const isolatedWindow = {};
const context = vm.createContext({ window: isolatedWindow, document: doc });
vm.runInContext(`(${installAgentLib.toString()})();`, context);
const lib = isolatedWindow.__ab;
assert.notEqual(lib, pageWindow.__ab);
assert.equal(lib.pageApproval().kind, "data");
assert.equal(lib.veil(true), 4, "OTP, card, email and hidden OTP must all be masked");
for (const el of [otp, card, email, hiddenOtp]) {
  assert.equal(el.style.getPropertyValue("-webkit-text-security"), "disc");
}
assert.equal(ordinary.style.getPropertyValue("-webkit-text-security"), "");
lib.veil(false);
assert.equal(otp.style.getPropertyValue("-webkit-text-security"), "");
assert.equal(otp.value, "123456", "masking must not edit actual form values");

// Restore pre-existing inline CSS exactly, including priority.
card.style.setProperty("-webkit-text-security", "circle", "important");
lib.veil(true);
lib.veil(false);
assert.equal(card.style.getPropertyValue("-webkit-text-security"), "circle");
assert.equal(card.style.getPropertyPriority("-webkit-text-security"), "important");

// Each sensitive field independently blocks silent eval, even without a password.
for (const field of [otp, card, hiddenOtp]) {
  doc.children.splice(0, doc.children.length, field);
  assert.equal(lib.pageApproval().kind, "data");
}
doc.children.splice(0, doc.children.length, ordinary);
assert.equal(lib.pageApproval(), null);
const password = element("input", { type: "password" }, "secret");
shadow.shadowRoot = scope([password]);
doc.children.splice(0, doc.children.length, shadow);
assert.equal(lib.pageApproval().kind, "login", "shadow-root passwords require handoff");

// --- screenshot redaction rects: drawn by the worker, outside the page's reach ---
const editable = element("div", { contenteditable: "true" }, "draft note 555");
editable.isContentEditable = true;
doc.children.splice(0, doc.children.length, editable);
assert.equal(lib.foreign(editable), true, "a prefilled contenteditable is foreign: the agent did not type it");
assert.equal(JSON.stringify(lib.secrets()), JSON.stringify(["draft note 555"]), "secrets() must list the editable draft");
const rects = lib.redactRects(10, 20);
assert.equal(rects.rects.length, 1, "the editable draft must be redacted from screenshots");
assert.equal(rects.rects[0].x, 10, "caller frame offset must be applied");

// --- consent control above the clicked element: a span inside role=checkbox reaches the box ---
const box = element("div", { role: "checkbox", "aria-checked": "false", "aria-label": "I accept the privacy policy" });
const span = element("span");
span.parentElement = box;
box.matches = (s) => s.includes('[role="checkbox"]');
doc.children.splice(0, doc.children.length, box, span);
assert.equal(lib.approval({ ref: lib.refFor(span) })?.kind, "consent", "a click on the span must reach the consent box above it");
const done = element("div", { role: "checkbox", "aria-checked": "true", "aria-label": "I accept the privacy policy" });
const span2 = element("span");
span2.parentElement = done;
done.matches = (s) => s.includes('[role="checkbox"]');
doc.children.splice(0, doc.children.length, done, span2);
assert.equal(lib.approval({ ref: lib.refFor(span2) }), null, "an already ticked box is not a step");

// --- javascript: links are refused outright ---
const link = element("a", { href: "javascript:fetch('/x')" });
link.closest = (s) => (s.includes("a[href]") ? link : null);
doc.children.splice(0, doc.children.length, link);
const js = lib.approval({ ref: lib.refFor(link) });
assert.equal(js?.kind, "jslink");
assert.equal(js?.label, "javascript:fetch('/x')");
console.log("[page-security] passed");
