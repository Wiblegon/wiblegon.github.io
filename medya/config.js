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
    { tur: "sinav", ad: "Şınav Token (1x / 5x)", puan: null },
    { tur: "tts",   ad: "TTS Token", puan: null },
  ],

  // ---- TTS sesleri ----
  // Motor: ElevenLabs (worker üzerinden, API anahtarı tarayıcıya inmez).
  // Karakter sesleri admin panelindeki TTS sekmesinden ElevenLabs voice ID'siyle eşlenir.
  SESLER: [
    { id: "kalin-erkek",        ad: "Kalın Erkek Sesi" },
    { id: "ince-erkek",         ad: "İnce Erkek Sesi" },
    { id: "kalin-kadin",        ad: "Kalın Kadın Sesi" },
    { id: "ince-kadin",         ad: "İnce Kadın Sesi" },
    { id: "kufurbaz-haydo",     ad: "Küfürbaz Haydo" },
    { id: "arthur-morgan",      ad: "Arthur Morgan" },
    { id: "ramiz-karaeski",     ad: "Ramiz Karaeski" },
    { id: "darth-vader",        ad: "Darth Vader" },
    { id: "minecraft-villager", ad: "Minecraft Villager" },
    { id: "anime-girl",         ad: "Tatlı Anime Girl" },
    { id: "john-marston",       ad: "John Marston" },
    { id: "dobby",              ad: "Dobby" },
    { id: "glados",             ad: "GLaDOS (Portal)" },
    { id: "optimus-prime",      ad: "Optimus Prime" },
    { id: "mickey-mouse",       ad: "Mickey Mouse" },
  ],
};
