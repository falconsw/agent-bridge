import { t, setLang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
let lang = "tr";
let status = null;

function render() {
  setLang(lang);
  const T = (key, vars) => t(key, vars);
  $("access-label").textContent = T("agentAccess");
  $("lang-label").textContent = T("languageLabel");
  $("advanced-label").textContent = T("advanced");
  $("port-label").textContent = T("portLabel");
  $("token-label").textContent = T("tokenField");
  $("blocked-label").textContent = T("blockedLabel");
  $("activity-heading").textContent = T("recentActions");

  if (status) {
    $("dot").classList.toggle("on", status.open);
    $("dot").style.background = status.enabled ? undefined : "#666";
    $("status").textContent = !status.enabled
      ? T("statusOff")
      : status.open
        ? status.myTabs
          ? T("statusConnectedTabs", { n: status.myTabs })
          : T("statusConnectedIdle")
        : T("statusWaiting");
    $("activity").innerHTML =
      (status.activity ?? []).map((e) => `<li>${e.time} — ${e.cmd}${e.target ? " · " + e.target : ""}</li>`).join("") ||
      `<li>${T("nothingYet")}</li>`;
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => {
    if (s) {
      status = s;
      lang = s.lang || "tr";
      $("lang").value = lang;
      if (s.token) $("token").value = s.token; // show the automatically generated pairing token
      render();
    }
  });
}

chrome.storage.local.get(["token", "port", "lang", "enabled", "blockPatterns"], ({ token, port, lang: savedLang, enabled, blockPatterns }) => {
  if (token) $("token").value = token;
  if (blockPatterns?.length) $("blocked").value = blockPatterns.join(", ");
  if (port) $("port").value = port;
  lang = savedLang || "tr";
  $("lang").value = lang;
  $("enabled").checked = !!enabled;
  render();
});
refresh();

$("enabled").onchange = () => {
  chrome.storage.local.set({ enabled: $("enabled").checked });
  refresh();
};

$("lang").onchange = () => {
  lang = $("lang").value;
  chrome.storage.local.set({ lang });
  render();
};

$("port").onchange = () => {
  chrome.storage.local.set({ port: Number($("port").value) || 8791 });
};

$("blocked").onchange = () => {
  const patterns = $("blocked").value.split(",").map((p) => p.trim()).filter(Boolean);
  chrome.storage.local.set({ blockPatterns: patterns });
};

setInterval(refresh, 1500);
