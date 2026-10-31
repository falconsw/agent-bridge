// Live use: calls a single tool on the real, connected Chrome.
// Usage: node test/live.mjs <tool> '<JSON args>'
// Example:  node test/live.mjs tabs
//           node test/live.mjs read '{"maxChars":3000}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [tool, args] = process.argv.slice(2);
if (!tool) {
  console.log("usage: node test/live.mjs <tabs|read|click|type|navigate|screenshot|eval|done> [JSON]");
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
  // the extension reconnects within ~3s whenever the bridge restarts
  r = await client.callTool({ name: tool, arguments: args ? JSON.parse(args) : {} });
  if (!r.isError) break;
  await new Promise((y) => setTimeout(y, 500));
}
for (const c of r.content ?? []) {
  if (c.type === "text") console.log(c.text);
  if (c.type === "image") console.log(`[image received, ${Math.round((c.data?.length ?? 0) / 1024)} KB base64]`);
}
await client.close();
