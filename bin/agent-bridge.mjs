#!/usr/bin/env node
// agent-bridge: lets terminal agents (MCP clients) operate Chrome.
// Runs both the WebSocket server (the extension connects to it) and the MCP server
// (the agent connects to it) in the same process.
import { setLang, t } from "../src/i18n.mjs";
import { startBridge } from "../src/bridge.mjs";
import { startMcp } from "../src/mcp.mjs";
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
const shotsDir = arg("shots", join(process.cwd(), "shots"));
mkdirSync(shotsDir, { recursive: true });

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

await startMcp({ shotsDir });
