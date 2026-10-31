// Local bridge: WebSocket server the Chrome extension connects to.
// Binds to 127.0.0.1 only; the extension must present the pairing token on connect.
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { t } from "./i18n.mjs";

/** Requests in flight: id → { resolve, reject, timer } */
const pending = new Map();
let wss = null;
let ext = null; // connected extension socket (single extension assumed; a new one replaces it)

function makeToken() {
  // Readable pairing token without ambiguous characters (0/O, 1/I).
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const chunk = (n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
  return `${chunk(4)}-${chunk(4)}`;
}

export function startBridge({ port = 8791, token: fixed } = {}) {
  const token = fixed || makeToken();
  wss = new WebSocketServer({ host: "127.0.0.1", port });
  return new Promise((resolve, reject) => {
    wss.on("error", reject);
    wss.on("listening", () => resolve(token));
    wss.on("connection", (socket) => {
      let authenticated = false;
      socket.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!authenticated) {
          if (msg.type === "hello" && msg.token === token) {
            authenticated = true;
            ext?.close();
            ext = socket;
            console.error(t("extConnected", { chrome: msg.chrome ?? "?" }));
            socket.send(JSON.stringify({ type: "ready" }));
          } else {
            socket.close(4001, "invalid token");
          }
          return;
        }
        // Reply to a request: { id, ok, data } | { id, ok: false, error }
        const waiting = pending.get(msg.id);
        if (!waiting) return;
        pending.delete(msg.id);
        clearTimeout(waiting.timer);
        if (msg.ok) waiting.resolve(msg.data);
        else waiting.reject(new Error(msg.error || t("extError")));
      });
      socket.on("close", () => {
        if (ext === socket) {
          ext = null;
          console.error(t("extDisconnected"));
        }
      });
    });
  });
}

/** Sends a command to the extension; resolves with the reply or times out. */
export function request(cmd, args = {}, timeoutMs = 30_000) {
  if (!ext || ext.readyState !== 1) {
    return Promise.reject(new Error(t("extNotConnected")));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(t("timeout", { cmd, sn: timeoutMs / 1000 })));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ id, cmd, args }));
  });
}
