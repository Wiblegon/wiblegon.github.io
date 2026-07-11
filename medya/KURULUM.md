# Wiblegon Medya v2 — Kurulum

Counter (sayaç) sistemli Kick medya oynatma. İzleyici Kick'te ödül aldıkça hakkı birikir,
sitede istediği zaman kullanır.

## Sistem nasıl çalışıyor?

```
Kick ödülü alınır ──webhook──> Cloudflare Worker ──> hak +1 (D1 veritabanı)
İzleyici sitede "Oynat" der ──> hak -1, kuyruğa girer ──> OBS overlay oynatır
```

| Kick ödülü | Puan | Verdiği hak |
|---|---|---|
| Video Oynat | 250 | 1 video |
| Ses Oynat | 200 | 1 ses |
| Foto Oynat | 100 | 1 foto |
| Medya Oynat (eski usul) | — | seçili medyayı direkt oynatır |

Eşleşme ödül **adındaki kelimeye** göre yapılır: içinde "video" geçen ödül video hakkı,
"ses/müzik" geçen ses hakkı, "foto/resim" geçen foto hakkı verir. Puanı Kick'te sen belirliyorsun.

## Kurulum adımları

### 1. Bu repoyu GitHub'a gönder
`wiblegon.github.io` reposunun yeni halini push'la. Yeni sayfa: **https://wiblegon.github.io/medya/**

### 2. Cloudflare Worker'ı güncelle
1. Cloudflare Dashboard → Workers & Pages → **kick-medya** worker'ı
2. Edit code → içeriği tamamen sil → `medya/worker.js` dosyasının içeriğini yapıştır → Deploy
3. Ayarlar aynı kalıyor (D1 binding `DB`, env: `KICK_CLIENT_ID`, `SESSION_SECRET`, `ADMIN_KEY`, `KANAL_ADI`).
   `SITE_ORIGIN` varsa `https://wiblegon.github.io` yap (yoksa gerek yok, kod içinde zaten izinli).

### 3. Veritabanını kur
1. **https://wiblegon.github.io/medya/admin.html** aç
2. Yönetici anahtarını gir → Bağlan
3. **Kurulum** sekmesi → **"Kur"** butonu
   > ⚠️ Bu buton eski wiblegonstream sisteminin bütün tablolarını kalıcı siler ve test videosunu ekler.

### 4. Kick bağlantısı (eski sistemden kalan ayarlar geçerliyse sadece yayıncı girişi yeterli)
Kurulum sekmesinde sırayla:
1. Client Secret kaydet (daha önce kaydettiysen atla)
2. **Yayıncı olarak giriş yap** (kick hesabınla — token yenilendi)
3. **Webhook aboneliğini kur**

Kick Developer ayarlarında redirect URI zaten `https://kick-medya.wiblegon.workers.dev/auth/callback` olmalı (değişmedi).

### 5. Kick'te ödülleri oluştur
Creator Dashboard → Rewards:
- **Video Oynat** — 250 puan
- **Ses Oynat** — 200 puan
- **Foto Oynat** — 100 puan
- **Medya Oynat** (varsa dursun, eski usul çalışır)

### 6. OBS
Kaynak ekle → **Tarayıcı** →
- URL: `https://wiblegon.github.io/medya/overlay.html`
- Genişlik 1920, Yükseklik 1080
- ✅ "Sayfayı OBS ile kontrol et" işaretli kalsın (ses için)

### 7. Test
Admin → Kurulum → Test:
- "Sahte ödül ver" ile kendine +1 video hakkı ver → sitede giriş yap → Kırmızı Gömlekli Adam'ı oynat
- veya medya id `1` girip "Overlay'de oynat" ile direkt OBS'yi test et

## Medya ekleme
1. Dosyayı bu repoda `medya/dosyalar/` klasörüne at (GitHub dosya başı 100 MB sınırı var)
2. Admin → Kütüphane → tür + başlık + `dosyalar/dosyaadi.mp4` → Ekle
3. İstersen `https://...` ile dış link de ekleyebilirsin (direkt mp4/mp3/jpg linki olmalı)

## Hata düzeltme
- Webhook kaçırdıysa: Admin → Haklar → kullanıcı adı + tür + `+1` → Uygula
- Yanlış hak verildiyse: aynı yerden `-1`
- Kuyruktan kaldırma: Admin → Kuyruk → "İptal + iade" (hakkı/puanı geri verir) veya "İptal"
- Ne olup bittiğini görmek için: Admin → Loglar (tüm webhook'lar kaydedilir)

## Eski sistemi tamamen silme
1. Admin → Kurulum → "Kur" butonu eski tabloları zaten siliyor
2. GitHub'da **wiblegonstream** reposunu sil: repo → Settings → en alt → Delete this repository
