// supabase/functions/delete-account/index.ts
// Deploy: supabase functions deploy delete-account

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

    // Verify JWT via raw fetch — same approach as create-checkout (proven to work)
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": serviceKey,
      },
    });
    const userData = await userRes.json();

    if (!userData?.id) {
      console.error("Auth failed:", JSON.stringify(userData));
      return new Response(JSON.stringify({ error: "Invalid or expired session. Please sign in again." }), {
        status: 401, headers: CORS,
      });
    }

    const userId = userData.id;
    console.log("Deleting account for user:", userId);

    // ── 2. Delete all user data via REST API (service role) ──
    // Explicit delete in order — CASCADE handles it but this is safer
    const tables = ["trade_images", "trades", "journal_settings", "journals", "profiles"];
    for (const table of tables) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${table}?user_id=eq.${userId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${serviceKey}`,
          "apikey": serviceKey,
          "Prefer": "return=minimal",
        },
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`Failed to delete from ${table}:`, err);
        // Continue — partial cleanup is better than stopping
      } else {
        console.log(`Deleted from ${table}`);
      }
    }

    // ── 3. Delete the auth user (must be last) ───────────────
    const deleteRes = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
      },
    });

    if (!deleteRes.ok) {
      const err = await deleteRes.json().catch(() => ({ message: deleteRes.statusText }));
      console.error("Auth user deletion failed:", JSON.stringify(err));
      return new Response(JSON.stringify({ error: "Failed to delete auth user: " + (err.message || deleteRes.statusText) }), {
        status: 500, headers: CORS,
      });
    }

    console.log("Account successfully deleted for user:", userId);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS });

  } catch (err: any) {
    console.error("FATAL:", err.message);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: CORS,
    });
  }
});