// supabase/functions/apply-referral/index.ts
//
// Called on SIGNED_IN from supabase.js when localStorage has a ref_code.
// Creates the referral row and links referred_by on the new user's profile.
//
// Deploy: supabase functions deploy apply-referral

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body    = await req.json();
    const refCode = (body.referral_code || body.refCode || "").trim().toUpperCase();

    if (!refCode) {
      console.warn("[apply-referral] Missing referral_code in body");
      return new Response(JSON.stringify({ error: "Missing referral_code" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── 1. Verify the calling user's JWT ─────────────────────
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      console.error("[apply-referral] Auth error:", userError);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const user = userData.user;
    console.log(`[apply-referral] User ${user.id} applying code: ${refCode}`);

    // ── 2. Find referrer by referral_code ─────────────────────
    const { data: referrer, error: refError } = await supabase
      .from("profiles")
      .select("id")
      .eq("referral_code", refCode)
      .single();

    if (refError || !referrer) {
      console.warn(`[apply-referral] Invalid referral code: ${refCode}`);
      return new Response(JSON.stringify({ error: "Invalid referral code" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 3. Prevent self-referral ──────────────────────────────
    if (referrer.id === user.id) {
      console.warn(`[apply-referral] Self-referral attempt by user ${user.id}`);
      return new Response(JSON.stringify({ error: "Cannot refer yourself" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 4. Prevent duplicate referral ─────────────────────────
    const { data: existing, error: existErr } = await supabase
      .from("referrals")
      .select("id")
      .eq("referred_user_id", user.id)
      .maybeSingle();

    if (existErr) {
      console.error("[apply-referral] DB error checking duplicates:", existErr);
    }

    if (existing) {
      console.log(`[apply-referral] User ${user.id} already has a referral record — skipping`);
      return new Response(JSON.stringify({ skipped: true, reason: "already referred" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 5. Update new user's profile with referred_by ─────────
    const { error: profileUpdateErr } = await supabase
      .from("profiles")
      .update({ referred_by: referrer.id })
      .eq("id", user.id);

    if (profileUpdateErr) {
      console.error("[apply-referral] Failed to update profile:", profileUpdateErr);
      return new Response(JSON.stringify({ error: "Failed to update profile" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── 6. Insert referral row ────────────────────────────────
    const { error: insertError } = await supabase
      .from("referrals")
      .insert({
        referrer_id:      referrer.id,
        referred_user_id: user.id,
        status:           "pending",
        reward_granted:   false,
      });

    if (insertError) {
      console.error("[apply-referral] Failed to insert referral row:", insertError);
      return new Response(JSON.stringify({ error: "Failed to record referral" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(
      `[apply-referral] ✅ Referral recorded: referrer=${referrer.id}, referred=${user.id}, code=${refCode}`
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[apply-referral] Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
