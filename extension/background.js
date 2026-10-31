// Agent Bridge servis işçisi: yerel köprüye (ws://127.0.0.1:port) bağlanır,
// agent komutlarını chrome.debugger ile yerine getirir. Kimse olmadan hiçbir şey yapmaz:
// bağlantı yalnız kullanıcının kendi makinesindeki köprüye, token eşleşmesiyle açılır.

const varsayilanPort = 8791;
let ws = null;
let token = "";
let port = varsayilanPort;
let eklenen = new Set(); // debugger eklenmiş sekmeler
let yenidenDeneme = 0;
let etkinlik = []; // son işlemler (popup gösterir)

const rozet = (metin, renk = "#1a7f37") => {
  chrome.action.setBadgeText({ text: metin });
  chrome.action.setBadgeBackgroundColor({ color: renk });
};

const gunluk = (cmd, hedef = "") => {
  etkinlik = [{ saat: new Date().toLocaleTimeString("tr-TR"), cmd, hedef: hedef.slice(0, 60) }, ...etkinlik].slice(0, 8);
  chrome.storage.local.set({ etkinlik });
};

async function debuggerEkle(tabId) {
  if (eklenen.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable").catch(() => {});
  eklenen.add(tabId);
}

chrome.debugger.onDetach.addListener(({ tabId }) => {
  eklenen.delete(tabId);
  gunluk("debugger ayrıldı", tabId ? `sekme ${tabId}` : "");
});

chrome.tabs.onRemoved.addListener((tabId) => eklenen.delete(tabId));

async function komut(cmd, args = {}) {
  switch (cmd) {
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case "eval": {
      const tabId = args.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await debuggerEkle(tabId);
      const yanit = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (yanit.exceptionDetails) throw new Error(yanit.exceptionDetails.exception?.description || "sayfa betiği hata verdi");
      return yanit.result?.value ?? null;
    }
    case "navigate": {
      const tab = args.newTab
        ? await chrome.tabs.create({ url: args.url })
        : await chrome.tabs.update(undefined, { url: args.url });
      return { tabId: tab.id, url: args.url };
    }
    case "screenshot": {
      const tabId = args.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
      await debuggerEkle(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
      const yanit = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png" });
      return { data: yanit.data };
    }
    case "ping":
      return { pong: true };
    default:
      throw new Error(`bilinmeyen komut: ${cmd}`);
  }
}

function baglan() {
  chrome.storage.local.get(["token", "port"], ({ token: t, port: p }) => {
    token = t || "";
    port = p || varsayilanPort;
    if (!token) {
      rozet("?", "#9a6700");
      return;
    }
    clearTimeout(baglan.zamanlayici);
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      tekrarBaglan();
      return;
    }
    ws.onopen = () => {
      yenidenDeneme = 0;
      ws.send(JSON.stringify({ type: "hello", token, chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] }));
    };
    ws.onmessage = async (olay) => {
      let msg;
      try {
        msg = JSON.parse(olay.data);
      } catch {
        return;
      }
      if (msg.type === "ready") {
        rozet("AÇIK");
        gunluk("bağlandı", `port ${port}`);
        return;
      }
      if (!msg.id) return; // kalp atışı vb.
      try {
        gunluk(msg.cmd, JSON.stringify(argsKisa(msg.args ?? {})));
        const data = await komut(msg.cmd, msg.args ?? {});
        ws.send(JSON.stringify({ id: msg.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e.message || e) }));
      }
    };
    ws.onclose = tekrarBaglan;
    ws.onerror = () => ws?.close();
  });
}

const argsKisa = (args) => {
  const { expression, url, path, ...kalan } = args;
  return { ...kalan, ...(url ? { url } : {}) };
};

function tekrarBaglan() {
  rozet(yenidenDeneme > 6 ? "—" : "…", "#9a6700");
  const bekle = Math.min(15000, 1000 * ++yenidenDeneme);
  clearTimeout(baglan.zamanlayici);
  baglan.zamanlayici = setTimeout(baglan, bekle);
}

chrome.storage.onChanged.addListener((degisiklikler, alan) => {
  if (alan === "local" && (degisiklikler.token || degisiklikler.port)) {
    ws?.close();
    yenidenDeneme = 0;
    baglan();
  }
});

// Popup'tan bağlantı durumu sorgusu
chrome.runtime.onMessage.addListener((msg, _gonderen, yanitla) => {
  if (msg.type === "durum") {
    yanitla({ acik: ws?.readyState === 1, etkinlik, tokenVar: !!token, port });
  }
  if (msg.type === "yeniden") baglan();
  return false;
});

baglan();
