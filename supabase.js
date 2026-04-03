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
    .select('*')
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

  if (!isPro) return { isPro: false, expired: false, expiring: false, daysLeft: null, label: 'Free' };

  if (profile?.plan_type === 'lifetime' || !profile?.subscription_expires_at) {
    return { isPro: true, expired: false, expiring: false, daysLeft: null, label: 'Lifetime' };
  }

  const now      = new Date();
  const expires  = new Date(profile.subscription_expires_at);
  const msLeft   = expires - now;
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  const expired  = daysLeft <= 0;
  const expiring = !expired && daysLeft <= 7;

  let label;
  if (expired) {
    label = `Expired ${expires.toLocaleDateString()}`;
  } else if (expiring) {
    label = `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  } else {
    label = `Renews ${expires.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  return { isPro: true, expired, expiring, daysLeft, label };
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
