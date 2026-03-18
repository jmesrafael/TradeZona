serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  }

  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY")!;
    const priceId = Deno.env.get("STRIPE_PRICE_ID")!;
    const appUrl = Deno.env.get("APP_URL") || "https://tradezona.vercel.app";

    // Get user from JWT
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "Authorization": authHeader, "apikey": supabaseAnon }
    });
    const userData = await userRes.json();
    if (!userData.id) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });

    const userId = userData.id;
    const userEmail = userData.email;

    // Get profile
    const profileRes = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}&select=stripe_customer_id,plan`, {
      headers: { "Authorization": `Bearer ${serviceKey}`, "apikey": serviceKey }
    });
    const profiles = await profileRes.json();
    const profile = profiles[0];

    if (profile?.plan === "pro") {
      return new Response(JSON.stringify({ error: "Already on Pro" }), { status: 400, headers: cors });
    }

    // Get or create Stripe customer
    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customerRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          email: userEmail,
          "metadata[supabase_user_id]": userId,
        }),
      });
      const customer = await customerRes.json();
      if (!customer.id) throw new Error("Failed to create Stripe customer: " + JSON.stringify(customer));
      customerId = customer.id;

      // Save customer ID
      await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ stripe_customer_id: customerId }),
      });
    }

    // Create Stripe Checkout session
    const sessionRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: customerId,
        mode: "subscription",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        success_url: `${appUrl}/subscription.html?upgraded=1`,
        cancel_url: `${appUrl}/subscription.html?cancelled=1`,
        "metadata[supabase_user_id]": userId,
      }),
    });

    const session = await sessionRes.json();
    if (!session.url) throw new Error(session.error?.message || "No checkout URL returned");

    return new Response(JSON.stringify({ url: session.url }), { headers: cors });

  } catch (err) {
    console.error("Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: cors });
  }
});

function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(handler);
}