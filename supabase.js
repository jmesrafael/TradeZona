// ============================================================
//  supabase.js — Shared Supabase client for TradeZona v2
//  Load this script BEFORE any other scripts on every page.
// ============================================================

const SUPABASE_URL  = "https://oixrpuqylidbunbttftg.supabase.co";
const SUPABASE_ANON = "sb_publishable_0JIYopUpUp6DonOkOzWcJQ_KL0OyIho";

const { createClient } = supabase;

const db = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    storage: window.localStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// ── Auth state watcher ────────────────────────────────────────
db.auth.onAuthStateChange(async (event, session) => {
  const publicPaths = ["/", "/auth", "/confirm", "/reset-password"];
  const path =
    window.location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";

  if (event === "SIGNED_OUT") {
    if (!publicPaths.includes(path)) {
      window.location.href = "/auth";
    }
  }

  if (event === "PASSWORD_RECOVERY") {
    if (!path.includes("reset-password")) {
      window.location.href = "/reset-password";
    }
  }

  // 🧠 REFERRAL LOGIC — apply stored referral code on sign-in
  if (event === "SIGNED_IN" && session?.user) {
    try {
      const refCode = localStorage.getItem("ref_code");
      if (refCode) {
        console.log("[referral] Applying referral code:", refCode);
        const res = await fetch(`${SUPABASE_URL}/functions/v1/apply-referral`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ referral_code: refCode }),
        });
        const data = await res.json();
        console.log("[referral] Response:", data);
        localStorage.removeItem("ref_code"); // Always clear, success or not
      }
    } catch (err) {
      console.error("[referral] Error:", err);
    }
  }
});

// ── requireAuth ───────────────────────────────────────────────
async function requireAuth() {
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) {
    await db.auth.signOut();
    window.location.href = "/auth";
    return null;
  }
  return user;
}

async function getUser() {
  const { data: { user } } = await db.auth.getUser();
  return user;
}

// ── Profile ───────────────────────────────────────────────────
async function getProfile(userId) {
  const { data } = await db
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  return data;
}

/**
 * Update safe profile fields from client (name only).
 * Plan/Stripe/theme fields are updated via dedicated functions.
 */
async function updateProfile(userId, updates) {
  const safe = {};
  if ("name" in updates) safe.name = updates.name;
  if (!Object.keys(safe).length) return;
  const { error } = await db.from("profiles").update(safe).eq("id", userId);
  if (error) throw error;
}

// ── Theme Persistence ─────────────────────────────────────────
/**
 * Persist theme/font to Supabase via secure RPC.
 * localStorage is updated instantly; DB is synced in background.
 */
async function saveThemeToProfile(colorTheme, fontTheme) {
  try {
    const { error } = await db.rpc("update_user_theme", {
      p_color_theme: colorTheme || null,
      p_font_theme:  fontTheme  || null,
    });
    if (error) console.warn("[theme] DB sync failed:", error.message);
    else console.log("[theme] Synced to DB:", { colorTheme, fontTheme });
  } catch (err) {
    console.warn("[theme] DB sync error:", err);
  }
}

/**
 * Apply theme + font from a profile object (on login).
 * Falls back to localStorage → defaults.
 */
function applyProfileTheme(profile) {
  if (!window.TZ) return;
  const colorTheme = profile?.color_theme || localStorage.getItem("tl_theme") || "dark";
  const fontTheme  = profile?.font_theme  || localStorage.getItem("tl_font")  || "default";

  // Sync localStorage so theme.js picks it up on next load
  localStorage.setItem("tl_theme", colorTheme);
  localStorage.setItem("tl_font",  fontTheme);

  TZ.applyTheme(colorTheme);
  TZ.applyFont(fontTheme);
}

// ── Subscription Helpers ──────────────────────────────────────
/**
 * Returns a rich subscription status object.
 */
function getSubscriptionStatus(profile) {
  const isPro = profile?.plan === "pro";
  const expiresAt = profile?.subscription_expires_at;
  const planType  = profile?.plan_type || "none";

  if (!isPro) {
    return { isPro: false, planType: "none", label: "Free", daysLeft: null, expiring: false, expired: false };
  }

  if (!expiresAt) {
    return { isPro: true, planType, label: "Active subscription", daysLeft: null, expiring: false, expired: false };
  }

  const d       = new Date(expiresAt);
  const now     = new Date();
  const daysLeft = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  const expired  = daysLeft <= 0;
  const expiring = !expired && daysLeft <= 7;

  const formatted = d.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  let label;
  if (expired) {
    label = "Expired";
  } else if (daysLeft === 1) {
    label = `Subscription ends on ${formatted} (1 day left)`;
  } else {
    label = `Subscription ends on ${formatted} (${daysLeft} days left)`;
  }

  return { isPro, planType, label, daysLeft, expiring, expired };
}

/**
 * Legacy helper kept for backwards compatibility.
 */
function formatSubscriptionExpiry(isoString) {
  if (!isoString) return null;
  const d   = new Date(isoString);
  const now = new Date();
  if (d < now) return "Expired";
  const diff      = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  const formatted = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  if (diff <= 7) return `Expires soon — ${formatted} (${diff}d left)`;
  return `Renews / expires ${formatted}`;
}

// ── Referrals ─────────────────────────────────────────────────
async function getReferrals(userId) {
  const { data, error } = await db
    .from("referrals")
    .select("id, status, reward_granted, created_at, referred_user_id")
    .eq("referrer_id", userId)
    .order("created_at", { ascending: false });
  if (error) { console.error("getReferrals:", error); return []; }
  return data || [];
}

