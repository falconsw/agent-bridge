// Local bridge: WebSocket server the Chrome extension connects to.
// Binds to 127.0.0.1 only. Pairing is trust-on-first-use: the first extension
// token that connects is pinned to a file, and later bridges accept only it.
// A fixed --token skips TOFU and requires exact matches instead.
//
// Several agents at once: the first bridge process owns the port ("primary"); every later
// one (another Claude Code / Cursor / Codex session) joins it as a "driver" instead of
// crashing on EADDRINUSE. If the primary exits, a driver takes the port over.
import WebSocket, { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n.mjs";

/** Requests in flight: id → { resolve, reject, timer } */
const pending = new Map();
let ext = null; // primary: connected extension socket (a new one replaces it)
let upstream = null; // driver: socket to the primary bridge
let settings = null;
let mode = null; // "primary" | "driver"

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

function settle(msg) {
  const waiting = pending.get(msg.id);
  if (!waiting) return;
  pending.delete(msg.id);
  clearTimeout(waiting.timer);
  if (msg.ok) waiting.resolve(msg.data);
  else waiting.reject(new Error(msg.error || t("extError")));
}

function listen() {
  const { port, fixed, pins } = settings;
  let expect = fixed ?? pins.load(); // fixed --token wins; otherwise TOFU
  const token = expect ?? makeToken();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  const accepts = (helloToken, role) => {
    if (expect === null) {
      // TOFU applies to the extension only; drivers must present the pinned token.
      if (role !== "extension") return false;
      pins.save(helloToken);
      expect = helloToken;
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
          const helloRole = msg.role === "driver" ? "driver" : "extension";
          if (msg.type === "hello" && typeof msg.token === "string" && accepts(msg.token, helloRole)) {
            authenticated = true;
            role = helloRole;
            if (role === "extension") {
              ext?.close();
              ext = socket;
              console.error(t("extConnected", { chrome: msg.chrome ?? "?" }));
            }
            socket.send(JSON.stringify({ type: "ready" }));
          } else {
            socket.close(4001, "invalid token");
          }
          return;
        }
        if (role === "driver" && msg.id && msg.cmd) {
          // Driver: proxy a single command to the extension.
          request(msg.cmd, msg.args ?? {}, msg.timeout)
            .then((data) => socket.send(JSON.stringify({ id: msg.id, ok: true, data })))
            .catch((e) => socket.send(JSON.stringify({ id: msg.id, ok: false, error: e.message })));
          return;
        }
        // Reply to a request: { id, ok, data } | { id, ok: false, error }
        if (role === "extension") settle(msg);
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

/** Joins an already running bridge as a driver; resolves once it accepted our token. */
function join_() {
  const { port, fixed, pins } = settings;
  const token = fixed ?? pins.load();
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error(t("driverNoPin")));
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", token, role: "driver" })));
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "ready") {
        upstream = socket;
        console.error(t("driverJoined", { port }));
        return resolve(token);
      }
      settle(msg);
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (upstream !== socket) return reject(new Error("invalid token"));
      upstream = null;
      for (const [id, waiting] of pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(t("bridgeRestarted")));
        pending.delete(id);
      }
      // The primary went away: take the port over (or join whoever did).
      setTimeout(() => connectBridge().catch(() => {}), 300 + Math.random() * 400);
    });
  });
}

/** Becomes the primary if the port is free, otherwise joins the running primary. */
async function connectBridge() {
  try {
    const token = await listen();
    mode = "primary";
    return { token, mode };
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    const token = await join_();
    mode = "driver";
    return { token, mode };
  }
}

export function startBridge({ port = 8791, token: fixed, pinFile = join(homedir(), ".agent-bridge", "token.json") } = {}) {
  settings = { port, fixed, pins: makePinStore(pinFile) };
  return connectBridge();
}

/** Sends a command to the extension (directly or via the primary bridge); times out. */
export async function request(cmd, args = {}, timeoutMs = 30_000) {
  if (mode === "driver" && !upstream) await connectBridge().catch(() => {}); // lazy recovery
  // The extension reconnects within a few seconds after a bridge (re)start: give it that time.
  for (let waited = 0; !(ext ?? upstream) && waited < 4000; waited += 200) await new Promise((y) => setTimeout(y, 200));
  const target = ext ?? upstream;
  if (!target || target.readyState !== 1) {
    return Promise.reject(new Error(t("extNotConnected")));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(t("timeout", { cmd, sn: timeoutMs / 1000 })));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    target.send(JSON.stringify({ id, cmd, args, timeout: timeoutMs }));
  });
}
