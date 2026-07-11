// ============================================================
//  WIBLEGON MEDYA v2 — Kick sadakat puanı sayaç (counter) sistemi
//  Cloudflare Worker + D1
//
//  Nasıl çalışır:
//   1. İzleyici Kick'te ödül alır: "Video Oynat" (250), "Ses Oynat" (200), "Foto Oynat" (100)
//   2. Kick webhook'u buraya düşer -> izleyicinin hakkı +1 artar
//   3. İzleyici sitede Kick ile giriş yapar, hakkını görür,
//      kütüphaneden medya seçip istediği zaman oynatır -> hakkı -1 azalır
//   4. OBS overlay kuyruğu çekip yayında oynatır
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

// Ödül adı -> hak türü eşleşmesi (başlık içinde geçen kelimeye göre, büyük/küçük harf önemsiz)
function odulTuru(baslik) {
  // hem normal hem Türkçe küçük harfe çevirip ikisine de bak (VIDEO / VİDEO ikisi de yakalanır)
  const adaylar = [(baslik || "").toLowerCase(), (baslik || "").toLocaleLowerCase("tr")];
  const icerir = (k) => adaylar.some(b => b.includes(k));
  if (icerir("medya")) return "medya";                          // eski usul direkt oynatma
  if (icerir("video") || icerir("klip")) return "video";
  if (icerir("ses") || icerir("müzik") || icerir("muzik") || icerir("şarkı") || icerir("sarki")) return "ses";
  if (icerir("foto") || icerir("resim") || icerir("görsel") || icerir("gorsel")) return "foto";
  return null;
}

const HAK_TURLERI = ["video", "ses", "foto"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const yol = url.pathname;

    if (request.method === "OPTIONS") return cevap(null, 204, request, env);

    try {
      await dbKur(env);

      if (yol === "/" || yol === "/api/saglik") return cevap({ tamam: true, surum: "medya-v2" }, 200, request, env);

      if (yol === "/auth/login") return authLogin(url, env);
      if (yol === "/auth/callback") return authCallback(url, request, env);

      if (yol === "/api/ben" && request.method === "GET") return apiBen(request, env);
      if (yol === "/api/medya" && request.method === "GET") return apiMedya(request, env);
      if (yol === "/api/durum" && request.method === "GET") return apiDurum(request, env);
      if (yol === "/api/oynat" && request.method === "POST") return apiOynat(request, env);
      if (yol === "/api/sec" && request.method === "POST") return apiSec(request, env);

      if (yol === "/webhook/kick" && request.method === "POST") return webhookKick(request, env, ctx);

      if (yol === "/api/overlay/siradaki" && request.method === "GET") return overlaySiradaki(request, env);
      if (yol === "/api/overlay/bitti" && request.method === "POST") return overlayBitti(request, env);

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
    `CREATE TABLE IF NOT EXISTS m_islenen (rid TEXT PRIMARY KEY, durum TEXT, kullanici TEXT, tur TEXT, zaman INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_medya (id INTEGER PRIMARY KEY AUTOINCREMENT, tur TEXT, baslik TEXT, url TEXT, thumb TEXT, sure INTEGER DEFAULT 0, oynatma INTEGER DEFAULT 0, eklenme INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_kuyruk (id INTEGER PRIMARY KEY AUTOINCREMENT, kullanici TEXT, medya_id INTEGER, durum TEXT, kaynak TEXT, rid TEXT, tur TEXT, zaman INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_secim (kullanici TEXT PRIMARY KEY, medya_id INTEGER, zaman INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_yayinci (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT, refresh_token TEXT, bitis INTEGER)`,
    `CREATE TABLE IF NOT EXISTS m_log (id INTEGER PRIMARY KEY AUTOINCREMENT, zaman TEXT, tip TEXT, govde TEXT)`,
    `CREATE TABLE IF NOT EXISTS m_ayar (anahtar TEXT PRIMARY KEY, deger TEXT)`,
  ];
  for (const s of t) await env.DB.prepare(s).run();
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
  const k = { video: 0, ses: 0, foto: 0 };
  for (const r of results) if (k[r.tur] !== undefined) k[r.tur] = r.adet;
  return k;
}

async function apiBen(request, env) {
  const kullanici = await oturumCoz(request, env);
  if (!kullanici) return cevap({ hata: "giriş yok" }, 401, request, env);
  return cevap({ ad: kullanici, krediler: await krediGetir(env, kullanici) }, 200, request, env);
}

