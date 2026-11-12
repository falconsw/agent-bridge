// End-to-end MCP test against the fake extension (started here; --no-fake when one is already running).
// Starts TWO bridges on the same port: the first becomes primary, the second must join as a driver.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";

const fake = process.argv.includes("--no-fake") ? null : spawn("node", ["test/fake-extension.mjs", "8799", "TEST-TOKEN"], { stdio: "ignore" });
process.on("exit", () => fake?.kill());

const start = async (name, extra = []) => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["bin/agent-bridge.mjs", "--port", "8799", "--token", "TEST-TOKEN", "--shots", "test/shots", "--lang", "en", ...extra],
    stderr: "pipe",
  });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  return client;
};

const call = async (client, name, args, { expectError = false } = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const body = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `<${c.type} ${c.mimeType}>`)).join("\n");
  console.log(`\n— ${name} → ${r.isError ? "ERROR" : "ok"}${expectError ? " (error expected)" : ""}\n${body.slice(0, 300)}`);
  if (!!r.isError !== expectError) process.exitCode = 1;
};

const primary = await start("primary");
const tools = await primary.listTools();
const schemaChars = JSON.stringify(tools.tools).length;
console.log(`tools (${tools.tools.length}, ~${Math.round(schemaChars / 4)} tokens of schema):`, tools.tools.map((t) => t.name).join(", "));

await call(primary, "navigate", { url: "https://example.com/" });
await call(primary, "find", { query: "more" });
await call(primary, "click", { ref: 2 });
await call(primary, "screenshot", {});
await call(primary, "eval", { expression: "1 + 1" }, { expectError: true }); // eval is opt-in: off by default
await call(primary, "navigate", { url: "https://elsewhere.test/" }); // no --allow: every site is open

const second = await start("second"); // same port → driver mode
await call(second, "read", {});
await primary.close(); // primary exits; the driver must take over the port
await new Promise((y) => setTimeout(y, 2500));
await call(second, "read", {});

// A run limited with --allow (joins as a driver: the list must survive the hop through the primary).
const limited = await start("limited", ["--allow", "example.com,*.example.org", "--no-eval"]);
const limitedTools = (await limited.listTools()).tools.map((t) => t.name);
if (limitedTools.includes("eval")) {
  console.log("\n— --no-eval still offers eval");
  process.exitCode = 1;
}
if (!/example\.com, \*\.example\.org/.test(limited.getInstructions() ?? "")) {
  console.log("\n— instructions do not mention the allowed domains");
  process.exitCode = 1;
}
await call(limited, "navigate", { url: "https://example.com/" });
await call(limited, "navigate", { url: "https://app.example.org/x" });
await call(limited, "navigate", { url: "https://elsewhere.test/" }, { expectError: true });
await call(limited, "navigate", { url: "https://example.com.elsewhere.test/" }, { expectError: true });
await call(second, "navigate", { url: "https://elsewhere.test/" }); // the other run stays unlimited
await limited.close();
await second.close();
console.log(`\n[test] ${process.exitCode ? "FAILED" : "passed"}`);
fake?.kill(); // the child would keep this process alive
