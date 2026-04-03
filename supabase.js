// supabase.js — FIXED & ENHANCED
// Handles auth state changes, referral application, helper functions.
// Include this on every page that needs auth.

// ── Config ────────────────────────────────────────────────
const SUPABASE_URL  = "https://oixrpuqylidbunbttftg.supabase.co";
const SUPABASE_ANON = "sb_publishable_0JIYopUpUp6DonOkOzWcJQ_KL0OyIho";

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);


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
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();         // use maybeSingle so it returns null instead of error when no row
  if (error) console.error('[supabase] getProfile error:', error);

  // Auto-create profile if missing (edge case: email confirmation race)
  if (!data && !error) {
    console.warn('[supabase] Profile missing — creating fallback profile for', userId);
    const { data: newProfile } = await db
      .from('profiles')
      .upsert({ id: userId, plan: 'free' }, { onConflict: 'id' })
      .select('*')
      .maybeSingle();
    return newProfile;
  }

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
  // Update position column for each journal in the new order
  const updates = orderedIds.map((id, index) =>
    db.from('journals').update({ position: index }).eq('id', id)
  );
  await Promise.all(updates);
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


// ═══════════════════════════════════════════════════════════
//  AUTH STATE CHANGE LISTENER
// ═══════════════════════════════════════════════════════════

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
    return newRow || { strategies: [], timeframes: [], pairs: [], moods: [], mood_colors: {} };
  }
  return data;
}

async function updateJournalSettings(journalId, updates) {
  const { error } = await db
    .from('journal_settings')
    .update(updates)
    .eq('journal_id', journalId);
  if (error) throw error;
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
  // Delete associated images first
  const { data: imgs } = await db
    .from('trade_images')
    .select('id, storage_url')
    .eq('trade_id', tradeId);

  if (imgs?.length) {
    const paths = imgs.map(i => i.storage_url).filter(Boolean);
    if (paths.length) {
      await db.storage.from('trade-images').remove(paths);
    }
    await db.from('trade_images').delete().eq('trade_id', tradeId);
  }

  const { error } = await db.from('trades').delete().eq('id', tradeId);
  if (error) throw error;
}


// ── Trade image helpers ───────────────────────────────────

async function addTradeImage(userId, tradeId, dataUrl) {
  // 1. Convert base64 dataUrl → Blob
  const res      = await fetch(dataUrl);
  const blob     = await res.blob();
  const ext      = blob.type.includes('png') ? 'png' : 'jpg';
  const fileName = `${userId}/${tradeId}/${Date.now()}.${ext}`;
 
  // 2. Upload to Supabase Storage bucket "trade-images"
  const { data: uploadData, error: uploadError } = await db.storage
    .from('trade-images')
    .upload(fileName, blob, {
      contentType: blob.type,
      upsert: false,
    });
 
  if (uploadError) throw uploadError;
 
  // 3. Save only the short path string in the DB — no more base64
  const { data, error } = await db
    .from('trade_images')
    .insert({
      user_id:     userId,
      trade_id:    tradeId,
      storage_url: uploadData.path,
      data:        null,   // explicitly null — we no longer store base64
    })
    .select('*')
    .single();
 
  if (error) throw error;
  return data;
}

async function deleteTradeImage(imageId) {
  // Get the row first so we know what to delete from Storage
  const { data: img } = await db
    .from('trade_images')
    .select('storage_url, data')
    .eq('id', imageId)
    .maybeSingle();
 
  // Delete from Storage if it's the new format (has storage_url, no base64)
  if (img?.storage_url && !img?.data) {
    await db.storage
      .from('trade-images')
      .remove([img.storage_url]);
  }
 
  // Delete the DB row
  const { error } = await db.from('trade_images').delete().eq('id', imageId);
  if (error) throw error;
}
 
async function getImageUrl(img) {
  if (!img) return '';
 
  // NEW: Storage URL — fetch a signed URL (valid 1 hour)
  if (img.storage_url && !img.data) {
    const { data, error } = await db.storage
      .from('trade-images')
      .createSignedUrl(img.storage_url, 60 * 60);
    return error ? '' : data.signedUrl;
  }
 
  // LEGACY: old base64 images still load fine
  if (img.data) return img.data;
  if (img.url)  return img.url;
 
  return '';
}

// Attach images to trade objects after loading
async function getTradeImages(tradeId) {
  const { data, error } = await db
    .from('trade_images')
    .select('*')
    .eq('trade_id', tradeId)
    .order('created_at', { ascending: true });
  if (error) console.error('[supabase] getTradeImages error:', error);
  return data || [];
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