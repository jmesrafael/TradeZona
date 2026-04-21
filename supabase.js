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

async function getReferralCount(userId) {
  const refs = await getReferrals(userId);
  return refs.length;
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
        strategies: ['Scalp', 'Breakout', 'FVG'],
        timeframes:  ['1h', '4h', '1D'],
        pairs:       ['EURUSD', 'BTCUSDT', 'XAUUSD'],
        moods:       ['Confident', 'Neutral', 'Anxious'],
        mood_colors: {
          'Confident': '#19c37d',
          'Neutral':   '#8fa39a',
          'Anxious':   '#ff5f6d'
        }
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
  try {
    console.log('%c🎬 IMAGE UPLOAD STARTED', 'color: #00ff88; font-weight: bold; font-size: 14px');

    // 1. Compress image before uploading (with optimization)
    console.log('[addTradeImage] 📦 Optimizing image for upload...');
    const compressed = await compressImage(dataUrl, {
      maxWidth: IMAGE_CONFIG.MAX_WIDTH,
      maxHeight: IMAGE_CONFIG.MAX_HEIGHT,
      targetQuality: IMAGE_CONFIG.QUALITY_MEDIUM
    });

    // Convert data URL to Blob directly (fetch() on a data URL fails in some
    // environments and produces a text/plain blob instead of the image type)
    function _dataUrlToBlob(url) {
      const [header, b64] = url.split(',');
      const mime = header.match(/:(.*?);/)[1];
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }

    const blob = _dataUrlToBlob(compressed);
    const ext  = blob.type.includes('png') ? 'png' : 'jpg';
    const fileName   = `trade_${Date.now()}.${ext}`;
    const sizeKB     = Math.round(blob.size / 1024);
    const sizeMB     = (blob.size / (1024 * 1024)).toFixed(2);

    console.log('[addTradeImage] ✅ Image optimized');
    console.log('[addTradeImage] File name:', fileName);
    console.log('[addTradeImage] File type:', blob.type);
    console.log('[addTradeImage] File size:', sizeKB, 'KB (' + sizeMB + 'MB)');

    // Check final size
    if (blob.size > IMAGE_CONFIG.MAX_FILE_SIZE_BYTES) {
      console.warn('[addTradeImage] ⚠️ Compressed image still exceeds limit');
      throw new Error(`Image too large: ${sizeMB}MB (max 5MB)`);
    }

    // 2. Try R2 first
    console.log('[addTradeImage] %c🚀 ATTEMPTING R2 UPLOAD', 'color: #19c37d; font-weight: bold');
    const r2Result = await tryR2Upload(userId, tradeId, blob, fileName);
    if (r2Result.success) {
      console.log('%c✅ IMAGE SAVED TO R2', 'color: #19c37d; font-weight: bold; font-size: 14px');
      console.log('[addTradeImage] R2 URL:', r2Result.data.storage_url);
      return r2Result.data;
    }

    console.warn('%c⚠️ R2 FAILED - FALLING BACK TO SUPABASE', 'color: #ff9500; font-weight: bold');
    console.log('[addTradeImage] R2 error:', r2Result.error);

    // 3. Fallback to Supabase Storage
    console.log('[addTradeImage] %c🔄 ATTEMPTING SUPABASE STORAGE FALLBACK', 'color: #ff9500; font-weight: bold');
    const supabaseResult = await uploadToSupabaseStorage(userId, tradeId, blob, fileName);
    console.log('%c✅ IMAGE SAVED TO SUPABASE (FALLBACK)', 'color: #ff9500; font-weight: bold; font-size: 14px');
    console.log('[addTradeImage] Supabase URL:', supabaseResult.storage_url);
    return supabaseResult;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('%c❌ IMAGE UPLOAD FAILED', 'color: #ff5f6d; font-weight: bold; font-size: 14px');
    console.error('[addTradeImage] Error:', errorMsg);
    throw error;
  }
}

