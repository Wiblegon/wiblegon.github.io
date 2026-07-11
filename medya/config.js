// ---- Wiblegon Medya ayarları ----
const CONFIG = {
  API_BASE: "https://kick-medya.wiblegon.workers.dev", // Cloudflare Worker adresi
  SITE_ADI: "Wiblegon Medya",
  KANAL_ADI: "wiblegon",
  // Kick'teki ödül adları ve puanları (bilgi amaçlı, eşleşme worker'da kelimeye göre yapılır)
  ODULLER: [
    { tur: "video", ad: "Video Oynat", puan: 250 },
    { tur: "ses",   ad: "Ses Oynat",   puan: 200 },
    { tur: "foto",  ad: "Foto Oynat",  puan: 100 },
  ],
};
