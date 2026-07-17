// ============================================================
//  WIBLEGON MEDYA v4 — Kick sadakat puanı sayaç (counter) sistemi
//  Cloudflare Worker + D1
//
//  Nasıl çalışır:
//   1. İzleyici Kick'te ödül alır: Video (250), Ses (200), Foto (100), Şınav/Mekik/TTS Token
//   2. Kick webhook'u buraya düşer (RSA imza doğrulamalı) -> izleyicinin hakkı artar
//   3. İzleyici sitede Kick ile giriş yapar, hakkını görür, istediği zaman kullanır
//   4. OBS overlay kuyruğu çekip yayında oynatır (medya / egzersiz banner / TTS sesi)
//   5. Eski "Medya Oynat" ödülü de çalışmaya devam eder (önce sitede seç, sonra ödülü al)
//
//  Gerekli env değişkenleri (eskisiyle aynı):
//   KICK_CLIENT_ID, SESSION_SECRET, ADMIN_KEY, KANAL_ADI
//   (KICK_CLIENT_SECRET env'de yoksa admin panelinden kaydedilir)
//  D1 binding adı: DB
// ============================================================

const KICK_ID = "https://id.kick.com";
const KICK_API = "https://api.kick.com/public/v1";
const SECIM_GECERLILIK_MS = 10 * 60 * 1000;   // eski usul seçim 10 dk geçerli
const OYNUYOR_ZAMAN_ASIMI_MS = 10 * 60 * 1000; // takılı kalan "oynuyor" kaydı kurtarma

const VARSAYILAN_SITE = "https://wiblegon.github.io/medya/";
const IZINLI_ORIGINLER = ["https://wiblegon.github.io"];

// Kick'in webhook imza public key'i (sabittir, docs.kick.com'dan)
const KICK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

// Ödül adı -> hak türü eşleşmesi (başlık içinde geçen kelimeye göre, büyük/küçük harf önemsiz)
function odulTuru(baslik) {
  // hem normal hem Türkçe küçük harfe çevirip ikisine de bak (VIDEO / VİDEO ikisi de yakalanır)
  const adaylar = [(baslik || "").toLowerCase(), (baslik || "").toLocaleLowerCase("tr")];
  const icerir = (k) => adaylar.some(b => b.includes(k));
  if (icerir("şınav") || icerir("sinav") || icerir("sınav") || icerir("push")) return "sinav";
  if (icerir("tts") || icerir("konuş") || icerir("konus") || icerir("seslendir")) return "tts";
  if (icerir("medya")) return "medya";                          // eski usul direkt oynatma
  if (icerir("video") || icerir("klip")) return "video";
  if (icerir("ses") || icerir("müzik") || icerir("muzik") || icerir("şarkı") || icerir("sarki")) return "ses";
  if (icerir("foto") || icerir("resim") || icerir("görsel") || icerir("gorsel")) return "foto";
  return null;
}

// "5x Şınav Token" gibi başlıklardan çarpanı çek (1x, 5x, x5...) — yoksa 1
function odulCarpan(baslik) {
  const m = (baslik || "").match(/(\d+)\s*[xX×]|[xX×]\s*(\d+)/);
  const n = m ? parseInt(m[1] || m[2], 10) : 1;
  return Math.min(100, Math.max(1, n || 1));
}

const MEDYA_TURLERI = ["video", "ses", "foto"];
const EGZERSIZ_TURLERI = ["sinav"]; // mekik kaldırıldı
const HAK_TURLERI = [...MEDYA_TURLERI, ...EGZERSIZ_TURLERI, "tts"];
const EGZERSIZ_MAX = 50;           // tek seferde en fazla bu kadar şınav/mekik istenebilir
const KUYRUK_BEKLEME_MS = 10 * 1000; // aynı kullanıcı 10 sn'de bir istek atabilir (spam koruması)

// TTS ayarları
const TTS_MAX_KARAKTER = 200;
const TTS_SES_IDLERI = [
  "kalin-erkek", "ince-erkek", "kalin-kadin", "ince-kadin",
  "kufurbaz-haydo", "arthur-morgan", "ramiz-karaeski", "darth-vader",
  "minecraft-villager", "anime-girl", "john-marston", "dobby",
  "glados", "optimus-prime", "mickey-mouse",
];

// ElevenLabs — 4 klasik ses için hazır (premade) voice ID varsayılanları.
// Karakter sesleri admin panelinden eşlenir (Voice Library'den seçip ID yapıştır).
const EL_API = "https://api.elevenlabs.io/v1";
const EL_MODEL = "eleven_flash_v2_5"; // Türkçe destekli, en ucuz model (0.5 kredi/karakter)
const EL_VARSAYILAN = {
  "kalin-erkek": "VR6AewLTigWG4xSOukaG", // Arnold (çok kalın)
  "ince-erkek":  "ErXwobaYiN019PkySvjV", // Antoni
  "kalin-kadin": "21m00Tcm4TlvDq8ikWAM", // Rachel
  "ince-kadin":  "EXAVITQu4vr4xnSDxMaL", // Bella
};
// Karakter eşlenmemişse en yakın klasiğe düş
const EL_YEDEK = {
  "kufurbaz-haydo": "ince-erkek", "arthur-morgan": "kalin-erkek", "ramiz-karaeski": "kalin-erkek",
  "darth-vader": "kalin-erkek", "minecraft-villager": "ince-erkek", "anime-girl": "ince-kadin",
  "john-marston": "kalin-erkek", "dobby": "ince-kadin", "glados": "kalin-kadin",
  "optimus-prime": "kalin-erkek", "mickey-mouse": "ince-erkek",
};
const DOSYA_MAX_BAYT = 1400000; // D1 satır sınırına güvenli mesafe (~1.4MB)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const yol = url.pathname;

    if (request.method === "OPTIONS") return cevap(null, 204, request, env);

    try {
      await dbKur(env);

      if (yol === "/" || yol === "/api/saglik") return cevap({ tamam: true, surum: "medya-v6" }, 200, request, env);

      const dosyaEsle = yol.match(/^\/dosya\/([A-Za-z0-9._-]+)$/);
      if (dosyaEsle && request.method === "GET") return dosyaSun(dosyaEsle[1], env);

      if (yol === "/auth/login") return authLogin(url, env);
      if (yol === "/auth/callback") return authCallback(url, request, env);

      if (yol === "/api/ben" && request.method === "GET") return apiBen(request, env);
      if (yol === "/api/medya" && request.method === "GET") return apiMedya(request, env);
      if (yol === "/api/durum" && request.method === "GET") return apiDurum(request, env);
      if (yol === "/api/oynat" && request.method === "POST") return apiOynat(request, env);
      if (yol === "/api/egzersiz" && request.method === "POST") return apiEgzersiz(request, env);
      if (yol === "/api/tts" && request.method === "POST") return apiTts(request, env);
      if (yol === "/api/sec" && request.method === "POST") return apiSec(request, env);

      if (yol === "/webhook/kick" && request.method === "POST") return webhookKick(request, env, ctx);

      if (yol === "/api/overlay/siradaki" && request.method === "GET") return overlaySiradaki(request, env);
      if (yol === "/api/overlay/bitti" && request.method === "POST") return overlayBitti(request, env);
      if (yol === "/api/overlay/tts-ses" && request.method === "GET") return overlayTtsSes(url, request, env);

      if (yol.startsWith("/api/admin/")) {
        if (request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) return cevap({ hata: "yetkisiz" }, 401, request, env);

        if (yol === "/api/admin/kur" && request.method === "POST") return adminKur(request, env);
        if (yol === "/api/admin/krediler" && request.method === "GET") return adminKrediler(request, env);
        if (yol === "/api/admin/kredi" && request.method === "POST") return adminKredi(request, env);
        if (yol === "/api/admin/kuyruk" && request.method === "GET") return adminKuyruk(request, env);
        const iptal = yol.match(/^\/api\/admin\/kuyruk\/(\d+)\/iptal$/);
        if (iptal && request.method === "POST") return adminKuyrukIptal(Number(iptal[1]), request, env);
        if (yol === "/api/admin/medya" && request.method === "POST") return adminMedyaEkle(request, env);
        const medyaSil = yol.match(/^\/api\/admin\/medya\/(\d+)$/);
        if (medyaSil && request.method === "DELETE") return adminMedyaSil(Number(medyaSil[1]), request, env);
        if (yol === "/api/admin/loglar" && request.method === "GET") return adminLoglar(request, env);
        if (yol === "/api/admin/test" && request.method === "POST") return adminTest(request, env);
        if (yol === "/api/admin/kick/secret" && request.method === "POST") return adminKickSecret(request, env);
        if (yol === "/api/admin/kick/abone" && request.method === "POST") return adminWebhookAbone(request, env);
        if (yol === "/api/admin/eleven/key" && request.method === "POST") return adminElevenKey(request, env);
        if (yol === "/api/admin/eleven/ara" && request.method === "GET") return adminElevenAra(url, request, env);
        if (yol === "/api/admin/eleven/ekle" && request.method === "POST") return adminElevenEkle(request, env);
        if (yol === "/api/admin/eleven/sesler" && request.method === "GET") return adminElevenSesler(request, env);
        if (yol === "/api/admin/eleven/sesler" && request.method === "POST") return adminElevenSeslerKaydet(request, env);
        if (yol === "/api/admin/dosya" && request.method === "POST") return adminDosyaYukle(url, request, env);
      }

      return cevap({ hata: "bulunamadı" }, 404, request, env);
    } catch (e) {
      return cevap({ hata: e.message }, 500, request, env);
    }
  },
};

