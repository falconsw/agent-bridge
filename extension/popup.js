import { t, setLang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
let lang = "tr";
let status = null;

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function describe(e, T) {
  if (e.key === "act_navigate" && !e.vars?.host) return T("act_navigate_bare");
  const vars = { ...e.vars };
  if (vars.reason) vars.reason = T(`reason_${vars.reason}`);
  const text = T(e.key, vars);
  return text === e.key ? e.key.replace(/^act_/, "") : text; // unknown command: show its plain name
}

function render() {
  setLang(lang);
  const T = (key, vars) => t(key, vars);
  document.documentElement.lang = lang;
  $("access-label").textContent = T("agentAccess");
  $("access-hint").textContent = T("accessHint");
  $("cursor-label").textContent = T("cursorLabel");
  $("cursor-hint").textContent = T("cursorHint");
  $("advanced-label").textContent = T("advanced");
  $("port-label").textContent = T("portLabel");
  $("token-label").textContent = T("tokenField");
  $("blocked-label").textContent = T("blockedLabel");
  $("activity-heading").textContent = T("recentActions");
  $("clear").textContent = T("clearLog");
  for (const b of $("lang").children) b.classList.toggle("active", b.dataset.lang === lang);

  if (status) {
    const on = status.enabled && status.open;
    $("dot").className = "dot" + (on ? " on" : status.enabled ? " wait" : "");
    $("status").textContent = !status.enabled
      ? T("statusOffShort")
      : status.open
        ? status.myTabs
          ? T("statusConnectedTabs", { n: status.myTabs })
          : T("statusConnectedIdle")
        : T("statusWaiting");
    const entries = (status.activity ?? []).filter((e) => e.key);
    const timeFmt = new Intl.DateTimeFormat(lang === "tr" ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    $("clear").hidden = !entries.length;
    $("activity").innerHTML =
      entries
        .map(
          (e) =>
            `<li><span class="what" title="${esc(describe(e, T))}">${e.agent ? `<span class="who">${esc(e.agent)}</span>` : ""}${esc(describe(e, T))}${e.count > 1 ? ` <span class="count">×${e.count}</span>` : ""}</span><time>${timeFmt.format(e.ts)}</time></li>`,
        )
        .join("") || `<li class="empty">${esc(T("nothingYet"))}</li>`;
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => {
    if (s) {
      status = s;
      lang = s.lang || "tr";
      if (s.token) $("token").value = s.token; // show the automatically generated pairing token
      render();
    }
  });
}

chrome.storage.local.get(["token", "port", "lang", "enabled", "blockPatterns", "cursor"], ({ token, port, lang: savedLang, enabled, blockPatterns, cursor }) => {
  if (token) $("token").value = token;
  if (blockPatterns?.length) $("blocked").value = blockPatterns.join(", ");
  if (port) $("port").value = port;
  lang = savedLang || "tr";
  $("enabled").checked = !!enabled;
  $("cursor").checked = cursor !== false; // on by default
  render();
});
refresh();

$("enabled").onchange = () => {
  chrome.storage.local.set({ enabled: $("enabled").checked });
  refresh();
};

$("cursor").onchange = () => {
  chrome.storage.local.set({ cursor: $("cursor").checked });
};

$("lang").onclick = (ev) => {
  const next = ev.target.dataset?.lang;
  if (!next || next === lang) return;
  lang = next;
  chrome.storage.local.set({ lang });
  render();
};

$("clear").onclick = () => {
  chrome.runtime.sendMessage({ type: "clearActivity" });
  if (status) status.activity = [];
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
