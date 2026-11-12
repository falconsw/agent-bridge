// Unit tests for the URL policy (extension/policy.js): no Chrome, no bridge.
import assert from "node:assert/strict";
import { parseAllow, matchesAllowed, matchesBlocked, denyReason } from "../extension/policy.js";

const allow = parseAllow("ads.google.com, *.example.com, https://github.com/falconsw/*");
assert.deepEqual(allow, ["ads.google.com", "*.example.com", "github.com/falconsw"]);

const yes = (url) => assert.equal(matchesAllowed(url, allow), true, `should allow ${url}`);
const no = (url) => assert.equal(matchesAllowed(url, allow), false, `should refuse ${url}`);

yes("https://ads.google.com/aw/campaigns?x=1");
yes("https://example.com/");
yes("https://www.example.com/a");
yes("https://app.eu.example.com/a");
yes("https://github.com/falconsw");
yes("https://github.com/falconsw/agent-bridge/issues");
yes("about:blank");

no("https://mail.google.com/");
no("https://google.com/");
no("https://ads.google.com.evil.net/");
no("https://evil.net/ads.google.com");
no("https://evil.net/?next=https://example.com/");
no("https://notexample.com/");
no("https://example.com.evil.net/");
no("https://github.com/falconswx/repo");
no("https://github.com/other/repo");
no("https://user:pw@evil.net/@example.com");
no("chrome://settings/");
no("file:///etc/passwd");
no("data:text/html,<h1>x</h1>");
no("javascript:alert(1)");

// No list: everything stays allowed (today's behaviour).
assert.equal(matchesAllowed("https://anything.test/", []), true);
assert.equal(matchesAllowed("https://anything.test/", undefined), true);
// Garbage from the wire never widens the list.
assert.equal(matchesAllowed("https://anything.test/", [null, 42, "", "*."]), false);

assert.throws(() => parseAllow("exa mple.com"));
assert.throws(() => parseAllow("*"));
assert.throws(() => parseAllow("*.com/*/x"));
assert.throws(() => parseAllow("ads.*.com"));
assert.deepEqual(parseAllow(""), []);
assert.deepEqual(parseAllow(undefined), []);

assert.equal(matchesBlocked("https://bank.example.com/login", ["bank.example.com/*"]), true);
assert.equal(denyReason("https://bank.example.com/login", { blockPatterns: ["bank.example.com/*"], allow }), "blocked");
assert.equal(denyReason("https://mail.google.com/", { allow }), "notAllowed");
assert.equal(denyReason("https://ads.google.com/", { allow }), null);
assert.equal(denyReason("https://mail.google.com/"), null);

console.log("[policy] passed");