// ================= Veritabanı =================

let dbHazir = false;
async function dbKur(env) {
  if (dbHazir) return;
  const t = [
    `CREATE TABLE IF NOT EXISTS m_krediler (kullanici TEXT NOT NULL, tur TEXT NOT NULL, adet INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kullanici, tur))`,
    `CREATE TABLE IF NOT EXISTS m_islenen (rid TEXT PRIMARY KEY, durum TEXT, kullanici TEXT, tur TEXT, zaman INTEGER, adet INTEGER DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS m_medya (id INTEGER PRIMARY KEY AUTOINCREMENT, tur TEXT, baslik TEXT, url TEXT, thumb TEXT, sure INTEGER DEFAULT 0, oynatma INTEGER DEFAULT 0, eklenme INTEGER, tagler TEXT)`,
    `CREATE TABLE IF NOT EXISTS m_kuyruk (id INTEGER PRIMARY KEY AUTOINCREMENT, kullanici TEXT, medya_id INTEGER, durum TEXT, kaynak TEXT, rid TEXT, tur TEXT, zaman INTEGER, adet INTEGER DEFAULT 0, metin TEXT, ses TEXT)`,
    `CREATE TABLE IF NOT EXISTS m_secim (kullanici TEXT PRIMARY KEY, medya_id INTEGER, zaman INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_yayinci (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT, refresh_token TEXT, bitis INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_log (id INTEGER PRIMARY KEY AUTOINCREMENT, zaman TEXT, tip TEXT, govde TEXT)`,
    `CREATE TABLE IF NOT EXISTS m_ayar (anahtar TEXT PRIMARY KEY, deger TEXT)`,
    `CREATE TABLE IF NOT EXISTS m_dosya (ad TEXT PRIMARY KEY, ct TEXT, veri TEXT, zaman INTEGER)`,
  ];
  for (const s of t) await env.DB.prepare(s).run();
  // Var olan kurulumlar için kolon göçleri (kolon zaten varsa sessizce geçer)
  const gocler = [
    `ALTER TABLE m_kuyruk ADD COLUMN adet INTEGER DEFAULT 0`,
    `ALTER TABLE m_islenen ADD COLUMN adet INTEGER DEFAULT 1`,
    `ALTER TABLE m_medya ADD COLUMN tagler TEXT`,
    `ALTER TABLE m_kuyruk ADD COLUMN metin TEXT`,
    `ALTER TABLE m_kuyruk ADD COLUMN ses TEXT`,
  ];
  for (const s of gocler) { try { await env.DB.prepare(s).run(); } catch (e) {} }
  dbHazir = true;
}

async function logla(env, tip, govde) {
  try {
    await env.DB.prepare("INSERT INTO m_log (zaman, tip, govde) VALUES (datetime('now'), ?, ?)")
      .bind(tip, String(govde).slice(0, 4000)).run();
  } catch (e) {}
}

// ================= Yardımcılar =================

function corsOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const izinli = [...IZINLI_ORIGINLER];
  if (env.SITE_ORIGIN) izinli.push(env.SITE_ORIGIN);
  return izinli.includes(origin) ? origin : izinli[0];
}

function cevap(veri, durum = 200, request, env) {
  return new Response(veri === null ? null : JSON.stringify(veri), {
    status: durum,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": corsOrigin(request, env),
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Oturum",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    },
  });
}

