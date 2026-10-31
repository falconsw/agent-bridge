// MCP server: exposes browser tools to agents (Claude Code, Cursor, Codex… anything that speaks MCP).
// Thin layer: read/click/type/navigate/screenshot/eval/done are implemented in the extension
// (background.js); every action replies with the resulting page state, so agents need no extra reads.
// All human-facing strings come from src/i18n.mjs (--lang, default tr).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { request } from "./bridge.mjs";
import { t } from "./i18n.mjs";

const text = (content) => ({ content: [{ type: "text", text: content }] });
const fail = (e) => ({ content: [{ type: "text", text: t("error", { msg: e.message }) }], isError: true });

export async function startMcp({ shotsDir }) {
  const server = new McpServer({ name: "agent-bridge", version: "0.2.2" });

  server.registerTool("tabs", { title: t("titleTabs"), description: t("descTabs"), inputSchema: {} }, async () => {
    try {
      const tabs = await request("tabs");
      return text(tabs.length ? tabs.map((tab) => `[${tab.id}]${tab.active ? " ★" : ""} ${tab.title}\n    ${tab.url}`).join("\n") : t("tabsEmpty"));
    } catch (e) {
      return fail(e);
    }
  });

  const targetArgs = {
    tabId: z.number().optional().describe("Tab id (defaults to the newest agent tab)"),
    selector: z.string().optional().describe("CSS selector"),
    index: z.number().optional().describe("Element index from the read output"),
  };

  server.registerTool("read", {
    title: t("titleRead"),
    description: t("descRead"),
    inputSchema: {
      tabId: z.number().optional().describe("Tab id (defaults to the newest agent tab)"),
      selector: z.string().optional().describe("Read only this element's text (CSS selector)"),
      maxChars: z.number().optional().describe("Max text length (default 1500)"),
    },
  }, async (args) => {
    try {
      const data = await request("read", args);
      const elements = (data.elements ?? [])
        .map((o) => `[${o.i}] <${o.tag}${o.type ? " " + o.type : ""}> ${o.label}${o.href ? " → " + o.href : ""}`)
        .join("\n");
      return text(`# ${data.title}\n${data.url}\n\n${data.text}\n\n${t("clickable")}\n${elements}`);
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("click", {
    title: t("titleClick"),
    description: t("descClick"),
    inputSchema: { ...targetArgs, text: z.string().optional().describe("Click the first visible element containing this text") },
  }, async (args) => {
    try {
      // The extension replies with the post-action state (title, url, elements) in the same call.
      return text(JSON.stringify(await request("click", args)));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("type", {
    title: t("titleType"),
    description: t("descType"),
    inputSchema: {
      ...targetArgs,
      text: z.string().describe("Text to type"),
      clear: z.boolean().optional().describe("Clear the field first (default true)"),
      pressEnter: z.boolean().optional().describe("Press Enter afterwards"),
    },
  }, async (args) => {
    try {
      // Same as click: the reply carries the page state after typing.
      return text(JSON.stringify(await request("type", args)));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("navigate", {
    title: t("titleNavigate"),
    description: t("descNavigate"),
    inputSchema: { url: z.string().url().describe("URL to open"), newTab: z.boolean().optional().describe("Always open a new agent tab") },
  }, async (args) => {
    try {
      return text(JSON.stringify(await request("navigate", args)));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("screenshot", {
    title: t("titleScreenshot"),
    description: t("descScreenshot"),
    inputSchema: {
      tabId: z.number().optional(),
      path: z.string().optional().describe("PNG file path (defaults to the shots folder)"),
    },
  }, async (args) => {
    try {
      const r = await request("screenshot", { tabId: args.tabId }, 60_000);
      const path = args.path || join(shotsDir, `shot-${Date.now()}.png`);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, Buffer.from(r.data, "base64"));
      return { content: [{ type: "image", data: r.data, mimeType: "image/png" }, { type: "text", text: t("saved", { path }) }] };
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("eval", {
    title: t("titleEval"),
    description: t("descEval"),
    inputSchema: { expression: z.string().describe("JavaScript to run"), tabId: z.number().optional() },
  }, async (args) => {
    try {
      const r = await request("eval", args, 60_000);
      return text(typeof r === "string" ? r : JSON.stringify(r));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("done", {
    title: t("titleDone"),
    description: t("descDone"),
    inputSchema: {},
  }, async () => {
    try {
      return text(JSON.stringify(await request("cleanup")));
    } catch (e) {
      return fail(e);
    }
  });

  await server.connect(new StdioServerTransport());
}