function buildReferralUrl(referralCode) {
  return `${window.location.origin}/auth?ref=${referralCode}`;
}

// ── Journals ──────────────────────────────────────────────────
async function getJournals(userId) {
  const { data, error } = await db
    .from("journals")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) { console.error("getJournals:", error); return []; }
  return data || [];
}

async function createJournal(userId, { name, capital, pin_hash, show_pnl = true, show_capital = true }) {
  const { data, error } = await db
    .from("journals")
    .insert({ user_id: userId, name, capital: capital || null, pin_hash: pin_hash || null, show_pnl, show_capital })
    .select()
    .single();
  if (error) throw error;

  await db.from("journal_settings").insert({
    journal_id: data.id,
    user_id:    userId,
    strategies: ["Breakout", "Reversal", "Trend"],
    timeframes: ["M15", "H1", "H4"],
    pairs:      ["EURUSD", "XAUUSD", "BTCUSDT"],
    moods:      ["Confident", "Neutral", "Anxious"],
    mood_colors: { Confident: "#19c37d", Neutral: "#8fa39a", Anxious: "#f59e0b" },
  });
  return data;
}

async function updateJournal(journalId, updates) {
  const { error } = await db.from("journals").update(updates).eq("id", journalId);
  if (error) throw error;
}

async function deleteJournal(journalId) {
  const { error } = await db.from("journals").delete().eq("id", journalId);
  if (error) throw error;
}

// ── Trades ────────────────────────────────────────────────────
async function getTrades(journalId) {
  const { data, error } = await db
    .from("trades")
    .select("*, trade_images(id, data)")
    .eq("journal_id", journalId)
    .order("created_at", { ascending: false });
  if (error) { console.error("getTrades:", error); return []; }
  return data || [];
}

async function createTrade(userId, journalId, trade) {
  const { data, error } = await db
    .from("trades")
    .insert({ ...tradeToDb(trade), journal_id: journalId, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateTrade(tradeId, updates) {
  const payload = tradeToDb(updates);
  if (!Object.keys(payload).length) return;
  const { error } = await db.from("trades").update(payload).eq("id", tradeId);
  if (error) throw error;
}

async function deleteTrade(tradeId) {
  const { error } = await db.from("trades").delete().eq("id", tradeId);
  if (error) throw error;
}

// ── DB ↔ UI mapping ───────────────────────────────────────────
function tradeToDb(t) {
  const o = {};
  if ("date"       in t) o.trade_date = t.date || null;
  if ("time"       in t) o.trade_time = t.time || null;
  if ("pair"       in t) o.pair       = t.pair || null;
  if ("position"   in t) o.position   = t.position || null;
  if ("strategy"   in t) o.strategy   = t.strategy || [];
  if ("timeframe"  in t) o.timeframe  = t.timeframe || [];
  if ("pnl" in t) {
    const n = parseFloat(t.pnl);
    o.pnl = !isNaN(n) && t.pnl != null && t.pnl !== "" ? n : null;
  }
  if ("r" in t) {
    const n = parseFloat(t.r);
    o.r_factor = !isNaN(n) && t.r != null && t.r !== "" ? n : null;
  }
  if ("confidence" in t) o.confidence = t.confidence || null;
  if ("mood"       in t) o.mood       = t.mood || [];
  if ("notes"      in t) o.notes      = t.notes || null;
  return o;
}

function dbToTrade(row) {
  return {
    id:         row.id,
    date:       row.trade_date || "",
    time:       row.trade_time ? String(row.trade_time).slice(0, 5) : "",
    pair:       row.pair || "",
    position:   row.position || "Long",
    strategy:   row.strategy || [],
    timeframe:  row.timeframe || [],
    pnl:        row.pnl != null ? String(row.pnl) : "",
    r:          row.r_factor != null ? String(row.r_factor) : "",
    confidence: row.confidence || 0,
    mood:       row.mood || [],
    notes:      row.notes || "",
    images:     (row.trade_images || []).map(img => ({ id: img.id, data: img.data || "" })),
  };
}

// ── Trade Images ──────────────────────────────────────────────
async function addTradeImage(userId, tradeId, base64DataUrl) {
  const { data, error } = await db
    .from("trade_images")
    .insert({ trade_id: tradeId, user_id: userId, data: base64DataUrl })
    .select()
    .single();
  if (error) throw error;
  return { ...data, _previewUrl: base64DataUrl };
}

async function getImageUrl(img) {
  if (!img) return "";
  if (img._previewUrl) return img._previewUrl;
  return img.data || "";
}

async function deleteTradeImage(imageId) {
  const { error } = await db.from("trade_images").delete().eq("id", imageId);
  if (error) throw error;
}

// ── Journal Settings ──────────────────────────────────────────
async function getJournalSettings(journalId) {
  const { data } = await db
    .from("journal_settings")
    .select("*")
    .eq("journal_id", journalId)
    .single();
  return data;
}

async function updateJournalSettings(journalId, updates) {
  const { error } = await db
    .from("journal_settings")
    .update(updates)
    .eq("journal_id", journalId);
  if (error) throw error;
}

// ── Realtime ──────────────────────────────────────────────────
function subscribeTrades(journalId, callback) {
  return db
    .channel("trades:" + journalId)
    .on("postgres_changes", { event: "*", schema: "public", table: "trades", filter: `journal_id=eq.${journalId}` }, callback)
    .subscribe();
}

// ── PIN security (SHA-256 via Web Crypto) ─────────────────────
async function hashPin(pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPin(pin, hash) {
  if (!hash) return true;
  return (await hashPin(pin)) === hash;
}