async function hmac(mesaj, gizli) {
  const anahtar = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(gizli), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const imza = await crypto.subtle.sign("HMAC", anahtar, new TextEncoder().encode(mesaj));
  return btoa(String.fromCharCode(...new Uint8Array(imza))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
}

// Oturum: cookie yok — token URL fragment'iyle siteye taşınır, localStorage'da durur,
// X-Oturum başlığıyla gelir. (Cross-site cookie sorunlarından tamamen kurtulmak için.)
async function oturumOlustur(kullanici, env) {
  const veri = btoa(encodeURIComponent(kullanici)).replace(/=+$/, "");
  return veri + "." + await hmac(veri, env.SESSION_SECRET);
}

async function oturumCoz(request, env) {
  const token = request.headers.get("X-Oturum") || "";
  const [veri, imza] = token.split(".");
  if (!veri || !imza) return null;
  if (await hmac(veri, env.SESSION_SECRET) !== imza) return null;
  try { return decodeURIComponent(atob(veri)).toLowerCase(); } catch (e) { return null; }
}

function siteUrl(env) { return env.SITE_URL || VARSAYILAN_SITE; }

async function kickSecret(env) {
  if (env.KICK_CLIENT_SECRET && env.KICK_CLIENT_SECRET !== "SONRA_DOLDURULACAK") return env.KICK_CLIENT_SECRET;
  const kayit = await env.DB.prepare("SELECT deger FROM m_ayar WHERE anahtar = 'kick_secret'").first().catch(() => null);
  return kayit?.deger || "";
}

// Yayıncı tokenı — süresi geçtiyse otomatik yenile
async function yayinciToken(env) {
  const kayit = await env.DB.prepare("SELECT * FROM m_yayinci WHERE id = 1").first();
  if (!kayit?.access_token) return null;
  if (kayit.bitis > Date.now() + 60000) return kayit.access_token;
  if (!kayit.refresh_token) return kayit.access_token;

  const res = await fetch(KICK_ID + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.KICK_CLIENT_ID,
      client_secret: await kickSecret(env),
      refresh_token: kayit.refresh_token,
    }),
  }).catch(() => null);
  if (!res || !res.ok) { await logla(env, "token-yenileme-hata", res ? await res.text() : "istek başarısız"); return kayit.access_token; }
  const token = await res.json();
  await env.DB.prepare("UPDATE m_yayinci SET access_token = ?, refresh_token = ?, bitis = ? WHERE id = 1")
    .bind(token.access_token, token.refresh_token || kayit.refresh_token, Date.now() + (token.expires_in || 3600) * 1000).run();
  return token.access_token;
}

// ================= Kimlik (Kick OAuth + PKCE) =================

