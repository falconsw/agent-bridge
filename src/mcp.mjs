// MCP server: exposes browser tools to agents (Claude Code, Cursor, Codex… anything that speaks MCP).
// Interactive elements are listed with indices; agents click/type by index or selector.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { request } from "./bridge.mjs";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (e) => ({ content: [{ type: "text", text: `Hata / Error: ${e.message}` }], isError: true });

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
  const server = new McpServer({ name: "agent-bridge", version: "0.2.0" });

  server.registerTool(
    "tabs",
    { title: "List agent tabs", description: "Agent'in kendi açtığı sekmeleri listeler / Lists the tabs the agent opened itself (the user's own tabs are never visible).", inputSchema: {} },
    async () => {
      try {
        const tabs = await request("tabs");
        return text(tabs.length ? tabs.map((t) => `[${t.id}]${t.active ? " ★" : ""} ${t.title}\n    ${t.url}`).join("\n") : "(açık agent sekmesi yok / no open agent tab — navigate ile bir sekme aç)");
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read page",
      description: "Agent sekmesinin başlığını, adresini, görünür metnini ve tıklanabilir öğelerini (indeksli) döndürür / Returns an agent tab's title, URL, visible text and clickable elements (indexed).",
      inputSchema: {
        tabId: z.number().optional().describe("Tab id (defaults to the newest agent tab)"),
        selector: z.string().optional().describe("Read only this element's text (CSS selector)"),
        maxChars: z.number().optional().describe("Max text length (default 12000)"),
      },
    },
    async (args) => {
      try {
        const r = await request("eval", { tabId: args.tabId, expression: readScript(args) });
        const d = typeof r === "string" ? JSON.parse(r) : r;
        const elements = (d.elements ?? []).map((o) => `[${o.i}] <${o.tag}${o.type ? " " + o.type : ""}> ${o.label}${o.href ? " → " + o.href : ""}`).join("\n");
        return text(`# ${d.title}\n${d.url}\n\n${d.text}\n\n## Tıklanabilir öğeler / Clickable elements\n${elements}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const targetArgs = {
    tabId: z.number().optional().describe("Tab id (defaults to the newest agent tab)"),
    selector: z.string().optional().describe("CSS selector"),
    index: z.number().optional().describe("Element index from the read output"),
  };

  server.registerTool(
    "click",
    {
      title: "Click",
      description: "CSS seçici, read çıktısındaki indeks ya da metinle öğeye tıklar / Clicks an element: by CSS selector, by index from the read output, or by text match.",
      inputSchema: { ...targetArgs, text: z.string().optional().describe("Click the first visible element containing this text") },
    },
    async (args) => {
      try {
        const r = await request("eval", {
          tabId: args.tabId,
          expression: `(() => {
            const ARGS = ${JSON.stringify({ selector: args.selector, index: args.index, text: args.text })};
            const elements = (${INVENTORY})();
            let el = null;
            if (ARGS.index !== undefined) el = elements.find(o => o.i === ARGS.index)?.e ?? elements[ARGS.index]?.e;
            else if (ARGS.selector) el = document.querySelector(ARGS.selector);
            else if (ARGS.text) {
              const t = ARGS.text.toLocaleLowerCase();
              el = elements.map(o => o.e).find(e => (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "").toLocaleLowerCase().includes(t));
            }
            if (!el) return { ok: false, error: "öğe bulunamadı / element not found" };
            el.scrollIntoView({ block: "center" });
            el.click();
            return { ok: true, clicked: (el.innerText || el.value || el.tagName).slice(0, 60) };
          })()`,
        });
        return text(JSON.stringify(r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "type",
    {
      title: "Type",
      description: "Alana metin yazar (contenteditable dahil); selector/index yoksa odaktaki alana yazar / Types text into a field, including contenteditable. With no selector/index, types into the focused element.",
      inputSchema: {
        ...targetArgs,
        text: z.string().describe("Text to type"),
        clear: z.boolean().optional().describe("Clear the field first (default true)"),
        pressEnter: z.boolean().optional().describe("Press Enter afterwards"),
      },
    },
    async (args) => {
      try {
        const r = await request("eval", {
          tabId: args.tabId,
          expression: `(() => {
            const ARGS = ${JSON.stringify({ selector: args.selector, index: args.index, text: args.text, clear: args.clear !== false, pressEnter: !!args.pressEnter })};
            const elements = (${INVENTORY})();
            let el = null;
            if (ARGS.index !== undefined) el = elements.find(o => o.i === ARGS.index)?.e ?? elements[ARGS.index]?.e;
            else if (ARGS.selector) el = document.querySelector(ARGS.selector);
            if (!el) { el = document.activeElement; }
            if (!el) return { ok: false, error: "alan bulunamadı / no field found" };
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
    },
  );

  server.registerTool(
    "navigate",
    {
      title: "Navigate",
      description: "Agent sekmesinde adrese gider; yeni adres için yeni agent sekmesi açar. Kullanıcının sekmelerine dokunmaz / Goes to a URL in an agent tab; opens a new agent tab for a fresh address. Never touches the user's own tabs.",
      inputSchema: { url: z.string().url().describe("URL to open"), newTab: z.boolean().optional().describe("Always open a new agent tab") },
    },
    async (args) => {
      try {
        const r = await request("navigate", args);
        return text(JSON.stringify(r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description: "Agent sekmesinin görüntüsünü PNG olarak kaydeder ve döndürür / Captures an agent tab as PNG, saves it to a file and returns the image.",
      inputSchema: {
        tabId: z.number().optional(),
        path: z.string().optional().describe("PNG file path (defaults to the shots folder)"),
      },
    },
    async (args) => {
      try {
        const r = await request("screenshot", { tabId: args.tabId }, 60_000);
        const path = args.path || join(shotsDir, `shot-${Date.now()}.png`);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, Buffer.from(r.data, "base64"));
        return { content: [{ type: "image", data: r.data, mimeType: "image/png" }, { type: "text", text: `Kaydedildi / Saved: ${path}` }] };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "eval",
    {
      title: "Run JavaScript",
      description: "Agent sekmesinde rastgele JavaScript çalıştırır (JSON'a çevrilebilir değer döndürün). Güçlü ve riskli: gerektiğinde kullanın / Runs arbitrary JavaScript in an agent tab (return JSON-serializable values). Powerful and risky: use sparingly.",
      inputSchema: { expression: z.string().describe("JavaScript to run"), tabId: z.number().optional() },
    },
    async (args) => {
      try {
        const r = await request("eval", args, 60_000);
        return text(typeof r === "string" ? r : JSON.stringify(r));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "done",
    {
      title: "Finish work",
      description: "Tüm agent sekmelerini kapatır, debugger'ı ayırır ve bekleme moduna geçer. İş bitince çağırın / Closes all agent tabs, detaches the debugger and puts the bridge back into idle mode. Call when the task is complete.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(JSON.stringify(await request("cleanup")));
      } catch (e) {
        return fail(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
