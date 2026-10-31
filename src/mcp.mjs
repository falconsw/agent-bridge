// MCP sunucusu: agent'lara tarayıcı araçları sunar (Claude Code, Cursor, Codex… hepsi MCP konuşur).
// Etkileşimli öğeler indekslenerek verilir; agent indeks ya da seçici ile tıklar/yazar.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { request } from "./bridge.mjs";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const hata = (e) => ({ content: [{ type: "text", text: `Hata: ${e.message}` }], isError: true });

/** Etkileşimli öğeleri indeksleyen sayfa betiği; read/click/type aynı sırayı kullanır. */
const ENVANTER = `
  (el) => {
    const gorunur = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
    };
    return [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[contenteditable=true]")]
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => gorunur(e))
      .map(({ e, i }) => ({
        i,
        tag: e.tagName.toLowerCase(),
        metin: (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "").trim().slice(0, 80),
        tip: e.type || "",
        href: e.href ? e.href.slice(0, 120) : undefined,
      }));
  }
`;

function topla(args = {}) {
  const { selector, maxChars = 12000 } = args;
  return `(() => {
    const ARGS = ${JSON.stringify({ selector, maxChars })};
    const hedef = ARGS.selector ? document.querySelector(ARGS.selector) : null;
    const envanter = (${ENVANTER})();
    return {
      title: document.title,
      url: location.href,
      metin: (hedef ?? document.body).innerText.slice(0, ARGS.maxChars),
      ogeler: envanter,
    };
  })()`;
}