async function authLogin(url, env) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const dijest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(dijest))).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
  const state = crypto.randomUUID();

  const hedef = new URL(KICK_ID + "/oauth/authorize");
  hedef.searchParams.set("client_id", env.KICK_CLIENT_ID);
  hedef.searchParams.set("redirect_uri", url.origin + "/auth/callback");
  hedef.searchParams.set("response_type", "code");
  hedef.searchParams.set("scope", url.searchParams.has("yayinci")
    ? "user:read events:subscribe channel:rewards:read channel:rewards:write"
    : "user:read");
  hedef.searchParams.set("code_challenge", challenge);
  hedef.searchParams.set("code_challenge_method", "S256");
  hedef.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      "Location": hedef.toString(),
      "Set-Cookie": `pkce=${verifier}.${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
    },
  });
}

async function authCallback(url, request, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = (request.headers.get("Cookie") || "").match(/pkce=([^;]+)/);
  if (!code || !cookie) return new Response("Giriş başarısız — tekrar dene.", { status: 400 });
  const [verifier, beklenenState] = cookie[1].split(".");
  if (state !== beklenenState) return new Response("State uyuşmadı — tekrar dene.", { status: 400 });

  const tokenRes = await fetch(KICK_ID + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.KICK_CLIENT_ID,
      client_secret: await kickSecret(env),
      redirect_uri: url.origin + "/auth/callback",
      code,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return new Response("Token alınamadı: " + await tokenRes.text(), { status: 502 });
  const token = await tokenRes.json();

  const benRes = await fetch(KICK_API + "/users", { headers: { "Authorization": "Bearer " + token.access_token } });
  if (!benRes.ok) return new Response("Kullanıcı bilgisi alınamadı", { status: 502 });
  const ben = await benRes.json();
  const kullanici = (ben.data?.[0]?.name || "").toLowerCase();
  if (!kullanici) return new Response("Kullanıcı adı çözülemedi", { status: 502 });

  // Yayıncının kendisi giriş yaptıysa tokenlarını sakla (webhook aboneliği + ödül iadesi için)
  if (kullanici === (env.KANAL_ADI || "").toLowerCase()) {
    await env.DB.prepare(
      "INSERT INTO m_yayinci (id, access_token, refresh_token, bitis) VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, bitis=excluded.bitis"
    ).bind(token.access_token, token.refresh_token || "", Date.now() + (token.expires_in || 3600) * 1000).run();
  }

  const oturum = await oturumOlustur(kullanici, env);
  return new Response(null, { status: 302, headers: { "Location": siteUrl(env) + "#oturum=" + oturum } });
}

// ================= İzleyici API =================

async function krediGetir(env, kullanici) {
  const { results } = await env.DB.prepare("SELECT tur, adet FROM m_krediler WHERE kullanici = ?").bind(kullanici).all();
  const k = { video: 0, ses: 0, foto: 0, sinav: 0, tts: 0 };
  for (const r of results) if (k[r.tur] !== undefined) k[r.tur] = r.adet;
  return k;
}

// Spam koruması: aynı kullanıcı kısa aralıklarla üst üste istek atamasın
async function cokHizliMi(env, kullanici) {
  const son = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM m_kuyruk WHERE kullanici = ? AND zaman > ?"
  ).bind(kullanici, Date.now() - KUYRUK_BEKLEME_MS).first();
  return (son?.n || 0) > 0;
}

async function apiBen(request, env) {
  const kullanici = await oturumCoz(request, env);
  if (!kullanici) return cevap({ hata: "giriş yok" }, 401, request, env);
  return cevap({ ad: kullanici, krediler: await krediGetir(env, kullanici) }, 200, request, env);
}

async function apiMedya(request, env) {
  const { results } = await env.DB.prepare("SELECT id, tur, baslik, url, thumb, sure, oynatma, tagler FROM m_medya ORDER BY id DESC").all();
  return cevap(results.map(m => ({ ...m, tagler: guvenliJson(m.tagler) })), 200, request, env);
}

function guvenliJson(s) {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

async function apiDurum(request, env) {
  const oynayan = await env.DB.prepare(
    "SELECT k.kullanici, m.baslik FROM m_kuyruk k JOIN m_medya m ON m.id = k.medya_id WHERE k.durum = 'oynuyor' ORDER BY k.id LIMIT 1"
  ).first();
  const bekleyen = await env.DB.prepare("SELECT COUNT(*) AS n FROM m_kuyruk WHERE durum = 'onaylandi'").first();
  return cevap({ oynuyor: oynayan || null, sirada: bekleyen?.n || 0 }, 200, request, env);
}

// Hak harcayarak oynatma — counter sisteminin kalbi
async function apiOynat(request, env) {
  const kullanici = await oturumCoz(request, env);
  if (!kullanici) return cevap({ hata: "önce giriş yap" }, 401, request, env);

  if (await cokHizliMi(env, kullanici)) return cevap({ hata: "yavaş ol şampiyon, 10 saniyede bir istek" }, 429, request, env);

  const { medyaId } = await request.json();
  const medya = await env.DB.prepare("SELECT * FROM m_medya WHERE id = ?").bind(medyaId).first();
  if (!medya) return cevap({ hata: "medya bulunamadı" }, 404, request, env);
  if (!MEDYA_TURLERI.includes(medya.tur)) return cevap({ hata: "geçersiz medya türü" }, 400, request, env);

  // Atomik düşüm: hak yoksa hiçbir satır etkilenmez, negatife düşmek imkânsız
  const dusum = await env.DB.prepare(
    "UPDATE m_krediler SET adet = adet - 1 WHERE kullanici = ? AND tur = ? AND adet > 0"
  ).bind(kullanici, medya.tur).run();

  if (!dusum.meta || dusum.meta.changes === 0) {
    return cevap({ hata: "yeterli hakkın yok", tur: medya.tur }, 402, request, env);
  }

  await env.DB.prepare(
    "INSERT INTO m_kuyruk (kullanici, medya_id, durum, kaynak, rid, tur, zaman) VALUES (?, ?, 'onaylandi', 'kredi', '', ?, ?)"
  ).bind(kullanici, medyaId, medya.tur, Date.now()).run();

  const bekleyen = await env.DB.prepare("SELECT COUNT(*) AS n FROM m_kuyruk WHERE durum IN ('onaylandi','oynuyor')").first();
  const kalan = await krediGetir(env, kullanici);
  return cevap({ tamam: true, sira: bekleyen?.n || 1, krediler: kalan }, 200, request, env);
}

// Şınav / mekik: token harcayarak yayıncıya egzersiz yaptır
async function apiEgzersiz(request, env) {
  const kullanici = await oturumCoz(request, env);
  if (!kullanici) return cevap({ hata: "önce giriş yap" }, 401, request, env);
  if (await cokHizliMi(env, kullanici)) return cevap({ hata: "yavaş ol şampiyon, 10 saniyede bir istek" }, 429, request, env);

  const { tur, adet } = await request.json();
  const n = Number(adet);
  if (!EGZERSIZ_TURLERI.includes(tur)) return cevap({ hata: "tur sinav veya mekik olmalı" }, 400, request, env);
  if (!Number.isInteger(n) || n < 1 || n > EGZERSIZ_MAX) {
    return cevap({ hata: `adet 1 ile ${EGZERSIZ_MAX} arasında tam sayı olmalı` }, 400, request, env);
  }

  // Atomik düşüm: token yetmiyorsa hiçbir şey değişmez
  const dusum = await env.DB.prepare(
    "UPDATE m_krediler SET adet = adet - ? WHERE kullanici = ? AND tur = ? AND adet >= ?"
  ).bind(n, kullanici, tur, n).run();
  if (!dusum.meta || dusum.meta.changes === 0) {
    const k = await krediGetir(env, kullanici);
    return cevap({ hata: `yeterli token yok (elinde ${k[tur]} var)`, tur }, 402, request, env);
  }

  await env.DB.prepare(
    "INSERT INTO m_kuyruk (kullanici, medya_id, durum, kaynak, rid, tur, zaman, adet) VALUES (?, 0, 'onaylandi', 'egzersiz', '', ?, ?, ?)"
  ).bind(kullanici, tur, Date.now(), n).run();

  const bekleyen = await env.DB.prepare("SELECT COUNT(*) AS n FROM m_kuyruk WHERE durum IN ('onaylandi','oynuyor')").first();
  return cevap({ tamam: true, sira: bekleyen?.n || 1, krediler: await krediGetir(env, kullanici) }, 200, request, env);
}

// TTS: token harcayarak seçtiği sesle yayında konuştur
async function apiTts(request, env) {
  const kullanici = await oturumCoz(request, env);
  if (!kullanici) return cevap({ hata: "önce giriş yap" }, 401, request, env);
  if (await cokHizliMi(env, kullanici)) return cevap({ hata: "yavaş ol şampiyon, 10 saniyede bir istek" }, 429, request, env);

  const { ses, metin } = await request.json();
  if (!TTS_SES_IDLERI.includes(ses)) return cevap({ hata: "geçersiz ses" }, 400, request, env);

  // Metin temizliği: kontrol karakterlerini at, boşlukları sadeleştir, limiti uygula
  const temiz = String(metin || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!temiz) return cevap({ hata: "metin boş olamaz" }, 400, request, env);
  if (temiz.length > TTS_MAX_KARAKTER) return cevap({ hata: `en fazla ${TTS_MAX_KARAKTER} karakter` }, 400, request, env);
  if (/https?:\/\/|www\./i.test(temiz)) return cevap({ hata: "metinde link olamaz" }, 400, request, env);

  // Atomik token düşümü
  const dusum = await env.DB.prepare(
    "UPDATE m_krediler SET adet = adet - 1 WHERE kullanici = ? AND tur = 'tts' AND adet > 0"
  ).bind(kullanici).run();
  if (!dusum.meta || dusum.meta.changes === 0) {
    return cevap({ hata: "TTS token'ın yok", tur: "tts" }, 402, request, env);
  }

  await env.DB.prepare(
    "INSERT INTO m_kuyruk (kullanici, medya_id, durum, kaynak, rid, tur, zaman, adet, metin, ses) VALUES (?, 0, 'onaylandi', 'tts', '', 'tts', ?, 0, ?, ?)"
  ).bind(kullanici, Date.now(), temiz, ses).run();

  const bekleyen = await env.DB.prepare("SELECT COUNT(*) AS n FROM m_kuyruk WHERE durum IN ('onaylandi','oynuyor')").first();
  return cevap({ tamam: true, sira: bekleyen?.n || 1, krediler: await krediGetir(env, kullanici) }, 200, request, env);
}

// Eski usul: seçim yap, sonra Kick'te "Medya Oynat" ödülünü al
async function apiSec(request, env) {
  const kullanici = await oturumCoz(request, env);
  if (!kullanici) return cevap({ hata: "önce giriş yap" }, 401, request, env);
  const { medyaId } = await request.json();
  const medya = await env.DB.prepare("SELECT id FROM m_medya WHERE id = ?").bind(medyaId).first();
  if (!medya) return cevap({ hata: "medya bulunamadı" }, 404, request, env);
  await env.DB.prepare(
    "INSERT INTO m_secim (kullanici, medya_id, zaman) VALUES (?, ?, ?) " +
    "ON CONFLICT(kullanici) DO UPDATE SET medya_id = excluded.medya_id, zaman = excluded.zaman"
  ).bind(kullanici, medyaId, Date.now()).run();
  return cevap({ tamam: true }, 200, request, env);
}

// ================= Kick webhook =================

const KABUL_DURUMLARI = ["", "pending", "accepted", "approved", "fulfilled"];
const RED_DURUMLARI = ["rejected", "refunded", "canceled", "cancelled"];
const IMZA_ZAMAN_PENCERESI_MS = 5 * 60 * 1000;

// Kick webhook imza doğrulama (RSA-SHA256, messageId.timestamp.body üzerinden).
// Sahte webhook ile kendine token yazdırmayı imkânsız kılar.
let kickImzaAnahtari = null;
async function kickPublicKey(env) {
  if (kickImzaAnahtari) return kickImzaAnahtari;
  const pem = (env.KICK_PUBLIC_KEY || KICK_PUBLIC_KEY_PEM)
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  kickImzaAnahtari = await crypto.subtle.importKey(
    "spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return kickImzaAnahtari;
}

async function webhookImzaGecerliMi(request, ham, env) {
  if (env.WEBHOOK_DOGRULAMA === "0") return true; // acil durum kapatma anahtarı
  const imza = request.headers.get("Kick-Event-Signature");
  const mesajId = request.headers.get("Kick-Event-Message-Id");
  const zaman = request.headers.get("Kick-Event-Message-Timestamp");
  if (!imza || !mesajId || !zaman) return false;
  const t = Date.parse(zaman);
  if (!t || Math.abs(Date.now() - t) > IMZA_ZAMAN_PENCERESI_MS) return false; // tekrar oynatma (replay) koruması
  try {
    const anahtar = await kickPublicKey(env);
    const veri = new TextEncoder().encode(`${mesajId}.${zaman}.${ham}`);
    const imzaBayt = Uint8Array.from(atob(imza), c => c.charCodeAt(0));
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", anahtar, imzaBayt, veri);
  } catch (e) { return false; }
}

async function webhookKick(request, env, ctx) {
  const tip = request.headers.get("Kick-Event-Type") || "";
  const ham = await request.text();

  if (!(await webhookImzaGecerliMi(request, ham, env))) {
    await logla(env, "imza-gecersiz", "SAHTE/İMZASIZ webhook reddedildi: " + ham.slice(0, 500));
    return new Response("imza geçersiz", { status: 401 });
  }
  await logla(env, tip || "webhook", ham);

  let govde = {};
  try { govde = JSON.parse(ham); } catch (e) { return new Response("ok"); }
  if (!tip.includes("reward")) return new Response("ok");

  const kullanici = (govde.redeemer?.username || govde.user?.username || govde.username || "").toLowerCase();
  const odulBaslik = govde.reward?.title || "";
  const rid = String(govde.id || "");
  const durum = (govde.status || "").toLowerCase();
  const tur = odulTuru(odulBaslik);
  const carpan = (EGZERSIZ_TURLERI.includes(tur) || tur === "tts") ? odulCarpan(odulBaslik) : 1; // "5x Şınav Token" -> 5

  if (!kullanici || !tur) return new Response("ok");

  // ---- Eski usul "Medya Oynat" ödülü ----
  if (tur === "medya") {
    if (RED_DURUMLARI.includes(durum)) return new Response("ok");
    if (rid) {
      const onceki = await env.DB.prepare("SELECT rid FROM m_islenen WHERE rid = ?").bind(rid).first();
      if (onceki) return new Response("ok");
      await env.DB.prepare("INSERT INTO m_islenen (rid, durum, kullanici, tur, zaman) VALUES (?, 'verildi', ?, 'medya', ?)")
        .bind(rid, kullanici, Date.now()).run();
    }
    const secim = await env.DB.prepare("SELECT * FROM m_secim WHERE kullanici = ? AND zaman > ?")
      .bind(kullanici, Date.now() - SECIM_GECERLILIK_MS).first();
    if (secim) {
      await env.DB.prepare(
        "INSERT INTO m_kuyruk (kullanici, medya_id, durum, kaynak, rid, tur, zaman) VALUES (?, ?, 'onaylandi', 'odul', ?, 'medya', ?)"
      ).bind(kullanici, secim.medya_id, rid, Date.now()).run();
      await env.DB.prepare("DELETE FROM m_secim WHERE kullanici = ?").bind(kullanici).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO m_kuyruk (kullanici, medya_id, durum, kaynak, rid, tur, zaman) VALUES (?, 0, 'eslesmedi', 'odul', ?, 'medya', ?)"
      ).bind(kullanici, rid, Date.now()).run();
      await logla(env, "secim-yok", kullanici + " Medya Oynat aldı ama sitede seçim yapmamış");
    }
    return new Response("ok");
  }

  // ---- Counter sistemi: video / ses / foto / şınav / mekik / tts hakkı ----
  const onceki = rid ? await env.DB.prepare("SELECT * FROM m_islenen WHERE rid = ?").bind(rid).first() : null;

  if (RED_DURUMLARI.includes(durum)) {
    // Kick tarafında reddedildi/iade edildi -> verilmiş hakkı geri al (verilen adet kadar)
    if (onceki && onceki.durum === "verildi") {
      const geriAl = Math.max(1, onceki.adet || 1);
      await env.DB.prepare("UPDATE m_krediler SET adet = MAX(0, adet - ?) WHERE kullanici = ? AND tur = ?")
        .bind(geriAl, kullanici, tur).run();
      await env.DB.prepare("UPDATE m_islenen SET durum = 'geri_alindi' WHERE rid = ?").bind(rid).run();
      await logla(env, "hak-geri-alindi", `${kullanici} -${geriAl} ${tur} (${rid})`);
    } else if (rid && !onceki) {
      await env.DB.prepare("INSERT INTO m_islenen (rid, durum, kullanici, tur, zaman, adet) VALUES (?, 'reddedildi', ?, ?, ?, 0)")
        .bind(rid, kullanici, tur, Date.now()).run();
    }
    return new Response("ok");
  }

  if (!KABUL_DURUMLARI.includes(durum)) return new Response("ok");
  if (onceki) return new Response("ok"); // aynı redemption iki kere sayılmaz

  if (rid) {
    await env.DB.prepare("INSERT INTO m_islenen (rid, durum, kullanici, tur, zaman, adet) VALUES (?, 'verildi', ?, ?, ?, ?)")
      .bind(rid, kullanici, tur, Date.now(), carpan).run();
  }
  await env.DB.prepare(
    "INSERT INTO m_krediler (kullanici, tur, adet) VALUES (?, ?, ?) " +
    "ON CONFLICT(kullanici, tur) DO UPDATE SET adet = adet + ?"
  ).bind(kullanici, tur, carpan, carpan).run();
  await logla(env, "hak-verildi", `${kullanici} +${carpan} ${tur} (${odulBaslik})`);

  // Bekleyen redemption'ı Kick tarafında otomatik kabul et (panelde birikmesin)
  if (durum === "pending" && rid && ctx) {
    ctx.waitUntil(redemptionKabul(rid, env));
  }
  return new Response("ok");
}

async function redemptionKabul(rid, env) {
  try {
    const token = await yayinciToken(env);
    if (!token) return;
    await fetch(KICK_API + "/channels/rewards/redemptions/accept", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [rid] }),
    });
  } catch (e) {}
}

async function redemptionRed(rid, env) {
  try {
    const token = await yayinciToken(env);
    if (!token) return;
    await fetch(KICK_API + "/channels/rewards/redemptions/reject", {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [rid] }),
    });
  } catch (e) {}
}

// ================= Overlay =================

async function overlaySiradaki(request, env) {
  // Takılı kalmış "oynuyor" kaydı varsa kurtar (OBS kapanmış olabilir)
  await env.DB.prepare("UPDATE m_kuyruk SET durum = 'oynadi' WHERE durum = 'oynuyor' AND zaman < ?")
    .bind(Date.now() - OYNUYOR_ZAMAN_ASIMI_MS).run();

  const suanki = await env.DB.prepare("SELECT id FROM m_kuyruk WHERE durum = 'oynuyor' LIMIT 1").first();
  if (suanki) return cevap(null, 200, request, env); // hâlâ bir şey oynuyor, bekle

  const sira = await env.DB.prepare(
    "SELECT k.id, k.kullanici, k.kaynak, k.adet, k.tur AS ktur, k.metin, k.ses, m.tur, m.baslik, m.url, m.sure FROM m_kuyruk k " +
    "LEFT JOIN m_medya m ON m.id = k.medya_id " +
    "WHERE k.durum = 'onaylandi' AND (k.kaynak IN ('egzersiz','tts') OR m.id IS NOT NULL) ORDER BY k.id LIMIT 1"
  ).first();
  if (!sira) return cevap(null, 200, request, env);

  await env.DB.prepare("UPDATE m_kuyruk SET durum = 'oynuyor', zaman = ? WHERE id = ?").bind(Date.now(), sira.id).run();

  if (sira.kaynak === "egzersiz") {
    return cevap({ tur: "egzersiz", egzersizTur: sira.ktur, adet: sira.adet, izleyici: sira.kullanici }, 200, request, env);
  }
  if (sira.kaynak === "tts") {
    return cevap({ tur: "tts", id: sira.id, ses: sira.ses, metin: sira.metin, izleyici: sira.kullanici }, 200, request, env);
  }
  return cevap({ tur: sira.tur, baslik: sira.baslik, url: sira.url, sure: sira.sure, izleyici: sira.kullanici }, 200, request, env);
}

async function overlayBitti(request, env) {
  const oynayan = await env.DB.prepare("SELECT * FROM m_kuyruk WHERE durum = 'oynuyor' ORDER BY id LIMIT 1").first();
  if (oynayan) {
    await env.DB.prepare("UPDATE m_kuyruk SET durum = 'oynadi' WHERE id = ?").bind(oynayan.id).run();
    if (oynayan.medya_id) {
      await env.DB.prepare("UPDATE m_medya SET oynatma = oynatma + 1 WHERE id = ?").bind(oynayan.medya_id).run();
    }
  }
  return cevap({ tamam: true }, 200, request, env);
}

// ElevenLabs TTS proxy — API anahtarı asla tarayıcıya inmez, ses worker üzerinden servis edilir
async function elevenKey(env) {
  if (env.ELEVENLABS_KEY) return env.ELEVENLABS_KEY;
  const kayit = await env.DB.prepare("SELECT deger FROM m_ayar WHERE anahtar = 'eleven_key'").first().catch(() => null);
  return kayit?.deger || "";
}

async function elevenSesHaritasi(env) {
  const kayit = await env.DB.prepare("SELECT deger FROM m_ayar WHERE anahtar = 'eleven_sesler'").first().catch(() => null);
  let ozel = {};
  try { ozel = JSON.parse(kayit?.deger || "{}"); } catch (e) {}
  return ozel;
}

// Bir ses id'si için kullanılacak ElevenLabs voice_id'yi çöz
async function elevenVoiceId(env, sesId) {
  const ozel = await elevenSesHaritasi(env);
  if (ozel[sesId]) return ozel[sesId];                    // admin panelinden eşlenmiş
  if (EL_VARSAYILAN[sesId]) return EL_VARSAYILAN[sesId];  // klasik seslerin hazır ID'si
  const yedek = EL_YEDEK[sesId];                          // karakter eşlenmemişse en yakın klasik
  return (yedek && (ozel[yedek] || EL_VARSAYILAN[yedek])) || EL_VARSAYILAN["kalin-erkek"];
}

async function overlayTtsSes(url, request, env) {
  const id = Number(url.searchParams.get("id") || 0);
  const kayit = await env.DB.prepare(
    "SELECT * FROM m_kuyruk WHERE id = ? AND kaynak = 'tts' AND durum IN ('oynuyor','onaylandi')"
  ).bind(id).first();
  if (!kayit || !kayit.metin) return cevap({ hata: "tts kaydı yok" }, 404, request, env);

  const anahtar = await elevenKey(env);
  if (!anahtar) return cevap({ hata: "elevenlabs anahtarı yok" }, 404, request, env);

  const voiceId = await elevenVoiceId(env, kayit.ses);
  const res = await fetch(`${EL_API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": anahtar, "Content-Type": "application/json" },
    body: JSON.stringify({ text: kayit.metin, model_id: EL_MODEL }),
  });
  if (!res.ok) {
    await logla(env, "eleven-hata", `${res.status}: ${(await res.text()).slice(0, 300)}`);
    return cevap({ hata: "elevenlabs " + res.status }, 502, request, env);
  }
  return new Response(res.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": corsOrigin(request, env),
    },
  });
}

