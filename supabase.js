// supabase.js — OPTIMIZED
// Handles auth state changes, referral application, helper functions.
// Include this on every page that needs auth.

// ── Config ────────────────────────────────────────────────
const SUPABASE_URL  = "https://oixrpuqylidbunbttftg.supabase.co";
const SUPABASE_ANON = "sb_publishable_0JIYopUpUp6DonOkOzWcJQ_KL0OyIho";

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);


// ══════════════════════════════════════════════════════════
//  IN-MEMORY CACHE
//  Eliminates redundant DB round-trips for stable data
//  (profile, journal settings) across page lifetime.
// ══════════════════════════════════════════════════════════
const _cache = {};

function _cacheSet(key, val, ttlMs = 30000) {
  _cache[key] = { val, exp: Date.now() + ttlMs };
}

function _cacheGet(key) {
  const c = _cache[key];
  if (!c || Date.now() > c.exp) return null;
  return c.val;
}

function _cacheInvalidate(prefix) {
  Object.keys(_cache).forEach(k => {
    if (k.startsWith(prefix)) delete _cache[k];
  });
}


// ── Auth helpers ──────────────────────────────────────────

async function getUser() {
  const { data: { user } } = await db.auth.getUser();
  return user;
}

async function requireAuth() {
  const user = await getUser();
  if (!user) {
    window.location.href = '/auth';
    return null;
  }
  return user;
}


// ── Profile helpers ───────────────────────────────────────

async function getProfile(userId) {
  const cacheKey = 'profile:' + userId;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) console.error('[supabase] getProfile error:', error);

  // Auto-create profile if missing (edge case: email confirmation race)
  if (!data && !error) {
    console.warn('[supabase] Profile missing — creating fallback profile for', userId);
    const { data: newProfile } = await db
      .from('profiles')
      .upsert({ id: userId, plan: 'free' }, { onConflict: 'id' })
      .select('*')
      .maybeSingle();
    _cacheSet(cacheKey, newProfile, 60000);
    return newProfile;
  }

  _cacheSet(cacheKey, data, 60000);
  return data;
}

async function updateProfile(userId, updates) {
  const { data, error } = await db
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  _cacheInvalidate('profile:' + userId); // bust cache so next read is fresh
  return data;
}


// ── Journal helpers ───────────────────────────────────────

async function getJournals(userId) {
  const { data, error } = await db
    .from('journals')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) console.error('[supabase] getJournals error:', error);
  return data || [];
}

