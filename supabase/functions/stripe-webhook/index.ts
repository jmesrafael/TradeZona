// supabase/functions/stripe-webhook/index.ts
//
// SETUP STEPS:
// 1. Run: supabase functions new stripe-webhook
// 2. Replace file content with this code
// 3. Set secrets:
//    supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_XXXX
//    supabase secrets set STRIPE_SECRET_KEY=sk_live_XXXX
// 4. Deploy: supabase functions deploy stripe-webhook
// 5. In Stripe Dashboard → Webhooks → Add endpoint:
//    URL: https://oixrpuqylidbunbttftg.supabase.co/functions/v1/stripe-webhook
//    Events to listen for:
//      - checkout.session.completed
//      - customer.subscription.deleted
//      - customer.subscription.updated
//    Copy the webhook signing secret → set as STRIPE_WEBHOOK_SECRET
//
// DB requirement: Run migration_stripe.sql in Supabase SQL Editor first

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

// Service role client — bypasses RLS to update profiles
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  // 1. Verify webhook came from Stripe
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  console.log(`Received Stripe event: ${event.type}`);

  // 2. Handle each event type
  try {
    switch (event.type) {

      // ── Payment succeeded → upgrade user to Pro ──────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.CheckoutSession;
        const userId = session.metadata?.supabase_user_id;
        if (!userId) { console.error("No supabase_user_id in session metadata"); break; }

        await supabase.from("profiles").update({
          plan: "pro",
          stripe_customer_id: session.customer as string,
          stripe_subscription_id: session.subscription as string,
        }).eq("id", userId);

        console.log(`Upgraded user ${userId} to Pro`);
        break;
      }

      // ── Subscription cancelled / expired → downgrade to Free ──
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        await supabase.from("profiles").update({
          plan: "free",
          stripe_subscription_id: null,
        }).eq("stripe_customer_id", customerId);

        console.log(`Downgraded customer ${customerId} to Free (subscription deleted)`);
        break;
      }

      // ── Subscription updated (e.g. payment failed → past_due) ──
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const isActive = sub.status === "active" || sub.status === "trialing";

        await supabase.from("profiles").update({
          plan: isActive ? "pro" : "free",
        }).eq("stripe_customer_id", customerId);

        console.log(`Updated customer ${customerId} plan → ${isActive ? "pro" : "free"} (status: ${sub.status})`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error("Error processing webhook event:", err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});