async function apiMedya(request, env) {
  const { results } = await env.DB.prepare("SELECT id, tur, baslik, url, thumb, sure, oynatma FROM m_medya ORDER BY id DESC").all();
  return cevap(results, 200, request, env);
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

  const { medyaId } = await request.json();
  const medya = await env.DB.prepare("SELECT * FROM m_medya WHERE id = ?").bind(medyaId).first();
  if (!medya) return cevap({ hata: "medya bulunamadı" }, 404, request, env);
  if (!HAK_TURLERI.includes(medya.tur)) return cevap({ hata: "geçersiz medya türü" }, 400, request, env);

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

async function webhookKick(request, env, ctx) {
  const tip = request.headers.get("Kick-Event-Type") || "";
  const ham = await request.text();
  await logla(env, tip || "webhook", ham);

  let govde = {};
  try { govde = JSON.parse(ham); } catch (e) { return new Response("ok"); }
  if (!tip.includes("reward")) return new Response("ok");

  const kullanici = (govde.redeemer?.username || govde.user?.username || govde.username || "").toLowerCase();
  const odulBaslik = govde.reward?.title || "";
  const rid = String(govde.id || "");
  const durum = (govde.status || "").toLowerCase();
  const tur = odulTuru(odulBaslik);

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

  // ---- Counter sistemi: video / ses / foto hakkı ----
  const onceki = rid ? await env.DB.prepare("SELECT * FROM m_islenen WHERE rid = ?").bind(rid).first() : null;

  if (RED_DURUMLARI.includes(durum)) {
    // Kick tarafında reddedildi/iade edildi -> verilmiş hakkı geri al
    if (onceki && onceki.durum === "verildi") {
      await env.DB.prepare("UPDATE m_krediler SET adet = adet - 1 WHERE kullanici = ? AND tur = ? AND adet > 0")
        .bind(kullanici, tur).run();
      await env.DB.prepare("UPDATE m_islenen SET durum = 'geri_alindi' WHERE rid = ?").bind(rid).run();
      await logla(env, "hak-geri-alindi", `${kullanici} ${tur} (${rid})`);
    } else if (rid && !onceki) {
      await env.DB.prepare("INSERT INTO m_islenen (rid, durum, kullanici, tur, zaman) VALUES (?, 'reddedildi', ?, ?, ?)")
        .bind(rid, kullanici, tur, Date.now()).run();
    }
    return new Response("ok");
  }

  if (!KABUL_DURUMLARI.includes(durum)) return new Response("ok");
  if (onceki) return new Response("ok"); // aynı redemption iki kere sayılmaz

  if (rid) {
    await env.DB.prepare("INSERT INTO m_islenen (rid, durum, kullanici, tur, zaman) VALUES (?, 'verildi', ?, ?, ?)")
      .bind(rid, kullanici, tur, Date.now()).run();
  }
  await env.DB.prepare(
    "INSERT INTO m_krediler (kullanici, tur, adet) VALUES (?, ?, 1) " +
    "ON CONFLICT(kullanici, tur) DO UPDATE SET adet = adet + 1"
  ).bind(kullanici, tur).run();
  await logla(env, "hak-verildi", `${kullanici} +1 ${tur} (${odulBaslik})`);

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
    "SELECT k.id, k.kullanici, m.tur, m.baslik, m.url, m.sure FROM m_kuyruk k " +
    "JOIN m_medya m ON m.id = k.medya_id WHERE k.durum = 'onaylandi' ORDER BY k.id LIMIT 1"
  ).first();
  if (!sira) return cevap(null, 200, request, env);

  await env.DB.prepare("UPDATE m_kuyruk SET durum = 'oynuyor', zaman = ? WHERE id = ?").bind(Date.now(), sira.id).run();
  return cevap({ ...sira, izleyici: sira.kullanici }, 200, request, env);
}

async function overlayBitti(request, env) {
  const oynayan = await env.DB.prepare("SELECT * FROM m_kuyruk WHERE durum = 'oynuyor' ORDER BY id LIMIT 1").first();
  if (oynayan) {
    await env.DB.prepare("UPDATE m_kuyruk SET durum = 'oynadi' WHERE id = ?").bind(oynayan.id).run();
    await env.DB.prepare("UPDATE m_medya SET oynatma = oynatma + 1 WHERE id = ?").bind(oynayan.medya_id).run();
  }
  return cevap({ tamam: true }, 200, request, env);
}

// ================= Admin =================

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
      "INSERT INTO m_medya (tur, baslik, url, thumb, sure, eklenme) VALUES ('video', 'Kırmızı Gömlekli Adam (test)', 'dosyalar/kirmizi-gomlekli-adam.mp4', NULL, 0, ?)"
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
    "SUM(CASE WHEN tur='foto' THEN adet ELSE 0 END) AS foto " +
    "FROM m_krediler GROUP BY kullanici ORDER BY kullanici"
  ).all();
  return cevap(results, 200, request, env);
}

// Hata düzeltme: elle hak ekle/çıkar
async function adminKredi(request, env) {
  const { kullanici, tur, delta } = await request.json();
  const ad = (kullanici || "").toLowerCase().trim();
  if (!ad || !HAK_TURLERI.includes(tur) || !Number.isInteger(delta)) {
    return cevap({ hata: "kullanici, tur (video/ses/foto) ve tam sayı delta gerekli" }, 400, request, env);
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
    "SELECT k.id, k.kullanici, k.durum, k.kaynak, k.tur, k.zaman, COALESCE(m.baslik, '(seçim eşleşmedi)') AS medya " +
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
    if (kayit.kaynak === "kredi" && HAK_TURLERI.includes(kayit.tur)) {
      // Krediyle alınmıştı -> hakkı geri ver
      await env.DB.prepare(
        "INSERT INTO m_krediler (kullanici, tur, adet) VALUES (?, ?, 1) " +
        "ON CONFLICT(kullanici, tur) DO UPDATE SET adet = adet + 1"
      ).bind(kayit.kullanici, kayit.tur).run();
    } else if (kayit.kaynak === "odul" && kayit.rid) {
      // Eski usul ödüldü -> Kick'te reddet (puan iadesi)
      await redemptionRed(kayit.rid, env);
    }
  }
  await logla(env, "admin-iptal", `kuyruk #${id} iptal, iade: ${!!iade}`);
  return cevap({ tamam: true }, 200, request, env);
}

async function adminMedyaEkle(request, env) {
  const { tur, baslik, url, thumb, sure } = await request.json();
  if (!HAK_TURLERI.includes(tur)) return cevap({ hata: "tur video/ses/foto olmalı" }, 400, request, env);
  if (!url) return cevap({ hata: "url gerekli" }, 400, request, env);
  let kThumb = thumb || null;
  if (tur === "foto" && !kThumb) kThumb = url;
  await env.DB.prepare(
    "INSERT INTO m_medya (tur, baslik, url, thumb, sure, eklenme) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(tur, (baslik || "Adsız").slice(0, 120), url.slice(0, 500), kThumb, Number(sure) || 0, Date.now()).run();
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
