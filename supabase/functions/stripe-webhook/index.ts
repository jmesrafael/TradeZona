// supabase/functions/stripe-webhook/index.ts
//
// SETUP STEPS:
// 1. supabase functions deploy stripe-webhook
// 2. Secrets required:
//    STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.18.0?target=deno&no-check";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

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

  try {
    switch (event.type) {

      // ── Payment succeeded → upgrade user to Pro ──────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.CheckoutSession;
        const userId = session.metadata?.supabase_user_id;
        if (!userId) { console.error("No supabase_user_id in session metadata"); break; }

        // Calculate subscription end date from Stripe subscription
        let expiresAt: string | null = null;
        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription as string);
            if (sub.current_period_end) {
              expiresAt = new Date(sub.current_period_end * 1000).toISOString();
            }
          } catch (e) {
            console.error("Could not fetch subscription details:", e);
          }
        }

        await supabase.from("profiles").update({
          plan: "pro",
          stripe_customer_id: session.customer as string,
          stripe_subscription_id: session.subscription as string,
          subscription_expires_at: expiresAt,
        }).eq("id", userId);

        console.log(`Upgraded user ${userId} to Pro (expires: ${expiresAt})`);

        // 🎁 Grant referral reward if this user was referred
        try {
          const rewardRes = await fetch(
            `${Deno.env.get("SUPABASE_URL")}/functions/v1/grant-referral-reward`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({ referred_user_id: userId }),
            }
          );
          const rewardData = await rewardRes.json();
          console.log("Referral reward result:", rewardData);
        } catch (e) {
          console.error("Failed to call grant-referral-reward:", e);
        }

        break;
      }

      // ── Subscription cancelled / expired → downgrade to Free ──
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        await supabase.from("profiles").update({
          plan: "free",
          stripe_subscription_id: null,
          subscription_expires_at: null,
        }).eq("stripe_customer_id", customerId);

        console.log(`Downgraded customer ${customerId} to Free (subscription deleted)`);
        break;
      }

      // ── Subscription updated ──────────────────────────────────
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const isActive = sub.status === "active" || sub.status === "trialing";
        const expiresAt = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        await supabase.from("profiles").update({
          plan: isActive ? "pro" : "free",
          subscription_expires_at: isActive ? expiresAt : null,
        }).eq("stripe_customer_id", customerId);

        console.log(`Updated customer ${customerId} → ${isActive ? "pro" : "free"} (expires: ${expiresAt})`);
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
