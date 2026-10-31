# Agent Bridge

Terminal agent'larına (Claude Code, Cursor, Codex… — MCP konuşan herkes) **kendi Chrome'unuzda** işlem yaptıran köprü. Agent sekme okur, tıklar, yazar, ekran görüntüsü alır — **sizin oturumlarınızla**: Studio, Search Console, TikTok, Business Suite… hepsi girili kalır.

Playwright/DevTools MCP'den farkı burada: onlar boş, oturumsuz bir tarayıcı açar. Agent Bridge sizin gerçek tarayıcınıza bağlanır.

## Nasıl çalışır

```
agent (MCP istemcisi)  ⇄ stdio  ⇄  agent-bridge  ⇄ WebSocket (127.0.0.1)  ⇄  Chrome eklentisi  ⇄  sayfalar
                                        (token korumalı)                          (chrome.debugger)
```

- **Eklenti** `chrome.debugger` API'sini kullanır: uzaktan hata ayıklama portu (9222) açmaya gerek yoktur.
- **Köprü** yalnız `127.0.0.1`'e bağlanır; eklenti açılışta token gönderir, token eşleşmezse bağlantı reddedilir.
- Ekran görüntüsü dahil tüm veriler makinenizden çıkmaz.

## Kurulum

**1. Eklenti (bir kez):**

1. Chrome'da `chrome://extensions` → sağ üstten **Geliştirici modu**'nu aç
2. **Paketlenmemiş öğe yükle** → bu depodaki `extension/` klasörünü seç
3. Araç çubuğundaki Agent Bridge simgesine tıkla (→ iğneyle sabitle)

**2. Köprü (her çalışmada):**

```
node bin/agent-bridge.mjs
```

**3. Eşleşme (tek hareket):** eklenti popup'ında **"Agent erişimi"** anahtarını aç. İlk bağlantı otomatik eşleşir (TOFU — ilk bağlanana güven); eşleşme `~/.agent-bridge/token.json`'a yazılır, sonraki köprü süreçleri onu tanır. Rozet **AÇIK** olur.

Yeniden eşleştirmek gerekirse: köprüyü `--fresh` ile başlat.

**4. Agent'a MCP olarak ekle (örnek, Claude Code):**

```
claude mcp add agent-bridge -- node /tam/yol/agent-bridge/bin/agent-bridge.mjs
```

## Araçlar

| Araç | İş |
| --- | --- |
| `tabs` | Agent'in kendi sekmelerini listeler (kullanıcı sekmeleri görünmez) |
| `read` | Başlık, adres, görünür metin + **indeksli tıklanabilir öğe envanteri** |
| `click` | Seçici, öğe indeksi ya da metinle tıklar |
| `type` | Alana yazar (contenteditable dahil); `pressEnter` seçeneği |
| `navigate` | Agent sekmesinde adrese gider; gerekirse yeni agent sekmesi açar |
| `screenshot` | PNG kaydeder ve döndürür |
| `eval` | Sayfada JavaScript çalıştırır (dikkatli) |
| `done` | İşi bitirir: sekmeleri kapatır, bekleme moduna geçer |

Önerilen akış: önce `read` (envanteri al), sonra `click`/`type`'ta indeksleri kullan.

## Test

Chrome gerekmez; sahte eklentiyle uçtan uca:

```
node test/fake-extension.mjs 8799 TEST-TOKEN &   # 1. uç
npm test                                          # 2. uç (MCP istemcisi)
```

## Güvenlik

- **Sekme yalıtımı:** agent yalnız **kendi açtığı sekmelerde** çalışır; kullanıcının sekmelerini listeleyemez, onlara gezinemez, tıklayamaz. Bir işe başlamak zorunda olduğu sekme her zaman `navigate` ile agent'in kendi sekmesidir.
- **Bekleme modu:** agent `done` aracını çağırınca ya da 10 dakika işlem olmayınca tüm agent sekmeleri kapanır, debugger ayrılır (sarı çubuk gider) ve köprü boşa düşer. Sonraki iş yine temiz bir sekmeyle başlar.
- Köprü yalnız `127.0.0.1` dinler; eşleşme token'la yapılır. Token'ı bilen her yerel süreç tarayıcıyı sürebilir — tek kullanıcılı makinede sınır budur (her yerel geliştirme aracında olduğu gibi).
- `chrome.debugger` kullandığı için eklenen sekmede Chrome'un "**... tarafından hataları ayıklanıyor**" çubuğu görünür; görmeniz bilerek böyle — ne zaman devrede olduğunu gösterir.
- **Prompt injection:** agent kötü niyetli bir sayfanın metniyle yönlendirilebilir. Eklenti popup'ındaki işlem günlüğü ne yapıldığını gösterir; yine de önemli hesaplarda agent'a kritik işlem yaptıracokseniz izleyin. Yol haritasındaki *onay modu* her yan etkili işlemde bildirimle onay isteyecek.

## Yol haritası

- [ ] Dosya yükleme (`DOM.setFileInputFiles`)
- [ ] Site izin listesi (yalnız listedeki alan adlarında işlem)
- [ ] Onay modu (yan etkili işlem öncesi bildirim + onay)
- [ ] npm paketi (`npx agent-bridge`)

## Lisans

MIT
