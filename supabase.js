// ============================================================
//  supabase.js — Shared Supabase client for TradeZona
//  Load this script BEFORE any other scripts on every page.
// ============================================================

const SUPABASE_URL  = 'https://oixrpuqylidbunbttftg.supabase.co';
const SUPABASE_ANON = 'sb_publishable_0JIYopUpUp6DonOkOzWcJQ_KL0OyIho';

// Storage bucket name — create this in Supabase Dashboard → Storage
const IMAGE_BUCKET = 'trade-images';

// Signed URL in-memory cache — avoids re-fetching for the same path within a session
const _urlCache = new Map();

const { createClient } = supabase;

const db = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    storage:            window.localStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: true,
  }
});

// ── Auth state watcher ────────────────────────────────────
db.auth.onAuthStateChange((event) => {
  const publicPaths = ['/', '/auth', '/confirm', '/reset-password'];
  const path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';

  if (event === 'SIGNED_OUT') {
    if (!publicPaths.includes(path)) {
      window.location.href = '/auth';
    }
  }

  if (event === 'PASSWORD_RECOVERY') {
    if (!path.includes('reset-password')) {
      window.location.href = '/reset-password';
    }
  }
});

// ── requireAuth ───────────────────────────────────────────
async function requireAuth() {
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user) {
    await db.auth.signOut();
    window.location.href = '/auth';
    return null;
  }
  return user;
}

async function getUser() {
  const { data: { user } } = await db.auth.getUser();
  return user;
}

// ── Profile ───────────────────────────────────────────────
async function getProfile(userId) {
  const { data } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  return data;
}

