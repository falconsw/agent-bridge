// Tiny i18n: every user-facing string lives here in Turkish and English.
// The Node side picks the language with --lang (default tr); the extension has
// its own copy of the same keys (extension/i18n.js) chosen in the popup.
const dicts = {
  tr: {
    help: `agent-bridge — agent'lara Chrome'da işlem yaptıran köprü

Kullanım: agent-bridge [--port 8791] [--token XXXX-XXXX] [--shots <klasör, varsayılan ~/.agent-bridge/shots>] [--lang tr|en] [--fresh]
                     [--allow <alan adları>] [--no-eval]

  --allow    Bu çalıştırmada agent yalnız bu alan adlarında çalışır (virgülle): ads.google.com, *.example.com, github.com/falconsw
             (AGENT_BRIDGE_ALLOW ortam değişkeni de olur). Başka adrese giden sekme durdurulur.
  --no-eval  eval aracını hiç sunma. eval zaten varsayılan kapalıdır: eklentide Gelişmiş > eval'den açılır.

1. Bu komutu çalıştır
2. Chrome'da Agent Bridge eklentisinde "Agent erişimi" anahtarını aç (ilk açılışta otomatik eşleşir)
3. Agent'ına MCP sunucusu olarak ekle:  agent-bridge  (stdio)

Araçlar: navigate, read, find, click, type, fill, select, key, scroll, hover, upload, wait, screenshot, console, network, eval, tabs, done`,
    bridgeListening: "[bridge] ws://127.0.0.1:{port} dinleniyor",
    bridgeToken: "[bridge] Token: {token}",
    bridgeHowTo: "[bridge] Chrome'da Agent Bridge eklentisinde \"Agent erişimi\" anahtarını aç, gerisi otomatik.",
    bridgeAllow: "[bridge] Bu çalıştırma yalnız şu alan adlarında: {allow}",
    bridgePairMode: "[bridge] Eşleşme modu: ilk bağlanan eklenti otomatik tanınır (TOFU).",
    bridgePinned: "[bridge] Eşleşildi / paired — Token: {token}",
    pinRejected: "[bridge] Farklı bir token reddedildi; sıfırlamak için --fresh ile başlat / different token rejected; start with --fresh to re-pin",
    extConnected: "[bridge] Eklenti bağlandı (Chrome {chrome})",
    extDisconnected: "[bridge] Eklenti bağlantısı kesildi",
    extNotConnected: "Eklenti bağlı değil. Chrome'da Agent Bridge popup'ını açıp Bağlan'a bas (token'lar eşleşmeli).",
    timeout: '"{cmd}" zaman aşımına uğradı ({sn} sn)',
    extError: "eklenti hatası",
    error: "Hata: {msg}",
    blockedUrl: "Engellenen adres kalıbına çarptı / blocked URL pattern: {url}",
    tabsEmpty: "(açık agent sekmesi yok — navigate ile bir sekme aç)",
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
    title_tabs: "Agent sekmeleri",
    title_navigate: "Sayfa aç",
    title_read: "Sayfayı oku",
    title_find: "Sayfada bul",
    title_click: "Tıkla",
    title_hover: "Üzerine gel",
    title_type: "Yaz",
    title_fill: "Formu doldur",
    title_select: "Seçenek seç",
    title_key: "Tuşa bas",
    title_scroll: "Kaydır",
    title_upload: "Dosya yükle",
    title_wait: "Bekle",
    title_console: "Konsol",
    title_network: "Ağ istekleri",
    title_eval: "JavaScript çalıştır",
    title_screenshot: "Ekran görüntüsü",
    title_done: "İş bitti",
    driverNoPin: "köprü zaten çalışıyor ama eşleşme yok: önce eklentide \"Agent erişimi\"ni aç",
    driverJoined: "[bridge] Çalışan köprüye katıldı (port {port}) — birden çok agent aynı tarayıcıyı paylaşıyor",
    bridgeRestarted: "köprü yeniden başladı; komutu tekrar dene",
  },
  en: {
    help: `agent-bridge — lets terminal agents operate Chrome

Usage: agent-bridge [--port 8791] [--token XXXX-XXXX] [--shots <folder>] [--lang tr|en] [--fresh]
                     [--allow <domains>] [--no-eval]

  --allow    Limit this run to these domains (comma separated): ads.google.com, *.example.com, github.com/falconsw
             (or the AGENT_BRIDGE_ALLOW environment variable). A tab that goes anywhere else is stopped.
  --no-eval  Do not offer the eval tool at all. eval is off by default: turn it on in the extension (Advanced > eval).

1. Run this command
2. In the Chrome extension, flip "Agent access" on (the first connection pairs automatically)
3. Add it to your agent as an MCP server:  agent-bridge  (stdio)

Tools: navigate, read, find, click, type, fill, select, key, scroll, hover, upload, wait, screenshot, console, network, eval, tabs, done`,
    bridgeListening: "[bridge] ws://127.0.0.1:{port} listening",
    bridgeToken: "[bridge] Token: {token}",
    bridgeHowTo: "[bridge] Flip \"Agent access\" on in the Chrome extension; the rest is automatic.",
    bridgeAllow: "[bridge] This run is limited to: {allow}",
    bridgePairMode: "[bridge] Pairing mode: the first extension that connects is trusted automatically (TOFU).",
    bridgePinned: "[bridge] Paired — Token: {token}",
    pinRejected: "[bridge] Different token rejected; start with --fresh to re-pin",
    extConnected: "[bridge] Extension connected (Chrome {chrome})",
    extDisconnected: "[bridge] Extension disconnected",
    extNotConnected: "Chrome extension is not connected. Open the Agent Bridge popup in Chrome and press Connect (tokens must match).",
    timeout: '"{cmd}" timed out ({sn} s)',
    extError: "extension error",
    error: "Error: {msg}",
    blockedUrl: "hit a blocked URL pattern: {url}",
    tabsEmpty: "(no open agent tab — use navigate to open one)",
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
    title_tabs: "Agent tabs",
    title_navigate: "Navigate",
    title_read: "Read page",
    title_find: "Find on page",
    title_click: "Click",
    title_hover: "Hover",
    title_type: "Type",
    title_fill: "Fill form",
    title_select: "Select option",
    title_key: "Press keys",
    title_scroll: "Scroll",
    title_upload: "Upload files",
    title_wait: "Wait",
    title_console: "Console",
    title_network: "Network requests",
    title_eval: "Run JavaScript",
    title_screenshot: "Screenshot",
    title_done: "Finish work",
    driverNoPin: "a bridge is already running but nothing is paired yet: flip \"Agent access\" on in the extension first",
    driverJoined: "[bridge] Joined the running bridge (port {port}) — several agents share the browser",
    bridgeRestarted: "bridge restarted; retry the command",
    // Model-facing text is English only (fewer tokens than Turkish); the tr dict falls back to it.
    instructions: `Drives the user's real Chrome (their logged-in sessions) in agent-owned tabs.
Token-efficient workflow:
- navigate already returns the page snapshot; do not call read right after it.
- Snapshot lines: role "label" rN [state]. Act with ref=N. Refs stay valid until the page changes.
- click/type/fill/select/key/hover/upload reply with only what changed (new elements or the new page). Do not read after them unless the reply says nothing changed and you need content.
- To locate something specific use find (cheap) instead of read. For long content use read mode:"all" with selector/ref or viewport:true.
- Use screenshot only for visual questions (charts, layout, images); it costs far more than text.
- Forms: fill (several fields in one call). Posting media: upload into the file input, then click.
- If a reply says "covered by …", close the overlay (key "Escape" or click its button) and retry.
- A field shown as "filled" holds a value you did not type (autofill, remembered account): it is the user's, you cannot read it. Do not try to get it another way; type over it only if the task gives you the value.
- You never sign in: when a reply says a sign-in is left to the user, stop and ask them to log in in the agent tab, then continue. Ticking consent boxes (terms, privacy policy) waits for the user's approval in the browser; if it is not approved, stop and tell the user instead of trying another way.
- Call done only when the user's whole task is finished (it closes the tabs).`,
    instructionsAllow: "- This run is limited by the user to these domains: {allow}. Other sites are refused; you cannot change the list, so tell the user if the task needs another one.",
    desc_tabs: "List agent tabs; switchTo makes one the default target, close closes one.",
    desc_navigate: 'Open a URL (or "back"/"forward"/"reload") in the agent tab, wait for load, return the page snapshot.',
    desc_read: "Snapshot: interactive elements with refs, headings, table rows (mode all adds all text, in order). Scope with ref/selector/viewport.",
    desc_find: "Find text in labels/page text; returns matching lines with refs (and link URLs). Cheaper than read.",
    desc_click: "Real mouse click on ref/selector/label; waits for the page to settle and returns what changed.",
    desc_hover: "Move the mouse over an element (menus, tooltips); returns what appeared.",
    desc_type: "Type into a field (real keyboard input; replaces content unless clear:false); submit presses Enter. Returns what changed.",
    desc_fill: "Fill a whole form in one call: text fields, select options, checkboxes/radios (true/false). Returns what changed.",
    desc_select: "Choose an option of a native <select> by value or text.",
    desc_key: 'Press keys/shortcuts: "Enter", "Escape", "Tab", "ArrowDown", "ctrl+a"… Returns what changed.',
    desc_scroll: "Scroll the page (or bring ref into view); returns the on-screen snapshot.",
    desc_upload: "Set local files on an <input type=file> (photo/video for a post, attachments).",
    desc_wait: "Wait until text/selector appears (or disappears with gone), or just wait timeout ms.",
    desc_console: "Recent console messages and exceptions of the agent tab.",
    desc_network: "Recent network requests (status, method, URL); apiOnly for XHR/fetch.",
    desc_eval: "Run JavaScript in the agent tab and return the JSON value. Last resort for data the snapshot misses.",
    desc_screenshot: "JPEG of the visible viewport. Expensive: only for visual questions.",
    desc_done: "Close all agent tabs and go idle. Only when the user's whole task is finished.",
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
