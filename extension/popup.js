const $ = (id) => document.getElementById(id);

function renderStatus(s) {
  $("dot").classList.toggle("on", s.open);
  $("status").textContent = s.open
    ? s.myTabs
      ? `bağlı · ${s.myTabs} agent sekmesi / connected`
      : "bağlı · boşta / connected · idle"
    : s.hasToken
      ? "köprü bekleniyor… / waiting for bridge…"
      : "token yok / no token";
  $("connect").hidden = s.open;
  $("disconnect").hidden = !s.open;
  $("activity").innerHTML =
    (s.activity ?? [])
      .map((e) => `<li>${e.time} — ${e.cmd}${e.target ? " · " + e.target : ""}</li>`)
      .join("") || "<li>henüz işlem yok / nothing yet</li>";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (s) => s && renderStatus(s));
}

chrome.storage.local.get(["token", "port"], ({ token, port }) => {
  if (token) $("token").value = token;
  if (port) $("port").value = port;
});
refresh();

$("connect").onclick = () => {
  const token = $("token").value.trim().toUpperCase();
  const port = Number($("port").value) || 8791;
  if (!token) {
    $("status").textContent = "önce token gir / enter the token first";
    return;
  }
  chrome.storage.local.set({ token, port }, () => chrome.runtime.sendMessage({ type: "reconnect" }));
  $("connect").textContent = "Kaydedildi ✓ / Saved ✓";
  setTimeout(() => ($("connect").textContent = "Bağlan / Connect"), 1500);
  setTimeout(refresh, 400);
};

$("disconnect").onclick = () => {
  chrome.storage.local.remove("token", () => {
    $("token").value = "";
    refresh();
  });
};

setInterval(refresh, 1500);
