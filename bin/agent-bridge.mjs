#!/usr/bin/env node
// agent-bridge: terminal agent'larına (MCP üzerinden) Chrome'da işlem yaptıran köprü.
// Aynı süreçte hem WebSocket sunucusu (eklenti buna bağlanır) hem MCP sunucusu (agent buna bağlanır) çalışır.
import { startBridge } from "../src/bridge.mjs";
import { startMcp } from "../src/mcp.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const arg = (ad, varsayilan) => {
  const i = process.argv.indexOf(`--${ad}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : varsayilan;
};

if (process.argv.includes("--help")) {
  console.log(`agent-bridge — agent'lara Chrome'da işlem yaptıran köprü

Kullanım: agent-bridge [--port 8791] [--token XXXX-XXXX] [--shots <klasör>]

1. Bu komutu çalıştır → token basılır
2. Chrome'da Agent Bridge eklentisini aç, token'ı yapıştır, Bağlan'a bas
3. Agent'ına MCP sunucusu olarak ekle:  agent-bridge  (stdio)

Araçlar: tabs, read, click, type, navigate, screenshot, eval`);
  process.exit(0);
}

const port = Number(arg("port", 8791));
const shotsDir = arg("shots", join(process.cwd(), "shots"));
mkdirSync(shotsDir, { recursive: true });

const token = await startBridge({ port, token: arg("token") });
console.error(`[köprü] ws://127.0.0.1:${port} dinleniyor`);
console.error(`[köprü] Token: ${token}`);
console.error("[köprü] Chrome'da Agent Bridge eklentisini açıp bu token'ı gir, sonra Bağlan'a bas.");

await startMcp({ shotsDir });
