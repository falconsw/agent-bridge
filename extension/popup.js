import { t, setLang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
let lang = "tr";
let status = null;
let copied = false;
// Terminal command that puts the bridge's token.json on the clipboard (Linux: prints it).
const OS = /Mac/i.test(navigator.platform) ? "mac" : /Win/i.test(navigator.platform) ? "win" : "other";
const PAIR_COPIES = OS !== "other";
const PAIR_COMMAND = {
  mac: "pbcopy < ~/.agent-bridge/token.json",
  win: 'type "%USERPROFILE%\\.agent-bridge\\token.json" | clip',
  other: "cat ~/.agent-bridge/token.json",
}[OS];

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
  $("confirm-label").textContent = T("confirmLabel");
  $("confirm-hint").textContent = T("confirmSettingHint");
  $("advanced-label").textContent = T("advanced");
  $("port-label").textContent = T("portLabel");
  $("token-label").textContent = T("tokenField");
  $("pair-label").textContent = T("pairLabel");
  $("pair-step1").textContent = T(PAIR_COPIES ? "pairStep1" : "pairStep1Manual");
  $("pair-step2").textContent = T("pairStep2");
  $("pair-cmd").textContent = PAIR_COMMAND;
  if (!copied) $("pair-copy").textContent = T("copyBtn");
  $("blocked-label").textContent = T("blockedLabel");
  $("eval-label").textContent = T("evalLabel");
  $("eval-on").textContent = T("evalOn");
  $("eval-allowlist").textContent = T("evalAllowlist");
  $("eval-off").textContent = T("evalOffOption");
  $("activity-heading").textContent = T("recentActions");
  $("clear").textContent = T("clearLog");
  for (const b of $("lang").children) b.classList.toggle("active", b.dataset.lang === lang);

  if (status) {
    const on = status.enabled && status.open;
    $("dot").className = "dot" + (on ? " on" : status.enabled ? " wait" : "");
    $("pair").hidden = !(status.enabled && status.rejected);
    // Back from the terminal with the token on the clipboard: paste goes straight into the field.
    if (!$("pair").hidden && document.activeElement === document.body) $("pair-token").focus();
    $("status").textContent = !status.enabled
      ? T("statusOffShort")
      : status.rejected
        ? T("statusRejected")
        : status.open
          ? status.myTabs
            ? T("statusConnectedTabs", { n: status.myTabs })
            : T("statusConnectedIdle")
          : T("statusWaiting");
    const allow = (status.allow ?? []).join(", ");
    $("allow").hidden = !allow || !on;
    $("allow").textContent = T("allowLine", { allow });
    $("allow").title = allow;
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
      // Show the automatically generated pairing token (but do not type over the user).
      if (s.token && document.activeElement !== $("token")) $("token").value = s.token;
      render();
    }
  });
}

chrome.storage.local.get(["token", "port", "lang", "enabled", "blockPatterns", "cursor", "evalMode", "confirmSensitive"], ({ token, port, lang: savedLang, enabled, blockPatterns, cursor, evalMode, confirmSensitive }) => {
  if (token) $("token").value = token;
  if (blockPatterns?.length) $("blocked").value = blockPatterns.join(", ");
  if (port) $("port").value = port;
  $("eval-mode").value = evalMode || "off"; // eval is opt-in: off until the user turns it on
  lang = savedLang || "tr";
  $("enabled").checked = !!enabled;
  $("cursor").checked = cursor !== false; // on by default
  $("confirm").checked = confirmSensitive !== false; // on by default
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

$("confirm").onchange = () => {
  chrome.storage.local.set({ confirmSensitive: $("confirm").checked });
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

// The bridge keeps the token of the extension it paired with first; a reinstalled extension has a new
// one and is refused. Entering the bridge's token here pairs them again (background.js reconnects).
const tokenIn = (text) => {
  try {
    return String(JSON.parse(text).token ?? "").trim(); // the whole token.json pasted
  } catch {
    return text.trim();
  }
};
for (const id of ["token", "pair-token"]) {
  $(id).onchange = () => {
    const token = tokenIn($(id).value);
    if (token) chrome.storage.local.set({ token });
  };
  // A paste is the whole token: no Enter needed.
  $(id).onpaste = () => setTimeout(() => {
    $(id).value = tokenIn($(id).value);
    $(id).onchange();
  });
}
$("pair-copy").onclick = async () => {
  await navigator.clipboard.writeText(PAIR_COMMAND);
  copied = true;
  $("pair-copy").textContent = t("copiedBtn");
  setTimeout(() => {
    copied = false;
    $("pair-copy").textContent = t("copyBtn");
  }, 1500);
};

$("port").onchange = () => {
  chrome.storage.local.set({ port: Number($("port").value) || 8791 });
};

$("blocked").onchange = () => {
  const patterns = $("blocked").value.split(",").map((p) => p.trim()).filter(Boolean);
  chrome.storage.local.set({ blockPatterns: patterns });
};

$("eval-mode").onchange = () => {
  chrome.storage.local.set({ evalMode: $("eval-mode").value });
};

setInterval(refresh, 1500);
