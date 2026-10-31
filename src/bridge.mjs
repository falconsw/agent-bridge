// Local bridge: WebSocket server the Chrome extension connects to.
// Binds to 127.0.0.1 only. Pairing is trust-on-first-use: the first extension
// token that connects is pinned to a file, and later bridges accept only it.
// A fixed --token skips TOFU and requires exact matches instead.
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Trust-on-first-use pin store: remembers the first accepted extension token. */
function makePinStore(pinFile) {
  const load = () => {
    try {
      return JSON.parse(readFileSync(pinFile, "utf8")).token ?? null;
    } catch {
      return null;
    }
  };
  const save = (token) => {
    mkdirSync(join(pinFile, ".."), { recursive: true });
    writeFileSync(pinFile, JSON.stringify({ token }, null, 2) + "\n");
  };
  return { load, save };
}

export function startBridge({ port = 8791, token: fixed, pinFile = join(homedir(), ".agent-bridge", "token.json") } = {}) {
  const pins = makePinStore(pinFile);
  const pinned = pins.load();
  const expect = fixed ?? pinned; // fixed --token wins; otherwise TOFU
  const token = expect ?? makeToken(); // printed so live drivers can read it
  wss = new WebSocketServer({ host: "127.0.0.1", port });
  const drivers = new Set(); // live drivers: authenticated sockets that send commands but are not the extension
  const accepts = (helloToken) => {
    if (expect === null) {
      // TOFU: first token wins and gets pinned for future bridges.
      pins.save(helloToken);
      console.error(t("bridgePinned", { token: helloToken }));
      return true;
    }
    return helloToken === expect;
  };
  return new Promise((resolve, reject) => {
    wss.on("error", reject);
    wss.on("listening", () => resolve(token));
    wss.on("connection", (socket) => {
      let authenticated = false;
      let role = "extension";
      socket.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!authenticated) {
          if (msg.type === "hello" && typeof msg.token === "string" && accepts(msg.token)) {
            authenticated = true;
            role = msg.role === "driver" ? "driver" : "extension";
            if (role === "extension") {
              ext?.close();
              ext = socket;
              console.error(t("extConnected", { chrome: msg.chrome ?? "?" }));
            } else {
              drivers.add(socket);
            }
            socket.send(JSON.stringify({ type: "ready" }));
          } else {
            socket.close(4001, "invalid token");
          }
          return;
        }
        if (role === "driver" && msg.id && msg.cmd) {
          // Live driver: proxy a single command to the extension.
          request(msg.cmd, msg.args ?? {})
            .then((data) => socket.send(JSON.stringify({ id: msg.id, ok: true, data })))
            .catch((e) => socket.send(JSON.stringify({ id: msg.id, ok: false, error: e.message })));
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
        drivers.delete(socket);
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
