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

// ── Helpers ───────────────────────────────────────────────────

/**
 * Detect plan type from a Stripe subscription's price interval.
 * Returns 'monthly' | 'yearly' | 'lifetime'.
 */
function detectPlanType(sub: Stripe.Subscription): "monthly" | "yearly" | "lifetime" {
  const item = sub.items?.data?.[0];
  const interval = item?.price?.recurring?.interval;
  if (!interval) return "monthly"; // default
  if (interval === "year") return "yearly";
  return "monthly";
}

/**
 * Calculate expiry date based on plan type.
 * Monthly → now + 30 days
 * Yearly  → now + 365 days
 * Falls back to Stripe's current_period_end if available.
 */
function calcExpiresAt(sub: Stripe.Subscription, planType: string): string {
  // Prefer Stripe's authoritative current_period_end
  if (sub.current_period_end) {
    return new Date(sub.current_period_end * 1000).toISOString();
  }

  // Fallback: calculate from now
  const now = new Date();
  const days = planType === "yearly" ? 365 : 30;
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + days);
  return expiry.toISOString();
}

/**
 * Call the grant-referral-reward function internally.
 */
async function callGrantReferralReward(userId: string): Promise<void> {
  try {
    const rewardRes = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/grant-referral-reward`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ referred_user_id: userId }),
      }
    );
    const rewardData = await rewardRes.json();
    console.log(`[referral] grant-referral-reward result for user ${userId}:`, rewardData);
  } catch (e) {
    console.error(`[referral] Failed to call grant-referral-reward for user ${userId}:`, e);
  }
}

// ── Webhook handler ───────────────────────────────────────────
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
    console.error("[webhook] Signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  console.log(`[webhook] Received event: ${event.type}`);

  try {
    switch (event.type) {

      // ── Checkout completed → Upgrade user to Pro ─────────────
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.CheckoutSession;
        const userId  = session.metadata?.supabase_user_id;

        if (!userId) {
          console.error("[webhook] checkout.session.completed: missing supabase_user_id in metadata");
          break;
        }

        let planType: "monthly" | "yearly" | "lifetime" = "monthly";
        let expiresAt: string | null = null;

        if (session.subscription) {
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription as string);
            planType  = detectPlanType(sub);
            expiresAt = calcExpiresAt(sub, planType);
            console.log(`[webhook] Plan type: ${planType}, expires: ${expiresAt}`);
          } catch (e) {
            console.error("[webhook] Could not fetch subscription details:", e);
            // Fall back to plan from metadata if available
            const metaPlan = session.metadata?.plan_type;
            if (metaPlan === "yearly") { planType = "yearly"; }
            const days = planType === "yearly" ? 365 : 30;
            const d = new Date();
            d.setDate(d.getDate() + days);
            expiresAt = d.toISOString();
          }
        } else {
          // One-time payment (lifetime) — no expiry
          planType  = "lifetime";
          expiresAt = null;
        }

        const { error: upgradeError } = await supabase.from("profiles").update({
          plan:                    "pro",
          plan_type:               planType,
          stripe_customer_id:      session.customer as string,
          stripe_subscription_id:  session.subscription as string ?? null,
          subscription_expires_at: expiresAt,
        }).eq("id", userId);

        if (upgradeError) {
          console.error(`[webhook] Failed to upgrade user ${userId}:`, upgradeError);
        } else {
          console.log(`[webhook] Upgraded user ${userId} to Pro (${planType}, expires: ${expiresAt})`);
        }

        // 🎁 Trigger referral reward for this new subscriber
        await callGrantReferralReward(userId);
        break;
      }

      // ── Subscription deleted → Downgrade to Free ─────────────
      case "customer.subscription.deleted": {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;

        const { error } = await supabase.from("profiles").update({
          plan:                    "free",
          plan_type:               "none",
          stripe_subscription_id:  null,
          subscription_expires_at: null,
        }).eq("stripe_customer_id", customerId);

        if (error) {
          console.error(`[webhook] Failed to downgrade customer ${customerId}:`, error);
        } else {
          console.log(`[webhook] Downgraded customer ${customerId} to Free`);
        }
        break;
      }

      // ── Subscription updated (renewal, plan change) ───────────
      case "customer.subscription.updated": {
        const sub        = event.data.object as Stripe.Subscription;
        const customerId = sub.customer as string;
        const isActive   = sub.status === "active" || sub.status === "trialing";
        const planType   = detectPlanType(sub);
        const expiresAt  = isActive && sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString()
          : null;

        const { error } = await supabase.from("profiles").update({
          plan:                    isActive ? "pro" : "free",
          plan_type:               isActive ? planType : "none",
          subscription_expires_at: isActive ? expiresAt : null,
        }).eq("stripe_customer_id", customerId);

        if (error) {
          console.error(`[webhook] Failed to update customer ${customerId}:`, error);
        } else {
          console.log(`[webhook] Updated customer ${customerId} → ${isActive ? "pro/" + planType : "free"} (expires: ${expiresAt})`);
        }
        break;
      }

      // ── Invoice paid (renewal) — keep expiry fresh ────────────
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        if (!invoice.subscription) break;

        try {
          const sub        = await stripe.subscriptions.retrieve(invoice.subscription as string);
          const customerId = sub.customer as string;
          const planType   = detectPlanType(sub);
          const expiresAt  = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;

          await supabase.from("profiles").update({
            plan:                    "pro",
            plan_type:               planType,
            subscription_expires_at: expiresAt,
          }).eq("stripe_customer_id", customerId);

          console.log(`[webhook] Renewed subscription for customer ${customerId} (${planType}, expires: ${expiresAt})`);
        } catch (e) {
          console.error("[webhook] invoice.payment_succeeded: failed to refresh expiry:", e);
        }
        break;
      }

      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error("[webhook] Error processing event:", err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
