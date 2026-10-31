// Sahte eklenti: Chrome olmadan köprüyü uçtan uca test etmek için.
// Gerçek eklentinin yaptığı şeyi yapar: bağlan, hello gönder, komutlara hazır yanıt ver.
import WebSocket from "ws";

const [, , portArg, tokenArg] = process.argv;
const port = Number(portArg) || 8799;
const token = tokenArg || "TEST-TOKEN";
const KUCUK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let zamanlayici;
const baglan = () => {
  clearTimeout(zamanlayici);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("open", () => {
    console.log(`[sahte-eklenti] bağlandı (port ${port})`);
    ws.send(JSON.stringify({ type: "hello", token, chrome: "fake" }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "ready") return;
    const yanit = (ok, data) => ws.send(JSON.stringify({ id: msg.id, ok, ...(ok ? { data } : { error: data }) }));
    switch (msg.cmd) {
      case "tabs":
        return yanit(true, [{ id: 1, title: "Örnek Sayfa", url: "https://example.com/", active: true }]);
      case "eval": {
        const d = msg.args.expression;
        if (d.includes("ogeler: envanter"))
          return yanit(true, { title: "Örnek Sayfa", url: "https://example.com/", metin: "Merhaba dünya. Bu bir test sayfasıdır.", ogeler: [{ i: 0, tag: "a", metin: "More information...", tip: "", href: "https://www.iana.org/domains/example" }] });
        if (d.includes(".click()"))
          return yanit(true, { ok: true, tıklanan: "More information..." });
        if (d.includes("insertText"))
          return yanit(true, { ok: true });
        return yanit(true, { ok: true });
      }
      case "navigate":
        return yanit(true, { tabId: 1, url: msg.args.url });
      case "screenshot":
        return yanit(true, { data: KUCUK_PNG });
      case "ping":
        return yanit(true, { pong: true });
      default:
        return yanit(false, `sahte eklenti bu komutu bilmiyor: ${msg.cmd}`);
    }
  });
  ws.on("close", () => {
    zamanlayici = setTimeout(baglan, 1000);
  });
  ws.on("error", () => ws.terminate());
};
baglan();
