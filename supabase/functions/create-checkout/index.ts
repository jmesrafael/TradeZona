// supabase/functions/create-checkout/index.ts
// Deploy: supabase functions deploy create-checkout

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // ── 1. Authenticate ──────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth header" }), { status: 401, headers: CORS });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeKey   = Deno.env.get("STRIPE_SECRET_KEY")!;
    const priceId     = Deno.env.get("STRIPE_PRICE_ID")!;
    const appUrl      = Deno.env.get("APP_URL") || "https://tradezona.vercel.app";

    // Guard: fail fast if secrets aren't configured
    if (!stripeKey) return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY not set" }), { status: 500, headers: CORS });
    if (!priceId)   return new Response(JSON.stringify({ error: "STRIPE_PRICE_ID not set" }), { status: 500, headers: CORS });

    // Verify JWT
    console.log("Verifying token...");
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "Authorization": `Bearer ${token}`, "apikey": serviceKey },
    });
    const userData = await userRes.json();
    if (!userData?.id) {
      console.error("Auth failed:", JSON.stringify(userData));
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401, headers: CORS });
    }

    const userId    = userData.id;
    const userEmail = userData.email;
    console.log("User:", userId, userEmail);

    // ── 2. Get profile (safe — handles missing stripe columns) ──
    console.log("Getting profile...");
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=plan,stripe_customer_id`,
      {
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Accept": "application/json",
        },
      }
    );

    let plan: string | null = null;
    let customerId: string | null = null;

    if (profileRes.ok) {
      const profiles = await profileRes.json();
      // profiles is an array — profiles[0] is the user row
      // if stripe_customer_id column doesn't exist yet, it'll just be missing from the row
      if (Array.isArray(profiles) && profiles.length > 0) {
        plan       = profiles[0].plan ?? null;
        customerId = profiles[0].stripe_customer_id ?? null;
      }
      console.log("Plan:", plan, "| Has customer ID:", !!customerId);
    } else {
      // Profile fetch failed — log but continue (can still create checkout without customer ID)
      const errText = await profileRes.text();
      console.warn("Profile fetch failed (continuing anyway):", errText);
    }

    if (plan === "pro") {
      return new Response(JSON.stringify({ error: "Already on Pro" }), { status: 400, headers: CORS });
    }

    // ── 3. Create or reuse Stripe customer ───────────────────
    if (!customerId) {
      console.log("Creating Stripe customer for:", userEmail);
      const customerRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `email=${encodeURIComponent(userEmail)}&metadata[supabase_user_id]=${userId}`,
      });
      const customer = await customerRes.json();
      console.log("Stripe customer result:", JSON.stringify({ id: customer.id, error: customer.error }));

      if (!customer.id) {
        throw new Error("Stripe customer creation failed: " + (customer.error?.message || JSON.stringify(customer)));
      }
      customerId = customer.id;

      // Save customer ID back to profile (best-effort — don't fail if column doesn't exist yet)
      const patchRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ stripe_customer_id: customerId }),
      });
      if (!patchRes.ok) {
        const patchErr = await patchRes.text();
        // This fails if migration_stripe.sql hasn't been run — warn but continue
        console.warn("Could not save stripe_customer_id to profile (run migration_stripe.sql):", patchErr);
      }
    }

    // ── 4. Create Stripe checkout session ────────────────────
    console.log("Creating checkout session with price:", priceId);
    const sessionBody = new URLSearchParams();
    sessionBody.append("customer", customerId);
    sessionBody.append("mode", "subscription");
    sessionBody.append("line_items[0][price]", priceId);
    sessionBody.append("line_items[0][quantity]", "1");
    sessionBody.append("success_url", `${appUrl}/subscription?upgraded=1`);
    sessionBody.append("cancel_url",  `${appUrl}/subscription?cancelled=1`);
    sessionBody.append("metadata[supabase_user_id]", userId);

    const sessionRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: sessionBody.toString(),
    });
    const session = await sessionRes.json();
    console.log("Session result:", JSON.stringify({ url: session.url, error: session.error }));

    if (!session.url) {
      throw new Error(
        "Stripe session creation failed: " +
        (session.error?.message || session.error?.code || JSON.stringify(session))
      );
    }

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: CORS });

  } catch (err: any) {
    console.error("FATAL:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: CORS,
    });
  }
});