// supabase/functions/grant-referral-reward/index.ts
// This function is called INTERNALLY by the stripe-webhook function.
// It grants the referrer 30 days of free Pro when their referred user pays.
//
// Deploy: supabase functions deploy grant-referral-reward
//
// No public HTTP trigger needed — called via service-role fetch from stripe-webhook.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { referred_user_id } = await req.json();

    if (!referred_user_id) {
      return new Response(JSON.stringify({ error: "Missing referred_user_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Find the referral row for this user
    const { data: referral, error: refErr } = await supabase
      .from("referrals")
      .select("id, referrer_id, reward_granted, status")
      .eq("referred_user_id", referred_user_id)
      .maybeSingle();

    if (refErr || !referral) {
      // No referral record — that's fine, just skip
      return new Response(JSON.stringify({ skipped: true, reason: "no referral found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (referral.reward_granted) {
      return new Response(JSON.stringify({ skipped: true, reason: "reward already granted" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Get referrer's current subscription_expires_at
    const { data: referrerProfile } = await supabase
      .from("profiles")
      .select("id, plan, subscription_expires_at, referral_count")
      .eq("id", referral.referrer_id)
      .single();

    if (!referrerProfile) {
      return new Response(JSON.stringify({ error: "Referrer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Calculate new expiry — 30 days from now OR extend existing expiry
    const REWARD_DAYS = 30;
    const now = new Date();
    let baseDate = now;

    // If referrer already has a future expiry, extend from there
    if (referrerProfile.subscription_expires_at) {
      const existing = new Date(referrerProfile.subscription_expires_at);
      if (existing > now) baseDate = existing;
    }

    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + REWARD_DAYS);

    // 4. Update referrer profile — use service role to bypass the trigger
    //    (trigger only blocks anon/user role updates, service role bypasses RLS)
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({
        plan: "pro",
        subscription_expires_at: newExpiry.toISOString(),
        referral_count: (referrerProfile.referral_count || 0) + 1,
      })
      .eq("id", referral.referrer_id);

    if (profileErr) {
      console.error("Failed to update referrer profile:", profileErr);
      return new Response(JSON.stringify({ error: "Failed to update referrer" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Mark referral as rewarded
    const { error: markErr } = await supabase
      .from("referrals")
      .update({ status: "rewarded", reward_granted: true })
      .eq("id", referral.id);

    if (markErr) {
      console.error("Failed to mark referral rewarded:", markErr);
    }

    console.log(`Granted ${REWARD_DAYS} days Pro to referrer ${referral.referrer_id}`);

    return new Response(
      JSON.stringify({ success: true, referrer_id: referral.referrer_id, days_granted: REWARD_DAYS }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("grant-referral-reward error:", err);
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
