// End-to-end MCP test against the fake extension (run test/fake-extension.mjs first).
// Starts TWO bridges on the same port: the first becomes primary, the second must join as a driver.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const start = async (name) => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["bin/agent-bridge.mjs", "--port", "8799", "--token", "TEST-TOKEN", "--shots", "test/shots", "--lang", "en"],
    stderr: "pipe",
  });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  return client;
};

const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const body = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `<${c.type} ${c.mimeType}>`)).join("\n");
  console.log(`\n— ${name} → ${r.isError ? "ERROR" : "ok"}\n${body.slice(0, 300)}`);
  if (r.isError) process.exitCode = 1;
};

const primary = await start("primary");
const tools = await primary.listTools();
const schemaChars = JSON.stringify(tools.tools).length;
console.log(`tools (${tools.tools.length}, ~${Math.round(schemaChars / 4)} tokens of schema):`, tools.tools.map((t) => t.name).join(", "));

await call(primary, "navigate", { url: "https://example.com/" });
await call(primary, "find", { query: "more" });
await call(primary, "click", { ref: 2 });
await call(primary, "screenshot", {});

const second = await start("second"); // same port → driver mode
await call(second, "read", {});
await primary.close(); // primary exits; the driver must take over the port
await new Promise((y) => setTimeout(y, 2500));
await call(second, "read", {});
await second.close();
console.log(`\n[test] ${process.exitCode ? "FAILED" : "passed"}`);
