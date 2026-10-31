const $ = (id) => document.getElementById(id);

function durumYaz(s) {
  $("nokta").classList.toggle("acik", s.acik);
  $("durum").textContent = s.acik ? "bağlı" : s.tokenVar ? "bekleniyor…" : "token yok";
  $("baglan").hidden = s.acik;
  $("kapat").hidden = !s.acik;
  $("etkinlik").innerHTML = (s.etkinlik ?? [])
    .map((e) => `<li>${e.saat} — ${e.cmd}${e.hedef ? " · " + e.hedef : ""}</li>`)
    .join("") || "<li>henüz işlem yok</li>";
}

function yenile() {
  chrome.runtime.sendMessage({ type: "durum" }, (s) => s && durumYaz(s));
}

chrome.storage.local.get(["token", "port"], ({ token, port }) => {
  if (token) $("token").value = token;
  if (port) $("port").value = port;
});
yenile();

$("baglan").onclick = () => {
  const token = $("token").value.trim().toUpperCase();
  const port = Number($("port").value) || 8791;
  if (!token) {
    $("durum").textContent = "token gir";
    return;
  }
  chrome.storage.local.set({ token, port }, () => chrome.runtime.sendMessage({ type: "yeniden" }));
  setTimeout(yenile, 400);
};

$("kapat").onclick = () => {
  chrome.storage.local.remove("token", () => {
    $("token").value = "";
    yenile();
  });
};

setInterval(yenile, 1500);
