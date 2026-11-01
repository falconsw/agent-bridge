// MCP server: exposes browser tools to agents (Claude Code, Cursor, Codex… anything that speaks MCP).
// Thin layer: the work happens in the extension (background.js + page.js), which already replies
// with compact text: actions report only what changed, navigate returns the new page's snapshot.
// All human-facing strings come from src/i18n.mjs (--lang, default tr).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { request, setAgent } from "./bridge.mjs";
import { t } from "./i18n.mjs";

const text = (content) => ({ content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }] });
const fail = (e) => ({ content: [{ type: "text", text: t("error", { msg: e.message }) }], isError: true });

const tabId = z.number().optional().describe("Agent tab id (default: newest agent tab)");
const targetArgs = {
  ref: z.number().optional().describe("Element ref N from a snapshot (rN)"),
  selector: z.string().optional().describe("CSS selector"),
  text: z.string().optional().describe("Visible label of the element"),
  tabId,
};

// MCP clients identify themselves in `initialize` (clientInfo.name); the model name is not part of it.
const CLIENT_NAMES = [
  [/claude-code/i, "Claude Code"],
  [/claude-ai|claude desktop/i, "Claude Desktop"],
  [/cursor/i, "Cursor"],
  [/codex/i, "Codex"],
  [/opencode/i, "OpenCode"],
  [/antigravity/i, "Antigravity"],
  [/windsurf|codeium/i, "Windsurf"],
  [/copilot|visual studio code|vscode/i, "VS Code"],
  [/zed/i, "Zed"],
];
const prettyClient = (name = "") => CLIENT_NAMES.find(([re]) => re.test(name))?.[1] ?? name;