async function tryR2Upload(userId, tradeId, blob, fileName) {
  try {
    console.log('[R2] ========== R2 UPLOAD START ==========');
    console.log('[R2] Authenticating user...');

    const { data: { user } } = await db.auth.getUser();
    if (!user?.id) throw new Error('User not authenticated');
    console.log('[R2] ✅ User authenticated:', user.id);

    const { data: sessionData } = await db.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) {
      throw new Error('No auth token available');
    }
    console.log('[R2] ✅ Token retrieved, length:', token.length);

    console.log('[R2] 📤 Calling edge function...');
    console.log('[R2] Endpoint:', `${SUPABASE_URL}/functions/v1/generate-r2-upload-url`);

    const urlResponse = await fetch(
      `${SUPABASE_URL}/functions/v1/generate-r2-upload-url`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          file_name: fileName,
          file_type: blob.type,
          trade_id: tradeId,
        }),
      }
    );

    console.log('[R2] Function response status:', urlResponse.status);

    if (!urlResponse.ok) {
      const responseText = await urlResponse.text();
      console.error('[R2] ❌ Edge function error:', responseText);
      return {
        success: false,
        error: `R2 function error (${urlResponse.status}): ${responseText}`
      };
    }

    const { upload_url: signedUrl, public_url: publicUrl } = await urlResponse.json();
    console.log('[R2] ✅ Got signed URL');
    console.log('[R2] Public URL:', publicUrl);

    console.log('[R2] 📤 Uploading blob to R2...');
    console.log('[R2] Blob size:', blob.size, 'bytes');

    const uploadResponse = await fetch(signedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': blob.type,
      },
      body: blob,
    });

    console.log('[R2] Upload response status:', uploadResponse.status);

    if (!uploadResponse.ok) {
      console.error('[R2] ❌ Upload failed:', uploadResponse.statusText);
      return {
        success: false,
        error: `R2 upload failed: ${uploadResponse.statusText}`
      };
    }

    console.log('[R2] ✅ Blob uploaded to R2 successfully');
    console.log('[R2] 💾 Saving R2 URL to database...');

    // Save to DB with R2 URL
    const { data: savedData, error } = await db
      .from('trade_images')
      .insert({
        user_id:     userId,
        trade_id:    tradeId,
        storage_url: publicUrl,
        data:        null,
      })
      .select('*')
      .single();

    if (error) {
      console.error('[R2] ❌ Database save error:', error);
      throw error;
    }

    console.log('[R2] ✅ Image record saved to DB');
    console.log('[R2] Image ID:', savedData.id);
    console.log('[R2] ========== R2 UPLOAD SUCCESS ==========');
    console.log('[R2] Storage URL:', savedData.storage_url);

    return { success: true, data: savedData };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[R2] ❌ EXCEPTION:', errorMsg);
    console.log('[R2] ========== R2 UPLOAD FAILED ==========');
    return {
      success: false,
      error: errorMsg
    };
  }
}

