#!/usr/bin/env node
// agent-bridge: lets terminal agents (MCP clients) operate Chrome.
// Runs both the WebSocket server (the extension connects to it) and the MCP server
// (the agent connects to it) in the same process.
import { setLang, t } from "../src/i18n.mjs";
import { startBridge } from "../src/bridge.mjs";
import { startMcp } from "../src/mcp.mjs";
import { parseAllow } from "../extension/policy.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

const langArg = arg("lang", "tr");
setLang(langArg === "en" ? "en" : "tr");

if (process.argv.includes("--help")) {
  console.log(t("help"));
  process.exit(0);
}

if (process.argv.includes("--fresh")) {
  // Re-pin: forget the previously paired extension; the next one connects freely.
  const pinFile = arg("pin", join(homedir(), ".agent-bridge", "token.json"));
  rmSync(pinFile, { force: true });
}

const port = Number(arg("port", 8791));
// Not cwd: GUI clients (Claude Desktop, Cursor…) may start us in "/", which is read-only.
const shotsDir = arg("shots", join(homedir(), ".agent-bridge", "shots"));
mkdirSync(shotsDir, { recursive: true });

// Allowed domains for this run. Set here by the user (flag or env), never by a tool call,
// so nothing the agent reads on a page can widen it.
let allow;
try {
  allow = parseAllow(arg("allow", process.env.AGENT_BRIDGE_ALLOW));
} catch (e) {
  console.error(t("error", { msg: e.message }));
  process.exit(1);
}
if (process.argv.includes("--allow") && !allow.length) {
  console.error(t("error", { msg: "--allow needs a list, e.g. --allow 'ads.google.com,*.example.com'" }));
  process.exit(1);
}
if (allow.length) console.error(t("bridgeAllow", { allow: allow.join(", ") }));

if (!arg("token")) console.error(t("bridgePairMode"));
const { token, mode } = await startBridge({ port, token: arg("token"), pinFile: arg("pin", join(homedir(), ".agent-bridge", "token.json")) });
if (mode === "primary") {
  console.error(t("bridgeListening", { port }));
  console.error(t("bridgeToken", { token }));
  console.error(t("bridgeHowTo"));
}

// The MCP client owns this process: when it closes stdin, exit and free the port
// (otherwise an orphaned bridge keeps 8791 and later sessions cannot start).
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

await startMcp({ shotsDir, allow, noEval: process.argv.includes("--no-eval") });
