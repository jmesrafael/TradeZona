// supabase/functions/create-checkout/index.ts
// Deploy: supabase functions deploy create-checkout
Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth header" }), { status: 401, headers: cors });
    }

    // Extract token from "Bearer <token>"
    const token = authHeader.replace("Bearer ", "").trim();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY")!;
    const priceId = Deno.env.get("STRIPE_PRICE_ID")!;
    const appUrl = Deno.env.get("APP_URL") || "https://tradezona.vercel.app";

    // Verify token using Supabase auth admin endpoint
    console.log("Verifying token...");
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": serviceKey,
      },
    });
    const userData = await userRes.json();
    console.log("User response status:", userRes.status);
    console.log("User ID:", userData.id);

    if (!userData.id) {
      return new Response(JSON.stringify({ 
        error: "Auth failed", 
        detail: JSON.stringify(userData) 
      }), { status: 401, headers: cors });
    }

    const userId = userData.id;
    const userEmail = userData.email;

    // Get profile using service key
    console.log("Getting profile...");
    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=stripe_customer_id,plan`,
      {
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Accept": "application/json",
        },
      }
    );
    const profiles = await profileRes.json();
    console.log("Profile:", JSON.stringify(profiles));
    const profile = profiles[0];

    if (profile?.plan === "pro") {
      return new Response(JSON.stringify({ error: "Already on Pro" }), { status: 400, headers: cors });
    }

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      console.log("Creating Stripe customer...");
      const customerRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `email=${encodeURIComponent(userEmail)}&metadata[supabase_user_id]=${userId}`,
      });
      const customer = await customerRes.json();
      console.log("Customer:", JSON.stringify({ id: customer.id, error: customer.error }));

      if (!customer.id) throw new Error("Stripe customer error: " + JSON.stringify(customer));
      customerId = customer.id;

      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({ stripe_customer_id: customerId }),
      });
    }

    console.log("Creating checkout session...");
    const body = new URLSearchParams();
    body.append("customer", customerId);
    body.append("mode", "subscription");
    body.append("line_items[0][price]", priceId);
    body.append("line_items[0][quantity]", "1");
    body.append("success_url", `${appUrl}/subscription.html?upgraded=1`);
    body.append("cancel_url", `${appUrl}/subscription.html?cancelled=1`);
    body.append("metadata[supabase_user_id]", userId);

    const sessionRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const session = await sessionRes.json();
    console.log("Session:", JSON.stringify({ url: session.url, error: session.error }));

    if (!session.url) throw new Error("No URL: " + JSON.stringify(session.error || session));

    return new Response(JSON.stringify({ url: session.url }), { headers: cors });

  } catch (err) {
    console.error("FATAL:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});