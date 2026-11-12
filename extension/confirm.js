// Approval window: the agent wants to tick a consent box (terms, privacy policy…), the user decides.
// An extension page in its own window: the agent cannot reach it and neither can the page.
// Closing the window or not answering counts as "no" (background.js).
import { t, setLang } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id");
const answer = (allow) => chrome.runtime.sendMessage({ type: "approvalAnswer", id, allow }, () => window.close());

chrome.storage.local.get("lang", ({ lang }) => {
  setLang(lang || "tr");
  document.documentElement.lang = lang || "tr";
  chrome.runtime.sendMessage({ type: "approvalInfo", id }, (info) => {
    if (!info) return window.close(); // already answered or timed out
    $("who").textContent = t("confirmFrom", { agent: info.agent || "Agent" });
    $("what").textContent = t(`confirm_${info.kind}`);
    $("host").textContent = info.host;
    // The label is page text: shown as plain text, never as markup.
    $("label").textContent = info.label;
    $("label").hidden = !info.label;
    $("hint").textContent = t("confirmHint");
    $("deny").textContent = t("denyBtn");
    $("allow").textContent = t("allowBtn");
    $("deny").onclick = () => answer(false);
    $("allow").onclick = () => answer(true);
  });
});