export async function startMcp({ shotsDir }) {
  const server = new McpServer({ name: "agent-bridge", version: "0.1.0" });

  server.registerTool(
    "tabs",
    { title: "Sekmeleri listele", description: "Chrome'daki açık sekmeleri listeler (id, başlık, adres).", inputSchema: {} },
    async () => {
      try {
        const tabs = await request("tabs");
        return text(tabs.map((t) => `[${t.id}]${t.active ? " ★" : ""} ${t.title}\n    ${t.url}`).join("\n"));
      } catch (e) {
        return hata(e);
      }
    },
  );

  server.registerTool(
    "read",
    {
      title: "Sayfayı oku",
      description: "Sekmenin başlığını, adresini, görünür metnini ve tıklanabilir öğelerini (indeksli) döndürür.",
      inputSchema: {
        tabId: z.number().optional().describe("Sekme kimliği (yoksa etkin sekme)"),
        selector: z.string().optional().describe("Yalnız bu öğenin metnini oku (CSS seçici)"),
        maxChars: z.number().optional().describe("En fazla metin uzunluğu (varsayılan 12000)"),
      },
    },
    async (args) => {
      try {
        const r = await request("eval", { tabId: args.tabId, expression: topla(args) });
        const d = typeof r === "string" ? JSON.parse(r) : r;
        const ogeler = (d.ogeler ?? []).map((o) => `[${o.i}] <${o.tag}${o.tip ? " " + o.tip : ""}> ${o.metin}${o.href ? " → " + o.href : ""}`).join("\n");
        return text(`# ${d.title}\n${d.url}\n\n${d.metin}\n\n## Tıklanabilir öğeler\n${ogeler}`);
      } catch (e) {
        return hata(e);
      }
    },
  );

  const hedefArgümanları = {
    tabId: z.number().optional().describe("Sekme kimliği (yoksa etkin sekme)"),
    selector: z.string().optional().describe("CSS seçici"),
    index: z.number().optional().describe("read aracındaki öğe indeksi"),
  };

  server.registerTool(
    "click",
    {
      title: "Tıkla",
      description: "Öğeye tıklar: CSS seçici ya da read çıktısındaki indeks ile.",
      inputSchema: { ...hedefArgümanları, text: z.string().optional().describe("Bu metni içeren ilk görünür öğeye tıkla") },
    },
    async (args) => {
      try {
        const r = await request("eval", {
          tabId: args.tabId,
          expression: `(() => {
            const ARGS = ${JSON.stringify({ selector: args.selector, index: args.index, text: args.text })};
            const envanter = (${ENVANTER})();
            let el = null;
            if (ARGS.index !== undefined) el = envanter.find(o => o.i === ARGS.index)?.e ?? envanter[ARGS.index]?.e;
            else if (ARGS.selector) el = document.querySelector(ARGS.selector);
            else if (ARGS.text) {
              const t = ARGS.text.toLocaleLowerCase("tr");
              el = envanter.map(o => o.e).find(e => (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || "").toLocaleLowerCase("tr").includes(t));
            }
            if (!el) return { ok: false, hata: "öğe bulunamadı" };
            el.scrollIntoView({ block: "center" });
            el.click();
            return { ok: true, tıklanan: (el.innerText || el.value || el.tagName).slice(0, 60) };
          })()`,
        });
        return text(JSON.stringify(r));
      } catch (e) {
        return hata(e);
      }
    },
  );

  server.registerTool(
    "type",
    {
      title: "Yaz",
      description: "Alana metin yazar; contenteditable dahil. selector/index yoksa odaktaki alana yazar.",
      inputSchema: {
        ...hedefArgümanları,
        text: z.string().describe("Yazılacak metin"),
        clear: z.boolean().optional().describe("Yazmadan önce içeriği temizle (varsayılan true)"),
        pressEnter: z.boolean().optional().describe("Sonra Enter gönder"),
      },
    },
    async (args) => {
      try {
        const r = await request("eval", {
          tabId: args.tabId,
          expression: `(() => {
            const ARGS = ${JSON.stringify({ selector: args.selector, index: args.index, text: args.text, clear: args.clear !== false, pressEnter: !!args.pressEnter })};
            const envanter = (${ENVANTER})();
            let el = null;
            if (ARGS.index !== undefined) el = envanter.find(o => o.i === ARGS.index)?.e ?? envanter[ARGS.index]?.e;
            else if (ARGS.selector) el = document.querySelector(ARGS.selector);
            if (!el) { el = document.activeElement; }
            if (!el) return { ok: false, hata: "alan bulunamadı" };
            el.focus();
            if (el.isContentEditable) {
              if (ARGS.clear) document.execCommand("selectAll", false, null);
              document.execCommand("insertText", false, ARGS.text);
              if (ARGS.pressEnter) document.execCommand("insertLineBreak");
            } else {
              const deger = (ARGS.clear ? "" : el.value) + ARGS.text;
              const tanimli = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
              if (tanimli && tanimli.set) tanimli.set.call(el, deger);
              else el.value = deger;
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
        return hata(e);
      }
    },
  );

  server.registerTool(
    "navigate",
    {
      title: "Sayfa aç",
      description: "Adrese gider: varsayılan etkin sekmede, newTab ile yeni sekmede.",
      inputSchema: { url: z.string().url().describe("Açılacak adres"), newTab: z.boolean().optional() },
    },
    async (args) => {
      try {
        const r = await request("navigate", args);
        return text(JSON.stringify(r));
      } catch (e) {
        return hata(e);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Ekran görüntüsü",
      description: "Sekmenin görüntüsünü PNG dosyasına yazar ve döndürür.",
      inputSchema: {
        tabId: z.number().optional(),
        path: z.string().optional().describe("PNG yolu (yoksa kayıt klasörüne yazar)"),
      },
    },
    async (args) => {
      try {
        const r = await request("screenshot", { tabId: args.tabId }, 60_000);
        const yol = args.path || join(shotsDir, `shot-${Date.now()}.png`);
        await mkdir(join(yol, ".."), { recursive: true });
        await writeFile(yol, Buffer.from(r.data, "base64"));
        return { content: [{ type: "image", data: r.data, mimeType: "image/png" }, { type: "text", text: `Kaydedildi: ${yol}` }] };
      } catch (e) {
        return hata(e);
      }
    },
  );

  server.registerTool(
    "eval",
    {
      title: "JavaScript çalıştır",
      description: "Sekmede rastgele JavaScript çalıştırır (sonucu JSON döndürün). Güçlü ve riskli: yalnız gerektiğinde.",
      inputSchema: { expression: z.string().describe("Çalıştırılacak JS"), tabId: z.number().optional() },
    },
    async (args) => {
      try {
        const r = await request("eval", args, 60_000);
        return text(typeof r === "string" ? r : JSON.stringify(r));
      } catch (e) {
        return hata(e);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
