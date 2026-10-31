#!/usr/bin/env node
// agent-bridge: lets terminal agents (MCP clients) operate Chrome.
// Runs both the WebSocket server (the extension connects to it) and the MCP server
// (the agent connects to it) in the same process.
import { setLang, t } from "../src/i18n.mjs";
import { startBridge } from "../src/bridge.mjs";
import { startMcp } from "../src/mcp.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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

const port = Number(arg("port", 8791));
const shotsDir = arg("shots", join(process.cwd(), "shots"));
mkdirSync(shotsDir, { recursive: true });

const token = await startBridge({ port, token: arg("token") });
console.error(t("bridgeListening", { port }));
console.error(t("bridgeToken", { token }));
console.error(t("bridgeHowTo"));

await startMcp({ shotsDir });
