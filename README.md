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
| `navigate` | Adrese gider (ya da `back`/`forward`/`reload`), **yüklenmeyi bekler ve sayfa görüntüsünü döndürür** |
| `read` | Sayfa görüntüsü: `rol "etiket" rN [durum]` satırları, tablolar `row "hücre | hücre"` olarak. `mode: "all"` tüm metni de ekler; `ref`/`selector`/`viewport` ile daraltılır |
| `find` | Etiket ve metinde arar, eşleşen satırları ref ve link adresiyle döndürür (`read`'den çok daha ucuz) |
| `click` / `hover` | `rN`, CSS seçici ya da etiketle **gerçek fare olayı**; sayfa durulana kadar bekler, **yalnız değişeni** döndürür |
| `type` / `fill` | Gerçek klavye girdisi (`Input.insertText`); `fill` bütün formu tek çağrıda doldurur: metin, `<select>`, onay kutusu/radyo (`true`/`false`) |
| `select` | Yerel `<select>` seçeneği seçer |
| `key` | Tuş ve kısayollar: `Enter`, `Escape`, `Tab Tab Enter`, `cmd+a` |
| `scroll` | Kaydırır, ekranda görünenleri döndürür |
| `upload` | `<input type=file>` alanına yerel dosya verir (post için fotoğraf/video) |
| `wait` | Metin/seçici görünene (ya da `gone` ile kaybolana) kadar bekler |
| `console` / `network` | Sekmenin konsol mesajları ve ağ istekleri |
| `screenshot` | Görünen alanın JPEG'i (1280 px'e kadar); pahalıdır, yalnız görsel sorular için |
| `eval` | Sayfada JavaScript çalıştırır (son çare) |
| `tabs` | Agent sekmeleri; `switchTo`, `close` |
| `done` | İş tamamen bitince sekmeleri kapatır |

**Token tasarrufu:** `navigate` görüntüyü zaten döndürür; eylemler yalnız yeni çıkan öğeleri (ya da yeni sayfayı) bildirir; aynı satırlar birleşir; görünmeyen/`aria-hidden` öğeler atlanır; araç açıklamaları kısa ve İngilizcedir. Açılır pencereler (alert/confirm) otomatik kabul edilip bildirilir, agent sekmesinin açtığı yeni sekmeler agent'e geçer. Shadow DOM ve aynı kökenli iframe'ler de okunur.

**Birden çok agent:** ilk köprü süreci portu alır; sonraki oturumlar (Claude Code, Cursor, Codex…) ona sürücü olarak katılır, ilk süreç kapanınca biri portu devralır.

## Test

Chrome gerekmez; sahte eklentiyle uçtan uca:

```
node test/fake-extension.mjs 8799 TEST-TOKEN &   # 1. uç
npm test                                          # 2. uç: iki köprü + devralma testi
```

## Güvenlik

- **Sekme yalıtımı:** agent yalnız **kendi açtığı sekmelerde** çalışır; kullanıcının sekmelerini listeleyemez, onlara gezinemez, tıklayamaz. Bir işe başlamak zorunda olduğu sekme her zaman `navigate` ile agent'in kendi sekmesidir.
- **Gizlilik filtresi:** şifre, gizli ve otomatik doldurma duyarlı alanlar (kredi kartı, OTP) anlık görüntüde **hiç görünmez** — model onları asla göremez.
- **Engellenen adres kalıpları:** popup > Gelişmiş'e virgülle yazın (ör. `banka.example.com/*, *.gov.tr/*`); `navigate` o adresleri reddeder.
- **Bekleme modu:** agent `done` aracını çağırınca ya da 10 dakika işlem olmayınca tüm agent sekmeleri kapanır, debugger ayrılır (sarı çubuk gider) ve köprü boşa düşer. Sonraki iş yine temiz bir sekmeyle başlar.
- Köprü yalnız `127.0.0.1` dinler; eşleşme token'la yapılır. Token'ı bilen her yerel süreç tarayıcıyı sürebilir — tek kullanıcılı makinede sınır budur (her yerel geliştirme aracında olduğu gibi).
- `chrome.debugger` kullandığı için eklenen sekmede Chrome'un "**... tarafından hataları ayıklanıyor**" çubuğu görünür; görmeniz bilerek böyle — ne zaman devrede olduğunu gösterir.
- **Prompt injection:** agent kötü niyetli bir sayfanın metniyle yönlendirilebilir. Eklenti popup'ındaki işlem günlüğü ne yapıldığını gösterir; yine de önemli hesaplarda agent'a kritik işlem yaptıracokseniz izleyin. Yol haritasındaki *onay modu* her yan etkili işlemde bildirimle onay isteyecek.

## Yol haritası

- [ ] Site izin listesi (yalnız listedeki alan adlarında işlem)
- [ ] Onay modu (yan etkili işlem öncesi bildirim + onay)
- [ ] npm paketi (`npx agent-bridge`)

## Lisans

MIT