async function createJournal(userId, { name, capital, pin_hash }) {
  const { data, error } = await db
    .from('journals')
    .insert({ user_id: userId, name, capital, pin_hash })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getTrades(journalId) {
  const { data, error } = await db
    .from('trades')
    .select('*')
    .eq('journal_id', journalId)
    .order('created_at', { ascending: false });
  if (error) console.error('[supabase] getTrades error:', error);
  return data || [];
}

async function getJournal(journalId) {
  const { data, error } = await db
    .from('journals')
    .select('*')
    .eq('id', journalId)
    .maybeSingle();
  if (error) console.error('[supabase] getJournal error:', error);
  return data;
}

async function updateJournalPositions(orderedIds) {
  // Fire all position updates in parallel instead of sequentially
  await Promise.all(
    orderedIds.map((id, index) =>
      db.from('journals').update({ position: index }).eq('id', id)
    )
  );
}


// ── Referral helpers ──────────────────────────────────────

async function getReferrals(userId) {
  const { data, error } = await db
    .from('referrals')
    .select(`
      *,
      referred_profile:profiles!referrals_referred_user_id_fkey (
        name
      )
    `)
    .eq('referrer_id', userId)
    .order('created_at', { ascending: false });
  if (error) console.error('[supabase] getReferrals error:', error);
  return data || [];
}

function buildReferralUrl(code) {
  if (!code || code === '—') return window.location.origin + '/auth?ref=???';
  return `${window.location.origin}/auth?ref=${code}`;
}


// ── Subscription helpers ──────────────────────────────────

function getSubscriptionStatus(profile) {
  const isPro = profile?.plan === 'pro';

  if (!isPro) return {
    isPro: false, expired: false, expiring: false,
    daysLeft: null, label: 'Free', planType: 'none'
  };

  const planType = profile?.plan_type || 'none';

  if (planType === 'lifetime' || !profile?.subscription_expires_at) {
    return {
      isPro: true, expired: false, expiring: false,
      daysLeft: null, label: 'Lifetime', planType: 'lifetime'
    };
  }

  const now      = new Date();
  const expires  = new Date(profile.subscription_expires_at);
  const msLeft   = expires - now;
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  const expired  = daysLeft <= 0;
  const expiring = !expired && daysLeft <= 7;

  let label;
  if (expired) {
    label = `Expired ${expires.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  } else if (expiring) {
    label = `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  } else {
    label = `Renews ${expires.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  return { isPro: true, expired, expiring, daysLeft, label, planType };
}


// ── Theme / font helpers ──────────────────────────────────

function applyProfileTheme(profile) {
  const theme = profile?.color_theme || localStorage.getItem('tl_theme') || 'dark';
  const font  = profile?.font_theme  || localStorage.getItem('tl_font')  || 'default';
  if (window.TZ) {
    TZ.setTheme(theme);
    TZ.setFont(font);
  }
}


// ── Page loader helper ────────────────────────────────────

function hidePageLoader() {
  const el = document.getElementById('pageLoader');
  if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }
}


// ══════════════════════════════════════════════════════════
//  AUTH STATE CHANGE LISTENER
// ══════════════════════════════════════════════════════════

db.auth.onAuthStateChange(async (event, session) => {
  if (event !== 'SIGNED_IN' || !session?.user) return;

  // ── Apply referral code if one is stored ─────────────────
  const refCode = (localStorage.getItem('ref_code') || '').trim().toUpperCase();
  if (refCode) {
    console.log('[supabase] Applying referral code:', refCode);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/apply-referral`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ referral_code: refCode }),
      });

      const result = await res.json();
      console.log('[supabase] apply-referral result:', result);

      if (result.success || result.skipped) {
        localStorage.removeItem('ref_code');
        sessionStorage.removeItem('ref_code');
      } else {
        console.warn('[supabase] Referral not applied:', result.error);
      }
    } catch (e) {
      console.error('[supabase] Referral application failed:', e);
    }
  }
});

// ── TZ namespace fallback (if theme.js not loaded) ────────
if (!window.TZ) {
  window.TZ = {
    hideLoader: hidePageLoader,
    setTheme:   (id) => localStorage.setItem('tl_theme', id),
    setFont:    (id) => localStorage.setItem('tl_font',  id),
    themeList:  [],
    fontList:   [],
  };
}


// ── Journal settings helpers ──────────────────────────────

async function getJournalSettings(journalId) {
  const cacheKey = 'jsettings:' + journalId;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const { data, error } = await db
    .from('journal_settings')
    .select('*')
    .eq('journal_id', journalId)
    .maybeSingle();
  if (error) console.error('[supabase] getJournalSettings error:', error);

  if (!data) {
    // Auto-create settings row if missing
    const { data: newRow } = await db
      .from('journal_settings')
      .upsert({
        journal_id: journalId,
        user_id: (await db.auth.getUser()).data.user?.id,
        strategies: [], timeframes: [], pairs: [], moods: [], mood_colors: {}
      }, { onConflict: 'journal_id' })
      .select('*')
      .maybeSingle();
    const result = newRow || { strategies: [], timeframes: [], pairs: [], moods: [], mood_colors: {} };
    _cacheSet(cacheKey, result, 120000);
    return result;
  }

  _cacheSet(cacheKey, data, 120000);
  return data;
}

async function updateJournalSettings(journalId, updates) {
  const { error } = await db
    .from('journal_settings')
    .update(updates)
    .eq('journal_id', journalId);
  if (error) throw error;
  _cacheInvalidate('jsettings:' + journalId); // bust cache so panel reflects new tags
}

async function updateJournal(journalId, updates) {
  const { data, error } = await db
    .from('journals')
    .update(updates)
    .eq('id', journalId)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}


