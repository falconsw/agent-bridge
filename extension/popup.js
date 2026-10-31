import { t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
let lang = "tr";
let status = null;

function render() {
  const T = (key, vars) => t(lang, key, vars);
  $("token-label").textContent = T("tokenLabel");
  $("port-label").textContent = T("portLabel");
  $("lang-label").textContent = T("languageLabel");
  $("connect").textContent = status?.justSaved ? T("savedBtn") : T("connectBtn");
  $("disconnect").textContent = T("disconnectBtn");
  $("activity-heading").textContent = T("recentActions");

  if (status) {
    $("dot").classList.toggle("on", status.open);
    $("status").textContent = status.open
      ? status.myTabs
        ? T("statusConnectedTabs", { n: status.myTabs })
        : T("statusConnectedIdle")
      : status.hasToken
        ? T("statusWaiting")
        : T("statusNoToken");
    $("connect").hidden = status.open;
    $("disconnect").hidden = !status.open;
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
      render();
    }
  });
}

chrome.storage.local.get(["token", "port", "lang"], ({ token, port, lang: savedLang }) => {
  if (token) $("token").value = token;
  if (port) $("port").value = port;
  lang = savedLang || "tr";
  $("lang").value = lang;
  render();
});
refresh();

$("connect").onclick = () => {
  const token = $("token").value.trim().toUpperCase();
  const port = Number($("port").value) || 8791;
  if (!token) {
    $("status").textContent = t(lang, "statusEnterToken");
    return;
  }
  chrome.storage.local.set({ token, port }, () => chrome.runtime.sendMessage({ type: "reconnect" }));
  status = { ...status, justSaved: true };
  render();
  setTimeout(() => {
    status = { ...status, justSaved: false };
    render();
  }, 1500);
  setTimeout(refresh, 400);
};

$("disconnect").onclick = () => {
  chrome.storage.local.remove("token", () => {
    $("token").value = "";
    refresh();
  });
};

$("lang").onchange = () => {
  lang = $("lang").value;
  chrome.storage.local.set({ lang });
  render();
};

setInterval(refresh, 1500);
