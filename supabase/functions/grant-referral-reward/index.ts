// supabase/functions/grant-referral-reward/index.ts
//
// Called INTERNALLY by stripe-webhook when a referred user subscribes.
// Grants the referrer +30 days of Pro (extending existing expiry if any).
//
// Deploy: supabase functions deploy grant-referral-reward
// No public trigger — internal only (service role key required).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REWARD_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { referred_user_id } = await req.json();

    if (!referred_user_id) {
      console.warn("[grant-reward] Missing referred_user_id");
      return new Response(JSON.stringify({ error: "Missing referred_user_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    console.log(`[grant-reward] Processing reward for referred_user_id: ${referred_user_id}`);

    // ── 1. Find referral row for this user ────────────────────
    const { data: referral, error: refErr } = await supabase
      .from("referrals")
      .select("id, referrer_id, reward_granted, status")
      .eq("referred_user_id", referred_user_id)
      .maybeSingle();

    if (refErr) {
      console.error("[grant-reward] DB error fetching referral:", refErr);
      return new Response(JSON.stringify({ error: "DB error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!referral) {
      console.log(`[grant-reward] No referral record found for user ${referred_user_id} — skipping`);
      return new Response(JSON.stringify({ skipped: true, reason: "no referral found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (referral.reward_granted) {
      console.log(`[grant-reward] Reward already granted for referral ${referral.id} — skipping`);
      return new Response(JSON.stringify({ skipped: true, reason: "reward already granted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 2. Get referrer's current profile ─────────────────────
    const { data: referrerProfile, error: profileErr } = await supabase
      .from("profiles")
      .select("id, plan, plan_type, subscription_expires_at, referral_count")
      .eq("id", referral.referrer_id)
      .single();

    if (profileErr || !referrerProfile) {
      console.error(`[grant-reward] Referrer ${referral.referrer_id} not found:`, profileErr);
      return new Response(JSON.stringify({ error: "Referrer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 3. Calculate new expiry (extend or start fresh) ───────
    const now = new Date();
    let baseDate = now;

    if (referrerProfile.subscription_expires_at) {
      const existing = new Date(referrerProfile.subscription_expires_at);
      // Only extend from future expiry; if already expired, start from now
      if (existing > now) {
        baseDate = existing;
        console.log(`[grant-reward] Extending existing expiry from ${existing.toISOString()}`);
      } else {
        console.log(`[grant-reward] Existing expiry ${existing.toISOString()} is in the past — starting from now`);
      }
    } else {
      console.log(`[grant-reward] No existing expiry — starting from now`);
    }

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + REWARD_DAYS);

    console.log(`[grant-reward] New expiry for referrer ${referral.referrer_id}: ${newExpiry.toISOString()}`);

    // ── 4. Update referrer profile (service role bypasses RLS) ─
    const { error: updateErr } = await supabase
      .from("profiles")
      .update({
        plan:                    "pro",
        plan_type:               referrerProfile.plan_type === "none" ? "monthly" : referrerProfile.plan_type,
        subscription_expires_at: newExpiry.toISOString(),
        referral_count:          (referrerProfile.referral_count || 0) + 1,
      })
      .eq("id", referral.referrer_id);

    if (updateErr) {
      console.error(`[grant-reward] Failed to update referrer profile:`, updateErr);
      return new Response(JSON.stringify({ error: "Failed to update referrer" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 5. Mark referral as rewarded ──────────────────────────
    const { error: markErr } = await supabase
      .from("referrals")
      .update({ status: "rewarded", reward_granted: true })
      .eq("id", referral.id);

    if (markErr) {
      // Non-fatal — log but don't fail the response
      console.error(`[grant-reward] Failed to mark referral ${referral.id} as rewarded:`, markErr);
    }

    console.log(
      `[grant-reward] ✅ Granted ${REWARD_DAYS} days Pro to referrer ${referral.referrer_id}. ` +
      `New expiry: ${newExpiry.toISOString()}`
    );

    return new Response(
      JSON.stringify({
        success:       true,
        referrer_id:   referral.referrer_id,
        days_granted:  REWARD_DAYS,
        new_expiry:    newExpiry.toISOString(),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[grant-reward] Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
