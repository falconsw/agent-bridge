// Fake extension: exercises the bridge end to end without Chrome.
// Mimics the real extension: connect, send hello, answer commands with canned data.
import WebSocket from "ws";

const [, , portArg, tokenArg] = process.argv;
const port = Number(portArg) || 8799;
const token = tokenArg || "TEST-TOKEN";
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let timer;
const connect = () => {
  clearTimeout(timer);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("open", () => {
    console.log(`[fake-extension] connected (port ${port})`);
    ws.send(JSON.stringify({ type: "hello", token, chrome: "fake" }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "ready") return;
    const reply = (ok, data) => ws.send(JSON.stringify({ id: msg.id, ok, ...(ok ? { data } : { error: data }) }));
    switch (msg.cmd) {
      case "tabs":
        return reply(true, [{ id: 1, title: "Example Page", url: "https://example.com/", active: true }]);
      case "read":
        return reply(true, {
          title: "Example Page",
          url: "https://example.com/",
          text: "Hello world. This is a test page.",
          elements: [{ i: 0, tag: "a", label: "More information...", type: "", href: "https://www.iana.org/domains/example" }],
        });
      case "click":
        return reply(true, { ok: true, clicked: "More information...", title: "Example Page", url: "https://example.com/", elements: [] });
      case "type":
        return reply(true, { ok: true, title: "Example Page", url: "https://example.com/", elements: [] });
      case "navigate":
        return reply(true, { tabId: 1, url: msg.args.url });
      case "screenshot":
        return reply(true, { data: TINY_PNG });
      case "cleanup":
        return reply(true, { closed: true, mode: "idle" });
      case "ping":
        return reply(true, { pong: true });
      default:
        return reply(false, `fake extension does not know this command: ${msg.cmd}`);
    }
  });
  ws.on("close", () => {
    timer = setTimeout(connect, 1000);
  });
  ws.on("error", () => ws.terminate());
};
connect();
