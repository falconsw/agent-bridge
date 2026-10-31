// Tiny i18n: every user-facing string lives here in Turkish and English.
// The Node side picks the language with --lang (default tr); the extension has
// its own copy of the same keys (extension/i18n.js) chosen in the popup.
const dicts = {
  tr: {
    help: `agent-bridge — agent'lara Chrome'da işlem yaptıran köprü

Kullanım: agent-bridge [--port 8791] [--token XXXX-XXXX] [--shots <klasör>] [--lang tr|en] [--fresh]

1. Bu komutu çalıştır
2. Chrome'da Agent Bridge eklentisinde "Agent erişimi" anahtarını aç (ilk açılışta otomatik eşleşir)
3. Agent'ına MCP sunucusu olarak ekle:  agent-bridge  (stdio)

Araçlar: tabs, read, click, type, navigate, screenshot, eval, done`,
    bridgeListening: "[bridge] ws://127.0.0.1:{port} dinleniyor",
    bridgeToken: "[bridge] Token: {token}",
    bridgeHowTo: "[bridge] Chrome'da Agent Bridge eklentisinde \"Agent erişimi\" anahtarını aç, gerisi otomatik.",
    bridgePairMode: "[bridge] Eşleşme modu: ilk bağlanan eklenti otomatik tanınır (TOFU).",
    bridgePinned: "[bridge] Eşleşildi / paired — Token: {token}",
    pinRejected: "[bridge] Farklı bir token reddedildi; sıfırlamak için --fresh ile başlat / different token rejected; start with --fresh to re-pin",
    extConnected: "[bridge] Eklenti bağlandı (Chrome {chrome})",
    extDisconnected: "[bridge] Eklenti bağlantısı kesildi",
    extNotConnected: "Eklenti bağlı değil. Chrome'da Agent Bridge popup'ını açıp Bağlan'a bas (token'lar eşleşmeli).",
    timeout: '"{cmd}" zaman aşımına uğradı ({sn} sn)',
    extError: "eklenti hatası",
    error: "Hata: {msg}",
    titleTabs: "Agent sekmelerini listele",
    titleRead: "Sayfayı oku",
    titleClick: "Tıkla",
    titleType: "Yaz",
    titleNavigate: "Sayfa aç",
    titleScreenshot: "Ekran görüntüsü",
    titleEval: "JavaScript çalıştır",
    titleDone: "İş bitti",
    descTabs: "Agent'in kendi açtığı sekmeleri listeler; kullanıcının sekmeleri görünmez.",
    descRead: "Agent sekmesinin başlığını, adresini, görünür metnini ve tıklanabilir öğelerini (indeksli) döndürür.",
    descClick: "CSS seçici, read çıktısındaki indeks ya da metinle öğeye tıklar.",
    descType: "Alana metin yazar (contenteditable dahil); selector/index yoksa odaktaki alana yazar.",
    descNavigate: "Agent sekmesinde adrese gider; yeni adres için yeni agent sekmesi açar. Kullanıcının sekmelerine dokunmaz.",
    descScreenshot: "Agent sekmesinin görüntüsünü PNG olarak kaydeder ve döndürür.",
    descEval: "Agent sekmesinde rastgele JavaScript çalıştırır (JSON'a çevrilebilir değer döndürün). Güçlü ve riskli: gerektiğinde kullanın.",
    descDone: "Tüm agent sekmelerini kapatır, debugger'ı ayırır ve bekleme moduna geçer. İş bitince çağırın.",
    tabsEmpty: "(açık agent sekmesi yok — navigate ile bir sekme aç)",
    clickable: "## Tıklanabilir öğeler",
    elementNotFound: "öğe bulunamadı",
    noFieldFound: "alan bulunamadı",
    saved: "Kaydedildi: {path}",
    tabNotOwned: "bu sekme agent'e ait değil; agent yalnız kendi açtığı sekmelerde çalışır",
    noAgentTab: "açık agent sekmesi yok — önce navigate ile bir sekme aç",
    unknownCommand: "bilinmeyen komut: {cmd}",
    pageScriptFailed: "sayfa betiği hata verdi",
    workDone: "agent işi bitirdi",
    noCommand10: "10 dk işlem olmadı",
    idleMode: "bekleme modu",
    tabsClosed: "{n} sekme kapandı",
    connectedLog: "bağlandı",
    idleShort: "boşta",
    agentTabsCount: "{n} agent sekmesi",
  },
  en: {
    help: `agent-bridge — lets terminal agents operate Chrome

Usage: agent-bridge [--port 8791] [--token XXXX-XXXX] [--shots <folder>] [--lang tr|en] [--fresh]

1. Run this command
2. In the Chrome extension, flip "Agent access" on (the first connection pairs automatically)
3. Add it to your agent as an MCP server:  agent-bridge  (stdio)

Tools: tabs, read, click, type, navigate, screenshot, eval, done`,
    bridgeListening: "[bridge] ws://127.0.0.1:{port} listening",
    bridgeToken: "[bridge] Token: {token}",
    bridgeHowTo: "[bridge] Flip \"Agent access\" on in the Chrome extension; the rest is automatic.",
    bridgePairMode: "[bridge] Pairing mode: the first extension that connects is trusted automatically (TOFU).",
    bridgePinned: "[bridge] Paired — Token: {token}",
    pinRejected: "[bridge] Different token rejected; start with --fresh to re-pin",
    extConnected: "[bridge] Extension connected (Chrome {chrome})",
    extDisconnected: "[bridge] Extension disconnected",
    extNotConnected: "Chrome extension is not connected. Open the Agent Bridge popup in Chrome and press Connect (tokens must match).",
    timeout: '"{cmd}" timed out ({sn} s)',
    extError: "extension error",
    error: "Error: {msg}",
    titleTabs: "List agent tabs",
    titleRead: "Read page",
    titleClick: "Click",
    titleType: "Type",
    titleNavigate: "Navigate",
    titleScreenshot: "Screenshot",
    titleEval: "Run JavaScript",
    titleDone: "Finish work",
    descTabs: "Lists the tabs the agent opened itself; the user's own tabs are never visible.",
    descRead: "Returns an agent tab's title, URL, visible text and clickable elements (indexed).",
    descClick: "Clicks an element by CSS selector, by index from the read output, or by text match.",
    descType: "Types text into a field, including contenteditable; with no selector/index, types into the focused element.",
    descNavigate: "Goes to a URL in an agent tab; opens a new agent tab for a fresh address. Never touches the user's own tabs.",
    descScreenshot: "Captures an agent tab as PNG, saves it to a file and returns the image.",
    descEval: "Runs arbitrary JavaScript in an agent tab (return JSON-serializable values). Powerful and risky: use sparingly.",
    descDone: "Closes all agent tabs, detaches the debugger and goes back to idle. Call when the task is complete.",
    tabsEmpty: "(no open agent tab — use navigate to open one)",
    clickable: "## Clickable elements",
    elementNotFound: "element not found",
    noFieldFound: "no field found",
    saved: "Saved: {path}",
    tabNotOwned: "tab does not belong to the agent; it only works in tabs it opened",
    noAgentTab: "no open agent tab — open one with navigate first",
    unknownCommand: "unknown command: {cmd}",
    pageScriptFailed: "page script failed",
    workDone: "agent finished the task",
    noCommand10: "no command for 10 min",
    idleMode: "idle",
    tabsClosed: "{n} tab(s) closed",
    connectedLog: "connected",
    idleShort: "idle",
    agentTabsCount: "{n} agent tab(s)",
  },
};

let current = "tr";

export const setLang = (lang) => {
  if (dicts[lang]) current = lang;
};
export const getLang = () => current;

export function t(key, vars = {}) {
  let text = dicts[current][key] ?? dicts.en[key] ?? key;
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}