// ================= Dosya deposu (D1, base64) — PC'den direkt foto yükleme =================

function b64Kodla(buf) {
  const bayt = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bayt.length; i += 0x8000) s += String.fromCharCode.apply(null, bayt.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64Coz(s) {
  const ikili = atob(s);
  const bayt = new Uint8Array(ikili.length);
  for (let i = 0; i < ikili.length; i++) bayt[i] = ikili.charCodeAt(i);
  return bayt;
}

async function dosyaSun(ad, env) {
  const kayit = await env.DB.prepare("SELECT ct, veri FROM m_dosya WHERE ad = ?").bind(ad).first().catch(() => null);
  if (!kayit) return new Response("bulunamadı", { status: 404 });
  return new Response(b64Coz(kayit.veri), {
    headers: { "Content-Type": kayit.ct, "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" },
  });
}

async function adminDosyaYukle(url, request, env) {
  const hamAd = url.searchParams.get("ad") || "dosya";
  const ad = Date.now().toString(36) + "-" + hamAd.toLocaleLowerCase("tr")
    .replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g").replace(/[ıİi]/g, "i").replace(/[öÖ]/g, "o").replace(/[şŞ]/g, "s").replace(/[üÜ]/g, "u")
    .replace(/[^a-z0-9._-]/g, "-").slice(0, 80);
  const veri = await request.arrayBuffer();
  if (veri.byteLength < 100) return cevap({ hata: "dosya boş" }, 400, request, env);
  if (veri.byteLength > DOSYA_MAX_BAYT) return cevap({ hata: `dosya çok büyük (max ${Math.floor(DOSYA_MAX_BAYT / 1024)} KB) — site zaten fotoyu küçültüyor, yine sığmadıysa daha küçük foto dene` }, 400, request, env);
  const ct = request.headers.get("Content-Type") || "application/octet-stream";
  await env.DB.prepare("INSERT INTO m_dosya (ad, ct, veri, zaman) VALUES (?, ?, ?, ?) ON CONFLICT(ad) DO UPDATE SET ct = excluded.ct, veri = excluded.veri")
    .bind(ad, ct, b64Kodla(veri), Date.now()).run();
  return cevap({ tamam: true, url: new URL(request.url).origin + "/dosya/" + ad }, 200, request, env);
}

// ================= Admin =================

async function adminElevenKey(request, env) {
  const { key } = await request.json();
  if (!key || key.length < 10) return cevap({ hata: "geçersiz anahtar" }, 400, request, env);
  await env.DB.prepare("INSERT INTO m_ayar (anahtar, deger) VALUES ('eleven_key', ?) ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger")
    .bind(key.trim()).run();
  // anahtarı doğrula
  const res = await fetch(EL_API + "/user", { headers: { "xi-api-key": key.trim() } }).catch(() => null);
  const bilgi = res && res.ok ? await res.json().catch(() => null) : null;
  return cevap({
    tamam: true,
    dogrulandi: !!bilgi,
    kalanKredi: bilgi?.subscription ? (bilgi.subscription.character_limit - bilgi.subscription.character_count) : null,
  }, 200, request, env);
}

// ElevenLabs topluluk kütüphanesinde ses ara (karakter sesleri buradan bulunur)
async function adminElevenAra(url, request, env) {
  const anahtar = await elevenKey(env);
  if (!anahtar) return cevap({ hata: "önce ElevenLabs anahtarını kaydet" }, 400, request, env);
  const q = (url.searchParams.get("q") || "").slice(0, 60);
  if (!q) return cevap({ hata: "q gerekli" }, 400, request, env);
  const res = await fetch(EL_API + "/shared-voices?page_size=8&search=" + encodeURIComponent(q), {
    headers: { "xi-api-key": anahtar },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok) return cevap({ hata: "elevenlabs " + res.status, detay: j }, 502, request, env);
  const sesler = (j?.voices || []).map(v => ({
    voice_id: v.voice_id,
    public_owner_id: v.public_owner_id,
    ad: v.name,
    dil: v.language || "",
    kullanim: v.cloned_by_count || 0,
    ucretsizMi: !(v.is_added_by_user) && (v.free_users_allowed !== false),
    onizleme: v.preview_url || "",
  }));
  return cevap(sesler, 200, request, env);
}

// Bulunan sesi hesabın My Voices'ına ekle ve karaktere eşle
async function adminElevenEkle(request, env) {
  const anahtar = await elevenKey(env);
  if (!anahtar) return cevap({ hata: "önce ElevenLabs anahtarını kaydet" }, 400, request, env);
  const { public_owner_id, voice_id, ad, sesId } = await request.json();
  if (!public_owner_id || !voice_id || !TTS_SES_IDLERI.includes(sesId)) {
    return cevap({ hata: "public_owner_id, voice_id ve geçerli sesId gerekli" }, 400, request, env);
  }
  const res = await fetch(`${EL_API}/voices/add/${public_owner_id}/${voice_id}`, {
    method: "POST",
    headers: { "xi-api-key": anahtar, "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: (ad || sesId).slice(0, 60) }),
  });
  const j = await res.json().catch(() => null);
  // "zaten ekli" hatası da başarı sayılır — eşlemeye devam et
  const zatenEkli = !res.ok && JSON.stringify(j || {}).includes("already");
  if (!res.ok && !zatenEkli) {
    await logla(env, "eleven-ekle-hata", `${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return cevap({ hata: "elevenlabs " + res.status, detay: j }, 502, request, env);
  }
  const yeniVoiceId = j?.voice_id || voice_id;
  const ozel = await elevenSesHaritasi(env);
  ozel[sesId] = yeniVoiceId;
  await env.DB.prepare("INSERT INTO m_ayar (anahtar, deger) VALUES ('eleven_sesler', ?) ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger")
    .bind(JSON.stringify(ozel)).run();
  return cevap({ tamam: true, sesId, voice_id: yeniVoiceId }, 200, request, env);
}

async function adminElevenSesler(request, env) {
  const ozel = await elevenSesHaritasi(env);
  const anahtar = await elevenKey(env);
  return cevap({ anahtarVar: !!anahtar, varsayilan: EL_VARSAYILAN, ozel }, 200, request, env);
}

async function adminElevenSeslerKaydet(request, env) {
  const { sesler } = await request.json();
  if (typeof sesler !== "object" || !sesler) return cevap({ hata: "sesler objesi gerekli" }, 400, request, env);
  const temiz = {};
  for (const [k, v] of Object.entries(sesler)) {
    if (TTS_SES_IDLERI.includes(k) && typeof v === "string" && /^[A-Za-z0-9]{10,40}$/.test(v.trim())) temiz[k] = v.trim();
  }
  await env.DB.prepare("INSERT INTO m_ayar (anahtar, deger) VALUES ('eleven_sesler', ?) ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger")
    .bind(JSON.stringify(temiz)).run();
  return cevap({ tamam: true, kayitli: temiz }, 200, request, env);
}

// Tek seferlik kurulum: yeni tablolar + örnek medya + ESKİ SİSTEMİN TÜM TABLOLARINI SİL
async function adminKur(request, env) {
  const eskiTablolar = ["site", "dosyalar", "medya", "kuyruk", "secimler", "oneriler", "yayinci", "ayarlar", "loglar"];
  const silinen = [];
  for (const t of eskiTablolar) {
    try { await env.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run(); silinen.push(t); } catch (e) {}
  }
  const adet = await env.DB.prepare("SELECT COUNT(*) AS n FROM m_medya").first();
  let ornekEklendi = false;
  if (!adet?.n) {
    await env.DB.prepare(
      "INSERT INTO m_medya (tur, baslik, url, thumb, sure, eklenme, tagler) VALUES ('video', 'Kırmızı Gömlekli Adam (test)', 'dosyalar/kirmizi-gomlekli-adam.mp4', NULL, 0, ?, '[\"test\"]')"
    ).bind(Date.now()).run();
    ornekEklendi = true;
  }
  return cevap({ tamam: true, eskiTablolarSilindi: silinen, ornekMedyaEklendi: ornekEklendi }, 200, request, env);
}

async function adminKrediler(request, env) {
  const { results } = await env.DB.prepare(
    "SELECT kullanici, " +
    "SUM(CASE WHEN tur='video' THEN adet ELSE 0 END) AS video, " +
    "SUM(CASE WHEN tur='ses' THEN adet ELSE 0 END) AS ses, " +
    "SUM(CASE WHEN tur='foto' THEN adet ELSE 0 END) AS foto, " +
    "SUM(CASE WHEN tur='sinav' THEN adet ELSE 0 END) AS sinav, " +
    "SUM(CASE WHEN tur='tts' THEN adet ELSE 0 END) AS tts " +
    "FROM m_krediler GROUP BY kullanici ORDER BY kullanici"
  ).all();
  return cevap(results, 200, request, env);
}

// Hata düzeltme: elle hak ekle/çıkar
async function adminKredi(request, env) {
  const { kullanici, tur, delta } = await request.json();
  const ad = (kullanici || "").toLowerCase().trim();
  if (!ad || !HAK_TURLERI.includes(tur) || !Number.isInteger(delta)) {
    return cevap({ hata: "kullanici, tur (video/ses/foto/sinav/mekik/tts) ve tam sayı delta gerekli" }, 400, request, env);
  }
  await env.DB.prepare(
    "INSERT INTO m_krediler (kullanici, tur, adet) VALUES (?, ?, MAX(0, ?)) " +
    "ON CONFLICT(kullanici, tur) DO UPDATE SET adet = MAX(0, adet + ?)"
  ).bind(ad, tur, delta, delta).run();
  await logla(env, "admin-kredi", `${ad} ${tur} ${delta > 0 ? "+" : ""}${delta}`);
  return cevap({ tamam: true, krediler: await krediGetir(env, ad) }, 200, request, env);
}

async function adminKuyruk(request, env) {
  const { results } = await env.DB.prepare(
    "SELECT k.id, k.kullanici, k.durum, k.kaynak, k.tur, k.zaman, k.adet, " +
    "COALESCE(m.baslik, CASE WHEN k.kaynak='egzersiz' THEN (k.adet || 'x ' || CASE k.tur WHEN 'sinav' THEN 'şınav' ELSE k.tur END) " +
    "WHEN k.kaynak='tts' THEN ('TTS [' || COALESCE(k.ses,'?') || ']: ' || SUBSTR(COALESCE(k.metin,''), 1, 80)) ELSE '(seçim eşleşmedi)' END) AS medya " +
    "FROM m_kuyruk k LEFT JOIN m_medya m ON m.id = k.medya_id " +
    "WHERE k.zaman > ? ORDER BY k.id DESC LIMIT 100"
  ).bind(Date.now() - 24 * 3600 * 1000).all();
  return cevap(results, 200, request, env);
}

// Kuyruk iptali — istenirse hak iadesiyle
async function adminKuyrukIptal(id, request, env) {
  const { iade } = await request.json().catch(() => ({}));
  const kayit = await env.DB.prepare("SELECT * FROM m_kuyruk WHERE id = ?").bind(id).first();
  if (!kayit) return cevap({ hata: "kayıt yok" }, 404, request, env);
  if (!["onaylandi", "oynuyor", "eslesmedi"].includes(kayit.durum)) {
    return cevap({ hata: "bu kayıt iptal edilemez (durum: " + kayit.durum + ")" }, 400, request, env);
  }
  await env.DB.prepare("UPDATE m_kuyruk SET durum = 'iptal' WHERE id = ?").bind(id).run();

  if (iade) {
    if ((kayit.kaynak === "kredi" || kayit.kaynak === "egzersiz" || kayit.kaynak === "tts") && HAK_TURLERI.includes(kayit.tur)) {
      // Krediyle/tokenla alınmıştı -> hakkı geri ver (egzersizde harcanan adet kadar)
      const geriVer = kayit.kaynak === "egzersiz" ? Math.max(1, kayit.adet || 1) : 1;
      await env.DB.prepare(
        "INSERT INTO m_krediler (kullanici, tur, adet) VALUES (?, ?, ?) " +
        "ON CONFLICT(kullanici, tur) DO UPDATE SET adet = adet + ?"
      ).bind(kayit.kullanici, kayit.tur, geriVer, geriVer).run();
    } else if (kayit.kaynak === "odul" && kayit.rid) {
      // Eski usul ödüldü -> Kick'te reddet (puan iadesi)
      await redemptionRed(kayit.rid, env);
    }
  }
  await logla(env, "admin-iptal", `kuyruk #${id} iptal, iade: ${!!iade}`);
  return cevap({ tamam: true }, 200, request, env);
}

async function adminMedyaEkle(request, env) {
  const { tur, baslik, url, thumb, sure, tagler } = await request.json();
  if (!MEDYA_TURLERI.includes(tur)) return cevap({ hata: "tur video/ses/foto olmalı" }, 400, request, env);
  if (!url) return cevap({ hata: "url gerekli" }, 400, request, env);
  let kThumb = thumb || null;
  if (tur === "foto" && !kThumb) kThumb = url;
  // Etiketler: dizi ya da "komik, korku" / "#komik #korku" metni kabul et, normalize et
  const hamTagler = Array.isArray(tagler) ? tagler : String(tagler || "").split(/[,#\s]+/);
  const temizTagler = [...new Set(hamTagler
    .map(t => String(t).trim().toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}-]/gu, ""))
    .filter(t => t.length > 0 && t.length <= 24))].slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO m_medya (tur, baslik, url, thumb, sure, eklenme, tagler) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(tur, (baslik || "Adsız").slice(0, 120), url.slice(0, 500), kThumb, Number(sure) || 0, Date.now(), JSON.stringify(temizTagler)).run();
  return apiMedya(request, env);
}

async function adminMedyaSil(id, request, env) {
  await env.DB.prepare("DELETE FROM m_medya WHERE id = ?").bind(id).run();
  return cevap({ tamam: true }, 200, request, env);
}

async function adminLoglar(request, env) {
  const { results } = await env.DB.prepare("SELECT * FROM m_log ORDER BY id DESC LIMIT 30").all();
  return cevap(results, 200, request, env);
}

async function adminTest(request, env) {
  const { medyaId, kullanici, tur } = await request.json();
  // Test 1: kuyruğa direkt medya at (overlay testi)
  if (medyaId) {
    const m = await env.DB.prepare("SELECT id FROM m_medya WHERE id = ?").bind(medyaId).first();
    if (!m) return cevap({ hata: "medya yok" }, 404, request, env);
    await env.DB.prepare(
      "INSERT INTO m_kuyruk (kullanici, medya_id, durum, kaynak, rid, tur, zaman) VALUES ('test', ?, 'onaylandi', 'test', '', 'video', ?)"
    ).bind(medyaId, Date.now()).run();
    return cevap({ tamam: true, mesaj: "kuyruğa eklendi, overlay birazdan oynatır" }, 200, request, env);
  }
  // Test 2: sahte webhook — sanki izleyici ödül almış gibi hak ver (counter testi)
  if (kullanici && HAK_TURLERI.includes(tur)) {
    await env.DB.prepare(
      "INSERT INTO m_krediler (kullanici, tur, adet) VALUES (?, ?, 1) " +
      "ON CONFLICT(kullanici, tur) DO UPDATE SET adet = adet + 1"
    ).bind(kullanici.toLowerCase(), tur).run();
    return cevap({ tamam: true, mesaj: `${kullanici} +1 ${tur}` }, 200, request, env);
  }
  return cevap({ hata: "medyaId veya (kullanici + tur) gönder" }, 400, request, env);
}

async function adminKickSecret(request, env) {
  const { secret } = await request.json();
  if (!secret || secret.length < 10) return cevap({ hata: "geçersiz değer" }, 400, request, env);
  await env.DB.prepare(
    "INSERT INTO m_ayar (anahtar, deger) VALUES ('kick_secret', ?) ON CONFLICT(anahtar) DO UPDATE SET deger = excluded.deger"
  ).bind(secret).run();
  return cevap({ tamam: true }, 200, request, env);
}

async function adminWebhookAbone(request, env) {
  const token = await yayinciToken(env);
  if (!token) return cevap({ hata: "önce yayıncı hesabıyla giriş yap (Kurulum sekmesi, 2. adım)" }, 400, request, env);
  const res = await fetch(KICK_API + "/events/subscriptions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "webhook",
      events: [{ name: "channel.reward.redemption.updated", version: 1 }],
    }),
  });
  return cevap({ durum: res.status, cevap: await res.json().catch(() => null) }, 200, request, env);
}