async function uploadToSupabaseStorage(userId, tradeId, blob, fileName) {
  try {
    console.log('[SUPABASE] ========== SUPABASE STORAGE FALLBACK START ==========');
    const path = `${userId}/${tradeId}/${fileName}`;
    console.log('[SUPABASE] Storage path:', path);
    console.log('[SUPABASE] Blob size:', blob.size, 'bytes');
    console.log('[SUPABASE] Content type:', blob.type);

    // Upload to Supabase Storage
    console.log('[SUPABASE] 📤 Uploading to Supabase Storage...');
    const { data: uploadData, error: uploadError } = await db.storage
      .from('trade-images')
      .upload(path, blob, { contentType: blob.type, upsert: false });

    if (uploadError) {
      console.error('[SUPABASE] ❌ Upload error:', uploadError);
      throw uploadError;
    }

    console.log('[SUPABASE] ✅ Uploaded to Supabase Storage');
    console.log('[SUPABASE] Storage path:', uploadData.path);

    // Save to DB with Supabase storage path
    console.log('[SUPABASE] 💾 Saving to database...');
    const { data: savedData, error } = await db
      .from('trade_images')
      .insert({
        user_id:     userId,
        trade_id:    tradeId,
        storage_url: uploadData.path,
        data:        null,
      })
      .select('*')
      .single();

    if (error) {
      console.error('[SUPABASE] ❌ Database save error:', error);
      throw error;
    }

    console.log('[SUPABASE] ✅ Saved to database');
    console.log('[SUPABASE] Image ID:', savedData.id);
    console.log('[SUPABASE] ========== SUPABASE STORAGE FALLBACK SUCCESS ==========');
    console.log('[SUPABASE] Storage URL:', savedData.storage_url);

    return savedData;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[SUPABASE] ❌ EXCEPTION:', errorMsg);
    console.log('[SUPABASE] ========== SUPABASE STORAGE FALLBACK FAILED ==========');
    throw error;
  }
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
      ? (img.storage_url.startsWith('https://')
          ? Promise.resolve() // R2 public URLs don't need explicit deletion
          : db.storage.from('trade-images').remove([img.storage_url])) // Supabase storage deletion
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

    // R2 URLs are already public, return them directly
    if (img.storage_url.startsWith('https://')) {
      return img.storage_url;
    }

    // Supabase storage paths need signed URLs
    const cached = _urlCache[cacheKey];
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
      // R2 URLs are already public, use them directly
      if (img.storage_url.startsWith('https://')) {
        results[i] = img.storage_url;
        return;
      }
      // Supabase storage paths need signed URLs
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


// ── Image optimization & compression ─────────────────────
const IMAGE_CONFIG = {
  MAX_FILE_SIZE_BYTES: 5 * 1024 * 1024, // 5 MB
  MAX_WIDTH: 1200,
  MAX_HEIGHT: 1200,
  TARGET_SIZE_KB: 200, // Target compressed size
  QUALITY_HIGH: 0.85,
  QUALITY_MEDIUM: 0.75,
  QUALITY_LOW: 0.60,
};

async function compressImage(dataUrl, options = {}) {
  return new Promise(resolve => {
    const {
      maxWidth = IMAGE_CONFIG.MAX_WIDTH,
      maxHeight = IMAGE_CONFIG.MAX_HEIGHT,
      targetKB = IMAGE_CONFIG.TARGET_SIZE_KB
    } = options;

    const img = new Image();
    img.onload = () => {
      try {
        // Calculate optimal dimensions
        let width = img.width;
        let height = img.height;
        const aspectRatio = width / height;

        // Constrain to max dimensions
        if (width > maxWidth) {
          width = maxWidth;
          height = Math.round(width / aspectRatio);
        }
        if (height > maxHeight) {
          height = maxHeight;
          width = Math.round(height * aspectRatio);
        }

        console.log(`[compress] Original: ${img.width}x${img.height} → Optimized: ${width}x${height}`);

        // Create canvas and draw
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Anti-alias for better quality
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Binary search for optimal quality to hit target size
        let minQuality = 0.3;
        let maxQuality = 0.95;
        let bestDataUrl = canvas.toDataURL('image/jpeg', 0.75);
        let iterations = 0;

        while (maxQuality - minQuality > 0.01 && iterations < 8) {
          iterations++;
          const midQuality = (minQuality + maxQuality) / 2;
          const testDataUrl = canvas.toDataURL('image/jpeg', midQuality);
          const testSizeKB = (testDataUrl.length * 0.75) / 1024;

          if (testSizeKB > targetKB) {
            maxQuality = midQuality; // Too large, reduce quality
          } else {
            minQuality = midQuality; // Under target, can use higher quality
            bestDataUrl = testDataUrl; // Keep this as best so far
          }
        }

        const finalSizeKB = (bestDataUrl.length * 0.75) / 1024;
        const finalQuality = Math.round(minQuality * 100);
        console.log(`[compress] ✅ Final: Quality ${finalQuality}% → ${Math.round(finalSizeKB)} KB (target: ${targetKB} KB)`);

        resolve(bestDataUrl);
      } catch (error) {
        console.error('[compress] Error during compression:', error);
        resolve(dataUrl); // Fall back to original
      }
    };
    img.onerror = () => {
      console.error('[compress] Image load failed');
      resolve(dataUrl);
    };
    img.src = dataUrl;
  });
}

/**
 * Validate image before compression
 * Returns { valid: boolean, error?: string }
 */
function validateImageBeforeUpload(file) {
  // Check file size
  if (file.size > IMAGE_CONFIG.MAX_FILE_SIZE_BYTES) {
    const maxMB = Math.round(IMAGE_CONFIG.MAX_FILE_SIZE_BYTES / (1024 * 1024) * 10) / 10;
    const fileMB = Math.round(file.size / (1024 * 1024) * 10) / 10;
    return {
      valid: false,
      error: `Image too large: ${fileMB}MB (max ${maxMB}MB)`
    };
  }

  // Check file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(file.type)) {
    return {
      valid: false,
      error: `Unsupported format: ${file.type}`
    };
  }

  return { valid: true };
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

// ── Custom Notes ──────────────────────────────────────────
async function getCustomNotes(journalId) {
  const { data, error } = await db.from('custom_notes')
    .select('*').eq('journal_id', journalId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
 
async function insertCustomNote(userId, journalId, note) {
  const { data, error } = await db.from('custom_notes')
    .insert({ user_id: userId, journal_id: journalId, ...note })
    .select().single();
  if (error) throw error;
  return data;
}
 
async function updateCustomNote(id, updates) {
  const { error } = await db.from('custom_notes')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
 
async function deleteCustomNote(id) {
  const { error } = await db.from('custom_notes').delete().eq('id', id);
  if (error) throw error;
}
 
// ── Pre-Session ───────────────────────────────────────────
async function getPresession(journalId, date) {
  const { data, error } = await db.from('presessions')
    .select('*')
    .eq('journal_id', journalId)
    .eq('session_date', date)
    .maybeSingle();
  if (error) throw error;
  return data;
}
 
async function upsertPresession(userId, journalId, date, updates) {
  const { error } = await db.from('presessions').upsert({
    user_id: userId,
    journal_id: journalId,
    session_date: date,
    ...updates,
    updated_at: new Date().toISOString()
  }, { onConflict: 'journal_id,session_date' });
  if (error) throw error;
}