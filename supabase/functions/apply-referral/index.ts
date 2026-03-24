// supabase/functions/apply-referral/index.ts
// Deploy: supabase functions deploy apply-referral
//
// Required secrets:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const { refCode } = await req.json();

    if (!refCode) {
      return new Response("Missing refCode", { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 🔐 Get user from token
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData?.user) {
      return new Response("Unauthorized", { status: 401 });
    }

    const user = userData.user;

    // 🔎 Find referrer
    const { data: referrer, error: refError } = await supabase
      .from("profiles")
      .select("id")
      .eq("referral_code", refCode)
      .single();

    if (refError || !referrer) {
      return new Response("Invalid referral", { status: 400 });
    }

    // 🚫 Prevent self-referral
    if (referrer.id === user.id) {
      return new Response("Cannot refer yourself", { status: 400 });
    }

    // 🚫 Prevent duplicate referral
    const { data: existing } = await supabase
      .from("referrals")
      .select("id")
      .eq("referred_user_id", user.id)
      .maybeSingle();

    if (existing) {
      return new Response("Already referred", { status: 400 });
    }

    // ✅ Apply referral
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ referred_by: referrer.id })
      .eq("id", user.id);

    if (updateError) {
      return new Response("Failed to update profile", { status: 500 });
    }

    const { error: insertError } = await supabase
      .from("referrals")
      .insert({
        referrer_id: referrer.id,
        referred_user_id: user.id
      });

    if (insertError) {
      return new Response("Failed to insert referral", { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response("Server error", { status: 500 });
  }
});