export async function startMcp({ shotsDir }) {
  const server = new McpServer({ name: "agent-bridge", version: "0.5.2" }, { instructions: t("instructions") });

  /** Registers a tool that forwards its arguments to one extension command. */
  const tool = (name, inputSchema, { cmd = name, timeout = 30_000 } = {}) =>
    server.registerTool(name, { title: t(`title_${name}`), description: t(`desc_${name}`), inputSchema }, async (args) => {
      try {
        return text(await request(cmd, args, timeout));
      } catch (e) {
        return fail(e);
      }
    });

  server.registerTool("tabs", {
    title: t("title_tabs"),
    description: t("desc_tabs"),
    inputSchema: {
      switchTo: z.number().optional().describe("Make this tab the default target"),
      close: z.number().optional().describe("Close this agent tab"),
    },
  }, async (args) => {
    try {
      const tabs = await request("tabs", args);
      return text(tabs.length ? tabs.map((tab) => `[${tab.id}]${tab.active ? " ★" : ""} ${tab.title}\n    ${tab.url}`).join("\n") : t("tabsEmpty"));
    } catch (e) {
      return fail(e);
    }
  });

  tool("navigate", {
    url: z.string().describe('URL to open, or "back" / "forward" / "reload"'),
    newTab: z.boolean().optional().describe("Open in a new agent tab"),
    max: z.number().optional().describe("Max snapshot lines (default 80)"),
    tabId,
  }, { timeout: 45_000 });

  tool("read", {
    mode: z.enum(["interactive", "all"]).optional().describe("interactive (default): controls + headings · all: also page text, in order"),
    viewport: z.boolean().optional().describe("Only what is on screen now"),
    ref: z.number().optional().describe("Only inside this element"),
    selector: z.string().optional().describe("Only inside this CSS selector"),
    max: z.number().optional().describe("Max lines (default 150 / 250 for all)"),
    tabId,
  });

  tool("find", {
    query: z.string().describe("Text to look for (case-insensitive) in labels and page text"),
    max: z.number().optional().describe("Max matches (default 20)"),
    tabId,
  });

  tool("click", {
    ...targetArgs,
    double: z.boolean().optional().describe("Double click"),
    button: z.enum(["left", "right", "middle"]).optional(),
  });

  tool("hover", targetArgs);

  tool("type", {
    ...targetArgs,
    text: z.string().describe("Text to type"),
    clear: z.boolean().optional().describe("Replace the current content (default true)"),
    submit: z.boolean().optional().describe("Press Enter afterwards"),
  });

  tool("fill", {
    fields: z.array(z.object({
      ref: z.number().optional(),
      selector: z.string().optional(),
      label: z.string().optional().describe("Visible label instead of ref"),
      value: z.union([z.string(), z.boolean()]).describe("Text, option for a select, or true/false for a checkbox/radio"),
    })).describe("Fields to fill in order"),
    submit: z.boolean().optional().describe("Press Enter after the last field"),
    tabId,
  }, { timeout: 60_000 });

  tool("select", { ...targetArgs, value: z.string().describe("Option value or visible text") });

  tool("key", {
    keys: z.string().describe('Keys separated by spaces, e.g. "Escape", "Tab Tab Enter", "ctrl+a", "cmd+v"'),
    repeat: z.number().optional(),
    tabId,
  });

  tool("scroll", {
    direction: z.enum(["down", "up"]).optional(),
    amount: z.number().optional().describe("Screens to scroll (default 1)"),
    ref: z.number().optional().describe("Scroll this element into view (or scroll inside it with amount)"),
    selector: z.string().optional(),
    max: z.number().optional().describe("Max lines of the on-screen snapshot (default 60)"),
    tabId,
  });

  tool("upload", {
    ref: z.number().optional().describe("ref of the <input type=file> (shown as file \"…\" rN)"),
    selector: z.string().optional().describe("CSS selector of the file input, e.g. input[type=file]"),
    paths: z.array(z.string()).describe("Absolute local file paths"),
    tabId,
  }, { timeout: 60_000 });

  tool("wait", {
    text: z.string().optional().describe("Wait until this text appears"),
    selector: z.string().optional().describe("Wait until this selector matches"),
    gone: z.boolean().optional().describe("Wait until it disappears instead"),
    timeout: z.number().optional().describe("ms (default 10000, max 60000)"),
    tabId,
  }, { timeout: 70_000 });

  tool("console", {
    errorsOnly: z.boolean().optional(),
    pattern: z.string().optional().describe("Regex filter"),
    limit: z.number().optional().describe("Last N (default 30)"),
    clear: z.boolean().optional(),
    tabId,
  });

  tool("network", {
    apiOnly: z.boolean().optional().describe("Only XHR/fetch requests"),
    pattern: z.string().optional().describe("Regex on URL"),
    limit: z.number().optional().describe("Last N (default 30)"),
    clear: z.boolean().optional(),
    tabId,
  });

  tool("eval", { expression: z.string().describe("JavaScript expression; use an async IIFE for statements"), tabId }, { timeout: 60_000 });

  server.registerTool("screenshot", {
    title: t("title_screenshot"),
    description: t("desc_screenshot"),
    inputSchema: {
      tabId,
      path: z.string().optional().describe("Where to save the JPEG (default: shots folder)"),
    },
  }, async (args) => {
    try {
      const r = await request("screenshot", { tabId: args.tabId }, 60_000);
      const path = resolve(args.path || join(shotsDir, `shot-${Date.now()}.jpg`));
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, Buffer.from(r.data, "base64"));
      return { content: [{ type: "image", data: r.data, mimeType: r.mimeType ?? "image/png" }, { type: "text", text: t("saved", { path }) }] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("done", { title: t("title_done"), description: t("desc_done"), inputSchema: {} }, async () => {
    try {
      return text(await request("cleanup"));
    } catch (e) {
      return fail(e);
    }
  });

  const agentId = randomUUID().slice(0, 8);
  setAgent({ id: agentId });
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    setAgent({ id: agentId, name: prettyClient(client?.name), version: client?.version });
  };
  await server.connect(new StdioServerTransport());
}