// ── Journals ──────────────────────────────────────────────
async function getJournals(userId) {
  const { data, error } = await db
    .from('journals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) { console.error('getJournals:', error); return []; }
  return data || [];
}

async function createJournal(userId, { name, capital, pin_hash, show_pnl = true, show_capital = true }) {
  const { data, error } = await db
    .from('journals')
    .insert({ user_id: userId, name, capital: capital || null, pin_hash: pin_hash || null, show_pnl, show_capital })
    .select()
    .single();
  if (error) throw error;

  // Default tags kept to exactly 3 per category so Free users never
  // immediately hit the 3-tag limit on a fresh journal.
  await db.from('journal_settings').insert({
    journal_id:  data.id,
    user_id:     userId,
    strategies:  ['Breakout', 'Reversal', 'Trend'],
    timeframes:  ['M15', 'H1', 'H4'],
    pairs:       ['EURUSD', 'XAUUSD', 'BTCUSD'],
    moods:       ['Confident', 'Neutral', 'Anxious'],
    mood_colors: {
      Confident: '#22c55e',
      Neutral:   '#64748b',
      Anxious:   '#ef4444',
    }
  });
  return data;
}

async function updateJournal(journalId, updates) {
  const { error } = await db.from('journals').update(updates).eq('id', journalId);
  if (error) throw error;
}

async function deleteJournal(journalId) {
  const { data: trades } = await db
    .from('trades')
    .select('id')
    .eq('journal_id', journalId);

  if (trades?.length) {
    const tradeIds = trades.map(t => t.id);
    const { data: images } = await db
      .from('trade_images')
      .select('storage_path')
      .in('trade_id', tradeIds)
      .not('storage_path', 'is', null);

    if (images?.length) {
      const paths = images.map(i => i.storage_path).filter(Boolean);
      if (paths.length) await db.storage.from(IMAGE_BUCKET).remove(paths);
    }
  }

  const { error } = await db.from('journals').delete().eq('id', journalId);
  if (error) throw error;
}

// ── Trades ────────────────────────────────────────────────
async function getTrades(journalId) {
  const { data, error } = await db
    .from('trades')
    .select('*, trade_images(id, data, storage_path)')
    .eq('journal_id', journalId)
    .order('created_at', { ascending: false });
  if (error) { console.error('getTrades:', error); return []; }
  return data || [];
}

async function createTrade(userId, journalId, trade) {
  const { data, error } = await db
    .from('trades')
    .insert({ ...tradeToDb(trade), journal_id: journalId, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateTrade(tradeId, updates) {
  const payload = tradeToDb(updates);
  if (!Object.keys(payload).length) return;
  const { error } = await db.from('trades').update(payload).eq('id', tradeId);
  if (error) throw error;
}

async function deleteTrade(tradeId) {
  const { data: images } = await db
    .from('trade_images')
    .select('storage_path')
    .eq('trade_id', tradeId)
    .not('storage_path', 'is', null);

  if (images?.length) {
    const paths = images.map(i => i.storage_path).filter(Boolean);
    if (paths.length) {
      await db.storage.from(IMAGE_BUCKET).remove(paths);
      paths.forEach(p => _urlCache.delete(p));
    }
  }

  const { error } = await db.from('trades').delete().eq('id', tradeId);
  if (error) throw error;
}

// ── DB ↔ UI mapping ───────────────────────────────────────
function tradeToDb(t) {
  const o = {};
  if ('date'       in t) o.trade_date  = t.date       || null;
  if ('time'       in t) o.trade_time  = t.time       || null;
  if ('pair'       in t) o.pair        = t.pair       || null;
  if ('position'   in t) o.position    = t.position   || null;
  if ('strategy'   in t) o.strategy    = t.strategy   || [];
  if ('timeframe'  in t) o.timeframe   = t.timeframe  || [];
  if ('pnl'        in t) { const n = parseFloat(t.pnl);      o.pnl      = (!isNaN(n) && t.pnl != null && t.pnl !== '')  ? n : null; }
  if ('r'          in t) { const n = parseFloat(t.r);        o.r_factor = (!isNaN(n) && t.r  != null && t.r  !== '')    ? n : null; }
  if ('confidence' in t) o.confidence  = t.confidence || null;
  if ('mood'       in t) o.mood        = t.mood       || [];
  if ('notes'      in t) o.notes       = t.notes      || null;
  return o;
}

function dbToTrade(row) {
  return {
    id:         row.id,
    date:       row.trade_date  || '',
    time:       row.trade_time  ? String(row.trade_time).slice(0, 5) : '',
    pair:       row.pair        || '',
    position:   row.position    || 'Long',
    strategy:   row.strategy    || [],
    timeframe:  row.timeframe   || [],
    pnl:        row.pnl        != null ? String(row.pnl)      : '',
    r:          row.r_factor   != null ? String(row.r_factor) : '',
    confidence: row.confidence  || 0,
    mood:       row.mood        || [],
    notes:      row.notes       || '',
    images: (row.trade_images || []).map(img => ({
      id:           img.id,
      storage_path: img.storage_path || null,
      data:         img.storage_path ? null : (img.data || ''),
    }))
  };
}

// ── Trade Images ──────────────────────────────────────────
async function addTradeImage(userId, tradeId, base64DataUrl) {
  let blob = null, ext = 'jpg', mimeType = 'image/jpeg';

  try {
    const [header, b64] = base64DataUrl.split(',');
    mimeType  = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
    ext       = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const raw = atob(b64);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    blob = new Blob([buf], { type: mimeType });
  } catch (e) {
    console.warn('addTradeImage: base64 parse failed, using DB fallback', e);
  }

  if (blob) {
    const path = `${userId}/${tradeId}/${Date.now()}.${ext}`;
    const { error: uploadErr } = await db.storage
      .from(IMAGE_BUCKET)
      .upload(path, blob, { contentType: mimeType, upsert: false });

    if (!uploadErr) {
      const { data, error: dbErr } = await db
        .from('trade_images')
        .insert({ trade_id: tradeId, user_id: userId, storage_path: path, data: null })
        .select()
        .single();
      if (dbErr) throw dbErr;
      _urlCache.set(path, base64DataUrl);
      return { ...data, _previewUrl: base64DataUrl };
    }
    console.warn('addTradeImage: Storage upload failed, falling back to DB base64', uploadErr);
  }

  const { data, error } = await db
    .from('trade_images')
    .insert({ trade_id: tradeId, user_id: userId, data: base64DataUrl, storage_path: null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getImageUrl(img) {
  if (!img) return '';
  if (img._previewUrl) return img._previewUrl;

  if (img.storage_path) {
    if (_urlCache.has(img.storage_path)) return _urlCache.get(img.storage_path);
    const { data, error } = await db.storage
      .from(IMAGE_BUCKET)
      .createSignedUrl(img.storage_path, 3600);
    if (!error && data?.signedUrl) {
      _urlCache.set(img.storage_path, data.signedUrl);
      return data.signedUrl;
    }
    console.warn('getImageUrl: signed URL failed', error);
    return '';
  }

  return img.data || '';
}

async function deleteTradeImage(imageId, storagePath) {
  if (storagePath) {
    await db.storage.from(IMAGE_BUCKET).remove([storagePath]);
    _urlCache.delete(storagePath);
  }
  const { error } = await db.from('trade_images').delete().eq('id', imageId);
  if (error) throw error;
}

// ── Journal Settings ──────────────────────────────────────
async function getJournalSettings(journalId) {
  const { data } = await db
    .from('journal_settings')
    .select('*')
    .eq('journal_id', journalId)
    .single();
  return data;
}

async function updateJournalSettings(journalId, updates) {
  const { error } = await db
    .from('journal_settings')
    .update(updates)
    .eq('journal_id', journalId);
  if (error) throw error;
}

// ── Realtime ──────────────────────────────────────────────
function subscribeTrades(journalId, callback) {
  return db.channel('trades:' + journalId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'trades', filter: `journal_id=eq.${journalId}` },
      callback)
    .subscribe();
}

// ── PIN security ──────────────────────────────────────────
async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPin(pin, hash) {
  if (!hash) return true;
  return (await hashPin(pin)) === hash;
}
