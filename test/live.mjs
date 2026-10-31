// Live driver: sends a single command to a PERSISTENT bridge over WebSocket (no MCP spawn).
// Start the bridge once (node bin/agent-bridge.mjs --token ...), then drive it per command.
// Usage: AB_TOKEN=... node test/live.mjs <tabs|eval|navigate|screenshot|cleanup> '[JSON args]'
import WebSocket from "ws";
import crypto from "node:crypto";

const [cmd, argsJson] = process.argv.slice(2);
if (!cmd) {
  console.log("usage: node test/live.mjs <tabs|eval|navigate|screenshot|cleanup> [JSON]");
  process.exit(1);
}
const args = argsJson ? JSON.parse(argsJson) : {};
const port = process.env.AB_PORT || "8791";
const token = process.env.AB_TOKEN || "TEST-TOKEN";

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const id = crypto.randomUUID();
let ready = false;
let answered = false;

const timeout = setTimeout(() => {
  if (!answered) console.error("Hata / Error: köprü zaman aşımı / bridge timeout");
  process.exit(2);
}, 90_000);

ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, role: "driver" })));
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "ready") {
    ready = true;
    ws.send(JSON.stringify({ id, cmd, args }));
    return;
  }
  if (msg.id !== id) return;
  answered = true;
  clearTimeout(timeout);
  if (msg.ok) {
    console.log(typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data, null, 1));
    process.exit(0);
  }
  console.error(`Hata / Error: ${msg.error}`);
  process.exit(1);
});
ws.on("error", (e) => {
  console.error(`Hata / Error: köprüye bağlanılamadı / cannot reach bridge: ${e.message}`);
  process.exit(2);
});
ws.on("close", () => {
  if (!answered && !ready) {
    console.error("Hata / Error: token reddedildi / token rejected");
    process.exit(1);
  }
});
