#!/usr/bin/env node
// agent-bridge: lets terminal agents (MCP clients) operate Chrome.
// Runs both the WebSocket server (the extension connects to it) and the MCP server
// (the agent connects to it) in the same process.
import { startBridge } from "../src/bridge.mjs";
import { startMcp } from "../src/mcp.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

if (process.argv.includes("--help")) {
  console.log(`agent-bridge — agent'lara Chrome'da işlem yaptıran köprü / lets agents operate Chrome

Kullanım / Usage: agent-bridge [--port 8791] [--token XXXX-XXXX] [--shots <klasör/folder>]

1. Bu komutu çalıştır → token basılır / Run this → a token is printed
2. Chrome'da Agent Bridge eklentisini aç, token'ı yapıştır, Bağlan'a bas /
   Open the Agent Bridge extension popup in Chrome, paste the token, press Connect
3. Agent'ına MCP sunucusu olarak ekle / Add as an MCP server to your agent:
   agent-bridge  (stdio)

Araçlar / Tools: tabs, read, click, type, navigate, screenshot, eval, done`);
  process.exit(0);
}

const port = Number(arg("port", 8791));
const shotsDir = arg("shots", join(process.cwd(), "shots"));
mkdirSync(shotsDir, { recursive: true });

const token = await startBridge({ port, token: arg("token") });
console.error(`[bridge] ws://127.0.0.1:${port} dinleniyor / listening`);
console.error(`[bridge] Token: ${token}`);
console.error("[bridge] Chrome'da Agent Bridge eklentisini açıp bu token'ı gir, sonra Bağlan'a bas. / Open the Agent Bridge extension in Chrome, paste this token and press Connect.");

await startMcp({ shotsDir });
