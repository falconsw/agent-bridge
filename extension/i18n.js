// Extension-side strings (Turkish / English). Keep the keys in sync with src/i18n.mjs.
// The language is chosen in the popup and stored in chrome.storage.local.lang (default "tr").
const dicts = {
  tr: {
    badgeOn: "AÇIK",
    connectedLog: "bağlandı",
    idleShort: "boşta",
    agentTabsCount: "{n} agent sekmesi",
    idleMode: "bekleme modu",
    tabsClosed: "{n} sekme kapandı",
    workDone: "agent işi bitirdi",
    noCommand10: "10 dk işlem olmadı",
    debuggerDetached: "debugger ayrıldı",
    tabNotOwned: "bu sekme agent'e ait değil; agent yalnız kendi açtığı sekmelerde çalışır",
    noAgentTab: "açık agent sekmesi yok — önce navigate ile bir sekme aç",
    unknownCommand: "bilinmeyen komut: {cmd}",
    pageScriptFailed: "sayfa betiği hata verdi",
    tabLabel: "sekme {id}",
    agentAccess: "Agent erişimi",
    statusOff: "kapalı — anahtarı aç",
    advanced: "Gelişmiş",
    tokenField: "Token (otomatik oluşur)",
    toggleOff: "anahtar kapandı",
    blockedUrl: "engellenen adres kalıbı / blocked URL pattern: {url}",
    blockedLabel: "Engellenen adres kalıpları (virgülle, * destekli)",
    portLabel: "Port",
    languageLabel: "Dil",
    recentActions: "Son işlemler",
    nothingYet: "henüz işlem yok",
  },
  en: {
    badgeOn: "ON",
    connectedLog: "connected",
    idleShort: "idle",
    agentTabsCount: "{n} agent tab(s)",
    idleMode: "idle",
    tabsClosed: "{n} tab(s) closed",
    workDone: "agent finished the task",
    noCommand10: "no command for 10 min",
    debuggerDetached: "debugger detached",
    tabNotOwned: "tab does not belong to the agent; it only works in tabs it opened",
    noAgentTab: "no open agent tab — open one with navigate first",
    unknownCommand: "unknown command: {cmd}",
    pageScriptFailed: "page script failed",
    tabLabel: "tab {id}",
    agentAccess: "Agent access",
    statusOff: "off — flip the switch",
    advanced: "Advanced",
    tokenField: "Token (generated automatically)",
    toggleOff: "toggle turned off",
    blockedUrl: "blocked URL pattern: {url}",
    blockedLabel: "Blocked URL patterns (comma separated, * wildcard)",
    portLabel: "Port",
    languageLabel: "Language",
    recentActions: "Recent actions",
    nothingYet: "nothing yet",
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
