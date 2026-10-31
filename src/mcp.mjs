// MCP server: exposes browser tools to agents (Claude Code, Cursor, Codex… anything that speaks MCP).
// Interactive elements are listed with indices; agents click/type by index or selector.
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

/** Page script that indexes interactive elements; read/click/type share the same order. */
const INVENTORY = `
  () => {
    const visible = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    };
    return [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[contenteditable=true]")]
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => visible(e))
      .map(({ e, i }) => ({
        i,
        tag: e.tagName.toLowerCase(),
        label: (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "").trim().slice(0, 80),
        type: e.type || "",
        href: e.href ? e.href.slice(0, 120) : undefined,
      }));
  }
`;

const readScript = (args = {}) => {
  const { selector, maxChars = 12000 } = args;
  return `(() => {
    const ARGS = ${JSON.stringify({ selector, maxChars })};
    const target = ARGS.selector ? document.querySelector(ARGS.selector) : null;
    const elements = (${INVENTORY})();
    return {
      title: document.title,
      url: location.href,
      text: (target ?? document.body).innerText.slice(0, ARGS.maxChars),
      elements,
    };
  })()`;
};

export async function startMcp({ shotsDir }) {
  const server = new McpServer({ name: "agent-bridge", version: "0.2.1" });

  server.registerTool("tabs", { title: t("titleTabs"), description: t("descTabs"), inputSchema: {} }, async () => {
    try {
      const tabs = await request("tabs");
      return text(tabs.length ? tabs.map((tab) => `[${tab.id}]${tab.active ? " ★" : ""} ${tab.title}\n    ${tab.url}`).join("\n") : t("tabsEmpty"));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("read", {
    title: t("titleRead"),
    description: t("descRead"),
    inputSchema: {
      tabId: z.number().optional().describe("Tab id (defaults to the newest agent tab)"),
      selector: z.string().optional().describe("Read only this element's text (CSS selector)"),
      maxChars: z.number().optional().describe("Max text length (default 12000)"),
    },
  }, async (args) => {
    try {
      const r = await request("eval", { tabId: args.tabId, expression: readScript(args) });
      const data = typeof r === "string" ? JSON.parse(r) : r;
      const elements = (data.elements ?? [])
        .map((o) => `[${o.i}] <${o.tag}${o.type ? " " + o.type : ""}> ${o.label}${o.href ? " → " + o.href : ""}`)
        .join("\n");
      return text(`# ${data.title}\n${data.url}\n\n${data.text}\n\n${t("clickable")}\n${elements}`);
    } catch (e) {
      return fail(e);
    }
  });

  const targetArgs = {
    tabId: z.number().optional().describe("Tab id (defaults to the newest agent tab)"),
    selector: z.string().optional().describe("CSS selector"),
    index: z.number().optional().describe("Element index from the read output"),
  };

  server.registerTool("click", {
    title: t("titleClick"),
    description: t("descClick"),
    inputSchema: { ...targetArgs, text: z.string().optional().describe("Click the first visible element containing this text") },
  }, async (args) => {
    try {
      const r = await request("eval", {
        tabId: args.tabId,
        expression: `(() => {
          const ARGS = ${JSON.stringify({ selector: args.selector, index: args.index, text: args.text, notFound: t("elementNotFound") })};
          const elements = (${INVENTORY})();
          let el = null;
          if (ARGS.index !== undefined) el = elements.find(o => o.i === ARGS.index)?.e ?? elements[ARGS.index]?.e;
          else if (ARGS.selector) el = document.querySelector(ARGS.selector);
          else if (ARGS.text) {
            const needle = ARGS.text.toLocaleLowerCase();
            el = elements.map(o => o.e).find(e => (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "").toLocaleLowerCase().includes(needle));
          }
          if (!el) return { ok: false, error: ARGS.notFound };
          el.scrollIntoView({ block: "center" });
          el.click();
          return { ok: true, clicked: (el.innerText || el.value || el.tagName).slice(0, 60) };
        })()`,
      });
      return text(JSON.stringify(r));
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
      const r = await request("eval", {
        tabId: args.tabId,
        expression: `(() => {
          const ARGS = ${JSON.stringify({ selector: args.selector, index: args.index, text: args.text, clear: args.clear !== false, pressEnter: !!args.pressEnter, notFound: t("noFieldFound") })};
          const elements = (${INVENTORY})();
          let el = null;
          if (ARGS.index !== undefined) el = elements.find(o => o.i === ARGS.index)?.e ?? elements[ARGS.index]?.e;
          else if (ARGS.selector) el = document.querySelector(ARGS.selector);
          if (!el) { el = document.activeElement; }
          if (!el) return { ok: false, error: ARGS.notFound };
          el.focus();
          if (el.isContentEditable) {
            if (ARGS.clear) document.execCommand("selectAll", false, null);
            document.execCommand("insertText", false, ARGS.text);
            if (ARGS.pressEnter) document.execCommand("insertLineBreak");
          } else {
            const value = (ARGS.clear ? "" : el.value) + ARGS.text;
            const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
            if (descriptor && descriptor.set) descriptor.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            if (ARGS.pressEnter) {
              el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
              el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
            }
          }
          return { ok: true };
        })()`,
      });
      return text(JSON.stringify(r));
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
