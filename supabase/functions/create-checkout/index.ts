// supabase/functions/create-checkout/index.ts
//
// SETUP STEPS:
// 1. Install Supabase CLI: https://supabase.com/docs/guides/cli
// 2. Run: supabase functions new create-checkout
// 3. Replace this file content with the code below
// 4. Set secrets:
//    supabase secrets set STRIPE_SECRET_KEY=sk_live_XXXX
//    supabase secrets set STRIPE_PRICE_ID=price_XXXX
//    supabase secrets set APP_URL=https://your-netlify-site.netlify.app
// 5. Deploy: supabase functions deploy create-checkout
//
// In Stripe dashboard:
// - Create a Product "TradeZona Pro" → recurring $5/month
// - Copy the Price ID (starts with price_) → set as STRIPE_PRICE_ID

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Verify the user is logged in via Supabase JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Check if user already has a Stripe customer ID (stored in profiles)
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, plan")
      .eq("id", user.id)
      .single();

    if (profile?.plan === "pro") {
      return new Response(JSON.stringify({ error: "Already subscribed to Pro" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Get or create Stripe customer
    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      // Save customer ID to profiles table
      // NOTE: You need to add stripe_customer_id column to profiles:
      //   ALTER TABLE public.profiles ADD COLUMN stripe_customer_id text;
      const serviceClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await serviceClient
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", user.id);
    }

    // 4. Create Stripe Checkout session
    const appUrl = Deno.env.get("APP_URL") || "https://yoursite.netlify.app";
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: Deno.env.get("STRIPE_PRICE_ID")!, quantity: 1 }],
      success_url: `${appUrl}/subscription.html?upgraded=1`,
      cancel_url:  `${appUrl}/subscription.html?cancelled=1`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      metadata: { supabase_user_id: user.id },
    });

    // 5. Return checkout URL → frontend redirects user there
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("create-checkout error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
