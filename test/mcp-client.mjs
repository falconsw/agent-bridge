// MCP istemcisiyle uçtan uca test: sunucuyu stdio'da başlat, araçları listele, çağır.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["bin/agent-bridge.mjs", "--port", "8799", "--token", "TEST-TOKEN", "--shots", "test/shots"],
});
const client = new Client({ name: "test", version: "0.0.1" });
await client.connect(transport);

const araclar = await client.listTools();
console.log("araçlar:", araclar.tools.map((t) => t.name).join(", "));

const cagir = async (ad, args, bekle = false) => {
  // bekle=true ise eklenti bağlanana kadar yeniden dener (ilk çağrı öncesi yarış olmasın)
  let r;
  for (let deneme = 0; deneme < (bekle ? 20 : 1); deneme++) {
    r = await client.callTool({ name: ad, arguments: args });
    if (!r.isError) break;
    await new Promise((y) => setTimeout(y, 250));
  }
  const metin = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n— ${ad} → ${r.isError ? "HATA" : "ok"}\n${metin.slice(0, 500)}`);
};

await cagir("tabs", {}, true); // eklentinin bağlanmasını bekle
await cagir("read", { tabId: 1 });
await cagir("click", { index: 0, tabId: 1 });
await cagir("screenshot", { tabId: 1 });
await client.close();
console.log("\n[test] tamam");
