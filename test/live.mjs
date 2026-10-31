// Canlı kullanım: bağlı gerçek Chrome'da tek araç çağırır.
// Kullanım: node test/live.mjs <araç> '<JSON argümanlar>'
// Örnek:    node test/live.mjs tabs
//           node test/live.mjs read '{"maxChars":3000}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [arac, argumanlar] = process.argv.slice(2);
if (!arac) {
  console.log("kullanım: node test/live.mjs <tabs|read|click|type|navigate|screenshot|eval> [JSON]");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["bin/agent-bridge.mjs", "--port", process.env.AB_PORT || "8791", "--token", process.env.AB_TOKEN || "TEST-TOKEN", "--shots", "shots"],
});
const client = new Client({ name: "live", version: "0.0.1" });
await client.connect(transport);

let r;
for (let i = 0; i < 20; i++) {
  // eklenti köprü yeniden başladığında ~3 sn içinde kendini yeniden bağlar
  r = await client.callTool({ name: arac, arguments: argumanlar ? JSON.parse(argumanlar) : {} });
  if (!r.isError) break;
  await new Promise((y) => setTimeout(y, 500));
}
for (const c of r.content ?? []) {
  if (c.type === "text") console.log(c.text);
  if (c.type === "image") console.log(`[görsel alındı, ${Math.round((c.data?.length ?? 0) / 1024)} KB base64]`);
}
await client.close();
