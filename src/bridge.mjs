// Yerel köprü: eklenti (WebSocket istemcisi) ile MCP araçları arasındaki mesajlaşma.
// Yalnız 127.0.0.1'e bağlanır; eklenti açılışta token göndermek zorundadır.
import { WebSocketServer } from "ws";
import crypto from "node:crypto";

/** Bekleyen istekler: id → { resolve, reject, timer } */
const pending = new Map();
let wss = null;
let ext = null; // bağlı eklenti soketi (tek eklenti varsayıyoruz; yenisi gelirse eskisini ezer)
let token = "";

export function extStatus() {
  return ext ? "bağlı" : "bağlı değil";
}

function prettyToken() {
  // Karışmaya eğilimli karakterler (0/O, 1/I) olmadan okunur token.
  const alfabe = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const parça = (n) => Array.from(crypto.randomBytes(n), (b) => alfabe[b % alfabe.length]).join("");
  return `${parça(4)}-${parça(4)}`;
}

export function startBridge({ port = 8791, token: sabit } = {}) {
  token = sabit || prettyToken();
  wss = new WebSocketServer({ host: "127.0.0.1", port });
  return new Promise((resolve, reject) => {
    wss.on("error", reject);
    wss.on("listening", () => resolve(token));
    wss.on("connection", (socket) => {
      let dogrulandi = false;
      socket.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!dogrulandi) {
          if (msg.type === "hello" && msg.token === token) {
            dogrulandi = true;
            ext?.close();
            ext = socket;
            console.error(`[köprü] Eklenti bağlandı (Chrome ${msg.chrome ?? "?"})`);
            socket.send(JSON.stringify({ type: "ready" }));
          } else {
            socket.close(4001, "token geçersiz");
          }
          return;
        }
        // İsteğin yanıtı: { id, ok, data } | { id, ok: false, error }
        const bekleyen = pending.get(msg.id);
        if (!bekleyen) return;
        pending.delete(msg.id);
        clearTimeout(bekleyen.timer);
        if (msg.ok) bekleyen.resolve(msg.data);
        else bekleyen.reject(new Error(msg.error || "eklenti hatası"));
      });
      socket.on("close", () => {
        if (ext === socket) {
          ext = null;
          console.error("[köprü] Eklenti bağlantısı kesildi");
        }
      });
    });
  });
}

/** MCP aracından eklentiye komut gönderir; yanıt ya da zaman aşımı. */
export function request(cmd, args = {}, timeoutMs = 30_000) {
  if (!ext || ext.readyState !== 1) {
    return Promise.reject(new Error("Chrome eklentisi bağlı değil. Chrome'da Agent Bridge düğmesine basıp Bağlan'a bak (token eşleşmeli)."));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`"${cmd}" zaman aşımına uğradı (${timeoutMs / 1000} sn)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ext.send(JSON.stringify({ id, cmd, args }));
  });
}