// ── Trade helpers ─────────────────────────────────────────

// Maps a raw DB row → the shape logs.html expects
function dbToTrade(row) {
  return {
    id:         row.id,
    date:       row.trade_date   || '',
    time:       row.trade_time   || '',
    pair:       row.pair         || '',
    position:   row.position     || 'Long',
    strategy:   row.strategy     || [],
    timeframe:  row.timeframe    || [],
    pnl:        row.pnl          != null ? String(row.pnl) : '',
    r:          row.r_factor     != null ? String(row.r_factor) : '',
    confidence: row.confidence   || 0,
    mood:       row.mood         || [],
    notes:      row.notes        || '',
    images:     [],   // loaded separately via getTradeImages
  };
}

async function createTrade(userId, journalId, fields) {
  const { data, error } = await db
    .from('trades')
    .insert({
      user_id:    userId,
      journal_id: journalId,
      trade_date: fields.date   || null,
      trade_time: fields.time   || null,
      pair:       fields.pair   || null,
      position:   fields.position || 'Long',
      strategy:   fields.strategy  || [],
      timeframe:  fields.timeframe || [],
      pnl:        fields.pnl  !== '' && fields.pnl  != null ? parseFloat(fields.pnl)  : null,
      r_factor:   fields.r    !== '' && fields.r    != null ? parseFloat(fields.r)    : null,
      confidence: fields.confidence || null,
      mood:       fields.mood  || [],
      notes:      fields.notes || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateTrade(tradeId, fields) {
  const { error } = await db
    .from('trades')
    .update({
      trade_date: fields.date   || null,
      trade_time: fields.time   || null,
      pair:       fields.pair   || null,
      position:   fields.position || 'Long',
      strategy:   fields.strategy  || [],
      timeframe:  fields.timeframe || [],
      pnl:        fields.pnl  !== '' && fields.pnl  != null ? parseFloat(fields.pnl)  : null,
      r_factor:   fields.r    !== '' && fields.r    != null ? parseFloat(fields.r)    : null,
      confidence: fields.confidence || null,
      mood:       fields.mood  || [],
      notes:      fields.notes || null,
    })
    .eq('id', tradeId);
  if (error) throw error;
}

async function deleteTrade(tradeId) {
  // Fetch image metadata and delete storage + DB rows in parallel where possible
  const { data: imgs } = await db
    .from('trade_images')
    .select('id, storage_url')
    .eq('trade_id', tradeId);

  if (imgs?.length) {
    const paths = imgs.map(i => i.storage_url).filter(Boolean);
    // Run storage removal and DB row deletion in parallel
    await Promise.all([
      paths.length ? db.storage.from('trade-images').remove(paths) : Promise.resolve(),
      db.from('trade_images').delete().eq('trade_id', tradeId),
    ]);
  }

  const { error } = await db.from('trades').delete().eq('id', tradeId);
  if (error) throw error;
}


// ── Trade image helpers ───────────────────────────────────

async function addTradeImage(userId, tradeId, dataUrl) {
  // 1. Compress image before uploading
  const compressed = await compressImage(dataUrl);
  const res        = await fetch(compressed);
  const blob       = await res.blob();
  const ext        = blob.type.includes('png') ? 'png' : 'jpg';
  const fileName   = `${userId}/${tradeId}/${Date.now()}.${ext}`;

  // 2. Upload to Supabase Storage bucket "trade-images"
  const { data: uploadData, error: uploadError } = await db.storage
    .from('trade-images')
    .upload(fileName, blob, { contentType: blob.type, upsert: false });

  if (uploadError) throw uploadError;

  // 3. Save only the short path string in the DB — no more base64
  const { data, error } = await db
    .from('trade_images')
    .insert({
      user_id:     userId,
      trade_id:    tradeId,
      storage_url: uploadData.path,
      data:        null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function deleteTradeImage(imageId) {
  const { data: img } = await db
    .from('trade_images')
    .select('storage_url, data')
    .eq('id', imageId)
    .maybeSingle();

  // Run storage removal and DB deletion in parallel
  await Promise.all([
    (img?.storage_url && !img?.data)
      ? db.storage.from('trade-images').remove([img.storage_url])
      : Promise.resolve(),
    db.from('trade_images').delete().eq('id', imageId),
  ]);
}


// ── Signed URL cache (55 min lifetime) ───────────────────
const _urlCache = {};

async function getImageUrl(img) {
  if (!img) return '';

  if (img.storage_url && !img.data) {
    const cacheKey = img.storage_url;
    const cached   = _urlCache[cacheKey];
    if (cached && cached.expires > Date.now()) return cached.url;
    const { data, error } = await db.storage
      .from('trade-images')
      .createSignedUrl(img.storage_url, 60 * 60);
    if (!error && data.signedUrl) {
      _urlCache[cacheKey] = { url: data.signedUrl, expires: Date.now() + 55 * 60 * 1000 };
      return data.signedUrl;
    }
    return '';
  }

  if (img.data) return img.data;
  if (img.url)  return img.url;
  return '';
}

// ── Batch signed URL fetch ────────────────────────────────
// Fetches signed URLs for multiple images in parallel with cache awareness.
// Use this instead of calling getImageUrl() in a loop.
async function getImageUrls(imgs) {
  if (!imgs || !imgs.length) return [];
  const now     = Date.now();
  const results = new Array(imgs.length).fill('');
  const toFetch = []; // only images that need a fresh signed URL

  imgs.forEach((img, i) => {
    if (!img)           return;
    if (img.data)       { results[i] = img.data; return; }
    if (img.url)        { results[i] = img.url;  return; }
    if (img.storage_url && !img.data) {
      const cached = _urlCache[img.storage_url];
      if (cached && cached.expires > now) { results[i] = cached.url; return; }
      toFetch.push({ idx: i, path: img.storage_url });
    }
  });

  // All cache misses fetched in parallel — single round-trip per image
  if (toFetch.length) {
    await Promise.all(toFetch.map(async ({ idx, path }) => {
      const { data, error } = await db.storage
        .from('trade-images')
        .createSignedUrl(path, 60 * 60);
      if (!error && data?.signedUrl) {
        _urlCache[path] = { url: data.signedUrl, expires: now + 55 * 60 * 1000 };
        results[idx] = data.signedUrl;
      }
    }));
  }

  return results;
}


// ── Image compression before upload ──────────────────────
async function compressImage(dataUrl, maxWidth = 1200, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale  = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}


// ── Bulk image count (1 query instead of N) ───────────────
async function getImageCountsForJournal(userId) {
  const { data } = await db
    .from('trade_images')
    .select('trade_id')
    .eq('user_id', userId);
  const counts = {};
  (data || []).forEach(row => {
    counts[row.trade_id] = (counts[row.trade_id] || 0) + 1;
  });
  return counts;
}

// Fetch all images for a single trade
async function getTradeImages(tradeId) {
  const { data, error } = await db
    .from('trade_images')
    .select('*')
    .eq('trade_id', tradeId)
    .order('created_at', { ascending: true });
  if (error) console.error('[supabase] getTradeImages error:', error);
  return data || [];
}


// ── Dashboard PNL helper ──────────────────────────────────
// Fetches PNL for multiple journals in ONE query instead of
// calling getTrades() per journal (N+1 problem on dashboard).
async function getJournalsPnl(journalIds) {
  if (!journalIds.length) return {};
  const { data } = await db
    .from('trades')
    .select('journal_id, pnl')
    .in('journal_id', journalIds)
    .not('pnl', 'is', null);

  const map = {};
  (data || []).forEach(row => {
    if (row.pnl != null) {
      map[row.journal_id] = (map[row.journal_id] || 0) + parseFloat(row.pnl);
    }
  });
  return map;
}


// ── Realtime subscription ─────────────────────────────────

function subscribeTrades(journalId, onChange) {
  return db
    .channel('trades:' + journalId)
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'trades',
      filter: `journal_id=eq.${journalId}`,
    }, onChange)
    .subscribe();
}


// ── PIN helper ────────────────────────────────────────────

async function hashPin(pin) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(pin)
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}